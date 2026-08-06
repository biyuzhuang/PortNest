use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::ssh_backend::{CancellationToken, ConnectionTarget, SshBackend, SshSession};
use crate::protocol::{ConnectionOptions, Credential};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelType {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelRule {
    pub id: String,
    pub name: String,
    pub tunnel_type: TunnelType,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_bind_host")]
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    #[serde(default)]
    pub allow_public_bind: bool,
}

fn default_true() -> bool {
    true
}
fn default_bind_host() -> String {
    "127.0.0.1".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelRuntimeInfo {
    pub id: String,
    pub connection_id: String,
    pub rule_id: String,
    pub name: String,
    pub tunnel_type: TunnelType,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub status: TunnelStatus,
    pub active_connections: usize,
    pub error: Option<String>,
}

struct TunnelRuntime {
    info: TunnelRuntimeInfo,
    cancellation: CancellationToken,
    active_connections: Arc<AtomicUsize>,
}

#[derive(Clone, Default)]
pub struct TunnelManager {
    runtimes: Arc<RwLock<HashMap<String, TunnelRuntime>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<dyn SshSession>>>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(
        &self,
        connection_id: String,
        rule: TunnelRule,
        backend: Arc<dyn SshBackend>,
        target: ConnectionTarget,
        credential: Credential,
        options: ConnectionOptions,
    ) -> Result<TunnelRuntimeInfo> {
        validate_rule(&rule)?;
        let existing = self
            .runtimes
            .read()
            .values()
            .find(|runtime| {
                runtime.info.connection_id == connection_id && runtime.info.rule_id == rule.id
            })
            .map(runtime_info);
        if let Some(existing) = existing {
            if matches!(
                existing.status,
                TunnelStatus::Starting | TunnelStatus::Running
            ) {
                return Ok(existing);
            }
            self.runtimes.write().remove(&existing.id);
            if let Some(session) = self.sessions.lock().await.remove(&connection_id) {
                let _ = session.disconnect().await;
            }
        }

        let session = {
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(&connection_id).cloned() {
                session
            } else {
                let session = backend.connect(&target, &credential, &options).await?;
                sessions.insert(connection_id.clone(), session.clone());
                session
            }
        };

        let tunnel_id = Uuid::new_v4().to_string();
        let cancellation = CancellationToken::default();
        let active_connections = Arc::new(AtomicUsize::new(0));
        let mut info = TunnelRuntimeInfo {
            id: tunnel_id.clone(),
            connection_id: connection_id.clone(),
            rule_id: rule.id.clone(),
            name: if rule.name.trim().is_empty() {
                format!("{}:{}", rule.bind_host, rule.bind_port)
            } else {
                rule.name.clone()
            },
            tunnel_type: rule.tunnel_type.clone(),
            bind_host: rule.bind_host.clone(),
            bind_port: rule.bind_port,
            target_host: rule.target_host.clone(),
            target_port: rule.target_port,
            status: TunnelStatus::Starting,
            active_connections: 0,
            error: None,
        };

        match rule.tunnel_type {
            TunnelType::Local | TunnelType::Dynamic => {
                let listener = TcpListener::bind((rule.bind_host.as_str(), rule.bind_port))
                    .await
                    .map_err(|error| {
                        Error::ConnectionFailed(format!(
                            "监听 {}:{} 失败: {error}",
                            rule.bind_host, rule.bind_port
                        ))
                    })?;
                info.status = TunnelStatus::Running;
                self.runtimes.write().insert(
                    tunnel_id.clone(),
                    TunnelRuntime {
                        info: info.clone(),
                        cancellation: cancellation.clone(),
                        active_connections: active_connections.clone(),
                    },
                );
                let manager = self.clone();
                tokio::spawn(async move {
                    let result = serve_local_listener(
                        listener,
                        session,
                        rule,
                        cancellation,
                        active_connections,
                    )
                    .await;
                    manager.finish_runtime(&tunnel_id, result);
                });
            }
            TunnelType::Remote => {
                let (ready_sender, ready_receiver) = oneshot::channel();
                let bind_host = rule.bind_host.clone();
                let target_host = rule.target_host.clone().expect("validated remote target");
                let target_port = rule.target_port.expect("validated remote target port");
                let session_for_task = session.clone();
                let cancellation_for_task = cancellation.clone();
                let active_for_task = active_connections.clone();
                let manager = self.clone();
                let runtime_id = tunnel_id.clone();
                tokio::spawn(async move {
                    let result = session_for_task
                        .serve_remote_forward(
                            &bind_host,
                            rule.bind_port,
                            &target_host,
                            target_port,
                            cancellation_for_task,
                            ready_sender,
                            active_for_task,
                        )
                        .await;
                    manager.finish_runtime(&runtime_id, result);
                });
                let allocated = ready_receiver
                    .await
                    .map_err(|_| Error::ConnectionFailed("远程转发启动任务意外结束".to_string()))?
                    .map_err(Error::ConnectionFailed)?;
                info.bind_port = allocated;
                info.status = TunnelStatus::Running;
                self.runtimes.write().insert(
                    tunnel_id.clone(),
                    TunnelRuntime {
                        info: info.clone(),
                        cancellation,
                        active_connections,
                    },
                );
            }
        }
        Ok(info)
    }

    pub async fn stop(&self, tunnel_id: &str) -> Result<()> {
        let connection_id = {
            let mut runtimes = self.runtimes.write();
            let runtime = runtimes
                .get_mut(tunnel_id)
                .ok_or_else(|| Error::InvalidConfig("隧道不存在或已经停止".to_string()))?;
            runtime.info.status = TunnelStatus::Stopping;
            runtime.cancellation.cancel();
            runtime.info.connection_id.clone()
        };
        self.runtimes.write().remove(tunnel_id);
        let has_more = self
            .runtimes
            .read()
            .values()
            .any(|runtime| runtime.info.connection_id == connection_id);
        if !has_more {
            if let Some(session) = self.sessions.lock().await.remove(&connection_id) {
                let _ = session.disconnect().await;
            }
        }
        Ok(())
    }

    pub async fn stop_all(&self, connection_id: Option<&str>) -> Result<()> {
        let ids: Vec<String> = self
            .runtimes
            .read()
            .values()
            .filter(|runtime| {
                connection_id
                    .map(|id| id == runtime.info.connection_id)
                    .unwrap_or(true)
            })
            .map(|runtime| runtime.info.id.clone())
            .collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
        Ok(())
    }

    pub fn list(&self, connection_id: Option<&str>) -> Vec<TunnelRuntimeInfo> {
        self.runtimes
            .read()
            .values()
            .filter(|runtime| {
                connection_id
                    .map(|id| id == runtime.info.connection_id)
                    .unwrap_or(true)
            })
            .map(runtime_info)
            .collect()
    }

    fn finish_runtime(&self, tunnel_id: &str, result: Result<()>) {
        if let Some(runtime) = self.runtimes.write().get_mut(tunnel_id) {
            match result {
                Ok(()) => runtime.info.status = TunnelStatus::Stopped,
                Err(error) => {
                    runtime.info.status = TunnelStatus::Error;
                    runtime.info.error = Some(error.to_string());
                }
            }
        }
    }
}

fn runtime_info(runtime: &TunnelRuntime) -> TunnelRuntimeInfo {
    let mut info = runtime.info.clone();
    info.active_connections = runtime.active_connections.load(Ordering::Acquire);
    info
}

fn validate_rule(rule: &TunnelRule) -> Result<()> {
    if !rule.enabled {
        return Err(Error::InvalidConfig("隧道规则已禁用".to_string()));
    }
    if rule.bind_host.trim().is_empty() || rule.bind_port == 0 {
        return Err(Error::InvalidConfig(
            "隧道监听地址和端口不能为空".to_string(),
        ));
    }
    if matches!(rule.bind_host.as_str(), "0.0.0.0" | "::" | "[::]") && !rule.allow_public_bind {
        return Err(Error::InvalidConfig(
            "公开监听需要显式确认局域网访问风险".to_string(),
        ));
    }
    if !matches!(rule.tunnel_type, TunnelType::Dynamic)
        && (rule.target_host.as_deref().unwrap_or("").trim().is_empty()
            || rule.target_port.unwrap_or(0) == 0)
    {
        return Err(Error::InvalidConfig(
            "本地或远程转发必须配置目标主机和端口".to_string(),
        ));
    }
    Ok(())
}

async fn serve_local_listener(
    listener: TcpListener,
    session: Arc<dyn SshSession>,
    rule: TunnelRule,
    cancellation: CancellationToken,
    active_connections: Arc<AtomicUsize>,
) -> Result<()> {
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Ok(()),
            accepted = listener.accept() => {
                let (mut stream, _) = accepted.map_err(Error::IoError)?;
                let session = session.clone();
                let rule = rule.clone();
                let active_connections = active_connections.clone();
                active_connections.fetch_add(1, Ordering::AcqRel);
                tokio::spawn(async move {
                    let result = async {
                        let (target_host, target_port) = if matches!(rule.tunnel_type, TunnelType::Dynamic) {
                            socks5_handshake(&mut stream).await?
                        } else {
                            (rule.target_host.clone().expect("validated target"), rule.target_port.expect("validated port"))
                        };
                        session.relay_direct_tcpip(stream, &target_host, target_port).await
                    }.await;
                    if let Err(error) = result { tracing::warn!("隧道连接失败: {error}"); }
                    active_connections.fetch_sub(1, Ordering::AcqRel);
                });
            }
        }
    }
}

async fn socks5_handshake(stream: &mut TcpStream) -> Result<(String, u16)> {
    let mut greeting = [0_u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(Error::IoError)?;
    if greeting[0] != 5 {
        return Err(Error::ProtocolError("仅支持 SOCKS5".to_string()));
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(Error::IoError)?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 0xff]).await.map_err(Error::IoError)?;
        return Err(Error::ProtocolError(
            "SOCKS5 客户端未提供无认证方式".to_string(),
        ));
    }
    stream.write_all(&[5, 0]).await.map_err(Error::IoError)?;
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(Error::IoError)?;
    if header[0] != 5 || header[1] != 1 {
        return Err(Error::ProtocolError(
            "SOCKS5 仅支持 CONNECT 请求".to_string(),
        ));
    }
    let host = match header[3] {
        1 => {
            let mut address = [0_u8; 4];
            stream
                .read_exact(&mut address)
                .await
                .map_err(Error::IoError)?;
            Ipv4Addr::from(address).to_string()
        }
        3 => {
            let length = stream.read_u8().await.map_err(Error::IoError)? as usize;
            let mut address = vec![0_u8; length];
            stream
                .read_exact(&mut address)
                .await
                .map_err(Error::IoError)?;
            String::from_utf8(address)
                .map_err(|_| Error::ProtocolError("SOCKS5 域名不是 UTF-8".to_string()))?
        }
        4 => {
            let mut address = [0_u8; 16];
            stream
                .read_exact(&mut address)
                .await
                .map_err(Error::IoError)?;
            Ipv6Addr::from(address).to_string()
        }
        _ => return Err(Error::ProtocolError("SOCKS5 地址类型不受支持".to_string())),
    };
    let port = stream.read_u16().await.map_err(Error::IoError)?;
    stream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(Error::IoError)?;
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn perform_socks_request(request: &[u8]) -> Result<(String, u16)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            socks5_handshake(&mut stream).await
        });
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [5, 0]);
        client.write_all(request).await.unwrap();
        let mut response = [0_u8; 10];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response[..2], &[5, 0]);
        server.await.unwrap()
    }

    #[test]
    fn public_bind_requires_confirmation() {
        let rule = TunnelRule {
            id: "one".into(),
            name: "public".into(),
            tunnel_type: TunnelType::Dynamic,
            enabled: true,
            auto_start: false,
            bind_host: "0.0.0.0".into(),
            bind_port: 1080,
            target_host: None,
            target_port: None,
            allow_public_bind: false,
        };
        assert!(validate_rule(&rule).is_err());
    }

    #[tokio::test]
    async fn socks5_accepts_ipv4_domain_and_ipv6_targets() {
        let ipv4 = perform_socks_request(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        assert_eq!(ipv4, ("127.0.0.1".to_string(), 80));

        let domain = perform_socks_request(&[
            5, 1, 0, 3, 11, b'e', b'x', b'a', b'm', b'p', b'l', b'e', b'.', b'c', b'o', b'm', 1,
            187,
        ])
        .await
        .unwrap();
        assert_eq!(domain, ("example.com".to_string(), 443));

        let mut ipv6_request = vec![5, 1, 0, 4];
        ipv6_request.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        ipv6_request.extend_from_slice(&22_u16.to_be_bytes());
        let ipv6 = perform_socks_request(&ipv6_request).await.unwrap();
        assert_eq!(ipv6, ("::1".to_string(), 22));
    }

    #[tokio::test]
    async fn socks5_rejects_clients_without_no_auth_method() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            socks5_handshake(&mut stream).await
        });
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(&[5, 1, 2]).await.unwrap();
        let mut response = [0_u8; 2];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(response, [5, 0xff]);
        assert!(server.await.unwrap().is_err());
    }
}
