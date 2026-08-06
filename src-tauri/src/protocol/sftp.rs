//! SFTP 协议插件
//!
//! SFTP 依赖 SSH 传输层实现文件传输功能

use async_trait::async_trait;
use parking_lot::Mutex;
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, ProtocolCapability,
    ProtocolPlugin,
};
use crate::protocol::ssh_backend::{CancellationToken, TransferProgress};

const TRANSFER_CHUNK_SIZE: usize = 128 * 1024;

fn is_transient_io_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/// 带进度回调与取消检查的分块复制。
/// - 读/写遇到 WouldBlock/TimedOut（配合会话超时）时视为瞬态：先检查取消，再继续重试；
/// - 写入按偏移分片推进，瞬态错误后从已写偏移继续，避免重复写入。
fn copy_with_progress<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    total: u64,
    progress: Option<&TransferProgress>,
    cancel: &CancellationToken,
) -> Result<u64> {
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
    let mut transferred = 0_u64;
    loop {
        if cancel.is_cancelled() {
            return Err(Error::TransferCancelled);
        }
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if is_transient_io_error(&e) => continue,
            Err(e) => return Err(Error::IoError(e)),
        };
        let mut written = 0;
        while written < count {
            if cancel.is_cancelled() {
                return Err(Error::TransferCancelled);
            }
            match writer.write(&buffer[written..count]) {
                Ok(0) => {
                    return Err(Error::IoError(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "写入零字节",
                    )))
                }
                Ok(n) => written += n,
                Err(e) if is_transient_io_error(&e) => continue,
                Err(e) => return Err(Error::IoError(e)),
            }
        }
        transferred += count as u64;
        if let Some(callback) = progress {
            callback(transferred, total);
        }
    }
    writer.flush().map_err(Error::IoError)?;
    Ok(transferred)
}

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
    pub(crate) uid: Option<u32>,
    #[serde(skip)]
    pub(crate) gid: Option<u32>,
}

pub(crate) fn symbolic_permissions(perm: Option<u32>, is_dir: bool, is_link: bool) -> String {
    let Some(mode) = perm else {
        return "----------".to_string();
    };
    let mut result = String::with_capacity(10);
    result.push(if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    });
    for (read, write, execute) in [
        (0o400, 0o200, 0o100),
        (0o040, 0o020, 0o010),
        (0o004, 0o002, 0o001),
    ] {
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
                        let is_link = stat
                            .perm
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
            let user = entry
                .uid
                .map(|uid| self.resolve_account_name("passwd", uid))
                .unwrap_or_else(|| "-".to_string());
            let group = entry
                .gid
                .map(|gid| self.resolve_account_name("group", gid))
                .unwrap_or_else(|| "-".to_string());
            entry.owner_group = format!("{}/{}", user, group);
        }

        Ok(entries)
    }

    fn resolve_account_name(&self, database: &str, id: u32) -> String {
        let cache = if database == "passwd" {
            &self.user_names
        } else {
            &self.group_names
        };
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
        let resolved = output
            .split(':')
            .next()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&fallback)
            .to_string();
        cache.lock().insert(id, resolved.clone());
        resolved
    }

    /// 下载文件（支持进度回调与取消）
    pub fn download_file(
        &self,
        remote_path: &str,
        local_path: &str,
        progress: Option<TransferProgress>,
        cancel: CancellationToken,
    ) -> Result<u64> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        let total = sftp
            .stat(Path::new(remote_path))
            .ok()
            .and_then(|stat| stat.size)
            .unwrap_or(0);
        let mut remote_file = sftp.open(Path::new(remote_path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("文件不存在: {}", e),
            ))
        })?;

        // 阻塞读设置 200ms 超时，让挂起的读能周期性返回并响应取消；结束后恢复无超时
        self.session.set_timeout(200);
        let result = (|| -> Result<u64> {
            let mut local_file =
                std::fs::File::create(local_path).map_err(Error::IoError)?;
            copy_with_progress(&mut remote_file, &mut local_file, total, progress.as_ref(), &cancel)
        })();
        self.session.set_timeout(0);

        if result.is_err() {
            let _ = std::fs::remove_file(local_path);
        }

        result
    }

    /// 上传文件（支持进度回调与取消）
    pub fn upload_file(
        &self,
        local_path: &str,
        remote_path: &str,
        progress: Option<TransferProgress>,
        cancel: CancellationToken,
    ) -> Result<u64> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        let total = std::fs::metadata(local_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut local_file = std::fs::File::open(local_path).map_err(Error::IoError)?;

        let mut remote_file = sftp.create(Path::new(remote_path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("上传失败: {}", e),
            ))
        })?;

        // 阻塞写设置 200ms 超时，让挂起的写能周期性返回并响应取消；结束后恢复无超时
        self.session.set_timeout(200);
        let result = (|| -> Result<u64> {
            copy_with_progress(&mut local_file, &mut remote_file, total, progress.as_ref(), &cancel)
        })();
        self.session.set_timeout(0);

        if result.is_err() {
            let _ = sftp.unlink(Path::new(remote_path));
        }

        result
    }

    /// 创建空文件
    pub fn create_file(&self, path: &str) -> Result<()> {
        let _blocking = BlockingModeGuard::new(&self.session);

        let sftp = self.sftp.lock();
        let file = sftp.create(Path::new(path)).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("创建文件失败: {}", e),
            ))
        })?;
        drop(file);
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::symbolic_permissions;
    use super::*;
    use std::io::Cursor;
    use std::sync::Mutex;

    #[test]
    fn formats_regular_file_permissions() {
        assert_eq!(
            symbolic_permissions(Some(0o100644), false, false),
            "-rw-r--r--"
        );
        assert_eq!(
            symbolic_permissions(Some(0o100755), false, false),
            "-rwxr-xr-x"
        );
    }

    #[test]
    fn uses_the_file_kind_reported_by_sftp_metadata() {
        assert_eq!(
            symbolic_permissions(Some(0o040750), true, false),
            "drwxr-x---"
        );
        assert_eq!(
            symbolic_permissions(Some(0o120777), false, true),
            "lrwxrwxrwx"
        );
    }

    #[test]
    fn formats_missing_and_special_permission_bits_consistently() {
        assert_eq!(symbolic_permissions(None, false, false), "----------");
        assert_eq!(
            symbolic_permissions(Some(0o104755), false, false),
            "-rwxr-xr-x"
        );
    }

    #[test]
    fn copy_reports_progress_monotonically_and_matches_total() {
        let data = vec![7_u8; 300_000];
        let mut sink = Vec::new();
        let updates: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
        let progress: TransferProgress = {
            let updates = updates.clone();
            Arc::new(move |transferred, total| {
                updates.lock().unwrap().push((transferred, total));
            })
        };
        let cancel = CancellationToken::default();

        let copied = copy_with_progress(
            Cursor::new(data.clone()),
            &mut sink,
            data.len() as u64,
            Some(&progress),
            &cancel,
        )
        .expect("copy should succeed");

        assert_eq!(copied, data.len() as u64);
        assert_eq!(sink, data);
        let updates = updates.lock().unwrap();
        assert!(!updates.is_empty(), "progress callback should be invoked");
        assert_eq!(
            updates.last().copied(),
            Some((data.len() as u64, data.len() as u64))
        );
        for pair in updates.windows(2) {
            assert!(pair[0].0 <= pair[1].0, "transferred must be monotonic");
        }
    }

    #[test]
    fn copy_stops_when_cancelled() {
        let data = vec![1_u8; 1_000_000];
        let mut sink = Vec::new();
        let cancel = CancellationToken::default();
        cancel.cancel();

        let result = copy_with_progress(Cursor::new(data), &mut sink, 1_000_000, None, &cancel);
        assert!(matches!(result, Err(Error::TransferCancelled)));
    }

    struct FlakyReadOnce<R> {
        inner: R,
        failed: bool,
    }

    impl<R: Read> Read for FlakyReadOnce<R> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if !self.failed {
                self.failed = true;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "transient",
                ));
            }
            self.inner.read(buffer)
        }
    }

    #[test]
    fn copy_retries_transient_read_errors() {
        let data = vec![9_u8; 4096];
        let reader = FlakyReadOnce {
            inner: Cursor::new(data.clone()),
            failed: false,
        };
        let mut sink = Vec::new();
        let cancel = CancellationToken::default();

        let copied = copy_with_progress(reader, &mut sink, data.len() as u64, None, &cancel)
            .expect("transient read error should be retried");

        assert_eq!(copied, data.len() as u64);
        assert_eq!(sink, data);
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
