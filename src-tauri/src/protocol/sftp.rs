//! SFTP 协议插件
//!
//! SFTP 依赖 SSH 传输层实现文件传输功能

use async_trait::async_trait;
use parking_lot::Mutex;
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, ProtocolCapability,
    ProtocolPlugin,
};

struct BlockingModeGuard<'a>(&'a Session);

impl<'a> BlockingModeGuard<'a> {
    fn new(session: &'a Session) -> Self {
        session.set_blocking(true);
        Self(session)
    }
}

impl Drop for BlockingModeGuard<'_> {
    fn drop(&mut self) {
        self.0.set_blocking(false);
    }
}

/// 文件信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_link: bool,
    pub modified: Option<i64>,
    pub permissions: String,
    pub owner_group: String,
    #[serde(skip)]
    uid: Option<u32>,
    #[serde(skip)]
    gid: Option<u32>,
}

fn symbolic_permissions(perm: Option<u32>, is_dir: bool, is_link: bool) -> String {
    let Some(mode) = perm else { return "----------".to_string() };
    let mut result = String::with_capacity(10);
    result.push(if is_link { 'l' } else if is_dir { 'd' } else { '-' });
    for (read, write, execute) in [(0o400, 0o200, 0o100), (0o040, 0o020, 0o010), (0o004, 0o002, 0o001)] {
        result.push(if mode & read != 0 { 'r' } else { '-' });
        result.push(if mode & write != 0 { 'w' } else { '-' });
        result.push(if mode & execute != 0 { 'x' } else { '-' });
    }
    result
}

/// SFTP 连接句柄
pub struct SftpConnectionHandle {
    id: Uuid,
    sftp: Arc<Mutex<Sftp>>,
    session: Session,
    remote_addr: (String, u16),
    user_names: Mutex<HashMap<u32, String>>,
    group_names: Mutex<HashMap<u32, String>>,
}

impl SftpConnectionHandle {
    pub fn new(id: Uuid, sftp: Sftp, session: Session, remote_addr: (String, u16)) -> Self {
        Self {
            id,
            sftp: Arc::new(Mutex::new(sftp)),
            session,
            remote_addr,
            user_names: Mutex::new(HashMap::new()),
            group_names: Mutex::new(HashMap::new()),
        }
    }

    /// 从 SSH 连接创建 SFTP 会话
    pub fn from_ssh(ssh_handle: &crate::protocol::ssh::SshConnectionHandle) -> Result<Self> {
        let _blocking = BlockingModeGuard::new(ssh_handle.session());

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
            user_names: Mutex::new(HashMap::new()),
            group_names: Mutex::new(HashMap::new()),
        })
    }

    /// 列出目录内容
    pub fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>> {
        let _blocking = BlockingModeGuard::new(&self.session);

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
                        let is_dir = stat.is_dir();
                        let is_link = stat.perm
                            .map(|perm| perm & 0o170000 == 0o120000)
                            .unwrap_or(false);
                        entries.push(FileInfo {
                            name,
                            path: full_path,
                            size: stat.size.unwrap_or(0),
                            is_dir,
                            is_link,
                            modified: stat.mtime.map(|t| t as i64),
                            permissions: symbolic_permissions(stat.perm, is_dir, is_link),
                            owner_group: "-/-".to_string(),
                            uid: stat.uid,
                            gid: stat.gid,
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

        drop(dir);
        drop(sftp);

        for entry in &mut entries {
            let user = entry.uid
                .map(|uid| self.resolve_account_name("passwd", uid))
                .unwrap_or_else(|| "-".to_string());
            let group = entry.gid
                .map(|gid| self.resolve_account_name("group", gid))
                .unwrap_or_else(|| "-".to_string());
            entry.owner_group = format!("{}/{}", user, group);
        }

        Ok(entries)
    }

    fn resolve_account_name(&self, database: &str, id: u32) -> String {
        let cache = if database == "passwd" { &self.user_names } else { &self.group_names };
        if let Some(name) = cache.lock().get(&id).cloned() {
            return name;
        }
        let fallback = id.to_string();
        let Ok(mut channel) = self.session.channel_session() else {
            cache.lock().insert(id, fallback.clone());
            return fallback;
        };
        let command = format!("getent {} {}", database, id);
        if channel.exec(&command).is_err() {
            cache.lock().insert(id, fallback.clone());
            return fallback;
        }
        let mut output = String::new();
        if channel.read_to_string(&mut output).is_err() {
            cache.lock().insert(id, fallback.clone());
            return fallback;
        }
        let _ = channel.wait_close();
        let resolved = output.split(':').next()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&fallback)
            .to_string();
        cache.lock().insert(id, resolved.clone());
        resolved
    }

    /// 下载文件
    pub fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        use std::fs::File as LocalFile;
        use std::io::copy;

        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        let mut remote_file = sftp.open(Path::new(remote_path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("文件不存在: {}", e),
            ))
        })?;

        let mut local_file = LocalFile::create(local_path).map_err(|e| Error::IoError(e))?;

        let copied = copy(&mut remote_file, &mut local_file).map_err(|e| Error::IoError(e))?;

        Ok(copied)
    }

    /// 上传文件
    pub fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        use std::fs::File as LocalFile;
        use std::io::copy;

        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        let mut local_file = LocalFile::open(local_path).map_err(|e| Error::IoError(e))?;

        let mut remote_file = sftp.create(Path::new(remote_path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("上传失败: {}", e),
            ))
        })?;

        let copied = copy(&mut local_file, &mut remote_file).map_err(|e| Error::IoError(e))?;

        Ok(copied)
    }

    /// 创建目录
    pub fn create_dir(&self, path: &str) -> Result<()> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        sftp.mkdir(Path::new(path), 0o755).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("创建目录失败: {}", e),
            ))
        })?;

        Ok(())
    }

    /// 删除文件
    pub fn delete_file(&self, path: &str) -> Result<()> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        sftp.unlink(Path::new(path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("删除文件失败: {}", e),
            ))
        })?;

        Ok(())
    }

    /// 删除目录
    pub fn delete_dir(&self, path: &str) -> Result<()> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        sftp.rmdir(Path::new(path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("删除目录失败: {}", e),
            ))
        })?;

        Ok(())
    }

    /// 重命名
    pub fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        sftp.rename(Path::new(old_path), Path::new(new_path), None)
            .map_err(|e| {
                Error::IoError(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("重命名失败: {}", e),
                ))
            })?;

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
