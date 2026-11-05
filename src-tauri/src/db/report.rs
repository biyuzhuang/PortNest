//! 数据库连接诊断结果的数据结构。
//!
//! 前端「测试连接」面板直接渲染这些结构：每个阶段一行，失败阶段带可执行的
//! 建议（`hint`）。这里只放数据，不含任何连接逻辑，便于单独测试。

use serde::Serialize;

/// 单个探测阶段的结果状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    /// 通过
    Ok,
    /// 通过但存在隐患
    Warn,
    /// 本协议/本配置下不适用，未执行
    Skipped,
    /// 失败（后续阶段会短路）
    Failed,
}

/// 探测报告的单个阶段
#[derive(Debug, Clone, Serialize)]
pub struct DbTestStage {
    /// 阶段标识：dns / tcp / tls / auth / metadata
    pub id: String,
    /// 面向用户的中文阶段名
    pub label: String,
    pub status: StageStatus,
    pub duration_ms: u64,
    /// 成功时的补充信息，例如解析到的 IP、服务器版本
    pub detail: Option<String>,
    /// 失败或警告时的建议
    pub hint: Option<String>,
}

impl DbTestStage {
    pub fn new(
        id: &str,
        label: &str,
        status: StageStatus,
        duration_ms: u64,
        detail: Option<String>,
        hint: Option<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            status,
            duration_ms,
            detail,
            hint,
        }
    }

    pub fn skipped(id: &str, label: &str, reason: &str) -> Self {
        Self::new(
            id,
            label,
            StageStatus::Skipped,
            0,
            Some(reason.to_string()),
            None,
        )
    }
}

/// TLS 协商情况
#[derive(Debug, Clone, Serialize)]
pub struct DbTlsInfo {
    /// 配置的模式：disabled / prefer / required / skip_verify / verify_identity
    pub mode: String,
    /// 本次连接是否真的建立了加密通道
    pub negotiated: bool,
    pub protocol: Option<String>,
    pub cipher: Option<String>,
    /// 是否校验证书；`None` 表示未加密或无法判断
    pub verified: Option<bool>,
}

/// 一次数据库连接探测的完整报告
#[derive(Debug, Clone, Serialize)]
pub struct DbTestReport {
    pub ok: bool,
    pub stages: Vec<DbTestStage>,
    /// 服务端往返耗时（元数据查询耗时）
    pub rtt_ms: u64,
    pub server_version: Option<String>,
    pub tls: Option<DbTlsInfo>,
    pub current_database: Option<String>,
    pub charset: Option<String>,
    pub timezone: Option<String>,
    pub read_only: Option<bool>,
    /// 非阻断性提示
    pub warnings: Vec<String>,
    /// 失败分类：dns_failed / tcp_refused / tcp_timeout / tls_failed /
    /// auth_failed / permission_denied / protocol_unsupported / unknown
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_hint: Option<String>,
}

impl DbTestReport {
    pub fn empty() -> Self {
        Self {
            ok: false,
            stages: Vec::new(),
            rtt_ms: 0,
            server_version: None,
            tls: None,
            current_database: None,
            charset: None,
            timezone: None,
            read_only: None,
            warnings: Vec::new(),
            error_code: None,
            error_message: None,
            error_hint: None,
        }
    }

    /// 记录一次失败：写入 error_* 字段并把剩余阶段标记为未执行。
    pub fn fail(mut self, code: &str, message: String, hint: &str) -> Self {
        self.ok = false;
        self.error_code = Some(code.to_string());
        self.error_message = Some(message);
        self.error_hint = Some(hint.to_string());
        self
    }

    /// 连接已经建立但元数据查询失败时使用：保留已有阶段，标记不可用。
    pub fn degraded(mut self, message: String) -> Self {
        self.ok = false;
        self.error_code = Some("metadata_failed".to_string());
        self.error_message = Some(message);
        self.error_hint = Some("连接已建立但无法读取服务器信息，请检查账号权限".to_string());
        self
    }
}

/// 已建立连接的运行状态（供状态栏与重连按钮使用）
#[derive(Debug, Clone, Serialize)]
pub struct DbConnectionInfo {
    pub protocol: String,
    /// connected | degraded
    pub state: String,
    pub latency_ms: Option<u64>,
    pub server_version: Option<String>,
    pub current_database: Option<String>,
    pub read_only: Option<bool>,
    pub tls_mode: Option<String>,
    /// 连接池配置值（mysql_async 未暴露实时占用，这里报告配置上下限）
    pub pool_min: u16,
    pub pool_max: u16,
}
