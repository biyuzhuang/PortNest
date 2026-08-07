//! Tauri 命令接口

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::ai::{AIAnalyzer, AnalyzeRequest, ConnectionInfo};
use crate::connection::ConnectionManager;
use crate::protocol::docker::{
    ContainerInfo, ContainerStats, DockerContainerCreateConfig, DockerSystemInfo, ImageInfo,
    NetworkInfo, VolumeInfo,
};
use crate::protocol::ssh_backend::{
    CancellationToken, ConnectionTarget, SftpHandle, ShellHandle, Ssh2Backend, SshBackend,
    SshSession, TerminalSize,
};
use crate::protocol::terminal_codec::{normalize_encoding, TerminalCodec};
use crate::protocol::tunnel::{TunnelManager, TunnelRule, TunnelRuntimeInfo};
use crate::protocol::PluginRegistry;
use crate::protocol::{ConnectionHandle, Credential, CredentialType};
use crate::storage::{ConnectionRecord, CredentialData, Database, SshKeyRecord};
use tauri::Emitter;
use tauri_plugin_clipboard_manager::ClipboardExt;

fn parse_connection_options(
    raw: Option<&str>,
) -> Result<crate::protocol::ConnectionOptions, String> {
    match raw {
        Some(value) if !value.trim().is_empty() => {
            serde_json::from_str(value).map_err(|e| format!("连接高级选项无效: {}", e))
        }
        _ => Ok(crate::protocol::ConnectionOptions::default()),
    }
}

/// Shell 会话信息
struct ShellSessionInfo {
    _connection_id: String,
    /// 本地终端（local 协议）没有 SSH 会话；SFTP 等能力依赖该字段，为空时拒绝
    session: Option<Arc<dyn SshSession>>,
    shell: Arc<dyn ShellHandle>,
    codec: Arc<Mutex<TerminalCodec>>,
}

/// Shell 会话管理器
pub(crate) struct ShellManager {
    sessions: RwLock<HashMap<String, ShellSessionInfo>>,
}

impl ShellManager {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    fn insert(
        &self,
        shell_id: String,
        connection_id: String,
        session: Option<Arc<dyn SshSession>>,
        shell: Arc<dyn ShellHandle>,
        encoding: &str,
    ) -> crate::Result<()> {
        let codec = Arc::new(Mutex::new(TerminalCodec::new(encoding)?));
        self.sessions.write().insert(
            shell_id,
            ShellSessionInfo {
                _connection_id: connection_id,
                session,
                shell,
                codec,
            },
        );
        Ok(())
    }

    fn get(&self, shell_id: &str) -> Option<(Option<Arc<dyn SshSession>>, Arc<dyn ShellHandle>)> {
        self.sessions
            .read()
            .get(shell_id)
            .map(|entry| (entry.session.clone(), entry.shell.clone()))
    }

    fn remove(&self, shell_id: &str) {
        self.sessions.write().remove(shell_id);
    }

    fn codec(&self, shell_id: &str) -> Option<Arc<Mutex<TerminalCodec>>> {
        self.sessions
            .read()
            .get(shell_id)
            .map(|entry| entry.codec.clone())
    }
}

/// SFTP 会话信息
struct SftpSessionInfo {
    _connection_id: String,
    handle: Arc<dyn SftpHandle>,
    session: Arc<dyn SshSession>,
    /// 是否为独立建立的 SSH 会话（`open_sftp` 创建）。关闭时需要主动断开传输；
    /// 复用 Shell 会话（`open_sftp_for_shell`）创建的不能断开，否则会连带终端。
    owns_session: bool,
}

/// SFTP 会话管理器
pub(crate) struct SftpManager {
    sessions: RwLock<HashMap<String, SftpSessionInfo>>,
    transfers: parking_lot::Mutex<HashMap<String, CancellationToken>>,
}

impl SftpManager {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            transfers: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    fn insert(
        &self,
        sftp_id: String,
        connection_id: String,
        handle: Arc<dyn SftpHandle>,
        session: Arc<dyn SshSession>,
        owns_session: bool,
    ) {
        self.sessions.write().insert(
            sftp_id,
            SftpSessionInfo {
                _connection_id: connection_id,
                handle,
                session,
                owns_session,
            },
        );
    }

    fn get(&self, sftp_id: &str) -> Option<Arc<dyn SftpHandle>> {
        self.sessions.read().get(sftp_id).map(|s| s.handle.clone())
    }

    fn get_session(&self, sftp_id: &str) -> Option<Arc<dyn SshSession>> {
        self.sessions.read().get(sftp_id).map(|s| s.session.clone())
    }

    fn owns_session(&self, sftp_id: &str) -> bool {
        self.sessions
            .read()
            .get(sftp_id)
            .map(|s| s.owns_session)
            .unwrap_or(false)
    }

    fn remove(&self, sftp_id: &str) {
        self.sessions.write().remove(sftp_id);
    }

    fn register_transfer(&self, transfer_id: String, token: CancellationToken) {
        self.transfers.lock().insert(transfer_id, token);
    }

    fn cancel_transfer(&self, transfer_id: &str) -> bool {
        if let Some(token) = self.transfers.lock().get(transfer_id).cloned() {
            token.cancel();
            true
        } else {
            false
        }
    }

    fn remove_transfer(&self, transfer_id: &str) {
        self.transfers.lock().remove(transfer_id);
    }
}

/// Docker 会话信息
struct DockerSessionInfo {
    _connection_id: String,
    handle: Arc<crate::protocol::docker::DockerConnectionHandle>,
}

/// Docker 会话管理器
pub(crate) struct DockerManager {
    sessions: RwLock<HashMap<String, DockerSessionInfo>>,
}

impl DockerManager {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    fn insert(
        &self,
        connection_id: String,
        handle: Arc<crate::protocol::docker::DockerConnectionHandle>,
    ) {
        self.sessions.write().insert(
            connection_id.clone(),
            DockerSessionInfo {
                _connection_id: connection_id,
                handle,
            },
        );
    }

    fn get(
        &self,
        connection_id: &str,
    ) -> Option<Arc<crate::protocol::docker::DockerConnectionHandle>> {
        self.sessions
            .read()
            .get(connection_id)
            .map(|s| s.handle.clone())
    }

    fn remove(&self, connection_id: &str) {
        self.sessions.write().remove(connection_id);
    }
}

/// 应用状态
pub struct AppState {
    pub db: Database,
    pub connection_manager: Arc<ConnectionManager>,
    pub plugin_registry: Arc<PluginRegistry>,
    pub ai_analyzer: AIAnalyzer,
    ssh2_backend: Arc<dyn SshBackend>,
    russh_backend: Arc<dyn SshBackend>,
    pub(crate) shell_manager: Arc<ShellManager>,
    pub(crate) sftp_manager: Arc<SftpManager>,
    pub(crate) tunnel_manager: Arc<TunnelManager>,
    pub(crate) docker_manager: Arc<DockerManager>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

impl AppState {
    pub fn new(app_dir: std::path::PathBuf) -> crate::Result<Self> {
        let db = Database::new(app_dir)?;
        let plugin_registry = Arc::new(PluginRegistry::default());
        let connection_manager = Arc::new(ConnectionManager::new(plugin_registry.clone()));

        Self::register_plugins(&plugin_registry);

        Ok(Self {
            db,
            connection_manager,
            plugin_registry,
            ai_analyzer: AIAnalyzer::default(),
            ssh2_backend: Arc::new(Ssh2Backend),
            russh_backend: Arc::new(crate::protocol::russh_backend::RusshBackend),
            shell_manager: Arc::new(ShellManager::new()),
            sftp_manager: Arc::new(SftpManager::new()),
            tunnel_manager: Arc::new(TunnelManager::new()),
            docker_manager: Arc::new(DockerManager::new()),
        })
    }

    fn ssh_backend(&self, options: &crate::protocol::ConnectionOptions) -> Arc<dyn SshBackend> {
        match options
            .protocol_options
            .get("ssh_backend")
            .map(String::as_str)
        {
            Some("ssh2") => self.ssh2_backend.clone(),
            Some("russh") => self.russh_backend.clone(),
            _ => self.russh_backend.clone(),
        }
    }

    fn register_plugins(registry: &Arc<PluginRegistry>) {
        registry.register(crate::protocol::ssh::SshPlugin::new());
        registry.register(crate::protocol::sftp::SftpPlugin::new());
        registry.register(crate::protocol::rdp::RdpPlugin::new());
        registry.register(crate::protocol::mysql::MysqlPlugin::new());
        registry.register(crate::protocol::pgsql::PgsqlPlugin::new());
        registry.register(crate::protocol::docker::DockerPlugin::new());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfigRequest {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub key_id: Option<String>,
    pub options: Option<String>,
    pub tags: Option<String>,
    pub color: Option<String>,
    pub folder_id: Option<String>,
    pub proxy_type: Option<String>,
    pub proxy_host: Option<String>,
    pub proxy_port: Option<u16>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
    pub encoding: Option<String>,
    pub timeout_ms: Option<u64>,
    /// 本地终端配置：终端类型 / 工作路径 / 自定义命令
    pub shell_type: Option<String>,
    pub cwd: Option<String>,
    pub custom_command: Option<String>,
    #[serde(default)]
    pub tunnel_rules: Vec<TunnelRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionResponse {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub status: String,
}

#[tauri::command]
pub async fn save_connection(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfigRequest,
) -> Result<ConnectionResponse, String> {
    // Use provided ID if editing, otherwise generate new
    let id = Uuid::parse_str(&config.id).unwrap_or_else(|_| Uuid::new_v4());
    let existing_connection = state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|connection| connection.id == id.to_string());
    let credential_id = existing_connection
        .as_ref()
        .and_then(|connection| Uuid::parse_str(&connection.credential_id).ok())
        .unwrap_or_else(Uuid::new_v4);

    let auth_type = config.auth_type.as_str();

    // 使用结构化 JSON 格式存储凭证
    let previous_credential = existing_connection.as_ref().and_then(|connection| {
        state
            .db
            .get_credential_structured(&connection.credential_id)
            .ok()
    });
    let managed_private_key = match config.key_id.as_deref() {
        Some(key_id) => Some(
            state
                .db
                .get_ssh_key_material(key_id)
                .map_err(|e| e.to_string())?,
        ),
        None => None,
    };
    let cred_data = match auth_type {
        "password" => CredentialData {
            auth_type: auth_type.to_string(),
            password: config
                .password
                .clone()
                .or_else(|| previous_credential.as_ref()?.password.clone()),
            private_key: None,
            passphrase: None,
            key_id: None,
        },
        "key" | "key_with_passphrase" => CredentialData {
            auth_type: auth_type.to_string(),
            password: None,
            private_key: managed_private_key.or_else(|| {
                config
                    .private_key
                    .clone()
                    .or_else(|| previous_credential.as_ref()?.private_key.clone())
            }),
            passphrase: config
                .passphrase
                .clone()
                .or_else(|| previous_credential.as_ref()?.passphrase.clone()),
            key_id: config
                .key_id
                .clone()
                .or_else(|| previous_credential.as_ref()?.key_id.clone()),
        },
        _ => CredentialData {
            auth_type: auth_type.to_string(),
            password: None,
            private_key: None,
            passphrase: None,
            key_id: None,
        },
    };

    state
        .db
        .save_credential_structured(credential_id, &config.name, auth_type, &cred_data)
        .map_err(|e| e.to_string())?;

    // Build options JSON with proxy and encoding settings
    let mut options_map = serde_json::Map::new();
    if let (Some(proxy_type), Some(proxy_host), Some(proxy_port)) =
        (&config.proxy_type, &config.proxy_host, &config.proxy_port)
    {
        let mut proxy_map = serde_json::Map::new();
        proxy_map.insert(
            "type".to_string(),
            serde_json::Value::String(proxy_type.clone()),
        );
        proxy_map.insert(
            "host".to_string(),
            serde_json::Value::String(proxy_host.clone()),
        );
        proxy_map.insert(
            "port".to_string(),
            serde_json::Value::Number((*proxy_port).into()),
        );
        if let Some(username) = &config.proxy_username {
            proxy_map.insert(
                "username".to_string(),
                serde_json::Value::String(username.clone()),
            );
        }
        if let Some(password) = &config.proxy_password {
            proxy_map.insert(
                "password".to_string(),
                serde_json::Value::String(password.clone()),
            );
        }
        options_map.insert("proxy".to_string(), serde_json::Value::Object(proxy_map));
    }
    if let Some(encoding) = &config.encoding {
        options_map.insert(
            "encoding".to_string(),
            serde_json::Value::String(encoding.clone()),
        );
    }
    if let Some(timeout_ms) = config.timeout_ms {
        options_map.insert(
            "timeout_ms".to_string(),
            serde_json::Value::Number(timeout_ms.into()),
        );
    }
    if config.protocol == "local" {
        if let Some(shell_type) = &config.shell_type {
            options_map.insert(
                "shell_type".to_string(),
                serde_json::Value::String(shell_type.clone()),
            );
        }
        if let Some(cwd) = &config.cwd {
            options_map.insert("cwd".to_string(), serde_json::Value::String(cwd.clone()));
        }
        if let Some(custom_command) = &config.custom_command {
            options_map.insert(
                "custom_command".to_string(),
                serde_json::Value::String(custom_command.clone()),
            );
        }
    }
    if !config.tunnel_rules.is_empty() {
        options_map.insert(
            "tunnel_rules".to_string(),
            serde_json::to_value(&config.tunnel_rules).map_err(|error| error.to_string())?,
        );
    }
    let options_json = if options_map.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&options_map).unwrap_or_default())
    };

    state
        .db
        .save_connection(
            id,
            &config.name,
            &config.protocol,
            &config.host,
            config.port,
            Some(&config.username),
            credential_id,
            options_json.as_deref(),
            config.tags.as_deref(),
            config.color.as_deref(),
            config.folder_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;

    Ok(ConnectionResponse {
        id: id.to_string(),
        name: config.name,
        protocol: config.protocol,
        status: "saved".to_string(),
    })
}

#[tauri::command]
pub async fn get_connections(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConnectionRecord>, String> {
    state.db.get_connections().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_connection_config(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<ConnectionConfigRequest, String> {
    let connection = state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| "连接不存在".to_string())?;
    let credential = state
        .db
        .get_credential_structured(&connection.credential_id)
        .map_err(|e| e.to_string())?;

    let mut proxy_type = None;
    let mut proxy_host = None;
    let mut proxy_port = None;
    let mut proxy_username = None;
    let mut proxy_password = None;
    let mut encoding = None;
    let mut timeout_ms = None;
    let mut tunnel_rules = Vec::new();
    let mut shell_type = None;
    let mut cwd = None;
    let mut custom_command = None;

    if let Some(options) = connection.options.as_deref() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(options) {
            encoding = value
                .get("encoding")
                .and_then(|item| item.as_str())
                .map(str::to_string);
            timeout_ms = value.get("timeout_ms").and_then(|item| item.as_u64());
            shell_type = value
                .get("shell_type")
                .and_then(|item| item.as_str())
                .map(str::to_string);
            cwd = value
                .get("cwd")
                .and_then(|item| item.as_str())
                .map(str::to_string);
            custom_command = value
                .get("custom_command")
                .and_then(|item| item.as_str())
                .map(str::to_string);
            tunnel_rules = value
                .get("tunnel_rules")
                .cloned()
                .and_then(|item| serde_json::from_value(item).ok())
                .unwrap_or_default();
            if let Some(proxy) = value.get("proxy") {
                proxy_type = proxy
                    .get("type")
                    .and_then(|item| item.as_str())
                    .map(str::to_string);
                proxy_host = proxy
                    .get("host")
                    .and_then(|item| item.as_str())
                    .map(str::to_string);
                proxy_port = proxy
                    .get("port")
                    .and_then(|item| item.as_u64())
                    .and_then(|port| u16::try_from(port).ok());
                proxy_username = proxy
                    .get("username")
                    .and_then(|item| item.as_str())
                    .map(str::to_string);
                proxy_password = proxy
                    .get("password")
                    .and_then(|item| item.as_str())
                    .map(str::to_string);
            }
        }
    }

    Ok(ConnectionConfigRequest {
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        host: connection.host,
        port: connection.port,
        username: connection.username.unwrap_or_else(|| "root".to_string()),
        auth_type: match credential.auth_type.as_str() {
            "key_with_passphrase" => "key".to_string(),
            value => value.to_string(),
        },
        password: credential.password,
        private_key: credential.private_key,
        passphrase: credential.passphrase,
        key_id: credential.key_id,
        options: connection.options,
        tags: connection.tags,
        color: connection.color,
        folder_id: connection.folder_id,
        proxy_type,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password,
        encoding,
        timeout_ms,
        shell_type,
        cwd,
        custom_command,
        tunnel_rules,
    })
}

#[tauri::command]
pub async fn delete_connection(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.delete_connection(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn analyze_connection(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<crate::ai::AnalyzeResult, String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;

    let request = AnalyzeRequest {
        session_id: connection_id,
        command_history: vec![],
        connection_metadata: ConnectionInfo {
            protocol: conn.protocol.clone(),
            host: conn.host.clone(),
            port: conn.port,
            connection_time_ms: 0,
        },
    };

    state
        .ai_analyzer
        .analyze(request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_protocols(state: tauri::State<'_, AppState>) -> Vec<ProtocolInfoResponse> {
    let mut protocols: Vec<ProtocolInfoResponse> = state
        .plugin_registry
        .list_protocols()
        .into_iter()
        .map(|(id, name)| ProtocolInfoResponse {
            id: id.to_string(),
            name: name.to_string(),
        })
        .collect();
    if !protocols.iter().any(|protocol| protocol.id == "local") {
        protocols.push(ProtocolInfoResponse {
            id: "local".to_string(),
            name: "本地终端".to_string(),
        });
    }
    protocols
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolInfoResponse {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellOpenResponse {
    pub shell_id: String,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PingResult {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
}

#[tauri::command]
pub async fn ping_host(host: String, port: u16) -> Result<PingResult, String> {
    let address = format!("{}:{}", host, port);
    let started = std::time::Instant::now();
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(&address),
    )
    .await
    {
        Ok(Ok(stream)) => {
            drop(stream);
            Ok(PingResult {
                reachable: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
            })
        }
        Ok(Err(_)) | Err(_) => Ok(PingResult {
            reachable: false,
            latency_ms: None,
        }),
    }
}

#[tauri::command]
pub async fn open_shell(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    cols: u32,
    rows: u32,
) -> Result<ShellOpenResponse, String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;

    if conn.protocol == "local" {
        let options_value = conn
            .options
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .unwrap_or_default();
        let shell_type = options_value
            .get("shell_type")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let cwd = options_value
            .get("cwd")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let custom_command = options_value
            .get("custom_command")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let encoding = options_value
            .get("encoding")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let response = spawn_local_shell(
            state.inner(),
            shell_type,
            cwd,
            custom_command,
            encoding,
            connection_id.clone(),
            cols,
            rows,
        )
        .await?;
        if let Err(error) = state.db.mark_connection_used(&connection_id) {
            tracing::warn!("更新最近连接时间失败: {error}");
        }
        return Ok(response);
    }

    if conn.protocol != "ssh" {
        return Err("此命令仅支持 SSH 或本地终端连接".to_string());
    }

    // 使用结构化方式获取凭证
    let cred_data = state
        .db
        .get_credential_structured(&conn.credential_id)
        .map_err(|e| e.to_string())?;

    let (credential_type, password, private_key, passphrase) = match cred_data.auth_type.as_str() {
        "password" => (CredentialType::Password, cred_data.password, None, None),
        "key" => (
            CredentialType::PrivateKey,
            None,
            cred_data.private_key,
            None,
        ),
        "key_with_passphrase" => (
            CredentialType::PrivateKeyWithPassphrase,
            None,
            cred_data.private_key,
            cred_data.passphrase,
        ),
        "agent" => (CredentialType::Agent, None, None, None),
        _ => return Err("不支持的认证类型".to_string()),
    };

    let credential = Credential {
        credential_type,
        password,
        private_key,
        passphrase,
    };

    let options = parse_connection_options(conn.options.as_deref())?;

    let target = ConnectionTarget {
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone().unwrap_or_default(),
    };
    let session = state
        .ssh_backend(&options)
        .connect(&target, &credential, &options)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!("SSH connection established to {}:{}", conn.host, conn.port);

    tracing::info!("Opening shell with cols={}, rows={}", cols, rows);
    let size = TerminalSize::new(cols, rows).map_err(|error| error.to_string())?;
    let shell = session.open_shell(size).await.map_err(|e| e.to_string())?;
    tracing::info!("Shell opened successfully: id={}", shell.id());
    let shell_id = shell.id().to_string();

    let encoding = normalize_encoding(options.encoding.as_deref().unwrap_or("UTF-8"))
        .map_err(|error| error.to_string())?;
    state
        .shell_manager
        .insert(
            shell_id.clone(),
            connection_id.clone(),
            Some(session),
            shell,
            &encoding,
        )
        .map_err(|error| error.to_string())?;
    if let Err(error) = state.db.mark_connection_used(&connection_id) {
        tracing::warn!("更新最近连接时间失败: {error}");
    }

    let auto_rules: Vec<TunnelRule> = conn
        .options
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|value| value.get("tunnel_rules").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    for rule in auto_rules
        .into_iter()
        .filter(|rule: &TunnelRule| rule.enabled && rule.auto_start)
    {
        let manager = state.tunnel_manager.clone();
        let backend = state.russh_backend.clone();
        let target = target.clone();
        let credential = credential.clone();
        let options = options.clone();
        let connection_id = connection_id.clone();
        tokio::spawn(async move {
            if let Err(error) = manager
                .start(connection_id, rule, backend, target, credential, options)
                .await
            {
                tracing::warn!("自动启动 SSH 隧道失败: {error}");
            }
        });
    }

    Ok(ShellOpenResponse { shell_id, encoding })
}

/// 启动本地终端并注册到 ShellManager（`open_shell` 与 `open_local_shell` 共用）
async fn spawn_local_shell(
    state: &AppState,
    shell_type: Option<String>,
    cwd: Option<String>,
    custom_command: Option<String>,
    encoding: Option<String>,
    connection_id: String,
    cols: u32,
    rows: u32,
) -> Result<ShellOpenResponse, String> {
    let shell_type = shell_type.unwrap_or_else(|| "powershell".to_string());
    let profile = crate::protocol::local::resolve_profile(
        &shell_type,
        cwd.as_deref(),
        custom_command.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let size = TerminalSize::new(cols, rows).map_err(|error| error.to_string())?;
    let encoding_label = match encoding.as_deref() {
        Some("auto") | None => crate::protocol::local::default_encoding(&shell_type),
        Some(label) => normalize_encoding(label).map_err(|error| error.to_string())?,
    };
    let handle = crate::protocol::local::spawn_local_shell(&profile, size)
        .map_err(|error| error.to_string())?;
    let shell_id = handle.id().to_string();
    state
        .shell_manager
        .insert(
            shell_id.clone(),
            connection_id,
            None,
            Arc::new(handle),
            &encoding_label,
        )
        .map_err(|error| error.to_string())?;
    tracing::info!(
        "本地终端已启动: {} (cwd: {})",
        profile.display_name,
        profile.cwd.display()
    );
    Ok(ShellOpenResponse {
        shell_id,
        encoding: encoding_label,
    })
}

/// 打开本地终端（快捷入口，无需已保存的连接记录）
#[tauri::command]
pub async fn open_local_shell(
    state: tauri::State<'_, AppState>,
    cols: u32,
    rows: u32,
    shell_type: Option<String>,
    cwd: Option<String>,
    custom_command: Option<String>,
    encoding: Option<String>,
) -> Result<ShellOpenResponse, String> {
    spawn_local_shell(
        state.inner(),
        shell_type,
        cwd,
        custom_command,
        encoding,
        "local-quick".to_string(),
        cols,
        rows,
    )
    .await
}

#[tauri::command]
pub async fn start_tunnel(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    rule_id: String,
) -> Result<TunnelRuntimeInfo, String> {
    let connections = state
        .db
        .get_connections()
        .map_err(|error| error.to_string())?;
    let connection = connections
        .iter()
        .find(|item| item.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;
    if connection.protocol != "ssh" {
        return Err("隧道仅支持 SSH 连接".to_string());
    }
    let options = parse_connection_options(connection.options.as_deref())?;
    let value = connection
        .options
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .unwrap_or_default();
    let rules: Vec<TunnelRule> = value
        .get("tunnel_rules")
        .cloned()
        .and_then(|item| serde_json::from_value(item).ok())
        .unwrap_or_default();
    let rule = rules
        .into_iter()
        .find(|item| item.id == rule_id)
        .ok_or_else(|| "隧道规则不存在".to_string())?;
    let stored = state
        .db
        .get_credential_structured(&connection.credential_id)
        .map_err(|error| error.to_string())?;
    let credential_type = match stored.auth_type.as_str() {
        "password" => CredentialType::Password,
        "key" => CredentialType::PrivateKey,
        "key_with_passphrase" => CredentialType::PrivateKeyWithPassphrase,
        "agent" => CredentialType::Agent,
        _ => return Err("不支持的认证类型".to_string()),
    };
    let credential = Credential {
        credential_type,
        password: stored.password,
        private_key: stored.private_key,
        passphrase: stored.passphrase,
    };
    let target = ConnectionTarget {
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone().unwrap_or_default(),
    };
    state
        .tunnel_manager
        .start(
            connection_id,
            rule,
            state.russh_backend.clone(),
            target,
            credential,
            options,
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stop_tunnel(
    state: tauri::State<'_, AppState>,
    tunnel_id: String,
) -> Result<(), String> {
    state
        .tunnel_manager
        .stop(&tunnel_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_tunnels(
    state: tauri::State<'_, AppState>,
    connection_id: Option<String>,
) -> Vec<TunnelRuntimeInfo> {
    state.tunnel_manager.list(connection_id.as_deref())
}

#[tauri::command]
pub async fn stop_all_tunnels(
    state: tauri::State<'_, AppState>,
    connection_id: Option<String>,
) -> Result<(), String> {
    state
        .tunnel_manager
        .stop_all(connection_id.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn write_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
    data: String,
) -> Result<(), String> {
    let (_, shell) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let codec = state
        .shell_manager
        .codec(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let data = codec
        .lock()
        .encode(&data)
        .map_err(|error| error.to_string())?;
    shell.write(&data).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn read_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<String, String> {
    let (_, shell) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let bytes = shell.read().await.map_err(|e| e.to_string())?;
    let codec = state
        .shell_manager
        .codec(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let result = codec
        .lock()
        .decode(&bytes)
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub async fn set_shell_encoding(
    state: tauri::State<'_, AppState>,
    shell_id: String,
    encoding: String,
) -> Result<String, String> {
    let codec = state
        .shell_manager
        .codec(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    codec
        .lock()
        .reset(&encoding)
        .map_err(|error| error.to_string())?;
    let label = codec.lock().label().to_string();
    Ok(label)
}

#[tauri::command]
pub async fn resize_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let (_, shell) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let size = TerminalSize::new(cols, rows).map_err(|error| error.to_string())?;
    shell.resize(size).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn close_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<(), String> {
    let (_, shell) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    shell.close().await.map_err(|e| e.to_string())?;

    state.shell_manager.remove(&shell_id);

    Ok(())
}

/// 彻底断开 Shell（包含 SSH 会话）
#[tauri::command]
pub async fn disconnect_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<(), String> {
    tracing::info!("disconnect_shell command called for shell_id: {}", shell_id);
    let (session, shell) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    if let Err(error) = shell.close().await {
        tracing::warn!("关闭 shell channel 失败: {:?}", error);
    }
    if let Some(session) = session {
        if let Err(error) = session.disconnect().await {
            tracing::warn!("断开 SSH session 失败: {:?}", error);
        }
    }

    // Remove from shell manager
    state.shell_manager.remove(&shell_id);

    tracing::info!("disconnect_shell completed for shell_id: {}", shell_id);

    Ok(())
}

/// 查询结果行
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultRow {
    pub values: Vec<serde_json::Value>,
}

/// 查询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<QueryResultRow>,
    pub affected_rows: u64,
    pub execution_time_ms: u64,
}

#[tauri::command]
pub async fn execute_query(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;

    let plugin = state
        .plugin_registry
        .get(&conn.protocol)
        .ok_or_else(|| "协议插件未找到".to_string())?;

    // 使用结构化方式获取凭证
    let cred_data = state
        .db
        .get_credential_structured(&conn.credential_id)
        .map_err(|e| e.to_string())?;

    let (credential_type, password, private_key, passphrase) = match cred_data.auth_type.as_str() {
        "password" => (CredentialType::Password, cred_data.password, None, None),
        "key" => (
            CredentialType::PrivateKey,
            None,
            cred_data.private_key,
            None,
        ),
        "key_with_passphrase" => (
            CredentialType::PrivateKeyWithPassphrase,
            None,
            cred_data.private_key,
            cred_data.passphrase,
        ),
        _ => return Err("不支持的认证类型".to_string()),
    };

    let credential = Credential {
        credential_type,
        password,
        private_key,
        passphrase,
    };

    let options = crate::protocol::ConnectionOptions::default();

    let handle = plugin
        .connect(
            &conn.host,
            conn.port,
            conn.username.as_deref().unwrap_or(""),
            &credential,
            &options,
        )
        .await
        .map_err(|e| e.to_string())?;

    match conn.protocol.as_str() {
        "mysql" => {
            let mysql_handle = handle
                .as_any()
                .downcast_ref::<crate::protocol::mysql::MysqlConnectionHandle>()
                .ok_or_else(|| "MySQL 句柄类型错误".to_string())?;

            let start = std::time::Instant::now();
            let rows = mysql_handle.query(&sql).await.map_err(|e| e.to_string())?;
            let elapsed = start.elapsed().as_millis() as u64;

            let columns: Vec<String> = if !rows.is_empty() {
                rows[0]
                    .columns()
                    .iter()
                    .map(|c| c.name_str().to_string())
                    .collect()
            } else {
                vec![]
            };

            let result_rows: Vec<QueryResultRow> = rows
                .iter()
                .enumerate()
                .map(|(_idx, row)| {
                    let values: Vec<serde_json::Value> = (0..row.len())
                        .map(|col_idx| {
                            if let Some(v) = row.get(col_idx) {
                                match v {
                                    mysql_async::Value::NULL => serde_json::Value::Null,
                                    mysql_async::Value::Bytes(b) => serde_json::Value::String(
                                        String::from_utf8_lossy(&b).to_string(),
                                    ),
                                    mysql_async::Value::Int(i) => {
                                        serde_json::Value::Number(i.into())
                                    }
                                    mysql_async::Value::UInt(u) => {
                                        serde_json::Value::Number(u.into())
                                    }
                                    mysql_async::Value::Float(f) => serde_json::json!(f),
                                    mysql_async::Value::Double(d) => serde_json::json!(d),
                                    _ => serde_json::Value::String(format!("{:?}", v)),
                                }
                            } else {
                                serde_json::Value::Null
                            }
                        })
                        .collect();
                    QueryResultRow { values }
                })
                .collect();

            Ok(QueryResult {
                columns,
                rows: result_rows,
                affected_rows: 0,
                execution_time_ms: elapsed,
            })
        }
        "postgresql" => Err("PostgreSQL 查询暂未实现".to_string()),
        _ => Err("此协议不支持查询".to_string()),
    }
}

/// AI 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// AI 聊天响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub message: ChatMessage,
    pub analysis: Option<crate::ai::AnalyzeResult>,
}

#[tauri::command]
pub async fn chat_with_ai(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    message: String,
) -> Result<ChatResponse, String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;

    let request = crate::ai::AnalyzeRequest {
        session_id: connection_id,
        command_history: vec![message.clone()],
        connection_metadata: crate::ai::ConnectionInfo {
            protocol: conn.protocol.clone(),
            host: conn.host.clone(),
            port: conn.port,
            connection_time_ms: 0,
        },
    };

    let analysis = state
        .ai_analyzer
        .analyze(request)
        .await
        .map_err(|e| e.to_string())?;

    let response_message = ChatMessage {
        role: "assistant".to_string(),
        content: format!(
            "分析结果:\n\n健康评分: {}/100\n\n{}\n\n建议: {}",
            analysis.health_score,
            analysis.summary,
            analysis.recommendations.join("\n")
        ),
    };

    Ok(ChatResponse {
        message: response_message,
        analysis: Some(analysis),
    })
}

// ==================== SFTP File Transfer Commands ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpOpenResponse {
    pub sftp_id: String,
}

/// 打开 SFTP 会话
#[tauri::command]
pub async fn open_sftp(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<SftpOpenResponse, String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;

    if conn.protocol != "ssh" {
        return Err("此协议不支持 SFTP".to_string());
    }

    // 使用结构化方式获取凭证
    let cred_data = state
        .db
        .get_credential_structured(&conn.credential_id)
        .map_err(|e| e.to_string())?;

    let (credential_type, password, private_key, passphrase) = match cred_data.auth_type.as_str() {
        "password" => (CredentialType::Password, cred_data.password, None, None),
        "key" => (
            CredentialType::PrivateKey,
            None,
            cred_data.private_key,
            None,
        ),
        "key_with_passphrase" => (
            CredentialType::PrivateKeyWithPassphrase,
            None,
            cred_data.private_key,
            cred_data.passphrase,
        ),
        _ => return Err("不支持的认证类型".to_string()),
    };

    let credential = Credential {
        credential_type,
        password,
        private_key,
        passphrase,
    };

    let options = parse_connection_options(conn.options.as_deref())?;
    let target = ConnectionTarget {
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone().unwrap_or_default(),
    };
    let session = state
        .ssh_backend(&options)
        .connect(&target, &credential, &options)
        .await
        .map_err(|e| e.to_string())?;
    let sftp_handle = match session.open_sftp().await {
        Ok(handle) => handle,
        Err(error) => {
            // 清理刚建立的 SSH 会话，避免 SFTP 初始化失败后遗留连接
            let _ = session.disconnect().await;
            return Err(error.to_string());
        }
    };
    let sftp_id = sftp_handle.id().to_string();

    state
        .sftp_manager
        .insert(sftp_id.clone(), connection_id, sftp_handle, session, true);

    Ok(SftpOpenResponse { sftp_id })
}

/// 通过已有 Shell 会话打开 SFTP（复用同一 SSH 传输，仅新建 SFTP 通道）
#[tauri::command]
pub async fn open_sftp_for_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<SftpOpenResponse, String> {
    let (session, _) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let session = session.ok_or_else(|| "本地终端不支持文件管理".to_string())?;
    let sftp_handle = session.open_sftp().await.map_err(|e| e.to_string())?;
    let sftp_id = sftp_handle.id().to_string();

    state
        .sftp_manager
        .insert(sftp_id.clone(), String::new(), sftp_handle, session, false);

    Ok(SftpOpenResponse { sftp_id })
}

/// 传输进度事件载荷
#[derive(Debug, Clone, Serialize)]
pub struct TransferProgressPayload {
    pub sftp_id: String,
    pub transfer_id: String,
    pub direction: String,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    /// running / done / cancelled / error
    pub status: String,
    pub error: Option<String>,
}

fn emit_transfer_event(app: &tauri::AppHandle, payload: &TransferProgressPayload) {
    let _ = app.emit("sftp-transfer-progress", payload);
}

/// 构造节流的进度回调（≥100ms 一次，末次必然发出）
fn transfer_progress_callback(
    app: tauri::AppHandle,
    payload_base: TransferProgressPayload,
) -> crate::protocol::ssh_backend::TransferProgress {
    let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    std::sync::Arc::new(move |transferred: u64, total: u64| {
        let mut last = last_emit
            .lock()
            .expect("transfer throttle mutex poisoned");
        let due = last.elapsed().as_millis() >= 100 || transferred == total;
        if !due {
            return;
        }
        *last = std::time::Instant::now();
        let payload = TransferProgressPayload {
            transferred,
            total,
            status: "running".to_string(),
            error: None,
            ..payload_base.clone()
        };
        let _ = app.emit("sftp-transfer-progress", &payload);
    })
}

fn transfer_file_name(path: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// 列出 SFTP 目录
#[tauri::command]
pub async fn list_sftp_dir(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<Vec<crate::protocol::sftp::FileInfo>, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;

    handle.list_dir(&path).await.map_err(|e| e.to_string())
}

/// 下载文件
#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let transfer_id = Uuid::new_v4().to_string();
    let cancel = CancellationToken::default();
    state
        .sftp_manager
        .register_transfer(transfer_id.clone(), cancel.clone());
    let base = TransferProgressPayload {
        sftp_id: sftp_id.clone(),
        transfer_id: transfer_id.clone(),
        direction: "download".to_string(),
        file_name: transfer_file_name(&remote_path),
        transferred: 0,
        total: 0,
        status: "running".to_string(),
        error: None,
    };
    emit_transfer_event(&app, &base);
    let progress = transfer_progress_callback(app.clone(), base.clone());
    let result = handle
        .download(&remote_path, &local_path, Some(progress), cancel.clone())
        .await;
    let outcome = match result {
        Ok(bytes) => {
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    transferred: bytes,
                    total: bytes,
                    status: "done".to_string(),
                    ..base
                },
            );
            Ok(bytes)
        }
        Err(_) if cancel.is_cancelled() => {
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    status: "cancelled".to_string(),
                    error: Some("传输已取消".to_string()),
                    ..base
                },
            );
            Err("传输已取消".to_string())
        }
        Err(e) => {
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    status: "error".to_string(),
                    error: Some(e.to_string()),
                    ..base
                },
            );
            Err(e.to_string())
        }
    };
    state.sftp_manager.remove_transfer(&transfer_id);
    outcome
}

/// 上传文件
#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let transfer_id = Uuid::new_v4().to_string();
    let cancel = CancellationToken::default();
    state
        .sftp_manager
        .register_transfer(transfer_id.clone(), cancel.clone());
    let base = TransferProgressPayload {
        sftp_id: sftp_id.clone(),
        transfer_id: transfer_id.clone(),
        direction: "upload".to_string(),
        file_name: transfer_file_name(&local_path),
        transferred: 0,
        total: 0,
        status: "running".to_string(),
        error: None,
    };
    emit_transfer_event(&app, &base);
    let progress = transfer_progress_callback(app.clone(), base.clone());
    let result = handle
        .upload(&local_path, &remote_path, Some(progress), cancel.clone())
        .await;
    let outcome = match result {
        Ok(bytes) => {
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    transferred: bytes,
                    total: bytes,
                    status: "done".to_string(),
                    ..base
                },
            );
            Ok(bytes)
        }
        Err(_) if cancel.is_cancelled() => {
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    status: "cancelled".to_string(),
                    error: Some("传输已取消".to_string()),
                    ..base
                },
            );
            Err("传输已取消".to_string())
        }
        Err(e) => {
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    status: "error".to_string(),
                    error: Some(e.to_string()),
                    ..base
                },
            );
            Err(e.to_string())
        }
    };
    state.sftp_manager.remove_transfer(&transfer_id);
    outcome
}

/// 取消进行中的传输
#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    transfer_id: String,
) -> Result<(), String> {
    if state.sftp_manager.get(&sftp_id).is_none() {
        return Err("SFTP 会话未找到".to_string());
    }
    // 幂等：传输进行中则取消；已完成/不存在也视为成功，避免误导性报错
    let _ = state.sftp_manager.cancel_transfer(&transfer_id);
    Ok(())
}

/// 创建空文件
#[tauri::command]
pub async fn sftp_create_file(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    handle.create_file(&path).await.map_err(|e| e.to_string())
}

/// 创建目录
#[tauri::command]
pub async fn sftp_create_dir(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    handle.create_dir(&path).await.map_err(|e| e.to_string())
}

/// 删除文件
#[tauri::command]
pub async fn sftp_delete_file(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    handle.delete_file(&path).await.map_err(|e| e.to_string())
}

/// 删除目录
#[tauri::command]
pub async fn sftp_delete_dir(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;

    handle.delete_dir(&path).await.map_err(|e| e.to_string())
}

/// 重命名
#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    handle
        .rename(&old_path, &new_path)
        .await
        .map_err(|e| e.to_string())
}

/// 关闭 SFTP 会话。独立会话（open_sftp）会同时断开其 SSH 传输；
/// 复用 Shell 的会话（open_sftp_for_shell）只关闭 SFTP 通道，不影响终端。
#[tauri::command]
pub async fn close_sftp(state: tauri::State<'_, AppState>, sftp_id: String) -> Result<(), String> {
    if let Some(handle) = state.sftp_manager.get(&sftp_id) {
        handle.close().await.map_err(|error| error.to_string())?;
    }
    if state.sftp_manager.owns_session(&sftp_id) {
        if let Some(session) = state.sftp_manager.get_session(&sftp_id) {
            let _ = session.disconnect().await;
        }
    }
    state.sftp_manager.remove(&sftp_id);
    Ok(())
}

/// 关闭独立 SFTP 连接（旧版兼容，会断开 SSH）
#[tauri::command]
pub async fn close_sftp_independent(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
) -> Result<(), String> {
    if let Some(handle) = state.sftp_manager.get(&sftp_id) {
        let _ = handle.close().await;
    }
    if let Some(session) = state.sftp_manager.get_session(&sftp_id) {
        let _ = session.disconnect().await;
    }
    state.sftp_manager.remove(&sftp_id);
    Ok(())
}

// ==================== Folder Commands ====================

#[tauri::command]
pub async fn get_folders(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::storage::FolderRecord>, String> {
    state.db.get_folders().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_folder(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    let folder_id = Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4());
    state
        .db
        .save_folder(folder_id, &name, parent_id.as_deref(), 0)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_folder(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_folder(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_folder(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state
        .db
        .rename_folder(&id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_ssh_keys(state: tauri::State<'_, AppState>) -> Result<Vec<SshKeyRecord>, String> {
    state.db.get_ssh_keys().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_ssh_key(
    state: tauri::State<'_, AppState>,
    name: String,
    file_name: String,
    private_key: String,
) -> Result<SshKeyRecord, String> {
    if name.trim().is_empty() || private_key.trim().is_empty() {
        return Err("密钥名称和内容不能为空".to_string());
    }
    let key_type = if private_key.contains("BEGIN RSA PRIVATE KEY") {
        "ssh-rsa"
    } else if private_key.contains("BEGIN EC PRIVATE KEY") {
        "ecdsa"
    } else if private_key.contains("BEGIN OPENSSH PRIVATE KEY") {
        "OpenSSH"
    } else {
        return Err("无法识别私钥格式".to_string());
    };
    let id = Uuid::new_v4();
    state
        .db
        .save_ssh_key(id, &name, &file_name, key_type, &private_key)
        .map_err(|e| e.to_string())?;
    state
        .db
        .get_ssh_keys()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|key| key.id == id.to_string())
        .ok_or_else(|| "保存后读取密钥失败".to_string())
}

#[tauri::command]
pub async fn delete_ssh_key(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_ssh_key(&id).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionExportBundle {
    pub version: u32,
    pub exported_at: i64,
    pub folders: Vec<crate::storage::FolderRecord>,
    pub connections: Vec<SessionExportConnection>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionExportConnection {
    #[serde(flatten)]
    pub connection: ConnectionRecord,
    pub credential: CredentialData,
}

#[derive(Debug, Serialize)]
pub struct SessionImportResult {
    pub folders: usize,
    pub connections: usize,
}

#[tauri::command]
pub async fn export_sessions(
    state: tauri::State<'_, AppState>,
    include_passwords: bool,
    include_private_keys: bool,
) -> Result<String, String> {
    let mut exported = Vec::new();
    for connection in state.db.get_connections().map_err(|e| e.to_string())? {
        let mut credential = state
            .db
            .get_credential_structured(&connection.credential_id)
            .map_err(|e| e.to_string())?;
        if !include_passwords {
            credential.password = None;
            credential.passphrase = None;
        }
        if !include_private_keys {
            credential.private_key = None;
            credential.key_id = None;
        } else if credential.private_key.is_none() {
            if let Some(key_id) = credential.key_id.as_deref() {
                credential.private_key = Some(
                    state
                        .db
                        .get_ssh_key_material(key_id)
                        .map_err(|e| e.to_string())?,
                );
            }
            credential.key_id = None;
        }
        exported.push(SessionExportConnection {
            connection,
            credential,
        });
    }
    serde_json::to_string_pretty(&SessionExportBundle {
        version: 1,
        exported_at: chrono::Utc::now().timestamp(),
        folders: state.db.get_folders().map_err(|e| e.to_string())?,
        connections: exported,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_sessions(
    state: tauri::State<'_, AppState>,
    json: String,
) -> Result<SessionImportResult, String> {
    let bundle: SessionExportBundle =
        serde_json::from_str(&json).map_err(|e| format!("会话 JSON 格式无效: {}", e))?;
    if bundle.version != 1 {
        return Err(format!("不支持的导出版本: {}", bundle.version));
    }
    let mut folder_ids = HashMap::new();
    for folder in &bundle.folders {
        folder_ids.insert(folder.id.clone(), Uuid::new_v4());
    }
    for folder in &bundle.folders {
        let id = folder_ids[&folder.id];
        let parent = folder
            .parent_id
            .as_ref()
            .and_then(|old| folder_ids.get(old))
            .map(|id| id.to_string());
        state
            .db
            .save_folder(id, &folder.name, parent.as_deref(), folder.sort_order)
            .map_err(|e| e.to_string())?;
    }
    let count = bundle.connections.len();
    for item in bundle.connections {
        let connection_id = Uuid::new_v4();
        let credential_id = Uuid::new_v4();
        let mut credential = item.credential;
        credential.key_id = None;
        state
            .db
            .save_credential_structured(
                credential_id,
                &item.connection.name,
                &credential.auth_type,
                &credential,
            )
            .map_err(|e| e.to_string())?;
        let folder_id = item
            .connection
            .folder_id
            .as_ref()
            .and_then(|old| folder_ids.get(old))
            .map(|id| id.to_string());
        state
            .db
            .save_connection(
                connection_id,
                &item.connection.name,
                &item.connection.protocol,
                &item.connection.host,
                item.connection.port,
                item.connection.username.as_deref(),
                credential_id,
                item.connection.options.as_deref(),
                item.connection.tags.as_deref(),
                item.connection.color.as_deref(),
                folder_id.as_deref(),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(SessionImportResult {
        folders: bundle.folders.len(),
        connections: count,
    })
}

#[tauri::command]
pub async fn move_connection_to_folder(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    state
        .db
        .update_connection_folder(&connection_id, folder_id.as_deref())
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetOrderItem {
    pub id: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
}

#[tauri::command]
pub async fn update_asset_order(
    state: tauri::State<'_, AppState>,
    connections: Vec<AssetOrderItem>,
    folders: Vec<AssetOrderItem>,
) -> Result<(), String> {
    let connection_updates = connections
        .into_iter()
        .map(|item| (item.id, item.parent_id, item.sort_order))
        .collect::<Vec<_>>();
    let folder_updates = folders
        .into_iter()
        .map(|item| (item.id, item.parent_id, item.sort_order))
        .collect::<Vec<_>>();
    state
        .db
        .update_asset_order(&connection_updates, &folder_updates)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// ==================== Test Connection ====================

#[tauri::command]
pub async fn test_connection(
    state: tauri::State<'_, AppState>,
    mut config: ConnectionConfigRequest,
) -> Result<String, String> {
    if let Some(key_id) = config.key_id.as_deref() {
        config.private_key = Some(
            state
                .db
                .get_ssh_key_material(key_id)
                .map_err(|e| e.to_string())?,
        );
    }
    if config.protocol == "local" {
        let shell_type = config
            .shell_type
            .clone()
            .unwrap_or_else(|| "powershell".to_string());
        crate::protocol::local::resolve_profile(
            &shell_type,
            config.cwd.as_deref(),
            config.custom_command.as_deref(),
        )
        .map_err(|error| format!("本地终端不可用: {error}"))?;
        return Ok("本机终端可用".to_string());
    }
    let plugin = state
        .plugin_registry
        .get(&config.protocol)
        .ok_or_else(|| "协议插件未找到".to_string())?;

    let auth_type = config.auth_type.as_str();
    let (credential_type, password, private_key, passphrase) = match auth_type {
        "password" => {
            let pass = config.password.unwrap_or_default();
            (CredentialType::Password, Some(pass), None, None)
        }
        "key" => {
            let key = config.private_key.unwrap_or_default();
            (CredentialType::PrivateKey, None, Some(key), None)
        }
        "key_with_passphrase" => {
            let key = config.private_key.unwrap_or_default();
            let pass = config.passphrase.unwrap_or_default();
            (
                CredentialType::PrivateKeyWithPassphrase,
                None,
                Some(key),
                Some(pass),
            )
        }
        "agent" => (CredentialType::Agent, None, None, None),
        _ => return Err("不支持的认证类型".to_string()),
    };

    let credential = Credential {
        credential_type,
        password,
        private_key,
        passphrase,
    };

    // Parse proxy from options if provided
    let mut options = crate::protocol::ConnectionOptions::default();
    if let (Some(proxy_type), Some(proxy_host), Some(proxy_port)) =
        (&config.proxy_type, &config.proxy_host, &config.proxy_port)
    {
        options.proxy = Some(crate::protocol::ProxyConfig {
            proxy_type: proxy_type.clone(),
            host: proxy_host.clone(),
            port: *proxy_port,
            username: config.proxy_username.clone(),
            password: config.proxy_password.clone(),
        });
    }

    if config.protocol == "ssh" {
        let target = ConnectionTarget {
            host: config.host,
            port: config.port,
            username: config.username,
        };
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            state
                .ssh_backend(&options)
                .connect(&target, &credential, &options),
        )
        .await
        {
            Ok(Ok(session)) => {
                let _ = session.disconnect().await;
                Ok("连接成功".to_string())
            }
            Ok(Err(error)) => Err(format!("连接失败: {error}")),
            Err(_) => Err("连接超时".to_string()),
        }
    } else {
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            plugin.connect(
                &config.host,
                config.port,
                &config.username,
                &credential,
                &options,
            ),
        )
        .await
        {
            Ok(Ok(_handle)) => Ok("连接成功".to_string()),
            Ok(Err(error)) => Err(format!("连接失败: {error}")),
            Err(_) => Err("连接超时".to_string()),
        }
    }
}

// ==================== Docker Commands ====================

#[tauri::command]
pub async fn docker_connect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;

    let plugin = state
        .plugin_registry
        .get(&conn.protocol)
        .ok_or_else(|| "协议插件未找到".to_string())?;

    let credential = Credential {
        credential_type: CredentialType::Password,
        password: None,
        private_key: None,
        passphrase: None,
    };

    let options = crate::protocol::ConnectionOptions::default();

    let handle: Arc<dyn ConnectionHandle> = plugin
        .connect(
            &conn.host,
            conn.port,
            conn.username.as_deref().unwrap_or(""),
            &credential,
            &options,
        )
        .await
        .map_err(|e| e.to_string())?
        .into();

    let docker_handle = Arc::downcast::<crate::protocol::docker::DockerConnectionHandle>(handle)
        .map_err(|_| "此连接不是 Docker 连接".to_string())?;

    state.docker_manager.insert(connection_id, docker_handle);

    Ok(())
}

#[tauri::command]
pub async fn docker_list_containers(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    all: bool,
) -> Result<Vec<ContainerInfo>, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.list_containers(all).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_create_container(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    config: DockerContainerCreateConfig,
) -> Result<String, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .create_container(config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_start_container(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .start_container(&container_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_stop_container(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
    timeout: Option<u64>,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .stop_container(&container_id, timeout)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_restart_container(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
    timeout: Option<u64>,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .restart_container(&container_id, timeout)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_kill_container(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
    signal: Option<String>,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .kill_container(&container_id, signal.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_remove_container(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
    force: bool,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .remove_container(&container_id, force)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_logs(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
    tail: Option<u64>,
) -> Result<String, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .logs(&container_id, tail, false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_stats(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    container_id: String,
) -> Result<ContainerStats, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.stats(&container_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_list_images(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<ImageInfo>, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.list_images().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_pull_image(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    image: String,
    tag: Option<String>,
) -> Result<String, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .pull_image(&image, tag.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_remove_image(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    image_id: String,
    force: bool,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .remove_image(&image_id, force)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_list_volumes(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<VolumeInfo>, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.list_volumes().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_create_volume(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    name: String,
    driver: String,
) -> Result<String, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .create_volume(&name, &driver)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_remove_volume(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    volume_name: String,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .remove_volume(&volume_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_list_networks(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<NetworkInfo>, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.list_networks().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_create_network(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    name: String,
    driver: String,
) -> Result<String, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .create_network(&name, &driver)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_remove_network(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    network_id: String,
) -> Result<(), String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle
        .remove_network(&network_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_ping(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<String, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.ping().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_info(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<DockerSystemInfo, String> {
    let handle = state
        .docker_manager
        .get(&connection_id)
        .ok_or_else(|| "Docker 会话未找到".to_string())?;

    handle.info().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    state.docker_manager.remove(&connection_id);
    Ok(())
}
