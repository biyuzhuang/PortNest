//! PostgreSQL 数据库协议插件
//!
//! 这里包含一个轻量的 PostgreSQL 前端/后端协议实现。它的目标是复用
//! PortNest 的统一数据库工作区，而不依赖某一个 UI 专属的数据库驱动。

use async_trait::async_trait;
use base64::Engine;
use hmac::{Hmac, Mac};
use native_tls::TlsConnector;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, CredentialType,
    ProtocolCapability, ProtocolPlugin,
};

type HmacSha256 = Hmac<Sha256>;

const PG_PROTOCOL_VERSION: i32 = 196_608;
const PG_SSL_REQUEST_CODE: i32 = 80_877_103;
const PG_CANCEL_REQUEST_CODE: i32 = 80_877_102;
const MAX_PG_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// PostgreSQL 查询列
#[derive(Debug, Clone)]
pub struct PgField {
    pub name: String,
    pub type_oid: u32,
    pub type_name: String,
}

/// PostgreSQL 原始查询结果
#[derive(Debug, Clone, Default)]
pub struct PgQueryResult {
    pub fields: Vec<PgField>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub command_tag: String,
}

impl PgQueryResult {
    pub fn column_names(&self) -> Vec<String> {
        self.fields.iter().map(|field| field.name.clone()).collect()
    }
}

/// 取消请求只需要连接启动时拿到的 backend key，不会复用正在执行查询的连接。
#[derive(Debug, Clone)]
pub struct PgCancelToken {
    host: String,
    port: u16,
    process_id: u32,
    secret_key: u32,
}

impl PgCancelToken {
    pub async fn cancel(&self) -> Result<()> {
        let mut stream = tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect((self.host.as_str(), self.port)),
        )
        .await
        .map_err(|_| Error::Timeout("PostgreSQL 取消连接超时".to_string()))?
        .map_err(Error::IoError)?;

        let mut packet = Vec::with_capacity(16);
        packet.extend_from_slice(&16_i32.to_be_bytes());
        packet.extend_from_slice(&PG_CANCEL_REQUEST_CODE.to_be_bytes());
        packet.extend_from_slice(&self.process_id.to_be_bytes());
        packet.extend_from_slice(&self.secret_key.to_be_bytes());
        stream.write_all(&packet).await.map_err(Error::IoError)?;
        let _ = stream.shutdown().await;
        Ok(())
    }
}

enum PgTransport {
    Plain(TcpStream),
    Tls(TlsStream<TcpStream>),
}

impl PgTransport {
    async fn read_exact(&mut self, buffer: &mut [u8]) -> Result<()> {
        match self {
            Self::Plain(stream) => stream
                .read_exact(buffer)
                .await
                .map(|_| ())
                .map_err(Error::IoError),
            Self::Tls(stream) => stream
                .read_exact(buffer)
                .await
                .map(|_| ())
                .map_err(Error::IoError),
        }
    }

    async fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        match self {
            Self::Plain(stream) => stream.write_all(bytes).await.map_err(Error::IoError),
            Self::Tls(stream) => stream.write_all(bytes).await.map_err(Error::IoError),
        }
    }
}

struct ScramState {
    client_first_bare: String,
    nonce: String,
    expected_server_signature: Option<Vec<u8>>,
}

/// 轻量 PostgreSQL 客户端。使用 simple query 协议，适合数据库管理 UI 的
/// 浏览、查询和 DDL/DML 操作。
pub struct PgClient {
    transport: PgTransport,
    host: String,
    port: u16,
    process_id: u32,
    secret_key: u32,
    server_version: Option<String>,
}

impl PgClient {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
        ssl_mode: &str,
        timeout: Duration,
    ) -> Result<Self> {
        let mode = ssl_mode.trim().to_ascii_lowercase();
        let tcp = tokio::time::timeout(timeout, TcpStream::connect((host, port)))
            .await
            .map_err(|_| Error::Timeout(format!("PostgreSQL 连接超时（{host}:{port}）")))?
            .map_err(Error::IoError)?;
        let _ = tcp.set_nodelay(true);

        let mut transport = if mode == "disabled" || mode == "disable" {
            PgTransport::Plain(tcp)
        } else {
            let mut stream = tcp;
            stream
                .write_all(&pg_ssl_request())
                .await
                .map_err(Error::IoError)?;
            let mut response = [0_u8; 1];
            stream
                .read_exact(&mut response)
                .await
                .map_err(Error::IoError)?;
            match response[0] {
                b'S' => {
                    let skip_verify = matches!(mode.as_str(), "skip_verify" | "prefer" | "allow");
                    let mut builder = TlsConnector::builder();
                    if skip_verify {
                        builder.danger_accept_invalid_certs(true);
                        builder.danger_accept_invalid_hostnames(true);
                    }
                    let connector = builder.build().map_err(|e| {
                        Error::ConnectionFailed(format!("创建 PostgreSQL TLS 连接失败: {e}"))
                    })?;
                    let tls = tokio_native_tls::TlsConnector::from(connector)
                        .connect(host, stream)
                        .await
                        .map_err(|e| {
                            Error::ConnectionFailed(format!("PostgreSQL TLS 握手失败: {e}"))
                        })?;
                    PgTransport::Tls(tls)
                }
                b'N' if matches!(
                    mode.as_str(),
                    "require"
                        | "required"
                        | "verify_ca"
                        | "verify_full"
                        | "verify_identity"
                        | "skip_verify"
                ) =>
                {
                    return Err(Error::ConnectionFailed(
                        "PostgreSQL 服务器不支持 SSL，但当前 SSL 模式要求加密连接".to_string(),
                    ));
                }
                b'N' => PgTransport::Plain(stream),
                other => {
                    return Err(Error::ProtocolError(format!(
                        "PostgreSQL SSL 协商返回未知响应: 0x{other:02x}"
                    )));
                }
            }
        };

        let database = if database.trim().is_empty() {
            username
        } else {
            database
        };
        let startup = pg_startup_message(username, database);
        transport.write_all(&startup).await?;

        let mut client = Self {
            transport,
            host: host.to_string(),
            port,
            process_id: 0,
            secret_key: 0,
            server_version: None,
        };
        tokio::time::timeout(timeout, client.authenticate(username, password))
            .await
            .map_err(|_| Error::Timeout("PostgreSQL 认证超时".to_string()))??;
        Ok(client)
    }

    async fn authenticate(&mut self, username: &str, password: &str) -> Result<()> {
        let mut scram: Option<ScramState> = None;
        loop {
            let (kind, body) = self.read_message().await?;
            match kind {
                b'R' => {
                    let code = read_i32(&body, 0)?;
                    match code {
                        0 => {}
                        3 => self.send_password(password).await?,
                        5 => {
                            let salt = body.get(4..8).ok_or_else(|| {
                                Error::ProtocolError("PostgreSQL MD5 认证响应缺少 salt".to_string())
                            })?;
                            self.send_password(&pg_md5_password(password, username, salt))
                                .await?;
                        }
                        10 => {
                            let payload = body.get(4..).unwrap_or_default();
                            let mechanisms = parse_cstring_list(payload)?;
                            if !mechanisms.iter().any(|item| item == "SCRAM-SHA-256") {
                                return Err(Error::AuthenticationFailed(format!(
                                    "PostgreSQL 仅提供了不支持的认证方式: {}",
                                    mechanisms.join(", ")
                                )));
                            }
                            let (message, state) = scram_client_first();
                            scram = Some(state);
                            self.send_sasl_initial("SCRAM-SHA-256", message.as_bytes())
                                .await?;
                        }
                        11 => {
                            let server_first = std::str::from_utf8(
                                body.get(4..).unwrap_or_default(),
                            )
                            .map_err(|_| {
                                Error::ProtocolError("PostgreSQL SCRAM 消息不是 UTF-8".to_string())
                            })?;
                            let state = scram.as_mut().ok_or_else(|| {
                                Error::ProtocolError("PostgreSQL SCRAM 状态丢失".to_string())
                            })?;
                            let (client_final, expected_signature) =
                                scram_client_final(password, state, server_first)?;
                            state.expected_server_signature = Some(expected_signature);
                            self.send_sasl_response(client_final.as_bytes()).await?;
                        }
                        12 => {
                            let server_final = std::str::from_utf8(
                                body.get(4..).unwrap_or_default(),
                            )
                            .map_err(|_| {
                                Error::ProtocolError("PostgreSQL SCRAM 消息不是 UTF-8".to_string())
                            })?;
                            if let Some(expected) = scram
                                .as_ref()
                                .and_then(|state| state.expected_server_signature.as_ref())
                            {
                                verify_scram_server_final(server_final, expected)?;
                            }
                        }
                        other => {
                            return Err(Error::AuthenticationFailed(format!(
                                "不支持的 PostgreSQL 认证方式: {other}"
                            )));
                        }
                    }
                }
                b'S' => {
                    if let Ok((key, value)) = parse_parameter_status(&body) {
                        if key == "server_version" {
                            self.server_version = Some(value);
                        }
                    }
                }
                b'K' => {
                    if body.len() >= 8 {
                        self.process_id = u32::from_be_bytes(body[0..4].try_into().unwrap());
                        self.secret_key = u32::from_be_bytes(body[4..8].try_into().unwrap());
                    }
                }
                b'E' => return Err(pg_error_from_body(&body)),
                b'N' => {}
                b'Z' => return Ok(()),
                _ => {}
            }
        }
    }

    pub fn server_version(&self) -> Option<&str> {
        self.server_version.as_deref()
    }

    pub fn cancel_token(&self) -> PgCancelToken {
        PgCancelToken {
            host: self.host.clone(),
            port: self.port,
            process_id: self.process_id,
            secret_key: self.secret_key,
        }
    }

    pub async fn query(&mut self, sql: &str) -> Result<PgQueryResult> {
        let mut payload = Vec::with_capacity(sql.len() + 1);
        payload.extend_from_slice(sql.as_bytes());
        payload.push(0);
        self.transport
            .write_all(&encode_message(b'Q', &payload))
            .await?;

        let mut current = PgQueryResult::default();
        let mut last = PgQueryResult::default();
        loop {
            let (kind, body) = self.read_message().await?;
            match kind {
                b'T' => {
                    current.fields = parse_row_description(&body)?;
                }
                b'D' => {
                    let row = parse_data_row(&body, &current.fields)?;
                    current.rows.push(row);
                }
                b'C' => {
                    current.command_tag = read_cstring(&body, 0)?.0;
                    current.affected_rows = affected_rows_from_tag(&current.command_tag);
                    last = current.clone();
                    current = PgQueryResult::default();
                }
                b'I' => {
                    last = PgQueryResult::default();
                    current = PgQueryResult::default();
                }
                b'E' => {
                    let error = pg_error_from_body(&body);
                    // ErrorResponse is followed by ReadyForQuery. Drain it so
                    // this connection remains usable for the next SQL command.
                    let _ = self.drain_until_ready().await;
                    return Err(error);
                }
                b'N' | b'A' => {}
                b'Z' => break,
                b'n' => {}
                b'1' | b'2' | b'3' | b'd' | b'c' => {}
                _ => {}
            }
        }
        Ok(last)
    }

    pub async fn execute_batch(&mut self, sql: &str) -> Result<usize> {
        let mut payload = Vec::with_capacity(sql.len() + 1);
        payload.extend_from_slice(sql.as_bytes());
        payload.push(0);
        self.transport
            .write_all(&encode_message(b'Q', &payload))
            .await?;
        let mut completed = 0usize;
        loop {
            let (kind, body) = self.read_message().await?;
            match kind {
                b'C' => completed += 1,
                b'E' => {
                    let error = pg_error_from_body(&body);
                    let _ = self.drain_until_ready().await;
                    return Err(error);
                }
                b'Z' => break,
                _ => {}
            }
        }
        Ok(completed)
    }

    async fn drain_until_ready(&mut self) -> Result<()> {
        loop {
            let (kind, _) = self.read_message().await?;
            if kind == b'Z' {
                return Ok(());
            }
        }
    }

    async fn send_password(&mut self, password: &str) -> Result<()> {
        let mut payload = Vec::with_capacity(password.len() + 1);
        payload.extend_from_slice(password.as_bytes());
        payload.push(0);
        self.transport
            .write_all(&encode_message(b'p', &payload))
            .await
    }

    async fn send_sasl_initial(&mut self, mechanism: &str, data: &[u8]) -> Result<()> {
        let mut payload = Vec::with_capacity(mechanism.len() + data.len() + 6);
        payload.extend_from_slice(mechanism.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&(data.len() as i32).to_be_bytes());
        payload.extend_from_slice(data);
        self.transport
            .write_all(&encode_message(b'p', &payload))
            .await
    }

    async fn send_sasl_response(&mut self, data: &[u8]) -> Result<()> {
        self.transport.write_all(&encode_message(b'p', data)).await
    }

    async fn read_message(&mut self) -> Result<(u8, Vec<u8>)> {
        let mut kind = [0_u8; 1];
        self.transport.read_exact(&mut kind).await?;
        let mut length = [0_u8; 4];
        self.transport.read_exact(&mut length).await?;
        let length = i32::from_be_bytes(length);
        if length < 4 || length as usize > MAX_PG_MESSAGE_BYTES {
            return Err(Error::ProtocolError(format!(
                "PostgreSQL 消息长度无效: {length}"
            )));
        }
        let mut body = vec![0_u8; length as usize - 4];
        if !body.is_empty() {
            self.transport.read_exact(&mut body).await?;
        }
        Ok((kind[0], body))
    }
}

/// PostgreSQL 系数据库连接句柄。PostgreSQL 与瀚高数据库共用该实现。
pub struct PgsqlConnectionHandle {
    id: Uuid,
    protocol_id: &'static str,
    client: tokio::sync::Mutex<PgClient>,
    remote_addr: (String, u16),
    connected_at: Instant,
    server_version: Option<String>,
}

impl PgsqlConnectionHandle {
    pub fn new(
        id: Uuid,
        protocol_id: &'static str,
        client: PgClient,
        remote_addr: (String, u16),
        server_version: Option<String>,
    ) -> Self {
        Self {
            id,
            protocol_id,
            client: tokio::sync::Mutex::new(client),
            remote_addr,
            connected_at: Instant::now(),
            server_version,
        }
    }
}

impl ConnectionHandle for PgsqlConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        self.protocol_id
    }

    fn is_connected(&self) -> bool {
        true
    }

    fn status(&self) -> crate::protocol::SessionStatus {
        crate::protocol::SessionStatus::Connected
    }

    fn remote_addr(&self) -> (&str, u16) {
        (&self.remote_addr.0, self.remote_addr.1)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// PostgreSQL 系数据库协议插件。瀚高数据库使用 PostgreSQL 有线协议，
/// 因此复用同一个客户端实现，仅协议标识与显示名称不同。
pub struct PgsqlPlugin {
    protocol_id: &'static str,
    display_name: &'static str,
}

impl PgsqlPlugin {
    pub fn new() -> Self {
        Self::postgresql()
    }

    pub fn postgresql() -> Self {
        Self {
            protocol_id: "postgresql",
            display_name: "PostgreSQL",
        }
    }

    pub fn highgo() -> Self {
        Self {
            protocol_id: "highgo",
            display_name: "HighGo 瀚高数据库",
        }
    }
}

impl Default for PgsqlPlugin {
    fn default() -> Self {
        Self::postgresql()
    }
}

#[async_trait]
impl ProtocolPlugin for PgsqlPlugin {
    fn protocol_id(&self) -> &'static str {
        self.protocol_id
    }

    fn display_name(&self) -> &'static str {
        self.display_name
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![ProtocolCapability::Query, ProtocolCapability::AIAnalysis]
    }

    fn default_port(&self) -> u16 {
        5432
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        username: &str,
        credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        let password = match &credential.credential_type {
            CredentialType::Password => credential.password.clone().unwrap_or_default(),
            _ => String::new(),
        };
        let database = options
            .protocol_options
            .get("database")
            .map(String::as_str)
            .unwrap_or(username);
        let ssl_mode = options
            .protocol_options
            .get("ssl_mode")
            .map(String::as_str)
            .unwrap_or("prefer");
        let timeout_ms = options.timeout_ms.unwrap_or(30_000).clamp(1_000, 300_000);
        let client = PgClient::connect(
            host,
            port,
            username,
            &password,
            database,
            ssl_mode,
            Duration::from_millis(timeout_ms),
        )
        .await?;
        let server_version = client.server_version().map(str::to_string);
        let id = Uuid::new_v4();
        Ok(Box::new(PgsqlConnectionHandle::new(
            id,
            self.protocol_id,
            client,
            (host.to_string(), port),
            server_version,
        )))
    }

    async fn health_check(&self, handle: &dyn ConnectionHandle) -> Result<bool> {
        let pgsql_handle = handle
            .as_any()
            .downcast_ref::<PgsqlConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 PostgreSQL 系数据库句柄".to_string()))?;
        let mut client = pgsql_handle.client.lock().await;
        match client.query("SELECT 1").await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    async fn get_metadata(&self, handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        let pgsql_handle = handle
            .as_any()
            .downcast_ref::<PgsqlConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 PostgreSQL 系数据库句柄".to_string()))?;

        Ok(ConnectionMetadata {
            session_id: pgsql_handle.id,
            protocol: pgsql_handle.protocol_id.to_string(),
            server_version: pgsql_handle.server_version.clone(),
            connection_time_ms: pgsql_handle.connected_at.elapsed().as_millis() as u64,
            keepalive_interval: None,
        })
    }
}

fn pg_ssl_request() -> [u8; 8] {
    let mut packet = [0_u8; 8];
    packet[0..4].copy_from_slice(&8_i32.to_be_bytes());
    packet[4..8].copy_from_slice(&PG_SSL_REQUEST_CODE.to_be_bytes());
    packet
}

fn pg_startup_message(username: &str, database: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&PG_PROTOCOL_VERSION.to_be_bytes());
    for (key, value) in [
        ("user", username),
        ("database", database),
        ("application_name", "PortNest"),
        ("client_encoding", "UTF8"),
    ] {
        body.extend_from_slice(key.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    let mut packet = Vec::with_capacity(body.len() + 4);
    packet.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    packet.extend_from_slice(&body);
    packet
}

fn encode_message(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(payload.len() + 5);
    packet.push(kind);
    packet.extend_from_slice(&((payload.len() + 4) as i32).to_be_bytes());
    packet.extend_from_slice(payload);
    packet
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32> {
    bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(i32::from_be_bytes)
        .ok_or_else(|| Error::ProtocolError("PostgreSQL 消息内容不完整".to_string()))
}

fn read_cstring(bytes: &[u8], offset: usize) -> Result<(String, usize)> {
    let rest = bytes
        .get(offset..)
        .ok_or_else(|| Error::ProtocolError("PostgreSQL 消息内容不完整".to_string()))?;
    let end = rest
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| Error::ProtocolError("PostgreSQL C 字符串未终止".to_string()))?;
    let value = std::str::from_utf8(&rest[..end])
        .map_err(|_| Error::ProtocolError("PostgreSQL 消息不是 UTF-8".to_string()))?
        .to_string();
    Ok((value, offset + end + 1))
}

fn parse_cstring_list(bytes: &[u8]) -> Result<Vec<String>> {
    let mut items = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let (item, next) = read_cstring(bytes, offset)?;
        if item.is_empty() {
            break;
        }
        items.push(item);
        offset = next;
    }
    Ok(items)
}

fn parse_parameter_status(body: &[u8]) -> Result<(String, String)> {
    let (key, offset) = read_cstring(body, 0)?;
    let (value, _) = read_cstring(body, offset)?;
    Ok((key, value))
}

fn pg_error_from_body(body: &[u8]) -> Error {
    let mut message = String::new();
    let mut code = String::new();
    let mut offset = 0usize;
    while offset < body.len() {
        let field = body[offset];
        if field == 0 || offset + 1 >= body.len() {
            break;
        }
        let (value, next) = match read_cstring(body, offset + 1) {
            Ok(value) => value,
            Err(_) => break,
        };
        match field {
            b'M' => message = value,
            b'C' => code = value,
            _ => {}
        }
        offset = next;
    }
    if message.is_empty() {
        message = "PostgreSQL 返回未知错误".to_string();
    }
    if code.is_empty() {
        Error::DatabaseError(message)
    } else {
        Error::DatabaseError(format!("{message} (SQLSTATE {code})"))
    }
}

fn parse_row_description(body: &[u8]) -> Result<Vec<PgField>> {
    let count = body
        .get(0..2)
        .and_then(|slice| slice.try_into().ok())
        .map(i16::from_be_bytes)
        .ok_or_else(|| Error::ProtocolError("PostgreSQL RowDescription 不完整".to_string()))?;
    if count < 0 {
        return Err(Error::ProtocolError("PostgreSQL 列数无效".to_string()));
    }
    let mut fields = Vec::with_capacity(count as usize);
    let mut offset = 2usize;
    for _ in 0..count {
        let (name, next) = read_cstring(body, offset)?;
        offset = next;
        let type_oid = body
            .get(offset + 6..offset + 10)
            .and_then(|slice| slice.try_into().ok())
            .map(u32::from_be_bytes)
            .ok_or_else(|| Error::ProtocolError("PostgreSQL 列类型信息不完整".to_string()))?;
        offset += 18;
        fields.push(PgField {
            name,
            type_oid,
            type_name: pg_type_name(type_oid).to_string(),
        });
    }
    Ok(fields)
}

fn parse_data_row(body: &[u8], fields: &[PgField]) -> Result<Vec<serde_json::Value>> {
    let count = body
        .get(0..2)
        .and_then(|slice| slice.try_into().ok())
        .map(i16::from_be_bytes)
        .ok_or_else(|| Error::ProtocolError("PostgreSQL DataRow 不完整".to_string()))?;
    let mut offset = 2usize;
    let mut values = Vec::with_capacity(count.max(0) as usize);
    for index in 0..count.max(0) as usize {
        let length = body
            .get(offset..offset + 4)
            .and_then(|slice| slice.try_into().ok())
            .map(i32::from_be_bytes)
            .ok_or_else(|| Error::ProtocolError("PostgreSQL 字段长度缺失".to_string()))?;
        offset += 4;
        if length < 0 {
            values.push(serde_json::Value::Null);
            continue;
        }
        let raw = body
            .get(offset..offset + length as usize)
            .ok_or_else(|| Error::ProtocolError("PostgreSQL 字段内容不完整".to_string()))?;
        offset += length as usize;
        values.push(decode_pg_value(
            fields.get(index).map(|field| field.type_oid),
            raw,
        ));
    }
    Ok(values)
}

fn decode_pg_value(type_oid: Option<u32>, raw: &[u8]) -> serde_json::Value {
    let text = match std::str::from_utf8(raw) {
        Ok(text) => text,
        Err(_) => {
            return serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(raw))
        }
    };
    match type_oid {
        Some(16) => match text {
            "t" | "true" => serde_json::Value::Bool(true),
            "f" | "false" => serde_json::Value::Bool(false),
            _ => serde_json::Value::String(text.to_string()),
        },
        Some(20) | Some(21) | Some(23) | Some(26) | Some(27) | Some(28) => text
            .parse::<i64>()
            .map(serde_json::Value::from)
            .unwrap_or_else(|_| serde_json::Value::String(text.to_string())),
        Some(700) | Some(701) | Some(1700) => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(serde_json::Value::Number)
            .unwrap_or_else(|| serde_json::Value::String(text.to_string())),
        Some(114) | Some(3802) => serde_json::from_str(text)
            .unwrap_or_else(|_| serde_json::Value::String(text.to_string())),
        _ => serde_json::Value::String(text.to_string()),
    }
}

fn affected_rows_from_tag(tag: &str) -> u64 {
    let upper = tag.to_ascii_uppercase();
    if upper.starts_with("SELECT") || upper.starts_with("SHOW") || upper.starts_with("EXPLAIN") {
        return 0;
    }
    tag.split_whitespace()
        .last()
        .and_then(|part| part.parse::<u64>().ok())
        .unwrap_or(0)
}

fn pg_md5_password(password: &str, username: &str, salt: &[u8]) -> String {
    let inner = format!("{:x}", md5::compute(format!("{password}{username}")));
    let mut outer_input = Vec::with_capacity(inner.len() + salt.len());
    outer_input.extend_from_slice(inner.as_bytes());
    outer_input.extend_from_slice(salt);
    format!("md5{:x}", md5::compute(outer_input))
}

fn scram_client_first() -> (String, ScramState) {
    let mut nonce_bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = base64::engine::general_purpose::STANDARD.encode(nonce_bytes);
    let client_first_bare = format!("n=,r={nonce}");
    let message = format!("n,,{client_first_bare}");
    (
        message,
        ScramState {
            client_first_bare,
            nonce,
            expected_server_signature: None,
        },
    )
}

fn scram_client_final(
    password: &str,
    state: &ScramState,
    server_first: &str,
) -> Result<(String, Vec<u8>)> {
    let mut nonce = None;
    let mut salt = None;
    let mut iterations = None;
    for part in server_first.split(',') {
        if let Some(value) = part.strip_prefix("r=") {
            nonce = Some(value.to_string());
        } else if let Some(value) = part.strip_prefix("s=") {
            salt = Some(
                base64::engine::general_purpose::STANDARD
                    .decode(value)
                    .map_err(|_| {
                        Error::AuthenticationFailed("PostgreSQL SCRAM salt 无效".to_string())
                    })?,
            );
        } else if let Some(value) = part.strip_prefix("i=") {
            iterations = value.parse::<u32>().ok();
        }
    }
    let nonce = nonce
        .ok_or_else(|| Error::AuthenticationFailed("PostgreSQL SCRAM 缺少 nonce".to_string()))?;
    let salt =
        salt.ok_or_else(|| Error::AuthenticationFailed("PostgreSQL SCRAM 缺少 salt".to_string()))?;
    let iterations = iterations
        .ok_or_else(|| Error::AuthenticationFailed("PostgreSQL SCRAM 缺少迭代次数".to_string()))?;
    if !nonce.starts_with(&state.nonce) {
        return Err(Error::AuthenticationFailed(
            "PostgreSQL SCRAM nonce 校验失败".to_string(),
        ));
    }

    let mut salted_password = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut salted_password);
    let client_key = hmac_sha256(&salted_password, b"Client Key")?;
    let stored_key = Sha256::digest(&client_key);
    let client_final_without_proof = format!("c=biws,r={nonce}");
    let auth_message = format!(
        "{},{},{}",
        state.client_first_bare, server_first, client_final_without_proof
    );
    let client_signature = hmac_sha256(&stored_key, auth_message.as_bytes())?;
    let proof: Vec<u8> = client_key
        .iter()
        .zip(client_signature.iter())
        .map(|(left, right)| left ^ right)
        .collect();
    let server_key = hmac_sha256(&salted_password, b"Server Key")?;
    let server_signature = hmac_sha256(&server_key, auth_message.as_bytes())?;
    let client_final = format!(
        "{client_final_without_proof},p={}",
        base64::engine::general_purpose::STANDARD.encode(proof)
    );
    Ok((client_final, server_signature))
}

fn verify_scram_server_final(server_final: &str, expected: &[u8]) -> Result<()> {
    for part in server_final.split(',') {
        if let Some(error) = part.strip_prefix("e=") {
            return Err(Error::AuthenticationFailed(format!(
                "PostgreSQL SCRAM 认证失败: {error}"
            )));
        }
        if let Some(value) = part.strip_prefix("v=") {
            let actual = base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(|_| {
                    Error::AuthenticationFailed("PostgreSQL SCRAM 服务端签名无效".to_string())
                })?;
            if actual != expected {
                return Err(Error::AuthenticationFailed(
                    "PostgreSQL SCRAM 服务端签名校验失败".to_string(),
                ));
            }
        }
    }
    Ok(())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| Error::AuthenticationFailed("PostgreSQL HMAC 密钥无效".to_string()))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn pg_type_name(oid: u32) -> &'static str {
    match oid {
        16 => "bool",
        17 => "bytea",
        18 => "char",
        19 => "name",
        20 => "int8",
        21 => "int2",
        23 => "int4",
        25 => "text",
        26 => "oid",
        114 => "json",
        142 => "xml",
        700 => "float4",
        701 => "float8",
        1042 => "bpchar",
        1043 => "varchar",
        1082 => "date",
        1083 => "time",
        1114 => "timestamp",
        1184 => "timestamptz",
        1186 => "interval",
        1266 => "timetz",
        1700 => "numeric",
        2950 => "uuid",
        3802 => "jsonb",
        1000 => "_bool",
        1005 => "_int2",
        1007 => "_int4",
        1015 => "_varchar",
        1016 => "_int8",
        1021 => "_float4",
        1022 => "_float8",
        1231 => "_numeric",
        3807 => "_jsonb",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_message(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&((payload.len() + 4) as i32).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    async fn read_server_message(stream: &mut TcpStream) -> (u8, Vec<u8>) {
        let mut kind = [0_u8; 1];
        stream.read_exact(&mut kind).await.unwrap();
        let mut length = [0_u8; 4];
        stream.read_exact(&mut length).await.unwrap();
        let length = i32::from_be_bytes(length) as usize;
        let mut body = vec![0_u8; length - 4];
        stream.read_exact(&mut body).await.unwrap();
        (kind[0], body)
    }

    #[tokio::test]
    async fn pg_client_cleartext_auth_and_simple_query() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut startup_length = [0_u8; 4];
            stream.read_exact(&mut startup_length).await.unwrap();
            let startup_size = i32::from_be_bytes(startup_length) as usize;
            let mut startup = vec![0_u8; startup_size - 4];
            stream.read_exact(&mut startup).await.unwrap();

            stream
                .write_all(&server_message(b'R', &3_i32.to_be_bytes()))
                .await
                .unwrap();
            let (kind, body) = read_server_message(&mut stream).await;
            assert_eq!(kind, b'p');
            assert_eq!(read_cstring(&body, 0).unwrap().0, "secret");

            stream
                .write_all(&server_message(b'R', &0_i32.to_be_bytes()))
                .await
                .unwrap();
            let mut parameter = Vec::new();
            parameter.extend_from_slice(b"server_version\0");
            parameter.extend_from_slice(b"16.0\0");
            stream
                .write_all(&server_message(b'S', &parameter))
                .await
                .unwrap();
            let mut backend_key = Vec::new();
            backend_key.extend_from_slice(&42_u32.to_be_bytes());
            backend_key.extend_from_slice(&99_u32.to_be_bytes());
            stream
                .write_all(&server_message(b'K', &backend_key))
                .await
                .unwrap();
            stream.write_all(&server_message(b'Z', b"I")).await.unwrap();

            let (kind, body) = read_server_message(&mut stream).await;
            assert_eq!(kind, b'Q');
            assert_eq!(read_cstring(&body, 0).unwrap().0, "SELECT 1");

            let mut row_description = Vec::new();
            row_description.extend_from_slice(&1_i16.to_be_bytes());
            row_description.extend_from_slice(b"?column?\0");
            row_description.extend_from_slice(&0_i32.to_be_bytes());
            row_description.extend_from_slice(&0_i16.to_be_bytes());
            row_description.extend_from_slice(&23_u32.to_be_bytes());
            row_description.extend_from_slice(&4_i16.to_be_bytes());
            row_description.extend_from_slice(&(-1_i32).to_be_bytes());
            row_description.extend_from_slice(&0_i16.to_be_bytes());
            stream
                .write_all(&server_message(b'T', &row_description))
                .await
                .unwrap();
            let mut data_row = Vec::new();
            data_row.extend_from_slice(&1_i16.to_be_bytes());
            data_row.extend_from_slice(&1_i32.to_be_bytes());
            data_row.push(b'1');
            stream
                .write_all(&server_message(b'D', &data_row))
                .await
                .unwrap();
            stream
                .write_all(&server_message(b'C', b"SELECT 1\0"))
                .await
                .unwrap();
            stream.write_all(&server_message(b'Z', b"I")).await.unwrap();
        });

        let mut client = PgClient::connect(
            "127.0.0.1",
            port,
            "tester",
            "secret",
            "postgres",
            "disabled",
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let result = client.query("SELECT 1").await.unwrap();
        assert_eq!(result.rows, vec![vec![serde_json::json!(1)]]);
        assert_eq!(client.server_version(), Some("16.0"));
        server.await.unwrap();
    }
}
