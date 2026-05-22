//! Tauri 命令接口

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::ai::{AIAnalyzer, AnalyzeRequest, ConnectionInfo};
use crate::connection::ConnectionManager;
use crate::protocol::PluginRegistry;
use crate::storage::{ConnectionRecord, Database};

/// 应用状态
pub struct AppState {
    pub db: Database,
    pub connection_manager: Arc<ConnectionManager>,
    pub plugin_registry: Arc<PluginRegistry>,
    pub ai_analyzer: AIAnalyzer,
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
        })
    }

    fn register_plugins(registry: &Arc<PluginRegistry>) {
        registry.register(crate::protocol::ssh::SshPlugin::new());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfigRequest {
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
    let id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();

    let auth_type = config.auth_type.as_str();
    let mut credential_data = Vec::new();

    match auth_type {
        "password" => {
            credential_data.extend_from_slice(config.password.as_ref().unwrap().as_bytes());
        }
        "key" | "key_with_passphrase" => {
            credential_data.extend_from_slice(config.private_key.as_ref().unwrap().as_bytes());
            if let Some(pass) = &config.passphrase {
                credential_data.extend_from_slice(b"\0");
                credential_data.extend_from_slice(pass.as_bytes());
            }
        }
        _ => {}
    }

    state
        .db
        .save_credential(credential_id, &config.name, auth_type, &credential_data)
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
            config.options.as_deref(),
            config.tags.as_deref(),
            config.color.as_deref(),
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
pub fn get_protocols(state: tauri::State<'_, AppState>) -> Vec<ProtocolInfo> {
    state
        .plugin_registry
        .list_protocols()
        .into_iter()
        .map(|(id, name)| ProtocolInfo { id: id.to_string(), name: name.to_string() })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolInfo {
    pub id: String,
    pub name: String,
}