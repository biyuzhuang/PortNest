//! Tauri 命令接口

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
use parking_lot::RwLock;
use std::collections::HashMap;

use crate::ai::{AIAnalyzer, AnalyzeRequest, ConnectionInfo};
use crate::connection::ConnectionManager;
use crate::protocol::{ConnectionHandle, Credential, CredentialType};
use crate::protocol::PluginRegistry;
use crate::protocol::docker::{
    ContainerInfo, DockerContainerCreateConfig, DockerSystemInfo, ImageInfo, NetworkInfo,
    VolumeInfo, ContainerStats,
};
use crate::storage::{ConnectionRecord, Database, CredentialData};

/// Shell 会话信息
struct ShellSessionInfo {
    _connection_id: String,
    handle: Arc<dyn ConnectionHandle>,
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

    fn insert(&self, shell_id: String, connection_id: String, handle: Arc<dyn ConnectionHandle>) {
        self.sessions.write().insert(shell_id, ShellSessionInfo {
            _connection_id: connection_id,
            handle,
        });
    }

    fn get(&self, shell_id: &str) -> Option<Arc<dyn ConnectionHandle>> {
        self.sessions.read().get(shell_id).map(|s| s.handle.clone())
    }

    fn remove(&self, shell_id: &str) {
        self.sessions.write().remove(shell_id);
    }
}

/// SFTP 会话信息
struct SftpSessionInfo {
    _connection_id: String,
    handle: Arc<crate::protocol::sftp::SftpConnectionHandle>,
    #[allow(dead_code)]
    ssh_handle: Arc<dyn ConnectionHandle>,
}

/// SFTP 会话管理器
pub(crate) struct SftpManager {
    sessions: RwLock<HashMap<String, SftpSessionInfo>>,
}

impl SftpManager {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    fn insert(&self, sftp_id: String, connection_id: String, handle: Arc<crate::protocol::sftp::SftpConnectionHandle>, ssh_handle: Arc<dyn ConnectionHandle>) {
        self.sessions.write().insert(sftp_id, SftpSessionInfo {
            _connection_id: connection_id,
            handle,
            ssh_handle,
        });
    }

    fn get(&self, sftp_id: &str) -> Option<Arc<crate::protocol::sftp::SftpConnectionHandle>> {
        self.sessions.read().get(sftp_id).map(|s| s.handle.clone())
    }

    fn get_ssh_handle(&self, sftp_id: &str) -> Option<Arc<dyn ConnectionHandle>> {
        self.sessions.read().get(sftp_id).map(|s| s.ssh_handle.clone())
    }

    fn remove(&self, sftp_id: &str) {
        self.sessions.write().remove(sftp_id);
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

    fn insert(&self, connection_id: String, handle: Arc<crate::protocol::docker::DockerConnectionHandle>) {
        self.sessions.write().insert(connection_id.clone(), DockerSessionInfo {
            _connection_id: connection_id,
            handle,
        });
    }

    fn get(&self, connection_id: &str) -> Option<Arc<crate::protocol::docker::DockerConnectionHandle>> {
        self.sessions.read().get(connection_id).map(|s| s.handle.clone())
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
    pub(crate) shell_manager: Arc<ShellManager>,
    pub(crate) sftp_manager: Arc<SftpManager>,
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
            shell_manager: Arc::new(ShellManager::new()),
            sftp_manager: Arc::new(SftpManager::new()),
            docker_manager: Arc::new(DockerManager::new()),
        })
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
    let credential_id = Uuid::new_v4();

    let auth_type = config.auth_type.as_str();
    
    // 使用结构化 JSON 格式存储凭证
    let cred_data = CredentialData {
        auth_type: auth_type.to_string(),
        password: config.password.clone(),
        private_key: config.private_key.clone(),
        passphrase: config.passphrase.clone(),
    };

    state
        .db
        .save_credential_structured(credential_id, &config.name, auth_type, &cred_data)
        .map_err(|e| e.to_string())?;

    // Build options JSON with proxy and encoding settings
    let mut options_map = serde_json::Map::new();
    if let (Some(proxy_type), Some(proxy_host), Some(proxy_port)) =
        (&config.proxy_type, &config.proxy_host, &config.proxy_port) {
        let mut proxy_map = serde_json::Map::new();
        proxy_map.insert("type".to_string(), serde_json::Value::String(proxy_type.clone()));
        proxy_map.insert("host".to_string(), serde_json::Value::String(proxy_host.clone()));
        proxy_map.insert("port".to_string(), serde_json::Value::Number((*proxy_port).into()));
        if let Some(username) = &config.proxy_username {
            proxy_map.insert("username".to_string(), serde_json::Value::String(username.clone()));
        }
        if let Some(password) = &config.proxy_password {
            proxy_map.insert("password".to_string(), serde_json::Value::String(password.clone()));
        }
        options_map.insert("proxy".to_string(), serde_json::Value::Object(proxy_map));
    }
    if let Some(encoding) = &config.encoding {
        options_map.insert("encoding".to_string(), serde_json::Value::String(encoding.clone()));
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

    state.ai_analyzer.analyze(request).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_protocols(state: tauri::State<'_, AppState>) -> Vec<ProtocolInfoResponse> {
    state
        .plugin_registry
        .list_protocols()
        .into_iter()
        .map(|(id, name)| ProtocolInfoResponse { id: id.to_string(), name: name.to_string() })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolInfoResponse {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellOpenResponse {
    pub shell_id: String,
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
        "password" => (
            CredentialType::Password,
            cred_data.password,
            None,
            None,
        ),
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

    let handle: Arc<dyn ConnectionHandle> = plugin
        .connect(&conn.host, conn.port, conn.username.as_deref().unwrap_or(""), &credential, &options)
        .await
        .map_err(|e| e.to_string())?
        .into();
    tracing::info!("SSH connection established to {}:{}", conn.host, conn.port);

    let handle_clone = handle.clone();
    tracing::info!("Opening shell with cols={}, rows={}", cols, rows);
    let shell = tokio::task::spawn_blocking(move || {
        handle_clone.open_shell(cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    tracing::info!("Shell opened successfully: id={}", shell.id);

    state.shell_manager.insert(
        shell.id.to_string(),
        connection_id,
        handle,
    );

    Ok(ShellOpenResponse {
        shell_id: shell.id.to_string(),
    })
}

#[tauri::command]
pub async fn write_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
    data: String,
) -> Result<(), String> {
    let shell_uuid = Uuid::parse_str(&shell_id).map_err(|e| e.to_string())?;
    let handle = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;
    let data = data.into_bytes();
    tracing::debug!("write_shell: writing {} bytes to shell {:?}", data.len(), shell_uuid);

    tokio::task::spawn_blocking(move || {
        handle.write_shell(&shell_uuid, &data)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn read_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<String, String> {
    let shell_uuid = Uuid::parse_str(&shell_id).map_err(|e| e.to_string())?;
    let handle = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;

    let result = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        tracing::debug!("read_shell calling handle.read_shell for {:?}", shell_uuid);
        match handle.read_shell(&shell_uuid, &mut buf) {
            Ok(n) => {
                if n > 0 {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    tracing::info!("read_shell: got {} chars: {:?}", n, &data[..std::cmp::min(n, 100)]);
                    Ok(data)
                } else {
                    tracing::trace!("read_shell: no data");
                    Ok(String::new())
                }
            }
            Err(e) => {
                tracing::error!("read_shell error: {:?}", e);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub async fn resize_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let shell_uuid = Uuid::parse_str(&shell_id).map_err(|e| e.to_string())?;
    let handle = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;

    tokio::task::spawn_blocking(move || {
        handle.resize_shell(&shell_uuid, cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn close_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<(), String> {
    let shell_uuid = Uuid::parse_str(&shell_id).map_err(|e| e.to_string())?;
    let handle = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;

    tokio::task::spawn_blocking(move || {
        handle.close_shell(&shell_uuid)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

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
    let shell_uuid = Uuid::parse_str(&shell_id).map_err(|e| e.to_string())?;
    let handle = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;

    // 在单个任务中顺序执行：先关闭 shell，再断开连接
    // 避免并发操作同一 handle 导致的竞态条件
    tokio::task::spawn_blocking(move || {
        // 先关闭 shell channel
        if let Err(e) = handle.close_shell(&shell_uuid) {
            tracing::warn!("关闭 shell channel 失败: {:?}", e);
        }
        // 再断开 SSH session
        if let Err(e) = handle.disconnect() {
            tracing::warn!("断开 SSH session 失败: {:?}", e);
        }
    })
    .await
    .map_err(|e| e.to_string())?;

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
        "password" => (
            CredentialType::Password,
            cred_data.password,
            None,
            None,
        ),
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
        .connect(&conn.host, conn.port, conn.username.as_deref().unwrap_or(""), &credential, &options)
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
                rows[0].columns().iter().map(|c| c.name_str().to_string()).collect()
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
                                    mysql_async::Value::Bytes(b) => serde_json::Value::String(String::from_utf8_lossy(&b).to_string()),
                                    mysql_async::Value::Int(i) => serde_json::Value::Number(i.into()),
                                    mysql_async::Value::UInt(u) => serde_json::Value::Number(u.into()),
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
        "postgresql" => {
            Err("PostgreSQL 查询暂未实现".to_string())
        }
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

    let analysis = state.ai_analyzer.analyze(request).await.map_err(|e| e.to_string())?;

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
        "password" => (
            CredentialType::Password,
            cred_data.password,
            None,
            None,
        ),
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
        .connect(&conn.host, conn.port, conn.username.as_deref().unwrap_or(""), &credential, &options)
        .await
        .map_err(|e| e.to_string())?;

    // SSH 连接才能创建 SFTP
    let ssh_handle = handle
        .as_any()
        .downcast_ref::<crate::protocol::ssh::SshConnectionHandle>()
        .ok_or_else(|| "此协议不支持 SFTP".to_string())?;

    let sftp_handle = crate::protocol::sftp::SftpConnectionHandle::from_ssh(ssh_handle)
        .map_err(|e| e.to_string())?;

    // Convert Box<dyn ConnectionHandle> to Arc<dyn ConnectionHandle>
    let handle_arc: Arc<dyn ConnectionHandle> = handle.into();

    let sftp_id = Uuid::new_v4().to_string();

    state.sftp_manager.insert(
        sftp_id.clone(),
        connection_id,
        Arc::new(sftp_handle),
        handle_arc,
    );

    Ok(SftpOpenResponse { sftp_id })
}

/// 通过已有 Shell 会话打开 SFTP（复用 SSH 连接，不创建新连接）
#[tauri::command]
pub async fn open_sftp_for_shell(
    state: tauri::State<'_, AppState>,
    shell_id: String,
) -> Result<SftpOpenResponse, String> {
    let ssh_handle = state
        .shell_manager
        .get(&shell_id)
        .ok_or_else(|| "Shell 会话未找到".to_string())?;

    let ssh_conn = ssh_handle
        .as_any()
        .downcast_ref::<crate::protocol::ssh::SshConnectionHandle>()
        .ok_or_else(|| "此连接不支持 SFTP".to_string())?;

    let sftp_handle = crate::protocol::sftp::SftpConnectionHandle::from_ssh(ssh_conn)
        .map_err(|e| e.to_string())?;

    // 恢复非阻塞模式，避免影响 Shell 读写
    ssh_conn.session().set_blocking(false);

    let sftp_id = Uuid::new_v4().to_string();

    // 共享 Shell 的 SSH 句柄，不独立持有
    state.sftp_manager.insert(
        sftp_id.clone(),
        String::new(),
        Arc::new(sftp_handle),
        ssh_handle.clone(),
    );

    Ok(SftpOpenResponse { sftp_id })
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

    let handle = handle.clone();
    tokio::task::spawn_blocking(move || {
        handle.list_dir(&path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// 下载文件
#[tauri::command]
pub async fn sftp_download(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let handle = handle.clone();
    let remote_path = remote_path.clone();
    let local_path = local_path.clone();
    tokio::task::spawn_blocking(move || {
        handle.download_file(&remote_path, &local_path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// 上传文件
#[tauri::command]
pub async fn sftp_upload(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let handle = state
        .sftp_manager
        .get(&sftp_id)
        .ok_or_else(|| "SFTP 会话未找到".to_string())?;
    let handle = handle.clone();
    let remote_path = remote_path.clone();
    let local_path = local_path.clone();
    tokio::task::spawn_blocking(move || {
        handle.upload_file(&local_path, &remote_path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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
    let handle = handle.clone();
    let path = path.clone();
    tokio::task::spawn_blocking(move || {
        handle.create_dir(&path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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
    let handle = handle.clone();
    let path = path.clone();
    tokio::task::spawn_blocking(move || {
        handle.delete_file(&path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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

    handle.delete_dir(&path).map_err(|e| e.to_string())
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
    let handle = handle.clone();
    let old_path = old_path.clone();
    let new_path = new_path.clone();
    tokio::task::spawn_blocking(move || {
        handle.rename(&old_path, &new_path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// 关闭 SFTP 会话（不主动断开 SSH，因为可能被 shell 共享）
#[tauri::command]
pub async fn close_sftp(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
) -> Result<(), String> {
    state.sftp_manager.remove(&sftp_id);
    Ok(())
}

/// 关闭独立 SFTP 连接（旧版兼容，会断开 SSH）
#[tauri::command]
pub async fn close_sftp_independent(
    state: tauri::State<'_, AppState>,
    sftp_id: String,
) -> Result<(), String> {
    if let Some(ssh_handle) = state.sftp_manager.get_ssh_handle(&sftp_id) {
        let _ = tokio::task::spawn_blocking(move || {
            ssh_handle.disconnect()
        }).await;
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
pub async fn delete_folder(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.delete_folder(&id).map_err(|e| e.to_string())
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

// ==================== Test Connection ====================

#[tauri::command]
pub async fn test_connection(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfigRequest,
) -> Result<String, String> {
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
            (CredentialType::PrivateKeyWithPassphrase, None, Some(key), Some(pass))
        }
        "agent" => {
            (CredentialType::Agent, None, None, None)
        }
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
        (&config.proxy_type, &config.proxy_host, &config.proxy_port) {
        options.proxy = Some(crate::protocol::ProxyConfig {
            proxy_type: proxy_type.clone(),
            host: proxy_host.clone(),
            port: *proxy_port,
            username: config.proxy_username.clone(),
            password: config.proxy_password.clone(),
        });
    }

    // Try to connect with timeout
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        plugin.connect(&config.host, config.port, &config.username, &credential, &options),
    )
    .await;

    match result {
        Ok(Ok(_handle)) => {
            // Connection successful, handle dropped automatically
            Ok("连接成功".to_string())
        }
        Ok(Err(e)) => Err(format!("连接失败: {}", e)),
        Err(_) => Err("连接超时".to_string()),
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
        .connect(&conn.host, conn.port, conn.username.as_deref().unwrap_or(""), &credential, &options)
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

    handle.create_container(config).await.map_err(|e| e.to_string())
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

    handle.start_container(&container_id).await.map_err(|e| e.to_string())
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

    handle.stop_container(&container_id, timeout).await.map_err(|e| e.to_string())
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

    handle.restart_container(&container_id, timeout).await.map_err(|e| e.to_string())
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

    handle.kill_container(&container_id, signal.as_deref()).await.map_err(|e| e.to_string())
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

    handle.remove_container(&container_id, force).await.map_err(|e| e.to_string())
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

    handle.logs(&container_id, tail, false).await.map_err(|e| e.to_string())
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

    handle.pull_image(&image, tag.as_deref()).await.map_err(|e| e.to_string())
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

    handle.remove_image(&image_id, force).await.map_err(|e| e.to_string())
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

    handle.create_volume(&name, &driver).await.map_err(|e| e.to_string())
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

    handle.remove_volume(&volume_name).await.map_err(|e| e.to_string())
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

    handle.create_network(&name, &driver).await.map_err(|e| e.to_string())
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

    handle.remove_network(&network_id).await.map_err(|e| e.to_string())
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