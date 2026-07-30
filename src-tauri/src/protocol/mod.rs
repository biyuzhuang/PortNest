//! 协议插件接口定义
//!
//! 所有协议插件 (SSH, RDP, SFTP, MySQL, PostgreSQL 等) 必须实现此接口

use async_trait::async_trait;
use std::collections::HashMap;
use uuid::Uuid;

use crate::error::{Error, Result};

/// 协议能力枚举
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolCapability {
    /// 终端交互
    Terminal,
    /// 文件传输
    FileTransfer,
    /// 隧道/端口转发
    Tunnel,
    /// 数据库查询
    Query,
    /// AI 辅助分析
    AIAnalysis,
    /// 远程桌面
    RemoteDesktop,
}

/// 连接元数据
#[derive(Debug, Clone)]
pub struct ConnectionMetadata {
    pub session_id: Uuid,
    pub protocol: String,
    pub server_version: Option<String>,
    pub connection_time_ms: u64,
    pub keepalive_interval: Option<u32>,
}

/// 连接选项
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ConnectionOptions {
    /// 超时时间（毫秒）
    pub timeout_ms: Option<u64>,
    /// Keepalive 间隔（秒）
    pub keepalive_interval: Option<u32>,
    /// 压缩
    pub compression: Option<bool>,
    /// 代理设置
    pub proxy: Option<ProxyConfig>,
    /// 协议特定选项
    pub protocol_options: HashMap<String, String>,
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        Self {
            timeout_ms: Some(30000),
            keepalive_interval: None,
            compression: None,
            proxy: None,
            protocol_options: HashMap::new(),
        }
    }
}

/// 代理配置
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxyConfig {
    #[serde(alias = "type")]
    pub proxy_type: String, // socks5, http
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// 命令执行结果
#[derive(Debug, Clone)]
pub struct CommandResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
    pub duration_ms: u64,
}

/// 会话状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

/// 协议插件 Trait - 所有协议必须实现
#[async_trait]
pub trait ProtocolPlugin: Send + Sync {
    /// 获取协议唯一标识符
    fn protocol_id(&self) -> &'static str;

    /// 获取协议显示名称
    fn display_name(&self) -> &'static str;

    /// 获取支持的协议能力列表
    fn capabilities(&self) -> Vec<ProtocolCapability>;

    /// 获取默认端口
    fn default_port(&self) -> u16;

    /// 建立连接
    async fn connect(
        &self,
        host: &str,
        port: u16,
        username: &str,
        credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>>;

    /// 检查连接健康状态
    async fn health_check(&self, handle: &dyn ConnectionHandle) -> Result<bool>;

    /// 获取连接元数据
    async fn get_metadata(&self, handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata>;
}

/// 凭据类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialType {
    Password,
    PrivateKey,
    PrivateKeyWithPassphrase,
    Agent,
}

/// 凭据数据
#[derive(Debug, Clone)]
pub struct Credential {
    pub credential_type: CredentialType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

/// 连接句柄接口
pub trait ConnectionHandle: Send + Sync + std::any::Any {
    fn id(&self) -> Uuid;
    fn protocol(&self) -> &'static str;
    fn is_connected(&self) -> bool;
    fn status(&self) -> SessionStatus;

    /// 获取远程地址
    fn remote_addr(&self) -> (&str, u16);

    /// 类型转换支持（用于 downcast）
    fn as_any(&self) -> &dyn std::any::Any;

    /// 打开交互式 shell (PTY)
    fn open_shell(&self, _cols: u32, _rows: u32) -> Result<ShellChannel> {
        Err(Error::ProtocolError("此协议不支持 shell".to_string()))
    }

    /// 读取 shell 数据
    fn read_shell(&self, _shell_id: &Uuid, _buf: &mut [u8]) -> Result<usize> {
        Err(Error::ProtocolError("此协议不支持 shell".to_string()))
    }

    /// 写入 shell 数据
    fn write_shell(&self, _shell_id: &Uuid, _data: &[u8]) -> Result<usize> {
        Err(Error::ProtocolError("此协议不支持 shell".to_string()))
    }

    /// 调整 shell 大小
    fn resize_shell(&self, _shell_id: &Uuid, _cols: u32, _rows: u32) -> Result<()> {
        Err(Error::ProtocolError("此协议不支持 shell".to_string()))
    }

    /// 关闭 shell
    fn close_shell(&self, _shell_id: &Uuid) -> Result<()> {
        Err(Error::ProtocolError("此协议不支持 shell".to_string()))
    }

    /// 断开连接（彻底关闭 SSH 会话）
    fn disconnect(&self) -> Result<()> {
        Err(Error::ProtocolError("此协议不支持 disconnect".to_string()))
    }
}

/// Shell 通道
#[derive(Debug, Clone)]
pub struct ShellChannel {
    pub id: Uuid,
    pub handle_id: Uuid,
}

/// 插件注册表
pub struct PluginRegistry {
    plugins: std::sync::Arc<
        parking_lot::RwLock<HashMap<&'static str, std::sync::Arc<dyn ProtocolPlugin>>>,
    >,
}

pub mod docker;
pub mod mysql;
pub mod pgsql;
pub mod rdp;
pub mod russh_backend;
pub mod sftp;
pub mod ssh;
pub mod ssh_backend;

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            plugins: std::sync::Arc::new(parking_lot::RwLock::new(HashMap::new())),
        }
    }

    pub fn register<P: ProtocolPlugin + 'static>(&self, plugin: P) {
        let id = plugin.protocol_id();
        let mut plugins = self.plugins.write();
        plugins.insert(id, std::sync::Arc::new(plugin));
    }

    pub fn get(&self, protocol_id: &str) -> Option<std::sync::Arc<dyn ProtocolPlugin>> {
        let plugins = self.plugins.read();
        plugins.get(protocol_id).cloned()
    }

    pub fn list_protocols(&self) -> Vec<(&'static str, &'static str)> {
        let plugins = self.plugins.read();
        plugins
            .iter()
            .map(|(id, p)| (*id, p.display_name()))
            .collect()
    }
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self::new()
    }
}
