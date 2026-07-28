//! SFTP 协议插件
//!
//! SFTP 依赖 SSH 传输层实现文件传输功能

use async_trait::async_trait;
use parking_lot::Mutex;
use ssh2::{Session, Sftp};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, ProtocolCapability,
    ProtocolPlugin,
};

/// 文件信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_link: bool,
    pub modified: Option<i64>,
}

/// SFTP 连接句柄
pub struct SftpConnectionHandle {
    id: Uuid,
    sftp: Arc<Mutex<Sftp>>,
    session: Session,
    remote_addr: (String, u16),
}

impl SftpConnectionHandle {
    pub fn new(id: Uuid, sftp: Sftp, session: Session, remote_addr: (String, u16)) -> Self {
        Self {
            id,
            sftp: Arc::new(Mutex::new(sftp)),
            session,
            remote_addr,
        }
    }

    /// 从 SSH 连接创建 SFTP 会话
    pub fn from_ssh(ssh_handle: &crate::protocol::ssh::SshConnectionHandle) -> Result<Self> {
        // SFTP needs blocking mode, temporarily switch
        ssh_handle.session().set_blocking(true);

        let sftp = ssh_handle
            .session()
            .sftp()
            .map_err(|e| Error::ProtocolError(format!("创建 SFTP 会话失败: {}", e)))?;

        let remote_addr = (
            ssh_handle.remote_addr().0.to_string(),
            ssh_handle.remote_addr().1,
        );
        Ok(Self {
            id: Uuid::new_v4(),
            sftp: Arc::new(Mutex::new(sftp)),
            session: ssh_handle.session().clone(),
            remote_addr,
        })
    }

    /// 列出目录内容
    pub fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>> {
        // SFTP operations need blocking mode
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        tracing::debug!("SFTP list_dir: opening {}", path);
        let mut dir = sftp.opendir(Path::new(path)).map_err(|e| {
            tracing::error!("SFTP opendir error for {}: {:?}", path, e);
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("opendir failed: {:?}", e),
            ))
        })?;

        let mut entries = Vec::new();
        loop {
            match dir.readdir() {
                Ok((filename, stat)) => {
                    let name = filename.to_string_lossy().to_string();
                    if name != "." && name != ".." {
                        let full_path = if path.ends_with('/') {
                            format!("{}{}", path, name)
                        } else {
                            format!("{}/{}", path, name)
                        };
                        entries.push(FileInfo {
                            name,
                            path: full_path,
                            size: stat.size.unwrap_or(0),
                            is_dir: stat.is_dir(),
                            is_link: false,
                            modified: stat.mtime.map(|t| t as i64),
                        });
                    }
                }
                Err(e) => {
                    // Check if end of directory (SSH_FX_EOF = 1)
                    let err_msg = format!("{}", e);
                    if err_msg.contains("no more files") || err_msg.contains("End of file") {
                        break;
                    }
                    if let ssh2::ErrorCode::SFTP(code) = e.code() {
                        if code == 1 {
                            break;
                        }
                    }
                    return Err(Error::IoError(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("readdir error: {}", e),
                    )));
                }
            }
        }

        // Switch back to non-blocking for SSH shell
        self.session.set_blocking(false);

        Ok(entries)
    }

    /// 下载文件
    pub fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        use std::fs::File as LocalFile;
        use std::io::copy;

        // SFTP needs blocking mode
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        let mut remote_file = sftp.open(Path::new(remote_path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("文件不存在: {}", e),
            ))
        })?;

        let mut local_file = LocalFile::create(local_path).map_err(|e| Error::IoError(e))?;

        let copied = copy(&mut remote_file, &mut local_file).map_err(|e| Error::IoError(e))?;

        self.session.set_blocking(false);

        Ok(copied)
    }

    /// 上传文件
    pub fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        use std::fs::File as LocalFile;
        use std::io::copy;

        // SFTP needs blocking mode
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        let mut local_file = LocalFile::open(local_path).map_err(|e| Error::IoError(e))?;

        let mut remote_file = sftp.create(Path::new(remote_path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("上传失败: {}", e),
            ))
        })?;

        let copied = copy(&mut local_file, &mut remote_file).map_err(|e| Error::IoError(e))?;

        self.session.set_blocking(false);

        Ok(copied)
    }

    /// 创建目录
    pub fn create_dir(&self, path: &str) -> Result<()> {
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        sftp.mkdir(Path::new(path), 0o755).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("创建目录失败: {}", e),
            ))
        })?;

        self.session.set_blocking(false);
        Ok(())
    }

    /// 删除文件
    pub fn delete_file(&self, path: &str) -> Result<()> {
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        sftp.unlink(Path::new(path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("删除文件失败: {}", e),
            ))
        })?;

        self.session.set_blocking(false);
        Ok(())
    }

    /// 删除目录
    pub fn delete_dir(&self, path: &str) -> Result<()> {
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        sftp.rmdir(Path::new(path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("删除目录失败: {}", e),
            ))
        })?;

        self.session.set_blocking(false);
        Ok(())
    }

    /// 重命名
    pub fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        self.session.set_blocking(true);

        let sftp = self.sftp.lock();
        sftp.rename(Path::new(old_path), Path::new(new_path), None)
            .map_err(|e| {
                Error::IoError(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("重命名失败: {}", e),
                ))
            })?;

        self.session.set_blocking(false);
        Ok(())
    }
}

impl ConnectionHandle for SftpConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        "sftp"
    }

    fn is_connected(&self) -> bool {
        true
    }

    fn status(&self) -> crate::protocol::SessionStatus {
        crate::protocol::SessionStatus::Connected
    }

    fn remote_addr(&self) -> (&str, u16) {
        (&self.remote_addr.0, self.remote_addr.1)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// SFTP 协议插件
pub struct SftpPlugin;

impl SftpPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SftpPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProtocolPlugin for SftpPlugin {
    fn protocol_id(&self) -> &'static str {
        "sftp"
    }

    fn display_name(&self) -> &'static str {
        "SFTP"
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![ProtocolCapability::FileTransfer]
    }

    fn default_port(&self) -> u16 {
        22
    }

    async fn connect(
        &self,
        _host: &str,
        _port: u16,
        _username: &str,
        _credential: &Credential,
        _options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        Err(Error::ProtocolError(
            "SFTP 需要通过 SSH 连接建立，请使用 SSH 连接".to_string(),
        ))
    }

    async fn health_check(&self, _handle: &dyn ConnectionHandle) -> Result<bool> {
        Ok(true)
    }

    async fn get_metadata(&self, _handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        Err(Error::ProtocolError("未实现".to_string()))
    }
}
