//! 本地终端支持
//!
//! 通过 portable-pty 启动真实交互式终端进程（Windows 使用 ConPTY，
//! Unix 使用系统 PTY），并实现 `ShellHandle`，复用现有 ShellManager 的
//! 读写/调整大小/关闭流程与终端编码管线。

use async_trait::async_trait;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::ssh_backend::{ShellHandle, TerminalSize};

const SHELL_READ_LIMIT: usize = 256 * 1024;

/// 解析后的本地终端启动配置
#[derive(Debug, Clone)]
pub struct LocalShellProfile {
    pub shell_type: String,
    pub display_name: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// 终端类型的显示名称
pub fn display_name_for(shell_type: &str) -> &'static str {
    match shell_type {
        "cmd" => "命令提示符 (cmd)",
        "powershell" | "powershell5" => "PowerShell 5.1",
        "powershell7" | "pwsh" => "PowerShell 7 (pwsh)",
        "bash" => "Git Bash",
        "wsl" => "WSL",
        "custom" => "自定义命令",
        _ => "本地终端",
    }
}

/// 未显式配置编码时，本地终端统一使用 UTF-8。
///
/// 实测 ConPTY（portable-pty 在 Windows 上的后端）输出与输入均为 UTF-8：
/// 即使系统 OEM 代码页是 936（GBK），cmd / PowerShell 的横幅与提示符中的
/// 中文也以 UTF-8 字节输出，GBK 解码会直接失败。因此本地终端不跟随系统
/// 代码页，一律 UTF-8；需要其它编码的场景仅存在于远程（SSH）终端。
pub fn default_encoding(_shell_type: &str) -> String {
    "UTF-8".to_string()
}

/// 解析本地终端启动配置：终端类型、工作路径、自定义命令
pub fn resolve_profile(
    shell_type: &str,
    configured_cwd: Option<&str>,
    custom_command: Option<&str>,
) -> Result<LocalShellProfile> {
    let normalized = shell_type.trim().to_ascii_lowercase();
    let cwd = resolve_cwd(configured_cwd);

    let (program, args) = match normalized.as_str() {
        "cmd" => (resolve_cmd()?, Vec::new()),
        "powershell" | "powershell5" => (resolve_powershell5()?, Vec::new()),
        "powershell7" | "pwsh" => (resolve_pwsh()?, Vec::new()),
        "bash" => (resolve_bash()?, Vec::new()),
        "wsl" => {
            let program = resolve_wsl()?;
            let mut args = Vec::new();
            if cwd.is_dir() {
                args.push("--cd".to_string());
                args.push(cwd.to_string_lossy().into_owned());
            }
            (program, args)
        }
        "custom" => resolve_custom(custom_command)?,
        _ => {
            return Err(Error::InvalidConfig(format!(
                "不支持的本地终端类型: {shell_type}"
            )))
        }
    };

    let display_name = display_name_for(&normalized).to_string();
    Ok(LocalShellProfile {
        shell_type: normalized,
        display_name,
        program,
        args,
        cwd,
    })
}

fn resolve_custom(custom_command: Option<&str>) -> Result<(String, Vec<String>)> {
    let (program, args) = split_custom_command(custom_command)?;
    let program_path = PathBuf::from(&program);
    let is_absolute_or_qualified = program_path.is_absolute()
        || program_path.components().count() > 1
        || program.contains('/')
        || program.contains('\\');
    let exists = program_path.is_file()
        || (!is_absolute_or_qualified && find_on_path(&program).is_some());
    if !exists {
        return Err(Error::InvalidConfig(format!(
            "未找到自定义命令的可执行文件: {program}"
        )));
    }
    Ok((program, args))
}

/// 拆分自定义命令行：第一个 token 为可执行文件，其余为参数；支持双引号
pub fn split_custom_command(command: Option<&str>) -> Result<(String, Vec<String>)> {
    let command = command
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::InvalidConfig("自定义命令不能为空".to_string()))?;
    let tokens = tokenize_command(command);
    if tokens.is_empty() {
        return Err(Error::InvalidConfig("自定义命令不能为空".to_string()));
    }
    let mut iter = tokens.into_iter();
    let program = iter.next().expect("非空 token 列表");
    Ok((program, iter.collect()))
}

fn tokenize_command(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in command.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ' ' | '\t' if !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// 工作路径：优先使用配置值（必须存在），否则回退用户主目录
fn resolve_cwd(configured: Option<&str>) -> PathBuf {
    if let Some(value) = configured {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_dir() {
                return path;
            }
        }
    }
    default_home()
}

fn default_home() -> PathBuf {
    if cfg!(windows) {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(profile);
        }
        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            let mut joined = drive.into_string().unwrap_or_default();
            joined.push_str(&path.to_string_lossy());
            return PathBuf::from(joined);
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn find_on_path(program: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
            .split(';')
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    for dir in std::env::split_paths(&path) {
        let base = dir.join(program);
        if base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(windows)]
fn system32(name: &str) -> Option<String> {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let candidate = root.join("System32").join(name);
    candidate.is_file().then(|| candidate.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn resolve_cmd() -> Result<String> {
    if let Some(comspec) = std::env::var_os("COMSPEC") {
        let path = PathBuf::from(comspec);
        if path.is_file() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    system32("cmd.exe")
        .or_else(|| find_on_path("cmd.exe"))
        .ok_or_else(|| Error::InvalidConfig("未找到 cmd.exe".to_string()))
}

#[cfg(not(windows))]
fn resolve_cmd() -> Result<String> {
    Err(Error::InvalidConfig("cmd 仅支持 Windows".to_string()))
}

#[cfg(windows)]
fn resolve_powershell5() -> Result<String> {
    system32(r"WindowsPowerShell\v1.0\powershell.exe")
        .or_else(|| find_on_path("powershell.exe"))
        .ok_or_else(|| {
            Error::InvalidConfig("未找到 Windows PowerShell (powershell.exe)".to_string())
        })
}

#[cfg(not(windows))]
fn resolve_powershell5() -> Result<String> {
    Err(Error::InvalidConfig("Windows PowerShell 仅支持 Windows".to_string()))
}

fn resolve_pwsh() -> Result<String> {
    let name = if cfg!(windows) { "pwsh.exe" } else { "pwsh" };
    find_on_path(name)
        .or_else(|| find_on_path("pwsh"))
        .ok_or_else(|| {
            Error::InvalidConfig("未找到 PowerShell 7 (pwsh)，请先安装 PowerShell 7".to_string())
        })
}

#[cfg(windows)]
fn resolve_bash() -> Result<String> {
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| find_on_path("bash.exe"))
        .ok_or_else(|| {
            Error::InvalidConfig("未找到 Git Bash (bash.exe)，请安装 Git for Windows".to_string())
        })
}

#[cfg(not(windows))]
fn resolve_bash() -> Result<String> {
    for candidate in ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"] {
        if PathBuf::from(candidate).is_file() {
            return Ok(candidate.to_string());
        }
    }
    find_on_path("bash").ok_or_else(|| Error::InvalidConfig("未找到 bash".to_string()))
}

#[cfg(windows)]
fn resolve_wsl() -> Result<String> {
    system32("wsl.exe")
        .or_else(|| find_on_path("wsl.exe"))
        .ok_or_else(|| Error::InvalidConfig("未找到 WSL (wsl.exe)，请先启用 WSL".to_string()))
}

#[cfg(not(windows))]
fn resolve_wsl() -> Result<String> {
    Err(Error::InvalidConfig("WSL 仅支持 Windows".to_string()))
}

/// PTY 输出通道消息
enum LocalShellOutput {
    Data(Vec<u8>),
    Eof,
}

/// 本地终端句柄：后台线程读取主 PTY 输出，异步接口与远程 Shell 一致
pub struct LocalShellHandle {
    id: Uuid,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    rx: flume::Receiver<LocalShellOutput>,
    eof: AtomicBool,
    child: Arc<Mutex<Option<Box<dyn Child>>>>,
}

/// 启动本地终端进程
pub fn spawn_local_shell(profile: &LocalShellProfile, size: TerminalSize) -> Result<LocalShellHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: size.rows as u16,
            cols: size.cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| Error::ProtocolError(format!("创建本地 PTY 失败: {error}")))?;

    let mut command = CommandBuilder::new(&profile.program);
    command.args(&profile.args);
    command.cwd(&profile.cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| Error::ProtocolError(format!("启动本地终端失败: {error}")))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| Error::ProtocolError(format!("创建 PTY 读取器失败: {error}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| Error::ProtocolError(format!("创建 PTY 写入器失败: {error}")))?;

    let (tx, rx) = flume::bounded::<LocalShellOutput>(1024);
    let child_shared: Arc<Mutex<Option<Box<dyn Child>>>> = Arc::new(Mutex::new(Some(child)));
    let thread_child = child_shared.clone();

    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(LocalShellOutput::Eof);
                    break;
                }
                Ok(count) => count,
            };
            if tx.send(LocalShellOutput::Data(buffer[..count].to_vec())).is_err() {
                // 接收方已关闭：终止子进程
                let mut guard = thread_child.lock();
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
                break;
            }
        }
    });

    Ok(LocalShellHandle {
        id: Uuid::new_v4(),
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        rx,
        eof: AtomicBool::new(false),
        child: child_shared,
    })
}

#[async_trait]
impl ShellHandle for LocalShellHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    async fn read(&self) -> Result<Vec<u8>> {
        if self.eof.load(Ordering::Acquire) {
            return Err(Error::ProtocolError("本地终端进程已退出".to_string()));
        }
        let mut output = Vec::new();
        while output.len() < SHELL_READ_LIMIT {
            match self.rx.try_recv() {
                Ok(LocalShellOutput::Data(chunk)) => output.extend_from_slice(&chunk),
                Ok(LocalShellOutput::Eof) | Err(flume::TryRecvError::Disconnected) => {
                    self.eof.store(true, Ordering::Release);
                    break;
                }
                Err(flume::TryRecvError::Empty) => break,
            }
        }
        if output.is_empty() && self.eof.load(Ordering::Acquire) {
            return Err(Error::ProtocolError("本地终端进程已退出".to_string()));
        }
        Ok(output)
    }

    async fn write(&self, data: &[u8]) -> Result<usize> {
        if self.eof.load(Ordering::Acquire) {
            return Err(Error::ProtocolError("本地终端进程已退出".to_string()));
        }
        let writer = self.writer.clone();
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut guard = writer.lock();
            guard
                .write_all(&data)
                .map_err(|error| Error::ProtocolError(format!("写入本地终端失败: {error}")))?;
            let _ = guard.flush();
            Ok(data.len())
        })
        .await
        .map_err(|error| Error::ProtocolError(format!("写入本地终端任务失败: {error}")))?
    }

    async fn resize(&self, size: TerminalSize) -> Result<()> {
        let master = self.master.clone();
        tokio::task::spawn_blocking(move || {
            master
                .lock()
                .resize(PtySize {
                    rows: size.rows as u16,
                    cols: size.cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| Error::ProtocolError(format!("调整本地终端大小失败: {error}")))
        })
        .await
        .map_err(|error| Error::ProtocolError(format!("调整本地终端任务失败: {error}")))?
    }

    async fn close(&self) -> Result<()> {
        self.eof.store(true, Ordering::Release);
        let mut guard = self.child.lock();
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        guard.take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_encoding_by_shell() {
        // 本地 ConPTY 终端输入输出均为 UTF-8，与系统 OEM 代码页无关
        assert_eq!(default_encoding("cmd"), "UTF-8");
        assert_eq!(default_encoding("powershell"), "UTF-8");
        assert_eq!(default_encoding("powershell5"), "UTF-8");
        assert_eq!(default_encoding("bash"), "UTF-8");
        assert_eq!(default_encoding("wsl"), "UTF-8");
        assert_eq!(default_encoding("powershell7"), "UTF-8");
        assert_eq!(default_encoding("custom"), "UTF-8");
    }

    #[test]
    fn custom_command_tokenization() {
        let (program, args) =
            split_custom_command(Some(r#""C:\Program Files\Git\bin\bash.exe" --login -l"#))
                .expect("custom command");
        assert_eq!(program, r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(args, vec!["--login", "-l"]);
    }

    #[test]
    fn custom_command_requires_value() {
        assert!(split_custom_command(None).is_err());
        assert!(split_custom_command(Some("   ")).is_err());
    }

    #[test]
    fn cwd_falls_back_to_home_when_configured_missing() {
        // "." 一定存在；配置为不存在路径时应回退到一个存在的目录
        let existing = resolve_cwd(Some("."));
        assert!(existing.is_dir());
        let fallback = resolve_cwd(Some(r"Z:\__portnest_does_not_exist__"));
        assert!(fallback.is_dir());
    }

    #[test]
    fn unknown_shell_type_is_rejected() {
        let error = resolve_profile("klingon", None, None).unwrap_err();
        assert!(error.to_string().contains("不支持的本地终端类型"));
    }

    #[test]
    fn custom_with_missing_executable_is_rejected() {
        let error = resolve_profile("custom", None, Some("__definitely_missing_program_xyz__"))
            .unwrap_err();
        assert!(error.to_string().contains("未找到自定义命令"));
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn local_cmd_pty_round_trip() {
        // 冒烟测试：通过 ConPTY 启动 cmd.exe，写入命令并等待回显，
        // 验证 PTY 创建、后台读取线程与写入通路正常工作。
        let profile = resolve_profile("cmd", None, None).expect("cmd profile");
        let size = TerminalSize::new(80, 24).expect("terminal size");
        let handle = spawn_local_shell(&profile, size).expect("spawn local shell");

        let marker = "PORTNEST_PTY_OK_12345";
        handle
            .write(format!("echo {marker}\r").as_bytes())
            .await
            .expect("write to pty");

        let mut echoed = String::new();
        // 模拟终端应答 ConPTY 的 DSR/DA 查询（真实应用由 xterm.js 自动回复）
        let mut pending = String::new();
        for _ in 0..100 {
            let bytes = handle.read().await.unwrap_or_default();
            if !bytes.is_empty() {
                let text = String::from_utf8_lossy(&bytes);
                pending.push_str(&text);
                echoed.push_str(&text);
                loop {
                    if let Some(index) = pending.find("\x1b[6n") {
                        handle
                            .write(b"\x1b[1;1R")
                            .await
                            .expect("respond to DSR query");
                        pending = pending[index + 4..].to_string();
                    } else if let Some(index) = pending.find("\x1b[c") {
                        handle
                            .write(b"\x1b[?62;1;2;6;9;15;22c")
                            .await
                            .expect("respond to DA query");
                        pending = pending[index + 3..].to_string();
                    } else {
                        break;
                    }
                }
            }
            if echoed.contains(marker) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        assert!(
            echoed.contains(marker),
            "cmd 未回显标记，读取到的内容: {echoed:?}"
        );
        handle.close().await.expect("close local shell");
    }

}
