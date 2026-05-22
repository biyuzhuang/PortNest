//! 错误类型定义

use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("连接失败: {0}")]
    ConnectionFailed(String),

    #[error("认证失败: {0}")]
    AuthenticationFailed(String),

    #[error("协议错误: {0}")]
    ProtocolError(String),

    #[error("存储错误: {0}")]
    StorageError(String),

    #[error("加密错误: {0}")]
    EncryptionError(String),

    #[error("插件未找到: {0}")]
    PluginNotFound(String),

    #[error("无效配置: {0}")]
    InvalidConfig(String),

    #[error("超时: {0}")]
    Timeout(String),

    #[error("IO错误: {0}")]
    IoError(#[from] std::io::Error),

    #[error("SSH错误: {0}")]
    SshError(#[from] ssh2::Error),

    #[error("数据库错误: {0}")]
    DatabaseError(String),
}

pub type Result<T> = std::result::Result<T, Error>;