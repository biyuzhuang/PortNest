//! Tauri 命令接口

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ai::{AIAnalyzer, AnalyzeRequest, ConnectionInfo};
use crate::connection::ConnectionManager;
use crate::protocol::docker::{
    ContainerInfo, ContainerStats, DockerContainerCreateConfig, DockerSystemInfo, ImageInfo,
    NetworkInfo, VolumeInfo,
};
use crate::protocol::ssh_backend::{
    session_pool_key, CancellationToken, ConnectionTarget, SftpHandle, ShellHandle, Ssh2Backend,
    SshBackend, SshSession, SshSessionPool, TerminalSize,
};
use crate::protocol::terminal_codec::{normalize_encoding, TerminalCodec};
use crate::protocol::tunnel::{TunnelManager, TunnelRule, TunnelRuntimeInfo};
use crate::protocol::PluginRegistry;
use crate::protocol::{ConnectionHandle, Credential, CredentialType};
use crate::storage::{CommandSnippetRecord, ConnectionRecord, CredentialData, Database, SftpTransferRecord, SshKeyRecord};
use tauri::Emitter;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub mod dashboard;
pub mod mysql_admin;

pub(crate) fn parse_connection_options(
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
    connection_id: String,
    lease_key: Option<String>,
    lease_owner: Option<String>,
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
        lease_key: Option<String>,
        lease_owner: Option<String>,
        session: Option<Arc<dyn SshSession>>,
        shell: Arc<dyn ShellHandle>,
        encoding: &str,
    ) -> crate::Result<()> {
        let codec = Arc::new(Mutex::new(TerminalCodec::new(encoding)?));
        self.sessions.write().insert(
            shell_id,
            ShellSessionInfo {
                connection_id,
                lease_key,
                lease_owner,
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

    fn lease(&self, shell_id: &str) -> Option<(String, String)> {
        self.sessions.read().get(shell_id).and_then(|entry| {
            Some((entry.lease_key.clone()?, entry.lease_owner.clone()?))
        })
    }

    fn codec(&self, shell_id: &str) -> Option<Arc<Mutex<TerminalCodec>>> {
        self.sessions
            .read()
            .get(shell_id)
            .map(|entry| entry.codec.clone())
    }

    fn connection_id(&self, shell_id: &str) -> Option<String> {
        self.sessions
            .read()
            .get(shell_id)
            .map(|entry| entry.connection_id.clone())
    }

    /// 指定连接是否存在存活的 Shell 会话（供仪表盘等依赖终端会话的功能门控）。
    pub(crate) fn has_live_shell(&self, connection_id: &str) -> bool {
        self.sessions.read().values().any(|entry| {
            entry.connection_id == connection_id
                && entry.session.as_ref().map(|session| session.status()) == Some(crate::protocol::SessionStatus::Connected)
        })
    }
}

/// SFTP 会话信息
struct SftpSessionInfo {
    connection_id: String,
    handle: Arc<dyn SftpHandle>,
    lease_key: String,
    lease_owner: String,
}

/// SFTP 会话管理器
pub(crate) struct SftpManager {
    sessions: RwLock<HashMap<String, SftpSessionInfo>>,
    transfers: parking_lot::Mutex<HashMap<String, CancellationToken>>,
    active_transfers: parking_lot::Mutex<usize>,
    max_concurrent: AtomicUsize,
    rate_limit_bps: AtomicU64,
    queue_notify: tokio::sync::Notify,
}

struct SftpTransferPermit {
    manager: Arc<SftpManager>,
}

impl Drop for SftpTransferPermit {
    fn drop(&mut self) {
        let mut active = self.manager.active_transfers.lock();
        *active = active.saturating_sub(1);
        drop(active);
        self.manager.queue_notify.notify_waiters();
    }
}

impl SftpManager {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            transfers: parking_lot::Mutex::new(HashMap::new()),
            active_transfers: parking_lot::Mutex::new(0),
            max_concurrent: AtomicUsize::new(2),
            rate_limit_bps: AtomicU64::new(0),
            queue_notify: tokio::sync::Notify::new(),
        }
    }

    fn insert(
        &self,
        sftp_id: String,
        connection_id: String,
        handle: Arc<dyn SftpHandle>,
        lease_key: String,
        lease_owner: String,
    ) {
        self.sessions.write().insert(
            sftp_id,
            SftpSessionInfo {
                connection_id,
                handle,
                lease_key,
                lease_owner,
            },
        );
    }

    fn get(&self, sftp_id: &str) -> Option<Arc<dyn SftpHandle>> {
        self.sessions.read().get(sftp_id).map(|s| s.handle.clone())
    }

    fn connection_id(&self, sftp_id: &str) -> Option<String> {
        self.sessions
            .read()
            .get(sftp_id)
            .map(|session| session.connection_id.clone())
    }

    fn lease(&self, sftp_id: &str) -> Option<(String, String)> {
        self.sessions.read().get(sftp_id)
            .map(|session| (session.lease_key.clone(), session.lease_owner.clone()))
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

    fn configure_queue(&self, max_concurrent: usize, rate_limit_bps: u64) {
        self.max_concurrent.store(max_concurrent.clamp(1, 8), Ordering::Release);
        self.rate_limit_bps.store(rate_limit_bps, Ordering::Release);
        self.queue_notify.notify_waiters();
    }

    fn queue_config(&self) -> SftpQueueConfig {
        SftpQueueConfig {
            max_concurrent: self.max_concurrent.load(Ordering::Acquire),
            rate_limit_bps: self.rate_limit_bps.load(Ordering::Acquire),
            active: *self.active_transfers.lock(),
        }
    }

    async fn acquire_transfer_slot(self: &Arc<Self>) -> SftpTransferPermit {
        loop {
            let notified = self.queue_notify.notified();
            {
                let mut active = self.active_transfers.lock();
                if *active < self.max_concurrent.load(Ordering::Acquire) {
                    *active += 1;
                    return SftpTransferPermit { manager: self.clone() };
                }
            }
            notified.await;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandVariable {
    pub name: String,
    #[serde(default)] pub default_value: Option<String>,
    #[serde(default)] pub choices: Vec<String>,
    #[serde(default)] pub sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSnippetInput {
    pub id: Option<String>, pub kind: String, pub name: String,
    pub description: Option<String>, pub content: String, pub folder: Option<String>,
    #[serde(default)] pub tags: Vec<String>, #[serde(default)] pub variables: Vec<CommandVariable>,
    #[serde(default)] pub favorite: bool,
}

fn render_command(template: &str, definitions: &[CommandVariable], values: &HashMap<String, String>) -> Result<String, String> {
    let mut result = template.to_string();
    for variable in definitions {
        let value = values.get(&variable.name).cloned().or_else(|| variable.default_value.clone())
            .ok_or_else(|| format!("缺少变量: {}", variable.name))?;
        if !variable.choices.is_empty() && !variable.choices.iter().any(|choice| choice == &value) {
            return Err(format!("变量 {} 的值不在允许枚举中", variable.name));
        }
        result = result.replace(&format!("{{{{{}}}}}", variable.name), &value);
    }
    if definitions.is_empty() {
        for (name, value) in values { result = result.replace(&format!("{{{{{}}}}}", name), &value); }
    }
    if result.contains("{{") || result.contains("}}") { return Err("命令包含未定义变量".to_string()); }
    Ok(result)
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
    pub(crate) ssh_session_pool: Arc<SshSessionPool>,
    pub(crate) docker_manager: Arc<DockerManager>,
    pub(crate) mysql_manager: Arc<mysql_admin::MysqlManager>,
    pub(crate) dashboard_manager: Arc<dashboard::DashboardManager>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

impl AppState {
    pub fn new(app_dir: std::path::PathBuf) -> crate::Result<Self> {
        let db = Database::new(app_dir)?;
        let plugin_registry = Arc::new(PluginRegistry::default());
        let connection_manager = Arc::new(ConnectionManager::new(plugin_registry.clone()));

        Self::register_plugins(&plugin_registry);

        let ssh_session_pool = Arc::new(SshSessionPool::new());
        Ok(Self {
            db,
            connection_manager,
            plugin_registry,
            ai_analyzer: AIAnalyzer::default(),
            ssh2_backend: Arc::new(Ssh2Backend),
            russh_backend: Arc::new(crate::protocol::russh_backend::RusshBackend),
            shell_manager: Arc::new(ShellManager::new()),
            sftp_manager: Arc::new(SftpManager::new()),
            tunnel_manager: Arc::new(TunnelManager::new(ssh_session_pool.clone())),
            ssh_session_pool,
            docker_manager: Arc::new(DockerManager::new()),
            mysql_manager: Arc::new(mysql_admin::MysqlManager::new()),
            dashboard_manager: Arc::new(dashboard::DashboardManager::new()),
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

pub(crate) fn credential_from_data(data: &CredentialData) -> Result<Credential, String> {
    let credential_type = match data.auth_type.as_str() {
        "password" => CredentialType::Password,
        "key" => CredentialType::PrivateKey,
        "key_with_passphrase" => CredentialType::PrivateKeyWithPassphrase,
        "agent" => CredentialType::Agent,
        _ => return Err("不支持的认证类型".to_string()),
    };
    Ok(Credential {
        credential_type,
        password: data.password.clone(),
        private_key: data.private_key.clone(),
        passphrase: data.passphrase.clone(),
    })
}

pub(crate) fn resolve_ssh_options(
    state: &AppState,
    connection_id: &str,
    mut options: crate::protocol::ConnectionOptions,
    credential_data: &CredentialData,
) -> Result<crate::protocol::ConnectionOptions, String> {
    let Some(proxy) = options.proxy.as_mut() else { return Ok(options) };
    if proxy.proxy_type != "ssh_jump" {
        proxy.password = credential_data.proxy_password.clone().or(proxy.password.take());
        return Ok(options);
    }

    let jump_id = proxy.jump_connection_id.clone().ok_or_else(|| "SSH 跳板机引用缺失".to_string())?;
    if jump_id == connection_id { return Err("SSH 跳板机不能引用当前连接".to_string()); }
    let jump_connection = state.db.get_connections().map_err(|error| error.to_string())?
        .into_iter()
        .find(|connection| connection.id == jump_id)
        .ok_or_else(|| "引用的 SSH 跳板机不存在".to_string())?;
    if jump_connection.protocol != "ssh" { return Err("跳板资产必须是 SSH 连接".to_string()); }
    let jump_data = state.db.get_credential_structured(&jump_connection.credential_id).map_err(|error| error.to_string())?;
    let jump_credential = credential_from_data(&jump_data)?;
    let mut jump_options = parse_connection_options(jump_connection.options.as_deref())?;
    if jump_options.proxy.as_ref().is_some_and(|nested| nested.proxy_type == "ssh_jump") {
        return Err("仅支持单级 SSH 跳板，所选跳板不能再引用 SSH 跳板".to_string());
    }
    if let Some(nested) = jump_options.proxy.as_mut() {
        nested.password = jump_data.proxy_password.clone().or(nested.password.take());
    }
    proxy.jump = Some(Box::new(crate::protocol::ResolvedJumpConfig {
        target: ConnectionTarget {
            host: jump_connection.host,
            port: jump_connection.port,
            username: jump_connection.username.unwrap_or_default(),
        },
        credential: jump_credential,
        options: jump_options,
    }));
    Ok(options)
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
    pub jump_connection_id: Option<String>,
    pub encoding: Option<String>,
    pub timeout_ms: Option<u64>,
    pub database: Option<String>,
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
    let proxy_password_to_store = if matches!(config.proxy_type.as_deref(), Some("socks5" | "http")) {
        config.proxy_password.clone().or_else(|| previous_credential.as_ref()?.proxy_password.clone())
    } else {
        None
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
            proxy_password: proxy_password_to_store.clone(),
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
            proxy_password: proxy_password_to_store.clone(),
        },
        _ => CredentialData {
            auth_type: auth_type.to_string(),
            password: None,
            private_key: None,
            passphrase: None,
            key_id: None,
            proxy_password: proxy_password_to_store,
        },
    };

    // Build options JSON with proxy and encoding settings
    let mut options_map = serde_json::Map::new();
    if let Some(proxy_type) = &config.proxy_type {
        let mut proxy_map = serde_json::Map::new();
        proxy_map.insert(
            "type".to_string(),
            serde_json::Value::String(proxy_type.clone()),
        );
        if proxy_type == "ssh_jump" {
            let jump_id = config.jump_connection_id.as_ref().ok_or_else(|| "请选择 SSH 跳板机".to_string())?;
            if jump_id == &id.to_string() { return Err("SSH 跳板机不能引用当前连接".to_string()); }
            let jump_connection = state.db.get_connections().map_err(|error| error.to_string())?
                .into_iter().find(|connection| &connection.id == jump_id)
                .ok_or_else(|| "引用的 SSH 跳板机不存在".to_string())?;
            if jump_connection.protocol != "ssh" { return Err("跳板资产必须是 SSH 连接".to_string()); }
            let jump_options = parse_connection_options(jump_connection.options.as_deref())?;
            if jump_options.proxy.as_ref().is_some_and(|proxy| proxy.proxy_type == "ssh_jump") {
                return Err("仅支持单级 SSH 跳板，所选跳板不能再引用 SSH 跳板".to_string());
            }
            proxy_map.insert("jump_connection_id".to_string(), serde_json::Value::String(jump_id.clone()));
        } else {
            let proxy_host = config.proxy_host.as_ref().filter(|value| !value.trim().is_empty()).ok_or_else(|| "请填写代理主机".to_string())?;
            let proxy_port = config.proxy_port.filter(|port| *port > 0).ok_or_else(|| "请填写有效代理端口".to_string())?;
            proxy_map.insert("host".to_string(), serde_json::Value::String(proxy_host.clone()));
            proxy_map.insert("port".to_string(), serde_json::Value::Number(proxy_port.into()));
            if let Some(username) = &config.proxy_username {
                proxy_map.insert("username".to_string(), serde_json::Value::String(username.clone()));
            }
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
    if let Some(database) = config.database.as_ref().filter(|value| !value.trim().is_empty()) {
        options_map.insert(
            "database".to_string(),
            serde_json::Value::String(database.trim().to_string()),
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
        .save_credential_structured(credential_id, &config.name, auth_type, &cred_data)
        .map_err(|e| e.to_string())?;

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
    let mut jump_connection_id = None;
    let mut encoding = None;
    let mut timeout_ms = None;
    let mut database = None;
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
            database = value
                .get("database")
                .and_then(|item| item.as_str())
                .map(str::to_string);
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
                let legacy_proxy_password = proxy
                    .get("password")
                    .and_then(|item| item.as_str())
                    .map(str::to_string);
                proxy_password = credential.proxy_password.clone().or(legacy_proxy_password);
                jump_connection_id = proxy.get("jump_connection_id").and_then(|item| item.as_str()).map(str::to_string);
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
        jump_connection_id,
        encoding,
        timeout_ms,
        database,
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

/// 将某个已保存连接的主机密钥更新为用户已经核验过的新指纹。
///
/// 调用方必须先向用户展示密钥变化警告并取得确认。这里接收连接 ID 而不是任意
/// host/port，避免前端误改其它主机的信任记录。直接写入已核验的指纹还能避免
/// “删除旧记录后、下次握手前”盲目信任其它密钥的竞态窗口。
#[tauri::command]
pub async fn update_ssh_host_key(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    fingerprint: String,
) -> Result<(), String> {
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?;
    if conn.protocol != "ssh" {
        return Err("仅 SSH 连接具有主机密钥记录".to_string());
    }

    let path = crate::app_data_dir().join("known-hosts.json");
    let fingerprint = fingerprint.trim();
    if fingerprint.is_empty() || fingerprint.len() > 512 || fingerprint.contains(['\r', '\n']) {
        return Err("SSH 主机密钥指纹无效".to_string());
    }
    let mut known: HashMap<String, String> = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("读取主机密钥记录失败: {error}"))?;
        serde_json::from_str(&content)
            .map_err(|error| format!("主机密钥记录已损坏: {error}"))?
    } else {
        HashMap::new()
    };
    let key = format!("{}:{}", conn.host, conn.port);
    known.insert(key.clone(), fingerprint.to_string());
    let content = serde_json::to_vec_pretty(&known)
        .map_err(|error| format!("序列化主机密钥失败: {error}"))?;
    std::fs::write(&path, content).map_err(|error| format!("保存主机密钥失败: {error}"))?;
    tracing::warn!("用户确认后已更新 SSH 主机密钥记录: {key}");
    Ok(())
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

    let credential = credential_from_data(&cred_data)?;
    let options = resolve_ssh_options(
        state.inner(),
        &connection_id,
        parse_connection_options(conn.options.as_deref())?,
        &cred_data,
    )?;

    let target = ConnectionTarget {
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone().unwrap_or_default(),
    };
    let lease_key = session_pool_key(&connection_id, &target, &credential, &options);
    let lease_owner = format!("shell:{}", Uuid::new_v4());
    let session = state
        .ssh_session_pool
        .acquire(
            lease_key.clone(),
            lease_owner.clone(),
            state.ssh_backend(&options),
            &target,
            &credential,
            &options,
        )
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!("SSH connection established to {}:{}", conn.host, conn.port);

    tracing::info!("Opening shell with cols={}, rows={}", cols, rows);
    let size = TerminalSize::new(cols, rows).map_err(|error| error.to_string())?;
    let shell = match session.open_shell(size).await {
        Ok(shell) => shell,
        Err(error) => {
            state.ssh_session_pool.release(&lease_key, &lease_owner).await;
            return Err(error.to_string());
        }
    };
    tracing::info!("Shell opened successfully: id={}", shell.id());
    let shell_id = shell.id().to_string();

    let encoding = normalize_encoding(options.encoding.as_deref().unwrap_or("UTF-8"))
        .map_err(|error| error.to_string())?;
    state
        .shell_manager
        .insert(
            shell_id.clone(),
            connection_id.clone(),
            Some(lease_key),
            Some(lease_owner),
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
            None,
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
    let stored = state
        .db
        .get_credential_structured(&connection.credential_id)
        .map_err(|error| error.to_string())?;
    let options = resolve_ssh_options(
        state.inner(),
        &connection_id,
        parse_connection_options(connection.options.as_deref())?,
        &stored,
    )?;
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
    let credential = credential_from_data(&stored)?;
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
pub async fn probe_tunnel(
    state: tauri::State<'_, AppState>,
    tunnel_id: String,
    dynamic_host: String,
    dynamic_port: u16,
) -> Result<String, String> {
    state.tunnel_manager.probe(&tunnel_id, &dynamic_host, dynamic_port).await
        .map_err(|error| error.to_string())
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
pub fn save_command_snippet(state: tauri::State<'_, AppState>, input: CommandSnippetInput) -> Result<CommandSnippetRecord, String> {
    let now = chrono::Utc::now().timestamp();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let kind = if input.kind == "task" { "task" } else { "snippet" };
    let record = CommandSnippetRecord { id, kind: kind.to_string(), name: input.name.trim().to_string(), description: input.description,
        content: input.content, folder: input.folder, tags: serde_json::to_string(&input.tags).map_err(|e| e.to_string())?,
        variables: serde_json::to_string(&input.variables).map_err(|e| e.to_string())?, favorite: input.favorite, created_at: now, updated_at: now };
    if record.name.is_empty() || record.content.trim().is_empty() { return Err("名称和命令内容不能为空".to_string()); }
    state.db.save_command_snippet(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

#[tauri::command]
pub fn list_command_snippets(state: tauri::State<'_, AppState>, kind: Option<String>, query: Option<String>) -> Result<Vec<CommandSnippetRecord>, String> {
    state.db.list_command_snippets(kind.as_deref(), query.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_command_snippet(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_command_snippet(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn render_command_snippet(content: String, variables: Vec<CommandVariable>, values: HashMap<String, String>) -> Result<String, String> {
    render_command(&content, &variables, &values)
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
    let lease = state.shell_manager.lease(&shell_id);
    state.shell_manager.remove(&shell_id);
    if let Some((key, owner)) = lease {
        state.ssh_session_pool.release(&key, &owner).await;
    }

    Ok(())
}

/// 彻底断开 Shell（包含 SSH 会话）
#[tauri::command]
pub async fn disconnect_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<(), String> {
    tracing::info!("disconnect_shell command called for shell_id: {}", shell_id);
    let (_session, shell) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    if let Err(error) = shell.close().await {
        tracing::warn!("关闭 shell channel 失败: {:?}", error);
    }
    let lease = state.shell_manager.lease(&shell_id);
    state.shell_manager.remove(&shell_id);
    if let Some((key, owner)) = lease {
        state.ssh_session_pool.release(&key, &owner).await;
    }

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
    pub last_insert_id: Option<u64>,
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
                last_insert_id: None,
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

    let credential = credential_from_data(&cred_data)?;
    let options = resolve_ssh_options(
        state.inner(),
        &connection_id,
        parse_connection_options(conn.options.as_deref())?,
        &cred_data,
    )?;
    let target = ConnectionTarget {
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone().unwrap_or_default(),
    };
    let lease_key = session_pool_key(&connection_id, &target, &credential, &options);
    let lease_owner = format!("sftp:{}", Uuid::new_v4());
    let session = state
        .ssh_session_pool
        .acquire(lease_key.clone(), lease_owner.clone(), state.ssh_backend(&options), &target, &credential, &options)
        .await
        .map_err(|e| e.to_string())?;
    let sftp_handle = match session.open_sftp().await {
        Ok(handle) => handle,
        Err(error) => {
            // 清理刚建立的 SSH 会话，避免 SFTP 初始化失败后遗留连接
            state.ssh_session_pool.release(&lease_key, &lease_owner).await;
            return Err(error.to_string());
        }
    };
    let sftp_id = sftp_handle.id().to_string();

    state
        .sftp_manager
        .insert(sftp_id.clone(), connection_id, sftp_handle, lease_key, lease_owner);

    Ok(SftpOpenResponse { sftp_id })
}

/// 通过已有 Shell 会话打开 SFTP（复用同一 SSH 传输，仅新建 SFTP 通道）
#[tauri::command]
pub async fn open_sftp_for_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<SftpOpenResponse, String> {
    let connection_id = state.shell_manager.connection_id(&shell_id).unwrap_or_default();
    let (session, _) = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let _session = session.ok_or_else(|| "本地终端不支持文件管理".to_string())?;
    let (lease_key, _) = state.shell_manager.lease(&shell_id).ok_or_else(|| "SSH 会话租约不存在".to_string())?;
    let lease_owner = format!("sftp:{}", Uuid::new_v4());
    let session = state.ssh_session_pool.retain(&lease_key, lease_owner.clone()).await
        .ok_or_else(|| "SSH 共享会话已经断开".to_string())?;
    let sftp_handle = session.open_sftp().await.map_err(|e| e.to_string())?;
    let sftp_id = sftp_handle.id().to_string();

    state
        .sftp_manager
        .insert(sftp_id.clone(), connection_id, sftp_handle, lease_key, lease_owner);

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
    pub actual_destination: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SftpTransferOptions {
    /// overwrite / skip / rename / resume
    pub conflict_policy: Option<String>,
    #[serde(default)]
    pub verify_checksum: bool,
    #[serde(default)]
    pub rate_limit_bps: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SftpQueueConfig {
    pub max_concurrent: usize,
    pub rate_limit_bps: u64,
    pub active: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SftpTransferResult {
    pub transfer_id: String,
    pub status: String,
    pub transferred: u64,
    pub total: u64,
    pub actual_destination: String,
    pub checksum: Option<String>,
}

fn emit_transfer_event(app: &tauri::AppHandle, payload: &TransferProgressPayload) {
    let _ = app.emit("sftp-transfer-progress", payload);
}

/// 构造节流的进度回调（≥100ms 一次，末次必然发出）
fn transfer_progress_callback(
    app: tauri::AppHandle,
    db: Database,
    payload_base: TransferProgressPayload,
) -> crate::protocol::ssh_backend::TransferProgress {
    let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    std::sync::Arc::new(move |transferred: u64, total: u64| {
        let mut last = last_emit
            .lock()
            .expect("transfer throttle mutex poisoned");
        let due = last.elapsed().as_millis() >= 250 || transferred == total;
        if !due {
            return;
        }
        *last = std::time::Instant::now();
        let payload = TransferProgressPayload {
            transferred,
            total,
            status: "running".to_string(),
            error: None,
            actual_destination: payload_base.actual_destination.clone(),
            ..payload_base.clone()
        };
        let destination = payload.actual_destination.as_deref().unwrap_or_default();
        if let Err(error) = db.update_sftp_transfer(
            &payload.transfer_id,
            "running",
            transferred,
            total,
            destination,
            None,
            None,
        ) {
            tracing::warn!("持久化 SFTP 传输进度失败: {error}");
        }
        let _ = app.emit("sftp-transfer-progress", &payload);
    })
}

fn transfer_file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn safe_entry_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        Err(format!("远端返回了不安全的文件名: {name}"))
    } else {
        Ok(name)
    }
}

async fn collect_remote_directory(
    handle: &Arc<dyn SftpHandle>,
    root: &str,
) -> Result<(Vec<PathBuf>, Vec<(String, PathBuf, u64)>), String> {
    let mut directories = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut stack = vec![(root.to_string(), PathBuf::new())];
    while let Some((remote_directory, relative_directory)) = stack.pop() {
        let entries = handle.list_dir(&remote_directory).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let name = safe_entry_name(&entry.name)?;
            let relative = relative_directory.join(name);
            if entry.is_dir && !entry.is_link {
                directories.push(relative.clone());
                stack.push((entry.path, relative));
            } else if !entry.is_dir {
                files.push((entry.path, relative, entry.size));
            }
        }
    }
    Ok((directories, files))
}

async fn collect_local_directory(root: &Path) -> Result<(Vec<PathBuf>, Vec<(PathBuf, PathBuf, u64)>), String> {
    let mut directories = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), PathBuf::new())];
    while let Some((local_directory, relative_directory)) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&local_directory)
            .await
            .map_err(|e| format!("读取本地目录失败 {}: {e}", local_directory.display()))?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| format!("读取本地目录项失败: {e}"))? {
            let file_type = entry.file_type().await.map_err(|e| format!("读取文件类型失败: {e}"))?;
            let name = entry.file_name();
            let relative = relative_directory.join(&name);
            if file_type.is_dir() {
                directories.push(relative.clone());
                stack.push((entry.path(), relative));
            } else if file_type.is_file() {
                let size = entry.metadata().await.map_err(|e| format!("读取文件信息失败: {e}"))?.len();
                files.push((entry.path(), relative, size));
            }
        }
    }
    Ok((directories, files))
}

fn directory_progress_callback(
    app: tauri::AppHandle,
    db: Database,
    payload_base: TransferProgressPayload,
    completed: u64,
    grand_total: u64,
) -> crate::protocol::ssh_backend::TransferProgress {
    let last_emit = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    Arc::new(move |transferred, _| {
        let aggregate = completed.saturating_add(transferred).min(grand_total);
        let mut last = last_emit.lock().expect("directory transfer throttle mutex poisoned");
        if last.elapsed().as_millis() < 250 && aggregate != grand_total { return; }
        *last = std::time::Instant::now();
        let payload = TransferProgressPayload {
            transferred: aggregate,
            total: grand_total,
            status: "running".to_string(),
            error: None,
            ..payload_base.clone()
        };
        let destination = payload.actual_destination.as_deref().unwrap_or_default();
        let _ = db.update_sftp_transfer(&payload.transfer_id, "running", aggregate, grand_total, destination, None, None);
        let _ = app.emit("sftp-transfer-progress", payload);
    })
}

fn emit_directory_checkpoint(
    app: &tauri::AppHandle,
    db: &Database,
    base: &TransferProgressPayload,
    transferred: u64,
    total: u64,
) {
    let destination = base.actual_destination.as_deref().unwrap_or_default();
    let _ = db.update_sftp_transfer(&base.transfer_id, "running", transferred, total, destination, None, None);
    emit_transfer_event(app, &TransferProgressPayload {
        transferred,
        total,
        status: "queued".to_string(),
        error: None,
        ..base.clone()
    });
}

fn effective_rate_limit(options: &SftpTransferOptions, manager: &SftpManager) -> Option<u64> {
    options
        .rate_limit_bps
        .or_else(|| {
            let configured = manager.rate_limit_bps.load(Ordering::Acquire);
            (configured > 0).then_some(configured)
        })
        .filter(|limit| *limit > 0)
}

fn normalize_conflict_policy(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("resume") {
        "overwrite" => Ok("overwrite"),
        "skip" => Ok("skip"),
        "rename" => Ok("rename"),
        "resume" => Ok("resume"),
        _ => Err("无效的冲突策略，应为 overwrite、skip、rename 或 resume".to_string()),
    }
}

fn numbered_local_path(path: &str, index: usize) -> String {
    let path = Path::new(path);
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    let name = match extension {
        Some(extension) => format!("{stem} ({index}).{extension}"),
        None => format!("{stem} ({index})"),
    };
    parent.join(name).to_string_lossy().to_string()
}

fn numbered_remote_path(path: &str, index: usize) -> String {
    let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
    let (stem, extension) = name.rsplit_once('.').map_or((name, None), |(stem, extension)| (stem, Some(extension)));
    let candidate = match extension {
        Some(extension) => format!("{stem} ({index}).{extension}"),
        None => format!("{stem} ({index})"),
    };
    if directory.is_empty() && path.starts_with('/') { format!("/{candidate}") } else if directory.is_empty() { candidate } else if directory == "/" { format!("/{candidate}") } else { format!("{directory}/{candidate}") }
}

async fn unique_local_path(path: &str) -> String {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) { return path.to_string(); }
    for index in 1..10_000 {
        let candidate = numbered_local_path(path, index);
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) { return candidate; }
    }
    format!("{}.{}", path, Uuid::new_v4())
}

async fn unique_remote_path(handle: &Arc<dyn SftpHandle>, path: &str) -> Result<String, String> {
    if handle.stat_size(path).await.map_err(|e| e.to_string())?.is_none() { return Ok(path.to_string()); }
    for index in 1..10_000 {
        let candidate = numbered_remote_path(path, index);
        if handle.stat_size(&candidate).await.map_err(|e| e.to_string())?.is_none() { return Ok(candidate); }
    }
    Ok(format!("{}.{}", path, Uuid::new_v4()))
}

async fn local_sha256(path: &str) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.map_err(|e| format!("打开本地文件以校验失败: {e}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).await.map_err(|e| format!("读取本地文件以校验失败: {e}"))?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn new_transfer_record(
    id: &str,
    connection_id: &str,
    direction: &str,
    source_path: &str,
    destination_path: &str,
    actual_destination: &str,
    policy: &str,
    verify_checksum: bool,
    total: u64,
) -> SftpTransferRecord {
    let now = chrono::Utc::now().timestamp();
    SftpTransferRecord {
        id: id.to_string(),
        connection_id: connection_id.to_string(),
        direction: direction.to_string(),
        source_path: source_path.to_string(),
        destination_path: destination_path.to_string(),
        actual_destination: actual_destination.to_string(),
        file_name: transfer_file_name(if direction == "upload" { source_path } else { destination_path }),
        conflict_policy: policy.to_string(),
        verify_checksum,
        status: "running".to_string(),
        transferred: 0,
        total,
        checksum: None,
        error: None,
        created_at: now,
        updated_at: now,
        completed_at: None,
    }
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
    options: Option<SftpTransferOptions>,
) -> Result<SftpTransferResult, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let connection_id = state.sftp_manager.connection_id(&sftp_id).unwrap_or_default();
    let options = options.unwrap_or_default();
    let policy = normalize_conflict_policy(options.conflict_policy.as_deref())?;
    let total = handle
        .stat_size(&remote_path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "远程文件不存在或无法读取".to_string())?;
    let destination_exists = tokio::fs::try_exists(&local_path).await.unwrap_or(false);
    let actual_destination = match policy {
        "rename" if destination_exists => unique_local_path(&local_path).await,
        _ => local_path.clone(),
    };
    let transfer_id = Uuid::new_v4().to_string();
    let mut record = new_transfer_record(
        &transfer_id,
        &connection_id,
        "download",
        &remote_path,
        &local_path,
        &actual_destination,
        policy,
        options.verify_checksum,
        total,
    );
    state.db.save_sftp_transfer(&record).map_err(|e| e.to_string())?;
    if policy == "skip" && destination_exists {
        record.status = "skipped".to_string();
        state.db.update_sftp_transfer(&transfer_id, "skipped", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
        return Ok(SftpTransferResult { transfer_id, status: "skipped".to_string(), transferred: 0, total, actual_destination, checksum: None });
    }
    if policy == "resume" && destination_exists {
        let local_size = tokio::fs::metadata(&local_path).await.map(|metadata| metadata.len()).unwrap_or(0);
        if local_size == total {
            state.db.update_sftp_transfer(&transfer_id, "skipped", total, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
            return Ok(SftpTransferResult { transfer_id, status: "skipped".to_string(), transferred: total, total, actual_destination, checksum: None });
        }
    }
    if policy == "overwrite" {
        let _ = tokio::fs::remove_file(format!("{actual_destination}.portnest.part")).await;
    }
    let rate_limit_bps = effective_rate_limit(&options, &state.sftp_manager);
    let _permit = state.sftp_manager.acquire_transfer_slot().await;
    state.db.update_sftp_transfer(&transfer_id, "running", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
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
        actual_destination: Some(actual_destination.clone()),
    };
    emit_transfer_event(&app, &base);
    let progress = transfer_progress_callback(app.clone(), state.db.clone(), base.clone());
    let result = handle
        .download(&remote_path, &actual_destination, Some(progress), cancel.clone(), rate_limit_bps)
        .await;
    let outcome = match result {
        Ok(bytes) => {
            let checksum = if options.verify_checksum {
                let local = local_sha256(&actual_destination).await?;
                let remote = handle.checksum_sha256(&remote_path).await.map_err(|e| e.to_string())?;
                if local != remote {
                    let message = format!("SHA-256 校验失败：本地 {local}，远端 {remote}");
                    state.db.update_sftp_transfer(&transfer_id, "error", bytes, total, &actual_destination, None, Some(&message)).map_err(|e| e.to_string())?;
                    emit_transfer_event(&app, &TransferProgressPayload { transferred: bytes, total, status: "error".to_string(), error: Some(message.clone()), ..base.clone() });
                    state.sftp_manager.remove_transfer(&transfer_id);
                    return Err(message);
                }
                Some(local)
            } else { None };
            state.db.update_sftp_transfer(&transfer_id, "done", bytes, total, &actual_destination, checksum.as_deref(), None).map_err(|e| e.to_string())?;
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    transferred: bytes,
                    total: bytes,
                    status: "done".to_string(),
                    ..base
                },
            );
            Ok(SftpTransferResult { transfer_id: transfer_id.clone(), status: "done".to_string(), transferred: bytes, total, actual_destination: actual_destination.clone(), checksum })
        }
        Err(_) if cancel.is_cancelled() => {
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|record| record.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "cancelled", checkpoint, total, &actual_destination, None, Some("传输已取消，可稍后续传")).map_err(|e| e.to_string())?;
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
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|record| record.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "error", checkpoint, total, &actual_destination, None, Some(&e.to_string())).map_err(|db_error| db_error.to_string())?;
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
    options: Option<SftpTransferOptions>,
) -> Result<SftpTransferResult, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let connection_id = state.sftp_manager.connection_id(&sftp_id).unwrap_or_default();
    let options = options.unwrap_or_default();
    let policy = normalize_conflict_policy(options.conflict_policy.as_deref())?;
    let total = tokio::fs::metadata(&local_path).await.map_err(|e| format!("读取本地文件失败: {e}"))?.len();
    let remote_size = handle.stat_size(&remote_path).await.map_err(|e| e.to_string())?;
    let actual_destination = if policy == "rename" && remote_size.is_some() {
        unique_remote_path(&handle, &remote_path).await?
    } else {
        remote_path.clone()
    };
    let transfer_id = Uuid::new_v4().to_string();
    let record = new_transfer_record(
        &transfer_id,
        &connection_id,
        "upload",
        &local_path,
        &remote_path,
        &actual_destination,
        policy,
        options.verify_checksum,
        total,
    );
    state.db.save_sftp_transfer(&record).map_err(|e| e.to_string())?;
    if policy == "skip" && remote_size.is_some() {
        state.db.update_sftp_transfer(&transfer_id, "skipped", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
        return Ok(SftpTransferResult { transfer_id, status: "skipped".to_string(), transferred: 0, total, actual_destination, checksum: None });
    }
    if policy == "resume" && remote_size == Some(total) {
        state.db.update_sftp_transfer(&transfer_id, "skipped", total, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
        return Ok(SftpTransferResult { transfer_id, status: "skipped".to_string(), transferred: total, total, actual_destination, checksum: None });
    }
    if policy == "overwrite" {
        let _ = handle.delete_file(&format!("{actual_destination}.portnest.part")).await;
    }
    let rate_limit_bps = effective_rate_limit(&options, &state.sftp_manager);
    let _permit = state.sftp_manager.acquire_transfer_slot().await;
    state.db.update_sftp_transfer(&transfer_id, "running", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
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
        actual_destination: Some(actual_destination.clone()),
    };
    emit_transfer_event(&app, &base);
    let progress = transfer_progress_callback(app.clone(), state.db.clone(), base.clone());
    let result = handle
        .upload(&local_path, &actual_destination, Some(progress), cancel.clone(), rate_limit_bps)
        .await;
    let outcome = match result {
        Ok(bytes) => {
            let checksum = if options.verify_checksum {
                let local = local_sha256(&local_path).await?;
                let remote = handle.checksum_sha256(&actual_destination).await.map_err(|e| e.to_string())?;
                if local != remote {
                    let message = format!("SHA-256 校验失败：本地 {local}，远端 {remote}");
                    state.db.update_sftp_transfer(&transfer_id, "error", bytes, total, &actual_destination, None, Some(&message)).map_err(|e| e.to_string())?;
                    emit_transfer_event(&app, &TransferProgressPayload { transferred: bytes, total, status: "error".to_string(), error: Some(message.clone()), ..base.clone() });
                    state.sftp_manager.remove_transfer(&transfer_id);
                    return Err(message);
                }
                Some(local)
            } else { None };
            state.db.update_sftp_transfer(&transfer_id, "done", bytes, total, &actual_destination, checksum.as_deref(), None).map_err(|e| e.to_string())?;
            emit_transfer_event(
                &app,
                &TransferProgressPayload {
                    transferred: bytes,
                    total: bytes,
                    status: "done".to_string(),
                    ..base
                },
            );
            Ok(SftpTransferResult { transfer_id: transfer_id.clone(), status: "done".to_string(), transferred: bytes, total, actual_destination: actual_destination.clone(), checksum })
        }
        Err(_) if cancel.is_cancelled() => {
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|record| record.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "cancelled", checkpoint, total, &actual_destination, None, Some("传输已取消，可稍后续传")).map_err(|e| e.to_string())?;
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
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|record| record.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "error", checkpoint, total, &actual_destination, None, Some(&e.to_string())).map_err(|db_error| db_error.to_string())?;
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

/// 递归下载目录。一个目录作为一个持久任务，内部文件共享取消令牌并累计进度。
#[tauri::command]
pub async fn sftp_download_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    options: Option<SftpTransferOptions>,
) -> Result<SftpTransferResult, String> {
    let handle = state.sftp_manager.get(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let connection_id = state.sftp_manager.connection_id(&sftp_id).unwrap_or_default();
    let options = options.unwrap_or_default();
    let policy = normalize_conflict_policy(options.conflict_policy.as_deref())?;
    let (directories, files) = collect_remote_directory(&handle, &remote_path).await?;
    let total = files.iter().map(|(_, _, size)| *size).sum::<u64>();
    let destination_exists = tokio::fs::try_exists(&local_path).await.unwrap_or(false);
    let actual_destination = if policy == "rename" && destination_exists {
        unique_local_path(&local_path).await
    } else {
        local_path.clone()
    };
    let transfer_id = Uuid::new_v4().to_string();
    let record = new_transfer_record(&transfer_id, &connection_id, "download_dir", &remote_path, &local_path, &actual_destination, policy, options.verify_checksum, total);
    state.db.save_sftp_transfer(&record).map_err(|e| e.to_string())?;
    if policy == "skip" && destination_exists {
        state.db.update_sftp_transfer(&transfer_id, "skipped", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
        return Ok(SftpTransferResult { transfer_id, status: "skipped".to_string(), transferred: 0, total, actual_destination, checksum: None });
    }

    let rate_limit_bps = effective_rate_limit(&options, &state.sftp_manager);
    let _permit = state.sftp_manager.acquire_transfer_slot().await;
    state.db.update_sftp_transfer(&transfer_id, "running", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
    let cancel = CancellationToken::default();
    state.sftp_manager.register_transfer(transfer_id.clone(), cancel.clone());
    let base = TransferProgressPayload {
        sftp_id: sftp_id.clone(),
        transfer_id: transfer_id.clone(),
        direction: "download".to_string(),
        file_name: transfer_file_name(&remote_path),
        transferred: 0,
        total,
        status: "running".to_string(),
        error: None,
        actual_destination: Some(actual_destination.clone()),
    };
    emit_transfer_event(&app, &base);
    let result = async {
        tokio::fs::create_dir_all(&actual_destination).await.map_err(|e| format!("创建本地目录失败: {e}"))?;
        for relative in directories.iter().filter(|path| !path.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(Path::new(&actual_destination).join(relative)).await.map_err(|e| format!("创建本地子目录失败: {e}"))?;
        }
        let mut completed = 0_u64;
        let mut manifest = Sha256::new();
        for (remote_file, relative, size) in &files {
            if cancel.is_cancelled() { return Err("传输已取消".to_string()); }
            let destination = Path::new(&actual_destination).join(relative).to_string_lossy().to_string();
            let exists = tokio::fs::try_exists(&destination).await.unwrap_or(false);
            if policy == "skip" && exists {
                completed = completed.saturating_add(*size);
                emit_directory_checkpoint(&app, &state.db, &base, completed, total);
                continue;
            }
            if policy == "resume" && exists && tokio::fs::metadata(&destination).await.map(|item| item.len()).unwrap_or(0) == *size {
                completed = completed.saturating_add(*size);
                emit_directory_checkpoint(&app, &state.db, &base, completed, total);
                continue;
            }
            if policy == "overwrite" { let _ = tokio::fs::remove_file(format!("{destination}.portnest.part")).await; }
            let progress = directory_progress_callback(app.clone(), state.db.clone(), base.clone(), completed, total);
            let bytes = handle.download(remote_file, &destination, Some(progress), cancel.clone(), rate_limit_bps).await.map_err(|e| e.to_string())?;
            if options.verify_checksum {
                let local = local_sha256(&destination).await?;
                let remote = handle.checksum_sha256(remote_file).await.map_err(|e| e.to_string())?;
                if local != remote { return Err(format!("SHA-256 校验失败: {}", relative.display())); }
                manifest.update(relative.to_string_lossy().as_bytes());
                manifest.update(local.as_bytes());
            }
            completed = completed.saturating_add(bytes);
            emit_directory_checkpoint(&app, &state.db, &base, completed, total);
        }
        let checksum = options.verify_checksum.then(|| format!("{:x}", manifest.finalize()));
        Ok::<(u64, Option<String>), String>((completed, checksum))
    }.await;

    let outcome = match result {
        Ok((bytes, checksum)) => {
            state.db.update_sftp_transfer(&transfer_id, "done", bytes, total, &actual_destination, checksum.as_deref(), None).map_err(|e| e.to_string())?;
            emit_transfer_event(&app, &TransferProgressPayload { transferred: bytes, total, status: "done".to_string(), ..base });
            Ok(SftpTransferResult { transfer_id: transfer_id.clone(), status: "done".to_string(), transferred: bytes, total, actual_destination: actual_destination.clone(), checksum })
        }
        Err(message) if cancel.is_cancelled() || message.contains("取消") => {
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|item| item.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "cancelled", checkpoint, total, &actual_destination, None, Some("传输已取消，可稍后续传")).map_err(|e| e.to_string())?;
            emit_transfer_event(&app, &TransferProgressPayload { transferred: checkpoint, total, status: "cancelled".to_string(), error: Some("传输已取消".to_string()), ..base });
            Err("传输已取消".to_string())
        }
        Err(message) => {
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|item| item.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "error", checkpoint, total, &actual_destination, None, Some(&message)).map_err(|e| e.to_string())?;
            emit_transfer_event(&app, &TransferProgressPayload { transferred: checkpoint, total, status: "error".to_string(), error: Some(message.clone()), ..base });
            Err(message)
        }
    };
    state.sftp_manager.remove_transfer(&transfer_id);
    outcome
}

/// 递归上传目录，跳过符号链接，避免循环及意外越过所选目录。
#[tauri::command]
pub async fn sftp_upload_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    options: Option<SftpTransferOptions>,
) -> Result<SftpTransferResult, String> {
    let handle = state.sftp_manager.get(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let connection_id = state.sftp_manager.connection_id(&sftp_id).unwrap_or_default();
    let options = options.unwrap_or_default();
    let policy = normalize_conflict_policy(options.conflict_policy.as_deref())?;
    let (mut directories, files) = collect_local_directory(Path::new(&local_path)).await?;
    directories.sort_by_key(|path| path.components().count());
    let total = files.iter().map(|(_, _, size)| *size).sum::<u64>();
    let destination_exists = handle.stat_size(&remote_path).await.map_err(|e| e.to_string())?.is_some() || handle.list_dir(&remote_path).await.is_ok();
    let actual_destination = if policy == "rename" && destination_exists {
        let mut selected = None;
        for index in 1..10_000 {
            let candidate = numbered_remote_path(&remote_path, index);
            let exists = handle.stat_size(&candidate).await.map_err(|e| e.to_string())?.is_some() || handle.list_dir(&candidate).await.is_ok();
            if !exists { selected = Some(candidate); break; }
        }
        selected.unwrap_or_else(|| format!("{}.{}", remote_path, Uuid::new_v4()))
    } else { remote_path.clone() };
    let transfer_id = Uuid::new_v4().to_string();
    let record = new_transfer_record(&transfer_id, &connection_id, "upload_dir", &local_path, &remote_path, &actual_destination, policy, options.verify_checksum, total);
    state.db.save_sftp_transfer(&record).map_err(|e| e.to_string())?;
    if policy == "skip" && destination_exists {
        state.db.update_sftp_transfer(&transfer_id, "skipped", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
        return Ok(SftpTransferResult { transfer_id, status: "skipped".to_string(), transferred: 0, total, actual_destination, checksum: None });
    }

    let rate_limit_bps = effective_rate_limit(&options, &state.sftp_manager);
    let _permit = state.sftp_manager.acquire_transfer_slot().await;
    state.db.update_sftp_transfer(&transfer_id, "running", 0, total, &actual_destination, None, None).map_err(|e| e.to_string())?;
    let cancel = CancellationToken::default();
    state.sftp_manager.register_transfer(transfer_id.clone(), cancel.clone());
    let base = TransferProgressPayload {
        sftp_id: sftp_id.clone(), transfer_id: transfer_id.clone(), direction: "upload".to_string(),
        file_name: transfer_file_name(&local_path), transferred: 0, total, status: "running".to_string(), error: None,
        actual_destination: Some(actual_destination.clone()),
    };
    emit_transfer_event(&app, &base);
    let result = async {
        if !destination_exists || actual_destination != remote_path { handle.create_dir(&actual_destination).await.map_err(|e| e.to_string())?; }
        for relative in directories.iter().filter(|path| !path.as_os_str().is_empty()) {
            let nested = remote_join(&actual_destination, &relative.to_string_lossy().replace('\\', "/"));
            if handle.stat_size(&nested).await.map_err(|e| e.to_string())?.is_none() && handle.list_dir(&nested).await.is_err() {
                handle.create_dir(&nested).await.map_err(|e| e.to_string())?;
            }
        }
        let mut completed = 0_u64;
        let mut manifest = Sha256::new();
        for (local_file, relative, size) in &files {
            if cancel.is_cancelled() { return Err("传输已取消".to_string()); }
            let destination = remote_join(&actual_destination, &relative.to_string_lossy().replace('\\', "/"));
            let remote_size = handle.stat_size(&destination).await.map_err(|e| e.to_string())?;
            if policy == "skip" && remote_size.is_some() || policy == "resume" && remote_size == Some(*size) {
                completed = completed.saturating_add(*size);
                emit_directory_checkpoint(&app, &state.db, &base, completed, total);
                continue;
            }
            if policy == "overwrite" { let _ = handle.delete_file(&format!("{destination}.portnest.part")).await; }
            let progress = directory_progress_callback(app.clone(), state.db.clone(), base.clone(), completed, total);
            let bytes = handle.upload(&local_file.to_string_lossy(), &destination, Some(progress), cancel.clone(), rate_limit_bps).await.map_err(|e| e.to_string())?;
            if options.verify_checksum {
                let local = local_sha256(&local_file.to_string_lossy()).await?;
                let remote = handle.checksum_sha256(&destination).await.map_err(|e| e.to_string())?;
                if local != remote { return Err(format!("SHA-256 校验失败: {}", relative.display())); }
                manifest.update(relative.to_string_lossy().as_bytes());
                manifest.update(local.as_bytes());
            }
            completed = completed.saturating_add(bytes);
            emit_directory_checkpoint(&app, &state.db, &base, completed, total);
        }
        let checksum = options.verify_checksum.then(|| format!("{:x}", manifest.finalize()));
        Ok::<(u64, Option<String>), String>((completed, checksum))
    }.await;
    let outcome = match result {
        Ok((bytes, checksum)) => {
            state.db.update_sftp_transfer(&transfer_id, "done", bytes, total, &actual_destination, checksum.as_deref(), None).map_err(|e| e.to_string())?;
            emit_transfer_event(&app, &TransferProgressPayload { transferred: bytes, total, status: "done".to_string(), ..base });
            Ok(SftpTransferResult { transfer_id: transfer_id.clone(), status: "done".to_string(), transferred: bytes, total, actual_destination: actual_destination.clone(), checksum })
        }
        Err(message) if cancel.is_cancelled() || message.contains("取消") => {
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|item| item.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "cancelled", checkpoint, total, &actual_destination, None, Some("传输已取消，可稍后续传")).map_err(|e| e.to_string())?;
            emit_transfer_event(&app, &TransferProgressPayload { transferred: checkpoint, total, status: "cancelled".to_string(), error: Some("传输已取消".to_string()), ..base });
            Err("传输已取消".to_string())
        }
        Err(message) => {
            let checkpoint = state.db.get_sftp_transfer(&transfer_id).map(|item| item.transferred).unwrap_or(0);
            state.db.update_sftp_transfer(&transfer_id, "error", checkpoint, total, &actual_destination, None, Some(&message)).map_err(|e| e.to_string())?;
            emit_transfer_event(&app, &TransferProgressPayload { transferred: checkpoint, total, status: "error".to_string(), error: Some(message.clone()), ..base });
            Err(message)
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

#[tauri::command]
pub async fn list_sftp_transfers(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SftpTransferRecord>, String> {
    state.db.list_sftp_transfers(&connection_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_sftp_transfer_history(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<usize, String> {
    state.db.clear_sftp_transfer_history(&connection_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn configure_sftp_transfer_queue(
    state: tauri::State<'_, AppState>,
    max_concurrent: usize,
    rate_limit_bps: u64,
) -> Result<SftpQueueConfig, String> {
    if !(1..=8).contains(&max_concurrent) {
        return Err("并发传输数必须在 1 到 8 之间".to_string());
    }
    state.sftp_manager.configure_queue(max_concurrent, rate_limit_bps);
    Ok(state.sftp_manager.queue_config())
}

#[tauri::command]
pub async fn get_sftp_transfer_queue(
    state: tauri::State<'_, AppState>,
) -> Result<SftpQueueConfig, String> {
    Ok(state.sftp_manager.queue_config())
}

#[tauri::command]
pub async fn sftp_retry_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    transfer_id: String,
) -> Result<SftpTransferResult, String> {
    let previous = state.db.get_sftp_transfer(&transfer_id).map_err(|e| e.to_string())?;
    let connection_id = state.sftp_manager.connection_id(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    if !previous.connection_id.is_empty() && previous.connection_id != connection_id {
        return Err("该传输记录不属于当前连接".to_string());
    }
    let options = Some(SftpTransferOptions {
        conflict_policy: Some("resume".to_string()),
        verify_checksum: previous.verify_checksum,
        rate_limit_bps: None,
    });
    if previous.direction == "download" {
        sftp_download(app, state, sftp_id, previous.source_path, previous.actual_destination, options).await
    } else if previous.direction == "upload" {
        sftp_upload(app, state, sftp_id, previous.source_path, previous.actual_destination, options).await
    } else if previous.direction == "download_dir" {
        sftp_download_directory(app, state, sftp_id, previous.source_path, previous.actual_destination, options).await
    } else if previous.direction == "upload_dir" {
        sftp_upload_directory(app, state, sftp_id, previous.source_path, previous.actual_destination, options).await
    } else {
        Err("无法重试未知类型的传输".to_string())
    }
}

#[tauri::command]
pub async fn sftp_set_permissions(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    if mode > 0o7777 {
        return Err("权限值必须在 0000 到 7777 之间".to_string());
    }
    let handle = state.sftp_manager.get(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    handle.set_permissions(&path, mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_set_owner(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<(), String> {
    if uid.is_none() && gid.is_none() {
        return Err("UID 和 GID 至少填写一项".to_string());
    }
    let handle = state.sftp_manager.get(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    handle.set_owner(&path, uid, gid).await.map_err(|e| e.to_string())
}

const REMOTE_EDITOR_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct SftpTextFile {
    pub content: String,
    pub size: usize,
    pub checksum: String,
}

#[tauri::command]
pub async fn sftp_read_text_file(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<SftpTextFile, String> {
    let handle = state.sftp_manager.get(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let data = handle.read_file(&path, REMOTE_EDITOR_MAX_BYTES).await.map_err(|e| e.to_string())?;
    if data.contains(&0) {
        return Err("该文件包含二进制数据，不能使用文本编辑器打开".to_string());
    }
    let size = data.len();
    let checksum = format!("{:x}", Sha256::digest(&data));
    let content = String::from_utf8(data).map_err(|_| "该文件不是有效的 UTF-8 文本，不能直接编辑".to_string())?;
    Ok(SftpTextFile { content, size, checksum })
}

#[tauri::command]
pub async fn sftp_write_text_file(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    path: String,
    content: String,
    expected_checksum: String,
) -> Result<String, String> {
    if content.len() > REMOTE_EDITOR_MAX_BYTES {
        return Err(format!("编辑内容超过 {} MiB 上限", REMOTE_EDITOR_MAX_BYTES / 1024 / 1024));
    }
    let handle = state.sftp_manager.get(&sftp_id).ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let current = handle.checksum_sha256(&path).await.map_err(|e| e.to_string())?;
    if current != expected_checksum {
        return Err("远程文件在编辑期间已被其他程序修改，请重新加载后再保存".to_string());
    }
    handle.write_file_atomic(&path, content.as_bytes()).await.map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(content.as_bytes())))
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
    let lease = state.sftp_manager.lease(&sftp_id);
    state.sftp_manager.remove(&sftp_id);
    if let Some((key, owner)) = lease { state.ssh_session_pool.release(&key, &owner).await; }
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
    let lease = state.sftp_manager.lease(&sftp_id);
    state.sftp_manager.remove(&sftp_id);
    if let Some((key, owner)) = lease { state.ssh_session_pool.release(&key, &owner).await; }
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
    for mut connection in state.db.get_connections().map_err(|e| e.to_string())? {
        let mut credential = state
            .db
            .get_credential_structured(&connection.credential_id)
            .map_err(|e| e.to_string())?;
        if !include_passwords {
            credential.password = None;
            credential.passphrase = None;
            credential.proxy_password = None;
        }
        if let Some(raw) = connection.options.as_deref() {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) {
                if let Some(proxy) = value.get_mut("proxy").and_then(|proxy| proxy.as_object_mut()) {
                    proxy.remove("password");
                }
                connection.options = serde_json::to_string(&value).ok();
            }
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
    let connection_ids: HashMap<String, Uuid> = bundle.connections.iter()
        .map(|item| (item.connection.id.clone(), Uuid::new_v4()))
        .collect();
    for item in bundle.connections {
        let connection_id = connection_ids[&item.connection.id];
        let credential_id = Uuid::new_v4();
        let mut credential = item.credential;
        credential.key_id = None;
        let remapped_options = item.connection.options.as_deref().map(|raw| {
            let mut value = serde_json::from_str::<serde_json::Value>(raw).unwrap_or_default();
            if let Some(jump_id) = value.get_mut("proxy")
                .and_then(|proxy| proxy.get_mut("jump_connection_id"))
                .and_then(|id| id.as_str()).map(str::to_string)
            {
                if let Some(new_id) = connection_ids.get(&jump_id) {
                    if let Some(proxy) = value.get_mut("proxy").and_then(|proxy| proxy.as_object_mut()) {
                        proxy.insert("jump_connection_id".to_string(), serde_json::Value::String(new_id.to_string()));
                    }
                }
            }
            serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
        });
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
                remapped_options.as_deref(),
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
    let test_timeout = std::time::Duration::from_millis(config.timeout_ms.unwrap_or(30_000));
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
            let pass = config.password.clone().unwrap_or_default();
            (CredentialType::Password, Some(pass), None, None)
        }
        "key" => {
            let key = config.private_key.clone().unwrap_or_default();
            (CredentialType::PrivateKey, None, Some(key), None)
        }
        "key_with_passphrase" => {
            let key = config.private_key.clone().unwrap_or_default();
            let pass = config.passphrase.clone().unwrap_or_default();
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
    if let Some(database) = config.database.as_ref().filter(|value| !value.trim().is_empty()) {
        options.protocol_options.insert("database".to_string(), database.trim().to_string());
    }
    if let Some(proxy_type) = &config.proxy_type {
        options.proxy = Some(crate::protocol::ProxyConfig {
            proxy_type: proxy_type.clone(),
            host: config.proxy_host.clone().unwrap_or_default(),
            port: config.proxy_port.unwrap_or_default(),
            username: config.proxy_username.clone(),
            password: config.proxy_password.clone(),
            jump_connection_id: config.jump_connection_id.clone(),
            jump: None,
        });
    }

    if config.protocol == "ssh" {
        let transient_data = CredentialData {
            auth_type: config.auth_type.clone(),
            password: credential.password.clone(),
            private_key: credential.private_key.clone(),
            passphrase: credential.passphrase.clone(),
            key_id: config.key_id.clone(),
            proxy_password: config.proxy_password.clone(),
        };
        options = resolve_ssh_options(
            state.inner(),
            config.id.as_str(),
            options,
            &transient_data,
        )?;
        let target = ConnectionTarget {
            host: config.host,
            port: config.port,
            username: config.username,
        };
        match tokio::time::timeout(
            test_timeout,
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
            test_timeout,
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
            Ok(Ok(handle)) => match plugin.health_check(handle.as_ref()).await {
                Ok(true) => Ok("连接成功".to_string()),
                Ok(false) => Err("连接验证失败".to_string()),
                Err(error) => Err(format!("连接验证失败: {error}")),
            },
            Ok(Err(error)) => Err(format!("连接失败: {error}")),
            Err(_) => Err("连接超时".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SshRouteTestResult {
    pub success: bool,
    pub route: String,
    pub stage: String,
    pub message: String,
    pub suggestion: Option<String>,
}

#[tauri::command]
pub async fn test_ssh_route(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfigRequest,
) -> Result<SshRouteTestResult, String> {
    let route = match config.proxy_type.as_deref() {
        Some("socks5") => "SOCKS5 → SSH",
        Some("http") => "HTTP CONNECT → SSH",
        Some("ssh_jump") => "SSH 跳板机 → 目标 SSH",
        _ => "直连 SSH",
    }.to_string();
    match test_connection(state, config).await {
        Ok(message) => Ok(SshRouteTestResult {
            success: true,
            route,
            stage: "authenticated".to_string(),
            message,
            suggestion: None,
        }),
        Err(message) => {
            let stage = if message.contains("代理") || message.contains("SOCKS5") || message.contains("HTTP CONNECT") { "proxy" }
                else if message.contains("跳板") { "jump" }
                else if message.contains("认证") || message.contains("密码") { "authentication" }
                else if message.contains("握手") || message.contains("主机密钥") { "ssh_handshake" }
                else { "connect" };
            let suggestion = match stage {
                "proxy" => "检查代理地址、端口、认证方式和网络访问权限",
                "jump" => "检查跳板资产凭据，并确认跳板服务器允许 TCP 转发",
                "authentication" => "检查目标 SSH 用户名、密码或私钥",
                "ssh_handshake" => "检查目标 SSH 服务和主机密钥记录",
                _ => "检查目标地址、端口、防火墙和连接超时设置",
            };
            Ok(SshRouteTestResult {
                success: false,
                route,
                stage: stage.to_string(),
                message,
                suggestion: Some(suggestion.to_string()),
            })
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

#[cfg(test)]
mod sftp_command_tests {
    use super::{normalize_conflict_policy, numbered_local_path, numbered_remote_path, remote_join, safe_entry_name, SftpManager};
    use std::sync::Arc;

    #[test]
    fn validates_transfer_conflict_policy() {
        assert_eq!(normalize_conflict_policy(None).unwrap(), "resume");
        assert_eq!(normalize_conflict_policy(Some("overwrite")).unwrap(), "overwrite");
        assert!(normalize_conflict_policy(Some("ask")).is_err());
    }

    #[test]
    fn creates_numbered_paths_without_losing_extensions() {
        assert_eq!(numbered_local_path("C:\\tmp\\archive.tar.gz", 2), "C:\\tmp\\archive.tar (2).gz");
        assert_eq!(numbered_remote_path("/var/log/app.log", 3), "/var/log/app (3).log");
        assert_eq!(numbered_remote_path("/README", 1), "/README (1)");
    }

    #[test]
    fn joins_remote_paths_and_rejects_traversal_entries() {
        assert_eq!(remote_join("/", "logs"), "/logs");
        assert_eq!(remote_join("/var/", "logs"), "/var/logs");
        assert!(safe_entry_name("..").is_err());
        assert!(safe_entry_name("nested/file").is_err());
        assert_eq!(safe_entry_name("应用.log").unwrap(), "应用.log");
    }

    #[tokio::test]
    async fn transfer_queue_respects_dynamic_concurrency_limit() {
        let manager = Arc::new(SftpManager::new());
        manager.configure_queue(1, 128 * 1024);
        let first = manager.acquire_transfer_slot().await;
        let waiting_manager = manager.clone();
        let mut waiting = tokio::spawn(async move { waiting_manager.acquire_transfer_slot().await });
        assert!(tokio::time::timeout(std::time::Duration::from_millis(40), &mut waiting).await.is_err());
        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await.unwrap().unwrap();
        assert_eq!(manager.queue_config().active, 1);
        drop(second);
        assert_eq!(manager.queue_config().active, 0);
        assert_eq!(manager.queue_config().rate_limit_bps, 128 * 1024);
    }
}
