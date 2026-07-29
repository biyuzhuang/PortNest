//! SSH 协议插件

use async_trait::async_trait;
use base64::Engine;
use parking_lot::Mutex;
use sha2::Digest;
use ssh2::{Channel, ErrorCode, Session};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, CredentialType,
    ProtocolCapability, ProtocolPlugin, ShellChannel,
};

/// Shell 通道包装，使用独立的锁
struct ShellEntry {
    channel: Mutex<Channel>,
}

/// SSH 连接句柄
pub struct SshConnectionHandle {
    id: Uuid,
    session: Session,
    remote_addr: (String, u16),
    _connected_at: Instant,
    keepalive_interval: u32,
    last_keepalive: Mutex<Instant>,
    /// 活跃的 shell 通道，每个通道有独立的锁
    shells: Arc<Mutex<HashMap<Uuid, Arc<ShellEntry>>>>,
}

impl SshConnectionHandle {
    pub fn new(
        id: Uuid,
        session: Session,
        remote_addr: (String, u16),
        keepalive_interval: u32,
    ) -> Self {
        Self {
            id,
            session,
            remote_addr,
            _connected_at: Instant::now(),
            keepalive_interval,
            last_keepalive: Mutex::new(Instant::now()),
            shells: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    fn send_keepalive_if_due(&self) -> Result<()> {
        let mut last = self.last_keepalive.lock();
        if last.elapsed() < std::time::Duration::from_secs(self.keepalive_interval as u64) {
            return Ok(());
        }
        match self.session.keepalive_send() {
            Ok(_) => {
                *last = Instant::now();
                Ok(())
            }
            Err(error) if error.code() == ErrorCode::Session(-37) => Ok(()),
            Err(error) => Err(Error::SshError(error)),
        }
    }

    /// 打开新的 shell 通道
    pub fn open_shell_channel(&self, cols: u32, rows: u32) -> Result<ShellChannel> {
        let mut channel = self
            .session
            .channel_session()
            .map_err(|e| Error::SshError(e))?;

        channel
            .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
            .map_err(|e| Error::SshError(e))?;

        channel.shell().map_err(|e| Error::SshError(e))?;

        tracing::info!(
            "SSH shell channel opened successfully, cols={}, rows={}",
            cols,
            rows
        );

        // Switch to non-blocking mode after shell is opened
        // This prevents read_shell from blocking while holding the lock
        self.session.set_blocking(false);

        let shell_id = Uuid::new_v4();
        let shell = ShellChannel {
            id: shell_id,
            handle_id: self.id,
        };

        let entry = Arc::new(ShellEntry {
            channel: Mutex::new(channel),
        });

        self.shells.lock().insert(shell_id, entry);

        Ok(shell)
    }

    /// 读取 shell 数据
    pub fn read_shell(&self, shell_id: &Uuid, buf: &mut [u8]) -> Result<usize> {
        self.send_keepalive_if_due()?;
        // Get the entry Arc, then release the HashMap lock
        let entry = {
            let shells = self.shells.lock();
            shells.get(shell_id).cloned()
        };

        if let Some(entry) = entry {
            // Lock only this specific channel
            let mut channel = entry.channel.lock();
            let mut temp_buf = [0u8; 4096];
            match channel.read(&mut temp_buf) {
                Ok(0) => {
                    // No data available - this is normal for non-blocking
                    tracing::trace!("read_shell: no data");
                    Ok(0)
                }
                Ok(n) => {
                    let len = std::cmp::min(n, buf.len());
                    buf[..len].copy_from_slice(&temp_buf[..len]);
                    tracing::info!("read_shell: got {} bytes", len);
                    Ok(len)
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    tracing::trace!("read_shell: WouldBlock");
                    Ok(0)
                }
                Err(e) => {
                    tracing::error!("read_shell error: {:?}", e);
                    Err(Error::IoError(e))
                }
            }
        } else {
            tracing::error!("read_shell: shell {:?} not found", shell_id);
            Err(Error::ProtocolError("Shell 通道不存在".to_string()))
        }
    }

    /// 写入 shell 数据
    pub fn write_shell(&self, shell_id: &Uuid, data: &[u8]) -> Result<usize> {
        // Get the entry Arc, then release the HashMap lock
        let entry = {
            let shells = self.shells.lock();
            shells.get(shell_id).cloned()
        };

        if let Some(entry) = entry {
            tracing::debug!(
                "write_shell: writing {} bytes to shell {:?}",
                data.len(),
                shell_id
            );
            // In non-blocking mode, write may return WouldBlock
            // Try writing with a simple retry
            let mut written = 0;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while written < data.len() {
                let write_result = {
                    let mut channel = entry.channel.lock();
                    channel.write(&data[written..])
                };
                match write_result {
                    Ok(0) => return Err(Error::ConnectionFailed("SSH 通道已关闭".to_string())),
                    Ok(n) => written += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return Err(Error::Timeout("SSH 写入超时".to_string()));
                        }
                        // Release the channel lock before retrying so reads and
                        // remote window updates can continue.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => return Err(Error::IoError(e)),
                }
            }
            let _ = entry.channel.lock().flush();
            Ok(written)
        } else {
            Err(Error::ProtocolError("Shell 通道不存在".to_string()))
        }
    }

    /// 调整 shell 大小
    pub fn resize_shell(&self, shell_id: &Uuid, cols: u32, rows: u32) -> Result<()> {
        let entry = {
            let shells = self.shells.lock();
            shells.get(shell_id).cloned()
        };

        if let Some(entry) = entry {
            let mut channel = entry.channel.lock();
            channel
                .request_pty_size(cols, rows, None, None)
                .map_err(|e| Error::SshError(e))?;
            Ok(())
        } else {
            Err(Error::ProtocolError("Shell 通道不存在".to_string()))
        }
    }

    /// 关闭 shell
    pub fn close_shell(&self, shell_id: &Uuid) -> Result<()> {
        let entry = {
            let mut shells = self.shells.lock();
            tracing::info!(
                "close_shell: removing shell {:?} from session, remaining shells: {}",
                shell_id,
                shells.len()
            );
            shells.remove(shell_id)
        };

        if let Some(entry) = entry {
            tracing::info!("close_shell: closing channel for shell {:?}", shell_id);
            let mut channel = entry.channel.lock();
            let result = channel.close();
            tracing::info!("close_shell: channel closed for shell {:?}", shell_id);
            result.map_err(|e| Error::SshError(e))?;
            Ok(())
        } else {
            tracing::warn!("close_shell: shell {:?} not found", shell_id);
            Err(Error::ProtocolError("Shell 通道不存在".to_string()))
        }
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
        !self.shells.lock().is_empty()
    }

    fn status(&self) -> crate::protocol::SessionStatus {
        if self.is_connected() {
            crate::protocol::SessionStatus::Connected
        } else {
            crate::protocol::SessionStatus::Disconnected
        }
    }

    fn remote_addr(&self) -> (&str, u16) {
        (&self.remote_addr.0, self.remote_addr.1)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn open_shell(&self, cols: u32, rows: u32) -> Result<ShellChannel> {
        self.open_shell_channel(cols, rows)
    }

    fn read_shell(&self, shell_id: &Uuid, buf: &mut [u8]) -> Result<usize> {
        self.read_shell(shell_id, buf)
    }

    fn write_shell(&self, shell_id: &Uuid, data: &[u8]) -> Result<usize> {
        self.write_shell(shell_id, data)
    }

    fn resize_shell(&self, shell_id: &Uuid, cols: u32, rows: u32) -> Result<()> {
        self.resize_shell(shell_id, cols, rows)
    }

    fn close_shell(&self, shell_id: &Uuid) -> Result<()> {
        self.close_shell(shell_id)
    }

    fn disconnect(&self) -> Result<()> {
        tracing::info!("disconnect: disconnecting SSH session {:?}", self.id);
        // Disconnect the SSH session - this will close all channels
        self.session
            .disconnect(None, "User requested disconnect", None)
            .map_err(|e| Error::SshError(e))?;
        tracing::info!("disconnect: SSH session {:?} disconnected", self.id);
        Ok(())
    }
}

/// SSH 协议插件
pub struct SshPlugin;

impl SshPlugin {
    fn verify_host_identity(&self, session: &Session, host: &str, port: u16) -> Result<()> {
        let (host_key, host_key_type) = session
            .host_key()
            .ok_or_else(|| Error::ConnectionFailed("服务器未提供 SSH 主机密钥".to_string()))?;
        let fingerprint = sha2::Sha256::digest(host_key);
        let fingerprint = fingerprint
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        let key = format!("{}:{}", host, port);
        let known_hosts_path = crate::app_data_dir().join("known-hosts.json");

        let mut known: HashMap<String, String> = if known_hosts_path.exists() {
            let content = std::fs::read_to_string(&known_hosts_path)
                .map_err(|e| Error::StorageError(format!("读取主机密钥记录失败: {}", e)))?;
            serde_json::from_str(&content)
                .map_err(|e| Error::StorageError(format!("主机密钥记录已损坏: {}", e)))?
        } else {
            HashMap::new()
        };

        if let Some(expected) = known.get(&key) {
            if expected != &fingerprint {
                return Err(Error::AuthenticationFailed(format!(
                    "SSH 主机密钥已变化，已拒绝连接。主机: {}，新指纹: SHA256:{}",
                    key, fingerprint
                )));
            }
        } else {
            if let Some(parent) = known_hosts_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| Error::StorageError(format!("创建主机密钥目录失败: {}", e)))?;
            }
            known.insert(key.clone(), fingerprint.clone());
            let content = serde_json::to_vec_pretty(&known)
                .map_err(|e| Error::StorageError(format!("序列化主机密钥失败: {}", e)))?;
            std::fs::write(&known_hosts_path, content)
                .map_err(|e| Error::StorageError(format!("保存主机密钥失败: {}", e)))?;
            tracing::warn!(
                "首次连接主机 {}，已记录 {:?} 主机密钥指纹 SHA256:{}",
                key,
                host_key_type,
                fingerprint
            );
        }
        Ok(())
    }

    pub fn new() -> Self {
        Self
    }
}

impl Default for SshPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SshPlugin {
    /// SOCKS5 代理握手
    async fn socks5_handshake(
        &self,
        tcp: tokio::net::TcpStream,
        target_host: &str,
        target_port: u16,
        username: &Option<String>,
        password: &Option<String>,
    ) -> Result<tokio::net::TcpStream> {
        let mut tcp = tcp;

        // SOCKS5 greeting: client sends supported auth methods
        let auth_methods = if username.is_some() {
            vec![0x02, 0x00] // USERNAME/PASSWORD, NO_AUTH
        } else {
            vec![0x00] // NO_AUTH only
        };

        let mut greeting = vec![0x05, auth_methods.len() as u8];
        greeting.extend_from_slice(&auth_methods);

        tcp.write_all(&greeting)
            .await
            .map_err(|e| Error::IoError(e))?;

        // Read server auth method selection
        let mut reply = [0u8; 2];
        tcp.read_exact(&mut reply)
            .await
            .map_err(|e| Error::IoError(e))?;

        if reply[0] != 0x05 {
            return Err(Error::ProtocolError("SOCKS5 协议错误".to_string()));
        }

        match reply[1] {
            0x00 => {} // No auth required
            0x02 => {
                // Username/password auth
                if let Some(ref user) = username {
                    let pass = password.as_deref().unwrap_or("");
                    if user.len() > 255 || pass.len() > 255 {
                        return Err(Error::ProtocolError("SOCKS5 用户名或密码过长".to_string()));
                    }
                    let mut cred = vec![0x01]; // version
                    cred.push(user.len() as u8);
                    cred.extend_from_slice(user.as_bytes());
                    cred.push(pass.len() as u8);
                    cred.extend_from_slice(pass.as_bytes());
                    tcp.write_all(&cred).await.map_err(|e| Error::IoError(e))?;

                    let mut result = [0u8; 2];
                    tcp.read_exact(&mut result)
                        .await
                        .map_err(|e| Error::IoError(e))?;

                    if result[1] != 0x00 {
                        return Err(Error::AuthenticationFailed(
                            "SOCKS5 代理认证失败".to_string(),
                        ));
                    }
                }
            }
            0xFF => {
                return Err(Error::AuthenticationFailed(
                    "SOCKS5 代理不支持任何认证方式".to_string(),
                ))
            }
            _ => return Err(Error::ProtocolError("SOCKS5 不支持的认证方式".to_string())),
        }

        // Send connect request
        let mut connect_request = vec![
            0x05, // SOCKS version
            0x01, // CONNECT command
            0x00, // Reserved
            0x03, // Domain name
            target_host.len() as u8,
        ];
        connect_request.extend_from_slice(target_host.as_bytes());
        connect_request.extend_from_slice(&target_port.to_be_bytes());

        tcp.write_all(&connect_request)
            .await
            .map_err(|e| Error::IoError(e))?;

        // Read connect response
        let mut response_head = [0u8; 4];
        tcp.read_exact(&mut response_head)
            .await
            .map_err(Error::IoError)?;
        if response_head[0] != 0x05 || response_head[1] != 0x00 {
            return Err(Error::ProtocolError(format!(
                "SOCKS5 连接失败: 错误码 {}",
                response_head[1]
            )));
        }
        let address_len = match response_head[3] {
            0x01 => 4,
            0x04 => 16,
            0x03 => {
                let mut len = [0u8; 1];
                tcp.read_exact(&mut len).await.map_err(Error::IoError)?;
                len[0] as usize
            }
            _ => {
                return Err(Error::ProtocolError(
                    "SOCKS5 返回了未知地址类型".to_string(),
                ))
            }
        };
        let mut address_and_port = vec![0u8; address_len + 2];
        tcp.read_exact(&mut address_and_port)
            .await
            .map_err(Error::IoError)?;

        Ok(tcp)
    }

    /// HTTP CONNECT 代理握手
    async fn http_proxy_handshake(
        &self,
        tcp: tokio::net::TcpStream,
        target_host: &str,
        target_port: u16,
        username: &Option<String>,
        password: &Option<String>,
    ) -> Result<tokio::net::TcpStream> {
        let mut tcp = tcp;

        // Build CONNECT request
        let auth_header = if let Some(ref user) = username {
            let credentials = base64::engine::general_purpose::STANDARD.encode(format!(
                "{}:{}",
                user,
                password.as_deref().unwrap_or("")
            ));
            format!("Proxy-Authorization: Basic {}\r\n", credentials)
        } else {
            String::new()
        };

        let connect_request = format!(
            "CONNECT {}:{} HTTP/1.1\r\n\
             Host: {}:{}\r\n\
             {}\r\n",
            target_host, target_port, target_host, target_port, auth_header
        );

        tcp.write_all(connect_request.as_bytes())
            .await
            .map_err(|e| Error::IoError(e))?;

        // Read HTTP response
        let mut buffer = [0u8; 1024];
        let n = tcp.read(&mut buffer).await.map_err(|e| Error::IoError(e))?;

        let response = String::from_utf8_lossy(&buffer[..n]);

        // Check for 200 OK
        let status_line = response.lines().next().unwrap_or("");
        let status_ok = status_line
            .split_whitespace()
            .nth(1)
            .map(|code| code == "200")
            .unwrap_or(false);
        if !status_ok {
            return Err(Error::ProtocolError(format!(
                "HTTP 代理连接失败: {}",
                response.split("\r\n").next().unwrap_or("")
            )));
        }

        Ok(tcp)
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

        // Determine if we need proxy
        let tcp = if let Some(ref proxy) = options.proxy {
            // Connect via proxy
            let proxy_addr = format!("{}:{}", proxy.host, proxy.port);
            let tcp = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&proxy_addr))
                .await
                .map_err(|_| Error::Timeout(format!("连接代理 {} 超时", proxy_addr)))?
                .map_err(|e| Error::ConnectionFailed(format!("连接代理失败: {}", e)))?;

            tcp.set_nodelay(true).ok();

            match proxy.proxy_type.as_str() {
                "socks5" => {
                    self.socks5_handshake(tcp, host, port, &proxy.username, &proxy.password)
                        .await?
                }
                "http" => {
                    self.http_proxy_handshake(tcp, host, port, &proxy.username, &proxy.password)
                        .await?
                }
                _ => {
                    return Err(Error::ProtocolError(format!(
                        "不支持的代理类型: {}",
                        proxy.proxy_type
                    )))
                }
            }
        } else {
            // Direct connection
            let addr = format!("{}:{}", host, port);
            let tcp = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addr))
                .await
                .map_err(|_| Error::Timeout(format!("连接 {} 超时", addr)))?
                .map_err(|e| Error::ConnectionFailed(format!("TCP 连接失败: {}", e)))?;

            tcp.set_nodelay(true).ok();
            tcp
        };

        let mut sess = Session::new().map_err(|e| Error::SshError(e))?;

        sess.set_tcp_stream(
            tcp.into_std()
                .map_err(|e| Error::ConnectionFailed(format!("转换 TCP 流失败: {}", e)))?,
        );

        sess.handshake()
            .map_err(|e| Error::ConnectionFailed(format!("SSH 握手失败: {}", e)))?;
        self.verify_host_identity(&sess, host, port)?;

        match &credential.credential_type {
            CredentialType::Password => {
                let pass = credential
                    .password
                    .as_ref()
                    .ok_or_else(|| Error::AuthenticationFailed("缺少密码".to_string()))?;
                sess.userauth_password(username, pass)
                    .map_err(|e| Error::AuthenticationFailed(format!("密码认证失败: {}", e)))?;
            }
            CredentialType::PrivateKey | CredentialType::PrivateKeyWithPassphrase => {
                let key = credential
                    .private_key
                    .as_ref()
                    .ok_or_else(|| Error::AuthenticationFailed("缺少私钥".to_string()))?;

                let temp_dir = std::env::temp_dir();
                let key_path = temp_dir.join(format!("portnest_key_{}", Uuid::new_v4()));

                std::fs::write(&key_path, key).map_err(|e| {
                    Error::AuthenticationFailed(format!("写入临时密钥文件失败: {}", e))
                })?;

                let passphrase = credential.passphrase.as_deref();
                let res = sess.userauth_pubkey_file(username, None, &key_path, passphrase);

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

        let keepalive_interval = options.keepalive_interval.unwrap_or(15).max(5);
        sess.set_keepalive(true, keepalive_interval);

        let id = Uuid::new_v4();
        Ok(Box::new(SshConnectionHandle::new(
            id,
            sess,
            (host.to_string(), port),
            keepalive_interval,
        )))
    }

    async fn health_check(&self, handle: &dyn ConnectionHandle) -> Result<bool> {
        Ok(handle.status() == crate::protocol::SessionStatus::Connected)
    }

    async fn get_metadata(&self, _handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        Err(Error::ProtocolError("未实现".to_string()))
    }
}
