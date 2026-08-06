//! Stable SSH backend abstractions used while migrating from `ssh2` to `russh`.
//!
//! UI commands should depend on these traits instead of concrete SSH library
//! types. The `Ssh2Backend` adapter keeps the current implementation available
//! during the migration.

use async_trait::async_trait;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::sftp::{FileInfo, SftpConnectionHandle};
use crate::protocol::ssh::SshPlugin;
use crate::protocol::{
    ConnectionHandle, ConnectionOptions, Credential, ProtocolPlugin, SessionStatus,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}

impl TerminalSize {
    pub fn new(cols: u32, rows: u32) -> Result<Self> {
        if cols == 0 || rows == 0 {
            return Err(Error::InvalidConfig("终端列数和行数必须大于零".to_string()));
        }
        Ok(Self { cols, rows })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisconnectReason {
    UserRequested,
    RemoteClosed,
    AuthenticationFailed,
    ConnectionFailed(String),
    ApplicationExit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionEvent {
    StatusChanged(SessionStatus),
    ChannelOpened { channel_id: Uuid, kind: ChannelKind },
    ChannelClosed { channel_id: Uuid, kind: ChannelKind },
    Disconnected(DisconnectReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Shell,
    Sftp,
    Exec,
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    inner: Arc<CancellationState>,
}

#[derive(Debug, Default)]
struct CancellationState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancellationToken {
    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::AcqRel) {
            self.inner.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }

        let notified = self.inner.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

#[async_trait]
pub trait ShellHandle: Send + Sync {
    fn id(&self) -> Uuid;
    async fn read(&self) -> Result<Vec<u8>>;
    async fn write(&self, data: &[u8]) -> Result<usize>;
    async fn resize(&self, size: TerminalSize) -> Result<()>;
    async fn close(&self) -> Result<()>;
}

#[async_trait]
pub trait SftpHandle: Send + Sync {
    fn id(&self) -> Uuid;
    fn status(&self) -> SessionStatus;
    async fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>>;
    async fn download(&self, remote_path: &str, local_path: &str) -> Result<u64>;
    async fn upload(&self, local_path: &str, remote_path: &str) -> Result<u64>;
    async fn create_dir(&self, path: &str) -> Result<()>;
    async fn delete_file(&self, path: &str) -> Result<()>;
    async fn delete_dir(&self, path: &str) -> Result<()>;
    async fn rename(&self, old_path: &str, new_path: &str) -> Result<()>;
    async fn close(&self) -> Result<()>;
}

#[async_trait]
pub trait SshSession: Send + Sync {
    fn id(&self) -> Uuid;
    async fn open_shell(&self, size: TerminalSize) -> Result<Arc<dyn ShellHandle>>;
    async fn open_sftp(&self) -> Result<Arc<dyn SftpHandle>>;
    async fn exec(&self, command: &str) -> Result<ExecResult>;
    async fn relay_direct_tcpip(
        &self,
        _stream: TcpStream,
        _target_host: &str,
        _target_port: u16,
    ) -> Result<()> {
        Err(Error::ProtocolError(
            "当前 SSH 后端不支持端口转发".to_string(),
        ))
    }
    async fn serve_remote_forward(
        &self,
        _bind_host: &str,
        _bind_port: u16,
        _target_host: &str,
        _target_port: u16,
        _cancellation: CancellationToken,
        ready: oneshot::Sender<std::result::Result<u16, String>>,
        _active_connections: Arc<AtomicUsize>,
    ) -> Result<()> {
        let message = "当前 SSH 后端不支持远程端口转发".to_string();
        let _ = ready.send(Err(message.clone()));
        Err(Error::ProtocolError(message))
    }
    async fn disconnect(&self) -> Result<()>;
    fn status(&self) -> SessionStatus;
}

#[async_trait]
pub trait SshBackend: Send + Sync {
    async fn connect(
        &self,
        target: &ConnectionTarget,
        credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Arc<dyn SshSession>>;
}

#[derive(Debug, Default)]
pub struct Ssh2Backend;

struct Ssh2Session {
    handle: Arc<dyn ConnectionHandle>,
    target: ConnectionTarget,
    credential: Credential,
    options: ConnectionOptions,
}

struct Ssh2ShellHandle {
    session: Arc<dyn ConnectionHandle>,
    shell_id: Uuid,
}

const SHELL_READ_CHUNK_SIZE: usize = 64 * 1024;
const SHELL_READ_LIMIT: usize = 256 * 1024;

struct Ssh2SftpHandle {
    handle: Arc<SftpConnectionHandle>,
    owner: Arc<dyn ConnectionHandle>,
}

#[async_trait]
impl SshBackend for Ssh2Backend {
    async fn connect(
        &self,
        target: &ConnectionTarget,
        credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Arc<dyn SshSession>> {
        let plugin = SshPlugin::new();
        let handle = plugin
            .connect(
                &target.host,
                target.port,
                &target.username,
                credential,
                options,
            )
            .await?;

        Ok(Arc::new(Ssh2Session {
            handle: Arc::from(handle),
            target: target.clone(),
            credential: credential.clone(),
            options: options.clone(),
        }))
    }
}

#[async_trait]
impl SshSession for Ssh2Session {
    fn id(&self) -> Uuid {
        self.handle.id()
    }

    async fn open_shell(&self, size: TerminalSize) -> Result<Arc<dyn ShellHandle>> {
        let handle = self.handle.clone();
        let shell = tokio::task::spawn_blocking(move || handle.open_shell(size.cols, size.rows))
            .await
            .map_err(|error| Error::ProtocolError(format!("打开 Shell 任务失败: {error}")))??;

        Ok(Arc::new(Ssh2ShellHandle {
            session: self.handle.clone(),
            shell_id: shell.id,
        }))
    }

    async fn open_sftp(&self) -> Result<Arc<dyn SftpHandle>> {
        // The legacy ssh2 implementation changes Session blocking mode for
        // SFTP operations, so its compatibility path deliberately uses a
        // separate transport instead of sharing the interactive Shell session.
        let owner: Arc<dyn ConnectionHandle> = Arc::from(
            SshPlugin::new()
                .connect(
                    &self.target.host,
                    self.target.port,
                    &self.target.username,
                    &self.credential,
                    &self.options,
                )
                .await?,
        );
        let handle = owner.clone();
        let sftp = tokio::task::spawn_blocking(move || {
            let ssh = handle
                .as_any()
                .downcast_ref::<crate::protocol::ssh::SshConnectionHandle>()
                .ok_or_else(|| Error::ProtocolError("SSH2 会话类型不匹配".to_string()))?;
            SftpConnectionHandle::from_ssh(ssh).map(Arc::new)
        })
        .await
        .map_err(|error| Error::ProtocolError(format!("打开 SFTP 任务失败: {error}")))??;

        Ok(Arc::new(Ssh2SftpHandle {
            handle: sftp,
            owner,
        }))
    }

    async fn exec(&self, _command: &str) -> Result<ExecResult> {
        Err(Error::ProtocolError(
            "ssh2 兼容后端尚未接入临时 Exec Channel".to_string(),
        ))
    }

    async fn disconnect(&self) -> Result<()> {
        let handle = self.handle.clone();
        tokio::task::spawn_blocking(move || handle.disconnect())
            .await
            .map_err(|error| Error::ProtocolError(format!("断开 SSH 任务失败: {error}")))?
    }

    fn status(&self) -> SessionStatus {
        self.handle.status()
    }
}

#[async_trait]
impl ShellHandle for Ssh2ShellHandle {
    fn id(&self) -> Uuid {
        self.shell_id
    }

    async fn read(&self) -> Result<Vec<u8>> {
        let handle = self.session.clone();
        let shell_id = self.shell_id;
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            let mut chunk = vec![0; SHELL_READ_CHUNK_SIZE];

            while output.len() < SHELL_READ_LIMIT {
                let count = handle.read_shell(&shell_id, &mut chunk)?;
                if count == 0 {
                    break;
                }
                output.extend_from_slice(&chunk[..count]);
            }

            Ok(output)
        })
        .await
        .map_err(|error| Error::ProtocolError(format!("读取 Shell 任务失败: {error}")))?
    }

    async fn write(&self, data: &[u8]) -> Result<usize> {
        let handle = self.session.clone();
        let shell_id = self.shell_id;
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || handle.write_shell(&shell_id, &data))
            .await
            .map_err(|error| Error::ProtocolError(format!("写入 Shell 任务失败: {error}")))?
    }

    async fn resize(&self, size: TerminalSize) -> Result<()> {
        let handle = self.session.clone();
        let shell_id = self.shell_id;
        tokio::task::spawn_blocking(move || handle.resize_shell(&shell_id, size.cols, size.rows))
            .await
            .map_err(|error| Error::ProtocolError(format!("调整 Shell 任务失败: {error}")))?
    }

    async fn close(&self) -> Result<()> {
        let handle = self.session.clone();
        let shell_id = self.shell_id;
        tokio::task::spawn_blocking(move || handle.close_shell(&shell_id))
            .await
            .map_err(|error| Error::ProtocolError(format!("关闭 Shell 任务失败: {error}")))?
    }
}

#[async_trait]
impl SftpHandle for Ssh2SftpHandle {
    fn id(&self) -> Uuid {
        self.handle.id()
    }

    fn status(&self) -> SessionStatus {
        self.handle.status()
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>> {
        let handle = self.handle.clone();
        let path = path.to_string();
        blocking_sftp(move || handle.list_dir(&path)).await
    }

    async fn download(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        let handle = self.handle.clone();
        let remote_path = remote_path.to_string();
        let local_path = local_path.to_string();
        blocking_sftp(move || handle.download_file(&remote_path, &local_path)).await
    }

    async fn upload(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        let handle = self.handle.clone();
        let local_path = local_path.to_string();
        let remote_path = remote_path.to_string();
        blocking_sftp(move || handle.upload_file(&local_path, &remote_path)).await
    }

    async fn create_dir(&self, path: &str) -> Result<()> {
        let handle = self.handle.clone();
        let path = path.to_string();
        blocking_sftp(move || handle.create_dir(&path)).await
    }

    async fn delete_file(&self, path: &str) -> Result<()> {
        let handle = self.handle.clone();
        let path = path.to_string();
        blocking_sftp(move || handle.delete_file(&path)).await
    }

    async fn delete_dir(&self, path: &str) -> Result<()> {
        let handle = self.handle.clone();
        let path = path.to_string();
        blocking_sftp(move || handle.delete_dir(&path)).await
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        let handle = self.handle.clone();
        let old_path = old_path.to_string();
        let new_path = new_path.to_string();
        blocking_sftp(move || handle.rename(&old_path, &new_path)).await
    }

    async fn close(&self) -> Result<()> {
        let owner = self.owner.clone();
        tokio::task::spawn_blocking(move || owner.disconnect())
            .await
            .map_err(|error| Error::ProtocolError(format!("关闭兼容 SFTP 连接失败: {error}")))?
    }
}

async fn blocking_sftp<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| Error::ProtocolError(format!("SFTP 任务失败: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::{CancellationToken, TerminalSize};

    #[test]
    fn terminal_size_rejects_zero_dimensions() {
        assert!(TerminalSize::new(0, 24).is_err());
        assert!(TerminalSize::new(80, 0).is_err());
        assert_eq!(
            TerminalSize::new(80, 24).expect("valid terminal size"),
            TerminalSize { cols: 80, rows: 24 }
        );
    }

    #[tokio::test]
    async fn cancellation_is_shared_and_sticky() {
        let token = CancellationToken::default();
        let waiter = token.clone();

        let task = tokio::spawn(async move {
            waiter.cancelled().await;
            waiter.is_cancelled()
        });

        token.cancel();
        assert!(task.await.expect("cancellation waiter"));
        token.cancelled().await;
    }
}
