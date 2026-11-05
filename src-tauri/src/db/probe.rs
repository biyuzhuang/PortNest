//! 数据库连接探测：DNS → TCP → 认证 → TLS 协商结论 → 元数据。
//!
//! 与真正的连接池构建（`commands::mysql_admin::build_pool` 等）分开：这里只为
//! 「测试连接」按钮服务，使用**未保存的临时配置**，探测结束立即断开，不留连接。

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;

use super::report::{DbTestReport, DbTestStage, DbTlsInfo, StageStatus};
use crate::commands::ConnectionConfigRequest;
use crate::protocol::pgsql::PgClient;
use crate::protocol::{ConnectionOptions, Credential, CredentialType, ProtocolPlugin};

const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// 探测过程中收集到的服务器事实
struct ServerFacts {
    version: Option<String>,
    database: Option<String>,
    charset: Option<String>,
    timezone: Option<String>,
    read_only: Option<bool>,
    tls_negotiated: bool,
    tls_verified: Option<bool>,
    auth_ms: u64,
    meta_ms: u64,
}

/// 探测失败：(错误分类, 原始消息, 建议)
type ProbeFailure = (String, String, String);

/// NULL 安全的取值：`Row::get::<String,_>()` 遇到 NULL 会 panic，必须用 `get_opt`。
fn row_opt_string(row: &mysql_async::Row, column: &str) -> Option<String> {
    row.get_opt::<String, _>(column).and_then(Result::ok)
}

fn row_opt_i64(row: &mysql_async::Row, column: &str) -> Option<i64> {
    row.get_opt::<i64, _>(column).and_then(Result::ok)
}

fn failure(code: &str, message: String, hint: &str) -> ProbeFailure {
    (code.to_string(), message, hint.to_string())
}

/// 去掉 IPv6 字面量两侧的方括号，便于 `lookup_host` / `TcpStream::connect` 使用
fn normalize_host(host: &str) -> String {
    let trimmed = host.trim();
    trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed)
        .to_string()
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn effective_timeout(config: &ConnectionConfigRequest) -> Duration {
    Duration::from_millis(
        config
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, 300_000),
    )
}

/// 把数据库驱动的错误消息归类成稳定的错误码 + 建议
fn classify(message: &str) -> (&'static str, &'static str) {
    let lower = message.to_ascii_lowercase();
    if lower.contains("access denied")
        || lower.contains("password authentication failed")
        || lower.contains("authentication failed")
        || lower.contains("role") && lower.contains("does not exist")
    {
        return ("auth_failed", "请检查用户名与密码；确认该账号允许从当前主机登录");
    }
    if lower.contains("permission denied") || lower.contains("denied to") {
        return ("permission_denied", "账号可登录但缺少读取元数据的权限，请让 DBA 授权");
    }
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl") {
        return (
            "tls_failed",
            "证书校验失败：改用「跳过证书校验」可临时排查，或把服务器 CA 安装到系统信任链",
        );
    }
    if lower.contains("refused") {
        return ("tcp_refused", "端口未开放或被拒绝：确认数据库已启动、端口正确、未被防火墙拦截");
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return ("tcp_timeout", "连接超时：确认主机可达，必要时调大连接超时");
    }
    if lower.contains("unknown database") || lower.contains("does not exist") {
        return ("unknown_database", "默认数据库不存在：留空后连接，或填写正确的库名");
    }
    (
        "unknown",
        "请核对主机、端口、用户名、密码与 SSL 模式；必要时查看应用日志",
    )
}

/// 探测一份（可能尚未保存的）数据库连接配置
pub async fn probe(config: &ConnectionConfigRequest) -> DbTestReport {
    let protocol = config.protocol.trim().to_ascii_lowercase();
    let mut report = DbTestReport::empty();

    if !matches!(protocol.as_str(), "mysql" | "postgresql" | "highgo") {
        return report.fail(
            "protocol_unsupported",
            format!("暂不支持的数据库协议：{protocol}"),
            "连接测试目前支持 MySQL、PostgreSQL 与瀚高数据库",
        );
    }

    let host = normalize_host(&config.host);
    if host.is_empty() {
        return report.fail("unknown", "主机地址为空".to_string(), "请填写主机地址");
    }
    let port = config.port;
    let username = config.username.trim().to_string();
    if username.is_empty() {
        return report.fail(
            "auth_failed",
            "用户名为空".to_string(),
            "请填写数据库用户名",
        );
    }
    let password = config.password.clone().unwrap_or_default();
    let database = config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let ssl_mode = config
        .ssl_mode
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if protocol == "mysql" {
                "disabled".to_string()
            } else {
                "prefer".to_string()
            }
        });
    let timeout = effective_timeout(config);

    // MySQL 没有「优先使用 SSL」的语义：驱动只能表达「要」或「不要」。
    // 这里按「要求 SSL」处理，并在报告里说明，避免连接时出现含糊的 TLS 错误。
    let prefer_mapped_to_required = protocol == "mysql" && ssl_mode == "prefer";
    let connect_ssl_mode = if prefer_mapped_to_required {
        "required".to_string()
    } else {
        ssl_mode.clone()
    };

    // ---------- 1. DNS ----------
    let dns_start = Instant::now();
    match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host.as_str(), port))).await {
        Ok(Ok(addrs)) => {
            let addresses: Vec<SocketAddr> = addrs.collect();
            let elapsed = dns_start.elapsed().as_millis() as u64;
            if addresses.is_empty() {
                report.stages.push(DbTestStage::new(
                    "dns",
                    "域名解析",
                    StageStatus::Failed,
                    elapsed,
                    None,
                    Some("域名未解析到任何地址".to_string()),
                ));
                return report.fail(
                    "dns_failed",
                    format!("{host} 未解析到可用地址"),
                    "检查主机名拼写，或直接填写 IP 地址",
                );
            }
            let resolved = addresses
                .iter()
                .map(|addr| addr.ip().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            report.stages.push(DbTestStage::new(
                "dns",
                "域名解析",
                StageStatus::Ok,
                elapsed,
                Some(format!("{host} → {resolved}")),
                None,
            ));
        }
        Ok(Err(error)) => {
            let elapsed = dns_start.elapsed().as_millis() as u64;
            report.stages.push(DbTestStage::new(
                "dns",
                "域名解析",
                StageStatus::Failed,
                elapsed,
                Some(error.to_string()),
                Some("域名无法解析".to_string()),
            ));
            return report.fail(
                "dns_failed",
                format!("域名解析失败：{error}"),
                "检查主机名拼写、DNS 与网络连通性",
            );
        }
        Err(_) => {
            report.stages.push(DbTestStage::new(
                "dns",
                "域名解析",
                StageStatus::Failed,
                DNS_TIMEOUT.as_millis() as u64,
                Some("解析超时".to_string()),
                Some("DNS 服务器无响应".to_string()),
            ));
            return report.fail(
                "dns_failed",
                format!("域名解析超时（{host}）"),
                "检查 DNS 配置，或改用 IP 地址",
            );
        }
    }

    // ---------- 2. TCP ----------
    let tcp_start = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(stream)) => {
            let elapsed = tcp_start.elapsed().as_millis() as u64;
            let local = stream
                .local_addr()
                .map(|addr| addr.to_string())
                .unwrap_or_else(|_| "未知".to_string());
            report.stages.push(DbTestStage::new(
                "tcp",
                "TCP 连接",
                StageStatus::Ok,
                elapsed,
                Some(format!("{host}:{port}（本端 {local}）")),
                None,
            ));
        }
        Ok(Err(error)) => {
            let elapsed = tcp_start.elapsed().as_millis() as u64;
            let (code, hint) = classify(&error.to_string());
            report.stages.push(DbTestStage::new(
                "tcp",
                "TCP 连接",
                StageStatus::Failed,
                elapsed,
                Some(error.to_string()),
                Some(hint.to_string()),
            ));
            return report.fail(
                code,
                format!("无法连接 {host}:{port}：{error}"),
                hint,
            );
        }
        Err(_) => {
            report.stages.push(DbTestStage::new(
                "tcp",
                "TCP 连接",
                StageStatus::Failed,
                timeout.as_millis() as u64,
                Some("等待 TCP 握手超时".to_string()),
                Some("主机不可达或防火墙丢弃了数据包".to_string()),
            ));
            return report.fail(
                "tcp_timeout",
                format!("连接 {host}:{port} 超时（{}ms）", timeout.as_millis()),
                "确认主机可达；被墙或被安全组拦截时考虑使用 SSH 隧道",
            );
        }
    }

    // ---------- 3. 认证（同时得到 TLS 协商结论） ----------
    let facts = match protocol.as_str() {
        "mysql" => {
            match probe_mysql(
                &host,
                port,
                &username,
                &password,
                database.as_deref(),
                &connect_ssl_mode,
                timeout,
            )
            .await
            {
                Ok(facts) => facts,
                Err((code, message, hint)) => {
                    report.stages.push(DbTestStage::new(
                        "auth",
                        "身份认证",
                        StageStatus::Failed,
                        timeout.as_millis() as u64,
                        Some(message.clone()),
                        Some(hint.clone()),
                    ));
                    return report.fail(&code, message, &hint);
                }
            }
        }
        _ => {
            match probe_postgres(
                &host, port, &username, &password, database.as_deref(), &ssl_mode, timeout,
            )
            .await
            {
                Ok(facts) => facts,
                Err((code, message, hint)) => {
                    report.stages.push(DbTestStage::new(
                        "auth",
                        "身份认证",
                        StageStatus::Failed,
                        timeout.as_millis() as u64,
                        Some(message.clone()),
                        Some(hint.clone()),
                    ));
                    return report.fail(&code, message, &hint);
                }
            }
        }
    };

    report.stages.push(DbTestStage::new(
        "auth",
        "身份认证",
        StageStatus::Ok,
        facts.auth_ms,
        Some(format!("用户 {username} 认证通过")),
        None,
    ));

    // ---------- 4. TLS 结论（插在认证之前显示） ----------
    let tls_stage = if ssl_mode == "disabled" {
        DbTestStage::skipped("tls", "TLS 协商", "当前 SSL 模式为「禁用」")
    } else if facts.tls_negotiated {
        DbTestStage::new(
            "tls",
            "TLS 协商",
            StageStatus::Ok,
            0,
            Some(if ssl_mode == "prefer" {
                "服务器支持加密，已使用 TLS".to_string()
            } else {
                "已建立 TLS 加密通道".to_string()
            }),
            None,
        )
    } else {
        DbTestStage::new(
            "tls",
            "TLS 协商",
            StageStatus::Warn,
            0,
            Some("服务器未启用 SSL，连接为明文".to_string()),
            Some("生产环境建议在服务端开启 SSL".to_string()),
        )
    };
    report.stages.insert(2, tls_stage);
    report.tls = Some(DbTlsInfo {
        mode: ssl_mode.clone(),
        negotiated: facts.tls_negotiated,
        protocol: None,
        cipher: None,
        verified: facts.tls_verified,
    });

    // ---------- 5. 元数据 ----------
    let version_label = facts
        .version
        .clone()
        .unwrap_or_else(|| protocol.to_ascii_uppercase());
    let mut detail = vec![version_label];
    if let Some(database) = facts.database.clone() {
        detail.push(database);
    }
    if let Some(charset) = facts.charset.clone() {
        detail.push(charset);
    }
    report.stages.push(DbTestStage::new(
        "metadata",
        "服务器信息",
        StageStatus::Ok,
        facts.meta_ms,
        Some(detail.join(" · ")),
        None,
    ));

    // ---------- 汇总 ----------
    if ssl_mode == "disabled" && !is_loopback(&host) {
        report
            .warnings
            .push("当前连接未启用 SSL，账号密码将以明文在网络上传输".to_string());
    }
    if ssl_mode == "skip_verify" {
        report
            .warnings
            .push("已加密但跳过证书与主机名校验，存在中间人风险".to_string());
    }
    if prefer_mapped_to_required {
        report.warnings.push(
            "MySQL 不支持「优先使用 SSL」：本次按「要求 SSL」连接，服务器未启用 SSL 时会直接失败"
                .to_string(),
        );
    }
    if facts.read_only == Some(true) {
        report
            .warnings
            .push("服务器当前处于只读模式，写入类操作会被拒绝".to_string());
    }

    report.ok = true;
    report.rtt_ms = facts.meta_ms;
    report.server_version = facts.version;
    report.current_database = facts.database;
    report.charset = facts.charset;
    report.timezone = facts.timezone;
    report.read_only = facts.read_only;
    report
}

async fn probe_mysql(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: Option<&str>,
    ssl_mode: &str,
    timeout: Duration,
) -> Result<ServerFacts, ProbeFailure> {
    use crate::protocol::mysql::MysqlConnectionHandle;

    let plugin = crate::protocol::mysql::MysqlPlugin::new();
    let credential = Credential {
        credential_type: CredentialType::Password,
        password: Some(password.to_string()),
        private_key: None,
        passphrase: None,
    };
    let mut options = ConnectionOptions::default();
    if let Some(database) = database {
        options
            .protocol_options
            .insert("database".to_string(), database.to_string());
    }
    options
        .protocol_options
        .insert("ssl_mode".to_string(), ssl_mode.to_string());

    let connect_start = Instant::now();
    let handle = match tokio::time::timeout(
        timeout,
        plugin.connect(host, port, username, &credential, &options),
    )
    .await
    {
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            let message = error.to_string();
            let (code, hint) = classify(&message);
            return Err(failure(code, message, hint));
        }
        Err(_) => {
            return Err(failure(
                "tcp_timeout",
                format!("认证阶段超时（{}ms）", timeout.as_millis()),
                "服务端响应缓慢，或账号被锁定",
            ))
        }
    };
    let auth_ms = connect_start.elapsed().as_millis() as u64;

    let mysql_handle = handle
        .as_any()
        .downcast_ref::<MysqlConnectionHandle>()
        .ok_or_else(|| failure("unknown", "MySQL 句柄类型异常".to_string(), "请查看应用日志"))?;

    let meta_start = Instant::now();
    let rows = match tokio::time::timeout(
        timeout,
        mysql_handle.query(
            "SELECT VERSION() AS version, DATABASE() AS current_db, \
             @@character_set_client AS charset, @@time_zone AS tz, @@read_only AS ro",
        ),
    )
    .await
    {
        Ok(Ok(rows)) => rows,
        Ok(Err(error)) => {
            let message = error.to_string();
            let (code, hint) = classify(&message);
            return Err(failure(code, message, hint));
        }
        Err(_) => {
            return Err(failure(
                "tcp_timeout",
                "读取服务器信息超时".to_string(),
                "账号可能缺少读取变量权限，或服务器负载过高",
            ))
        }
    };
    let meta_ms = meta_start.elapsed().as_millis() as u64;

    let row = rows
        .first()
        .ok_or_else(|| failure("unknown", "服务器未返回版本信息".to_string(), "请查看应用日志"))?;

    Ok(ServerFacts {
        version: row_opt_string(row, "version"),
        database: row_opt_string(row, "current_db"),
        charset: row_opt_string(row, "charset"),
        timezone: row_opt_string(row, "tz"),
        read_only: row_opt_i64(row, "ro").map(|value| value != 0),
        tls_negotiated: ssl_mode != "disabled",
        tls_verified: if ssl_mode == "disabled" {
            None
        } else {
            Some(ssl_mode != "skip_verify")
        },
        auth_ms,
        meta_ms,
    })
}

async fn probe_postgres(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: Option<&str>,
    ssl_mode: &str,
    timeout: Duration,
) -> Result<ServerFacts, ProbeFailure> {
    let connect_start = Instant::now();
    let mut client = match tokio::time::timeout(
        timeout,
        PgClient::connect(
            host,
            port,
            username,
            password,
            database.unwrap_or(""),
            ssl_mode,
            timeout,
        ),
    )
    .await
    {
        Ok(Ok(client)) => client,
        Ok(Err(error)) => {
            let message = error.to_string();
            let (code, hint) = classify(&message);
            return Err(failure(code, message, hint));
        }
        Err(_) => {
            return Err(failure(
                "tcp_timeout",
                format!("认证阶段超时（{}ms）", timeout.as_millis()),
                "服务端响应缓慢，或 pg_hba.conf 拒绝了该来源",
            ))
        }
    };
    let auth_ms = connect_start.elapsed().as_millis() as u64;
    let negotiated = client.is_tls();
    let version = client.server_version().map(str::to_string);

    let meta_start = Instant::now();
    let result = match tokio::time::timeout(
        timeout,
        client.query(
            "SELECT current_database(), current_setting('client_encoding'), \
             current_setting('TimeZone'), current_setting('transaction_read_only')",
        ),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let message = error.to_string();
            let (code, hint) = classify(&message);
            return Err(failure(code, message, hint));
        }
        Err(_) => {
            return Err(failure(
                "tcp_timeout",
                "读取服务器信息超时".to_string(),
                "服务器负载过高，或账号缺少读取系统设置的权限",
            ))
        }
    };
    let meta_ms = meta_start.elapsed().as_millis() as u64;

    let row = result
        .rows
        .first()
        .ok_or_else(|| failure("unknown", "服务器未返回版本信息".to_string(), "请查看应用日志"))?;

    Ok(ServerFacts {
        version,
        database: row.first().and_then(|value| value.as_str()).map(str::to_string),
        charset: row.get(1).and_then(|value| value.as_str()).map(str::to_string),
        timezone: row.get(2).and_then(|value| value.as_str()).map(str::to_string),
        read_only: row
            .get(3)
            .and_then(|value| value.as_str())
            .map(|value| value.eq_ignore_ascii_case("on")),
        tls_negotiated: negotiated,
        tls_verified: if negotiated {
            Some(matches!(ssl_mode, "required" | "verify_identity" | "verify_ca" | "verify_full"))
        } else {
            None
        },
        auth_ms,
        meta_ms,
    })
}
