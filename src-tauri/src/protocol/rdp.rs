//! RDP 协议插件 (Windows 专用)
//!
//! 使用 Windows RDP COM 接口实现远程桌面功能

use async_trait::async_trait;
use std::path::PathBuf;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential,
    ProtocolCapability, ProtocolPlugin,
};

/// RDP 连接句柄
pub struct RdpConnectionHandle {
    id: Uuid,
    remote_addr: (String, u16),
    username: Option<String>,
}

impl RdpConnectionHandle {
    pub fn new(id: Uuid, remote_addr: (String, u16), username: Option<String>) -> Self {
        Self { id, remote_addr, username }
    }

    /// 获取 RDP 文件路径
    fn get_rdp_path(&self) -> PathBuf {
        std::env::temp_dir().join(format!("portnest_rdp_{}.rdp", self.id))
    }

    /// 生成 RDP 文件内容
    fn generate_rdp_file(&self) -> String {
        let mut rdp = String::new();
        rdp.push_str(&format!("full address:s:{}:{}\n", self.remote_addr.0, self.remote_addr.1));
        rdp.push_str("screen mode id:i:2\n"); // Full screen
        rdp.push_str("use multimon:i:0\n");
        rdp.push_str("desktopwidth:i:1920\n");
        rdp.push_str("desktopheight:i:1080\n");
        rdp.push_str("session bpp:i:32\n");
        rdp.push_str("compression:i:1\n");
        rdp.push_str("keyboardhook:i:2\n");
        rdp.push_str("audiocapturemode:i:0\n");
        rdp.push_str("videoplaybackmode:i:0\n");
        rdp.push_str("connection type:i:7\n");
        rdp.push_str("networkautodetect:i:1\n");
        rdp.push_str("bandwidthautodetect:i:1\n");
        rdp.push_str("displayconnectionbar:i:1\n");
        rdp.push_str("enableworkspacereconnect:i:0\n");
        rdp.push_str("disable wallpaper:i:0\n");
        rdp.push_str("allow font smoothing:i:1\n");
        rdp.push_str("allow desktop composition:i:1\n");
        rdp.push_str("disable full window drag:i:0\n");
        rdp.push_str("disable menu anims:i:0\n");
        rdp.push_str("disable themes:i:0\n");
        rdp.push_str("disable cursor setting:i:0\n");
        rdp.push_str("bitmapcachepersistenable:i:1\n");
        rdp.push_str("audiomode:i:0\n");
        rdp.push_str("redirectprinters:i:0\n");
        rdp.push_str("redirectcomports:i:0\n");
        rdp.push_str("redirectsmartcards:i:0\n");
        rdp.push_str("redirectclipboard:i:1\n");
        rdp.push_str("redirectposdevices:i:0\n");
        rdp.push_str("autoreconnection enabled:i:1\n");
        rdp.push_str("authentication level:i:2\n");
        rdp.push_str("prompt for credentials:i:0\n");
        rdp.push_str("negotiate security layer:i:1\n");
        rdp.push_str("remoteapplicationmode:i:0\n");
        rdp.push_str("alternate shell:s:\n");
        rdp.push_str("shell working directory:s:\n");
        rdp.push_str("gatewayhostname:s:\n");
        rdp.push_str("gatewayusagemethod:i:4\n");
        rdp.push_str("gatewaycredentialssource:i:4\n");
        rdp.push_str("gatewayprofileusagemethod:i:0\n");
        rdp.push_str("promptcredentialonce:i:0\n");
        rdp.push_str("gatewaybrokeringtype:i:0\n");
        rdp.push_str("use redirection security information:i:0\n");
        rdp.push_str("alternate shell:s:\n");

        if let Some(ref user) = self.username {
            rdp.push_str(&format!("username:s:{}\n", user));
        }

        rdp
    }

    /// 启动 RDP 连接
    pub fn launch(&self) -> Result<()> {
        let rdp_path = self.get_rdp_path();
        let rdp_content = self.generate_rdp_file();

        std::fs::write(&rdp_path, rdp_content)
            .map_err(|e| Error::ProtocolError(format!("写入 RDP 文件失败: {}", e)))?;

        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("mstsc.exe")
                .arg(rdp_path.as_os_str())
                .spawn()
                .map_err(|e| Error::ProtocolError(format!("启动 RDP 失败: {}", e)))?;
        }

        Ok(())
    }
}

impl ConnectionHandle for RdpConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        "rdp"
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn status(&self) -> crate::protocol::SessionStatus {
        crate::protocol::SessionStatus::Disconnected
    }

    fn remote_addr(&self) -> (&str, u16) {
        (&self.remote_addr.0, self.remote_addr.1)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// RDP 协议插件
pub struct RdpPlugin;

impl RdpPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RdpPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProtocolPlugin for RdpPlugin {
    fn protocol_id(&self) -> &'static str {
        "rdp"
    }

    fn display_name(&self) -> &'static str {
        "RDP (远程桌面)"
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![ProtocolCapability::RemoteDesktop]
    }

    fn default_port(&self) -> u16 {
        3389
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        username: &str,
        _credential: &Credential,
        _options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        #[cfg(target_os = "windows")]
        {
            let id = Uuid::new_v4();
            let username = if username.is_empty() { None } else { Some(username.to_string()) };
            let handle = Box::new(RdpConnectionHandle::new(id, (host.to_string(), port), username));
            handle.launch()?;
            Ok(handle as Box<dyn ConnectionHandle>)
        }

        #[cfg(not(target_os = "windows"))]
        {
            Err(Error::ProtocolError(
                "RDP 仅在 Windows 平台上可用".to_string(),
            ))
        }
    }

    async fn health_check(&self, _handle: &dyn ConnectionHandle) -> Result<bool> {
        Ok(true)
    }

    async fn get_metadata(&self, _handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        Err(Error::ProtocolError("RDP 元数据暂未实现".to_string()))
    }
}