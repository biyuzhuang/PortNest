//! Native async SSH backend built on one multiplexed `russh` transport.

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use sha2::Digest;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::sftp::{symbolic_permissions, FileInfo};
use crate::protocol::ssh_backend::{
    CancellationToken, ConnectionTarget, ExecResult, SftpHandle, ShellHandle, SshBackend,
    SshSession, TerminalSize, TransferProgress,
};
use crate::protocol::{ConnectionOptions, Credential, CredentialType, SessionStatus};

fn protocol_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::ProtocolError(format!("{context}: {error}"))
}

struct HostKeyVerifier {
    host: String,
    port: u16,
    rejection: Arc<StdMutex<Option<String>>>,
    forwarded_channels: ForwardRegistry,
}

type ForwardRegistry = Arc<StdMutex<HashMap<u32, mpsc::UnboundedSender<ForwardedTcpip>>>>;

struct ForwardedTcpip {
    channel: Channel<client::Msg>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let legacy_fingerprint = server_public_key.to_bytes().ok().map(|bytes| {
            sha2::Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        });
        let key = format!("{}:{}", self.host, self.port);
        let path = crate::app_data_dir().join("known-hosts.json");

        let result = (|| -> std::result::Result<bool, String> {
            let mut known: HashMap<String, String> = if path.exists() {
                let content = std::fs::read_to_string(&path)
                    .map_err(|error| format!("读取主机密钥记录失败: {error}"))?;
                serde_json::from_str(&content)
                    .map_err(|error| format!("主机密钥记录已损坏: {error}"))?
            } else {
                HashMap::new()
            };

            if let Some(expected) = known.get(&key) {
                if expected != &fingerprint && legacy_fingerprint.as_ref() != Some(expected) {
                    return Err(format!("SSH 主机密钥已变化，已拒绝连接。主机: {key}"));
                }
                return Ok(true);
            }

            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("创建主机密钥目录失败: {error}"))?;
            }
            known.insert(key.clone(), fingerprint.clone());
            let content = serde_json::to_vec_pretty(&known)
                .map_err(|error| format!("序列化主机密钥失败: {error}"))?;
            std::fs::write(&path, content).map_err(|error| format!("保存主机密钥失败: {error}"))?;
            tracing::warn!("首次连接主机 {}，已记录主机密钥指纹 {}", key, fingerprint);
            Ok(true)
        })();

        match result {
            Ok(accepted) => Ok(accepted),
            Err(message) => {
                *self.rejection.lock().expect("host-key rejection lock") = Some(message);
                Ok(false)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let sender = self
            .forwarded_channels
            .lock()
            .expect("forward registry lock")
            .get(&connected_port)
            .cloned();
        if let Some(sender) = sender {
            reply.accept().await;
            let _ = sender.send(ForwardedTcpip { channel });
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct RusshBackend;

pub struct RusshSession {
    id: Uuid,
    handle: Arc<Mutex<client::Handle<HostKeyVerifier>>>,
    forwarded_channels: ForwardRegistry,
}

struct RusshShellHandle {
    id: Uuid,
    channel: Mutex<Channel<client::Msg>>,
}

const SHELL_READ_WAIT: Duration = Duration::from_millis(10);
const SHELL_READ_LIMIT: usize = 256 * 1024;
const TRANSFER_CHUNK_SIZE: usize = 128 * 1024;

struct RusshSftpHandle {
    id: Uuid,
    session: SftpSession,
    transport: Arc<Mutex<client::Handle<HostKeyVerifier>>>,
    user_names: Mutex<HashMap<u32, String>>,
    group_names: Mutex<HashMap<u32, String>>,
}

#[async_trait]
impl SshBackend for RusshBackend {
    async fn connect(
        &self,
        target: &ConnectionTarget,
        credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Arc<dyn SshSession>> {
        let timeout = Duration::from_millis(options.timeout_ms.unwrap_or(30_000));
        let stream = tokio::time::timeout(timeout, connect_transport(target, options))
            .await
            .map_err(|_| Error::Timeout(format!("连接 {}:{} 超时", target.host, target.port)))??;

        let rejection = Arc::new(StdMutex::new(None));
        let forwarded_channels: ForwardRegistry = Arc::new(StdMutex::new(HashMap::new()));
        let handler = HostKeyVerifier {
            host: target.host.clone(),
            port: target.port,
            rejection: rejection.clone(),
            forwarded_channels: forwarded_channels.clone(),
        };
        let mut preferred = russh::Preferred::default();
        if has_legacy_host_key_record(&target.host, target.port) {
            let mut algorithms = preferred.key.to_vec();
            algorithms
                .sort_by_key(|algorithm| !matches!(algorithm, russh::keys::Algorithm::Rsa { .. }));
            preferred.key = Cow::Owned(algorithms);
        }
        let config = client::Config {
            preferred,
            keepalive_interval: Some(Duration::from_secs(
                options.keepalive_interval.unwrap_or(15).max(5) as u64,
            )),
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        };

        let mut handle = client::connect_stream(Arc::new(config), stream, handler)
            .await
            .map_err(|error| {
                let rejection = rejection.lock().expect("host-key rejection lock").take();
                Error::ConnectionFailed(
                    rejection.unwrap_or_else(|| format!("SSH 握手失败: {error}")),
                )
            })?;

        let authenticated = match credential.credential_type {
            CredentialType::Password => {
                let password = credential
                    .password
                    .as_deref()
                    .ok_or_else(|| Error::AuthenticationFailed("缺少密码".to_string()))?;
                handle
                    .authenticate_password(&target.username, password)
                    .await
                    .map_err(|error| Error::AuthenticationFailed(format!("密码认证失败: {error}")))?
                    .success()
            }
            CredentialType::PrivateKey | CredentialType::PrivateKeyWithPassphrase => {
                let private_key = credential
                    .private_key
                    .as_deref()
                    .ok_or_else(|| Error::AuthenticationFailed("缺少私钥".to_string()))?;
                let key = decode_secret_key(private_key, credential.passphrase.as_deref())
                    .map_err(|error| {
                        Error::AuthenticationFailed(format!("私钥解析失败: {error}"))
                    })?;
                let advertised_hash = handle.best_supported_rsa_hash().await.map_err(|error| {
                    Error::AuthenticationFailed(format!("协商 RSA 签名算法失败: {error}"))
                })?;
                // Some OpenSSH servers do not send EXT_INFO soon enough while
                // rejecting legacy ssh-rsa/SHA-1. In that case try the modern
                // RSA algorithms first, then retain compatibility with old
                // servers. Non-RSA keys ignore the hash selection.
                let hashes = advertised_hash
                    .map(|hash| vec![hash])
                    .unwrap_or_else(|| vec![Some(HashAlg::Sha512), Some(HashAlg::Sha256), None]);
                let key = Arc::new(key);
                let mut success = false;
                for hash in hashes {
                    let result = handle
                        .authenticate_publickey(
                            &target.username,
                            PrivateKeyWithHashAlg::new(key.clone(), hash),
                        )
                        .await
                        .map_err(|error| {
                            Error::AuthenticationFailed(format!("私钥认证失败: {error}"))
                        })?;
                    if result.success() {
                        success = true;
                        break;
                    }
                }
                success
            }
            CredentialType::Agent => authenticate_agent(&mut handle, &target.username).await?,
        };

        if !authenticated {
            return Err(Error::AuthenticationFailed("认证未成功".to_string()));
        }

        Ok(Arc::new(RusshSession {
            id: Uuid::new_v4(),
            handle: Arc::new(Mutex::new(handle)),
            forwarded_channels,
        }))
    }
}

fn has_legacy_host_key_record(host: &str, port: u16) -> bool {
    let path = crate::app_data_dir().join("known-hosts.json");
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(known) = serde_json::from_str::<HashMap<String, String>>(&content) else {
        return false;
    };
    known
        .get(&format!("{host}:{port}"))
        .is_some_and(|fingerprint| {
            fingerprint.len() == 64 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

#[cfg(windows)]
async fn authenticate_agent(
    handle: &mut client::Handle<HostKeyVerifier>,
    username: &str,
) -> Result<bool> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(agent) => agent.dynamic(),
        Err(open_ssh_error) => AgentClient::connect_pageant()
            .await
            .map_err(|pageant_error| {
                Error::AuthenticationFailed(format!(
                    "无法连接 OpenSSH Agent ({open_ssh_error}) 或 Pageant ({pageant_error})"
                ))
            })?
            .dynamic(),
    };
    authenticate_agent_identities(handle, username, &mut agent).await
}

#[cfg(unix)]
async fn authenticate_agent(
    handle: &mut client::Handle<HostKeyVerifier>,
    username: &str,
) -> Result<bool> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|error| Error::AuthenticationFailed(format!("连接 SSH Agent 失败: {error}")))?;
    authenticate_agent_identities(handle, username, &mut agent).await
}

async fn authenticate_agent_identities<S>(
    handle: &mut client::Handle<HostKeyVerifier>,
    username: &str,
    agent: &mut russh::keys::agent::client::AgentClient<S>,
) -> Result<bool>
where
    S: russh::keys::agent::client::AgentStream + Send + Unpin,
{
    let identities = agent.request_identities().await.map_err(|error| {
        Error::AuthenticationFailed(format!("读取 SSH Agent 密钥失败: {error}"))
    })?;
    for identity in identities {
        let key = identity.public_key().into_owned();
        let advertised_hash = handle.best_supported_rsa_hash().await.map_err(|error| {
            Error::AuthenticationFailed(format!("协商 Agent 签名算法失败: {error}"))
        })?;
        // Some OpenSSH servers do not send EXT_INFO soon enough for
        // `best_supported_rsa_hash`, while also rejecting legacy
        // ssh-rsa/SHA-1 signatures. Prefer rsa-sha2-512 when the
        // extension is absent, as recommended by russh.
        let hash = advertised_hash.unwrap_or(Some(HashAlg::Sha512));
        let result = handle
            .authenticate_publickey_with(username, key, hash, agent)
            .await
            .map_err(|error| Error::AuthenticationFailed(format!("SSH Agent 认证失败: {error}")))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[async_trait]
impl SshSession for RusshSession {
    fn id(&self) -> Uuid {
        self.id
    }

    async fn open_shell(&self, size: TerminalSize) -> Result<Arc<dyn ShellHandle>> {
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| protocol_error("打开 Shell Channel 失败", error))?;
        channel
            .request_pty(true, "xterm-256color", size.cols, size.rows, 0, 0, &[])
            .await
            .map_err(|error| protocol_error("请求 PTY 失败", error))?;
        channel
            .request_shell(true)
            .await
            .map_err(|error| protocol_error("启动 Shell 失败", error))?;

        Ok(Arc::new(RusshShellHandle {
            id: Uuid::new_v4(),
            channel: Mutex::new(channel),
        }))
    }

    async fn open_sftp(&self) -> Result<Arc<dyn SftpHandle>> {
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| protocol_error("打开 SFTP Channel 失败", error))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| protocol_error("启动 SFTP subsystem 失败", error))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| protocol_error("初始化 SFTP 协议失败", error))?;

        Ok(Arc::new(RusshSftpHandle {
            id: Uuid::new_v4(),
            session,
            transport: self.handle.clone(),
            user_names: Mutex::new(HashMap::new()),
            group_names: Mutex::new(HashMap::new()),
        }))
    }

    async fn exec(&self, command: &str) -> Result<ExecResult> {
        exec_on_transport(&self.handle, command).await
    }

    async fn relay_direct_tcpip(
        &self,
        stream: TcpStream,
        target_host: &str,
        target_port: u16,
    ) -> Result<()> {
        let origin = stream
            .peer_addr()
            .map(|address| (address.ip().to_string(), address.port() as u32))
            .unwrap_or_else(|_| ("127.0.0.1".to_string(), 0));
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_direct_tcpip(target_host, target_port as u32, origin.0, origin.1)
            .await
            .map_err(|error| protocol_error("打开 direct-tcpip Channel 失败", error))?;
        relay_tcp_channel(stream, channel).await
    }

    async fn serve_remote_forward(
        &self,
        bind_host: &str,
        bind_port: u16,
        target_host: &str,
        target_port: u16,
        cancellation: CancellationToken,
        ready: oneshot::Sender<std::result::Result<u16, String>>,
        active_connections: Arc<AtomicUsize>,
    ) -> Result<()> {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        self.forwarded_channels
            .lock()
            .expect("forward registry lock")
            .insert(bind_port as u32, sender);

        let allocated = match self
            .handle
            .lock()
            .await
            .tcpip_forward(bind_host, bind_port as u32)
            .await
        {
            Ok(port) => {
                if port == 0 {
                    bind_port
                } else {
                    port as u16
                }
            }
            Err(error) => {
                self.forwarded_channels
                    .lock()
                    .expect("forward registry lock")
                    .remove(&(bind_port as u32));
                let message = format!("服务端拒绝远程转发 {bind_host}:{bind_port}: {error}");
                let _ = ready.send(Err(message.clone()));
                return Err(Error::ProtocolError(message));
            }
        };

        if allocated != bind_port {
            let mut registry = self
                .forwarded_channels
                .lock()
                .expect("forward registry lock");
            if let Some(sender) = registry.remove(&(bind_port as u32)) {
                registry.insert(allocated as u32, sender);
            }
        }
        let _ = ready.send(Ok(allocated));

        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                forwarded = receiver.recv() => {
                    let Some(forwarded) = forwarded else { break; };
                    let target_host = target_host.to_string();
                    let active_connections = active_connections.clone();
                    active_connections.fetch_add(1, Ordering::AcqRel);
                    tokio::spawn(async move {
                        let result = async {
                            let stream = TcpStream::connect((target_host.as_str(), target_port)).await
                                .map_err(Error::IoError)?;
                            relay_tcp_channel(stream, forwarded.channel).await
                        }.await;
                        if let Err(error) = result {
                            tracing::warn!("远程转发连接失败: {error}");
                        }
                        active_connections.fetch_sub(1, Ordering::AcqRel);
                    });
                }
            }
        }

        let _ = self
            .handle
            .lock()
            .await
            .cancel_tcpip_forward(bind_host, allocated as u32)
            .await;
        self.forwarded_channels
            .lock()
            .expect("forward registry lock")
            .remove(&(allocated as u32));
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "User requested disconnect", "en")
            .await
            .map_err(|error| protocol_error("断开 SSH 会话失败", error))
    }

    fn status(&self) -> SessionStatus {
        if let Ok(handle) = self.handle.try_lock() {
            if handle.is_closed() {
                SessionStatus::Disconnected
            } else {
                SessionStatus::Connected
            }
        } else {
            SessionStatus::Connected
        }
    }
}

async fn relay_tcp_channel(mut stream: TcpStream, mut channel: Channel<client::Msg>) -> Result<()> {
    let mut socket_closed = false;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        tokio::select! {
            read = stream.read(&mut buffer), if !socket_closed => {
                match read {
                    Ok(0) => {
                        socket_closed = true;
                        channel.eof().await.map_err(|error| protocol_error("关闭隧道输入失败", error))?;
                    }
                    Ok(count) => channel.data(&buffer[..count]).await
                        .map_err(|error| protocol_error("写入隧道 Channel 失败", error))?,
                    Err(error) => return Err(Error::IoError(error)),
                }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        stream.write_all(&data).await.map_err(Error::IoError)?;
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
        }
    }
    Ok(())
}

#[async_trait]
impl ShellHandle for RusshShellHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    async fn read(&self) -> Result<Vec<u8>> {
        let mut channel = self.channel.lock().await;
        let deadline = tokio::time::Instant::now() + SHELL_READ_WAIT;
        let mut output = Vec::new();

        // A terminal refresh is commonly split over many SSH channel messages.
        // Returning only one message per UI poll creates an artificial backlog:
        // full-screen programs appear frozen and command output trickles in. Drain
        // everything that is already available, while keeping a per-call cap so a
        // busy shell cannot monopolize the async runtime.
        loop {
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                return Ok(output);
            };

            match tokio::time::timeout(remaining, channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data }))
                | Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                    output.extend_from_slice(&data);
                    if output.len() >= SHELL_READ_LIMIT {
                        return Ok(output);
                    }
                }
                Ok(Some(ChannelMsg::Eof | ChannelMsg::Close)) | Ok(None) => {
                    return Err(Error::ConnectionFailed("远端 Shell 已关闭".to_string()));
                }
                // Ignore channel bookkeeping messages and keep looking for data
                // within the same short polling window.
                Ok(Some(_)) => continue,
                Err(_) => return Ok(output),
            }
        }
    }

    async fn write(&self, data: &[u8]) -> Result<usize> {
        self.channel
            .lock()
            .await
            .data_bytes(Bytes::copy_from_slice(data))
            .await
            .map_err(|error| protocol_error("写入 Shell 失败", error))?;
        Ok(data.len())
    }

    async fn resize(&self, size: TerminalSize) -> Result<()> {
        self.channel
            .lock()
            .await
            .window_change(size.cols, size.rows, 0, 0)
            .await
            .map_err(|error| protocol_error("调整 Shell 大小失败", error))
    }

    async fn close(&self) -> Result<()> {
        self.channel
            .lock()
            .await
            .close()
            .await
            .map_err(|error| protocol_error("关闭 Shell Channel 失败", error))
    }
}

#[async_trait]
impl SftpHandle for RusshSftpHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn status(&self) -> SessionStatus {
        SessionStatus::Connected
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>> {
        let entries = self
            .session
            .read_dir(path)
            .await
            .map_err(|error| protocol_error("列出目录失败", error))?;
        let mut files = Vec::new();
        for entry in entries {
            let metadata = entry.metadata();
            let is_dir = metadata.is_dir();
            let is_link = metadata.is_symlink();
            let user = match (metadata.user.clone(), metadata.uid) {
                (Some(name), _) => name,
                (None, Some(uid)) => self.resolve_account("passwd", uid).await,
                _ => "-".to_string(),
            };
            let group = match (metadata.group.clone(), metadata.gid) {
                (Some(name), _) => name,
                (None, Some(gid)) => self.resolve_account("group", gid).await,
                _ => "-".to_string(),
            };
            files.push(FileInfo {
                name: entry.file_name(),
                path: entry.path(),
                size: metadata.size.unwrap_or(0),
                is_dir,
                is_link,
                modified: metadata.mtime.map(i64::from),
                permissions: symbolic_permissions(metadata.permissions, is_dir, is_link),
                owner_group: format!("{user}/{group}"),
                uid: metadata.uid,
                gid: metadata.gid,
            });
        }
        Ok(files)
    }

    async fn download(
        &self,
        remote_path: &str,
        local_path: &str,
        progress: Option<TransferProgress>,
        cancel: CancellationToken,
    ) -> Result<u64> {
        let total = self
            .session
            .metadata(remote_path)
            .await
            .map(|metadata| metadata.size.unwrap_or(0))
            .unwrap_or(0);
        let mut remote = self
            .session
            .open(remote_path)
            .await
            .map_err(|error| protocol_error("打开远程文件失败", error))?;
        let result = async {
            let mut local = tokio::fs::File::create(local_path).await?;
            let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
            let mut transferred = 0_u64;
            loop {
                let count = tokio::select! {
                    _ = cancel.cancelled() => return Err(Error::TransferCancelled),
                    result = remote.read(&mut buffer) => result.map_err(Error::IoError)?,
                };
                if count == 0 {
                    break;
                }
                tokio::select! {
                    _ = cancel.cancelled() => return Err(Error::TransferCancelled),
                    result = local.write_all(&buffer[..count]) => result.map_err(Error::IoError)?,
                }
                transferred += count as u64;
                if let Some(callback) = &progress {
                    callback(transferred, total);
                }
            }
            local.flush().await.map_err(Error::IoError)?;
            Ok::<u64, Error>(transferred)
        }
        .await;

        if result.is_err() {
            let _ = tokio::fs::remove_file(local_path).await;
        }

        result
    }

    async fn upload(
        &self,
        local_path: &str,
        remote_path: &str,
        progress: Option<TransferProgress>,
        cancel: CancellationToken,
    ) -> Result<u64> {
        let total = tokio::fs::metadata(local_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut local = tokio::fs::File::open(local_path).await?;
        let mut remote = self
            .session
            .create(remote_path)
            .await
            .map_err(|error| protocol_error("创建远程文件失败", error))?;
        let result = async {
            let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
            let mut transferred = 0_u64;
            loop {
                let count = tokio::select! {
                    _ = cancel.cancelled() => return Err(Error::TransferCancelled),
                    result = local.read(&mut buffer) => result.map_err(Error::IoError)?,
                };
                if count == 0 {
                    break;
                }
                tokio::select! {
                    _ = cancel.cancelled() => return Err(Error::TransferCancelled),
                    result = remote.write_all(&buffer[..count]) => result.map_err(Error::IoError)?,
                }
                transferred += count as u64;
                if let Some(callback) = &progress {
                    callback(transferred, total);
                }
            }
            remote.flush().await.map_err(Error::IoError)?;
            Ok::<u64, Error>(transferred)
        }
        .await;

        if result.is_err() {
            let _ = self.session.remove_file(remote_path).await;
        }

        result
    }

    async fn create_file(&self, path: &str) -> Result<()> {
        let file = self
            .session
            .create(path)
            .await
            .map_err(|error| protocol_error("创建文件失败", error))?;
        drop(file);
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> Result<()> {
        self.session
            .create_dir(path)
            .await
            .map_err(|error| protocol_error("创建目录失败", error))
    }

    async fn delete_file(&self, path: &str) -> Result<()> {
        self.session
            .remove_file(path)
            .await
            .map_err(|error| protocol_error("删除文件失败", error))
    }

    async fn delete_dir(&self, path: &str) -> Result<()> {
        self.session
            .remove_dir(path)
            .await
            .map_err(|error| protocol_error("删除目录失败", error))
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        self.session
            .rename(old_path, new_path)
            .await
            .map_err(|error| protocol_error("重命名失败", error))
    }

    async fn close(&self) -> Result<()> {
        self.session
            .close()
            .await
            .map_err(|error| protocol_error("关闭 SFTP Channel 失败", error))
    }
}

impl RusshSftpHandle {
    async fn resolve_account(&self, database: &str, id: u32) -> String {
        let cache = if database == "passwd" {
            &self.user_names
        } else {
            &self.group_names
        };
        if let Some(name) = cache.lock().await.get(&id).cloned() {
            return name;
        }

        let fallback = id.to_string();
        let command = format!("getent {database} {id}");
        let resolved = match exec_on_transport(&self.transport, &command).await {
            Ok(result) if result.exit_code == 0 => String::from_utf8_lossy(&result.stdout)
                .split(':')
                .next()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(&fallback)
                .to_string(),
            _ => fallback,
        };
        cache.lock().await.insert(id, resolved.clone());
        resolved
    }
}

async fn exec_on_transport(
    transport: &Arc<Mutex<client::Handle<HostKeyVerifier>>>,
    command: &str,
) -> Result<ExecResult> {
    let mut channel = transport
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|error| protocol_error("打开 Exec Channel 失败", error))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| protocol_error("执行远程命令失败", error))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = -1;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status as i32,
            _ => {}
        }
    }
    Ok(ExecResult {
        stdout,
        stderr,
        exit_code,
    })
}

async fn connect_transport(
    target: &ConnectionTarget,
    options: &ConnectionOptions,
) -> Result<tokio::net::TcpStream> {
    if let Some(proxy) = &options.proxy {
        let mut stream = tokio::net::TcpStream::connect((&*proxy.host, proxy.port))
            .await
            .map_err(|error| Error::ConnectionFailed(format!("连接代理失败: {error}")))?;
        match proxy.proxy_type.as_str() {
            "socks5" => {
                socks5_connect(
                    &mut stream,
                    &target.host,
                    target.port,
                    proxy.username.as_deref(),
                    proxy.password.as_deref(),
                )
                .await?;
            }
            "http" => {
                http_connect(
                    &mut stream,
                    &target.host,
                    target.port,
                    proxy.username.as_deref(),
                    proxy.password.as_deref(),
                )
                .await?;
            }
            value => {
                return Err(Error::ProtocolError(format!("不支持的代理类型: {value}")));
            }
        }
        Ok(stream)
    } else {
        tokio::net::TcpStream::connect((&*target.host, target.port))
            .await
            .map_err(|error| Error::ConnectionFailed(format!("TCP 连接失败: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_interrupts_hung_io() {
        let cancel = CancellationToken::default();
        let task = tokio::spawn({
            let cancel = cancel.clone();
            async move {
                // 模拟挂起的网络读：永远不会自然完成
                tokio::select! {
                    _ = cancel.cancelled() => Err(Error::TransferCancelled),
                    _ = tokio::time::sleep(Duration::from_secs(3600)) => Ok::<u64, Error>(1),
                }
            }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();

        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancel should interrupt the hung io promptly")
            .expect("task should not panic");
        assert!(matches!(result, Err(Error::TransferCancelled)));
    }
}

async fn socks5_connect(
    stream: &mut tokio::net::TcpStream,
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<()> {
    let methods = if username.is_some() {
        &[0x05, 0x02, 0x02, 0x00][..]
    } else {
        &[0x05, 0x01, 0x00][..]
    };
    stream.write_all(methods).await?;
    let mut selection = [0; 2];
    stream.read_exact(&mut selection).await?;
    if selection[0] != 5 || selection[1] == 0xff {
        return Err(Error::AuthenticationFailed(
            "SOCKS5 代理认证协商失败".to_string(),
        ));
    }
    if selection[1] == 2 {
        let username = username.unwrap_or("");
        let password = password.unwrap_or("");
        if username.len() > 255 || password.len() > 255 {
            return Err(Error::InvalidConfig("SOCKS5 凭据过长".to_string()));
        }
        let mut request = vec![1, username.len() as u8];
        request.extend_from_slice(username.as_bytes());
        request.push(password.len() as u8);
        request.extend_from_slice(password.as_bytes());
        stream.write_all(&request).await?;
        stream.read_exact(&mut selection).await?;
        if selection[1] != 0 {
            return Err(Error::AuthenticationFailed(
                "SOCKS5 代理认证失败".to_string(),
            ));
        }
    }
    if host.len() > 255 {
        return Err(Error::InvalidConfig("目标主机名过长".to_string()));
    }
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await?;
    let mut response = [0; 4];
    stream.read_exact(&mut response).await?;
    if response[0] != 5 || response[1] != 0 {
        return Err(Error::ConnectionFailed(format!(
            "SOCKS5 CONNECT 失败，错误码 {}",
            response[1]
        )));
    }
    let address_len = match response[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut length = [0; 1];
            stream.read_exact(&mut length).await?;
            length[0] as usize
        }
        _ => return Err(Error::ProtocolError("SOCKS5 地址类型无效".to_string())),
    };
    let mut remainder = vec![0; address_len + 2];
    stream.read_exact(&mut remainder).await?;
    Ok(())
}

async fn http_connect(
    stream: &mut tokio::net::TcpStream,
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<()> {
    let auth = username
        .map(|username| {
            let value = base64::engine::general_purpose::STANDARD
                .encode(format!("{username}:{}", password.unwrap_or("")));
            format!("Proxy-Authorization: Basic {value}\r\n")
        })
        .unwrap_or_default();
    let request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::with_capacity(1024);
    loop {
        let mut byte = [0; 1];
        stream.read_exact(&mut byte).await?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") || response.len() >= 16 * 1024 {
            break;
        }
    }
    let status = String::from_utf8_lossy(&response);
    let accepted = status
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        == Some("200");
    if !accepted {
        return Err(Error::ConnectionFailed(format!(
            "HTTP CONNECT 失败: {}",
            status.lines().next().unwrap_or("无响应")
        )));
    }
    Ok(())
}
