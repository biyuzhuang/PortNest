//! SSH 协议插件

use async_trait::async_trait;
use ssh2::Session;
use std::time::Instant;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential,
    CredentialType, ProtocolCapability, ProtocolPlugin,
};

/// SSH 连接句柄
pub struct SshConnectionHandle {
    id: Uuid,
    session: Option<Session>,
    remote_addr: (String, u16),
    #[allow(dead_code)]
    connected_at: Instant,
}

impl SshConnectionHandle {
    pub fn new(id: Uuid, session: Session, remote_addr: (String, u16)) -> Self {
        Self {
            id,
            session: Some(session),
            remote_addr,
            connected_at: Instant::now(),
        }
    }

    pub fn session(&self) -> &Session {
        self.session.as_ref().unwrap()
    }
}

impl ConnectionHandle for SshConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        "ssh"
    }

    fn is_connected(&self) -> bool {
        self.session.is_some()
    }

    fn status(&self) -> crate::protocol::SessionStatus {
        if self.session.is_some() {
            crate::protocol::SessionStatus::Connected
        } else {
            crate::protocol::SessionStatus::Disconnected
        }
    }

    fn remote_addr(&self) -> (&str, u16) {
        (&self.remote_addr.0, self.remote_addr.1)
    }
}

/// SSH 协议插件
pub struct SshPlugin;

impl SshPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SshPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProtocolPlugin for SshPlugin {
    fn protocol_id(&self) -> &'static str {
        "ssh"
    }

    fn display_name(&self) -> &'static str {
        "SSH"
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![
            ProtocolCapability::Terminal,
            ProtocolCapability::Tunnel,
            ProtocolCapability::FileTransfer,
            ProtocolCapability::AIAnalysis,
        ]
    }

    fn default_port(&self) -> u16 {
        22
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        username: &str,
        credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        let timeout = options
            .timeout_ms
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(30));

        let addr = format!("{}:{}", host, port);
        let tcp = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addr))
            .await
            .map_err(|_| Error::Timeout(format!("连接 {} 超时", addr)))?
            .map_err(|e| Error::ConnectionFailed(format!("TCP 连接失败: {}", e)))?;

        tcp.set_nodelay(true).ok();

        let mut sess = Session::new().map_err(|e| Error::SshError(e))?;

        sess.set_tcp_stream(tcp.into_std().map_err(|e| {
            Error::ConnectionFailed(format!("转换 TCP 流失败: {}", e))
        })?);

        sess.handshake()
            .map_err(|e| Error::ConnectionFailed(format!("SSH 握手失败: {}", e)))?;

        // 认证
        match &credential.credential_type {
            CredentialType::Password => {
                let pass = credential.password.as_ref()
                    .ok_or_else(|| Error::AuthenticationFailed("缺少密码".to_string()))?;
                sess.userauth_password(username, pass)
                    .map_err(|e| Error::AuthenticationFailed(format!("密码认证失败: {}", e)))?;
            }
            CredentialType::PrivateKey | CredentialType::PrivateKeyWithPassphrase => {
                let key = credential.private_key.as_ref()
                    .ok_or_else(|| Error::AuthenticationFailed("缺少私钥".to_string()))?;

                // 将私钥写入临时文件（ssh2 需要文件路径进行密钥认证）
                let temp_dir = std::env::temp_dir();
                let key_path = temp_dir.join(format!("portnest_key_{}", Uuid::new_v4()));

                std::fs::write(&key_path, key)
                    .map_err(|e| Error::AuthenticationFailed(format!("写入临时密钥文件失败: {}", e)))?;

                let passphrase = credential.passphrase.as_deref();
                let res = sess.userauth_pubkey_file(username, None, &key_path, passphrase);

                // 删除临时文件
                let _ = std::fs::remove_file(&key_path);

                res.map_err(|e| Error::AuthenticationFailed(format!("密钥认证失败: {}", e)))?;
            }
            CredentialType::Agent => {
                sess.userauth_agent(username)
                    .map_err(|e| Error::AuthenticationFailed(format!("Agent 认证失败: {}", e)))?;
            }
        }

        if !sess.authenticated() {
            return Err(Error::AuthenticationFailed("认证未成功".to_string()));
        }

        let id = Uuid::new_v4();
        Ok(Box::new(SshConnectionHandle::new(
            id,
            sess,
            (host.to_string(), port),
        )))
    }

    async fn health_check(&self, _handle: &dyn ConnectionHandle) -> Result<bool> {
        Ok(true)
    }

    async fn get_metadata(&self, _handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        Err(Error::ProtocolError("未实现".to_string()))
    }
}