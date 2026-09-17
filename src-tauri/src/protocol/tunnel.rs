use parking_lot::{Mutex as ParkingMutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::ssh_backend::{
    session_pool_key, CancellationToken, ConnectionTarget, SshBackend, SshSession, SshSessionPool,
};
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
    pub total_connections: usize,
    pub error: Option<String>,
}

struct TunnelRuntime {
    info: TunnelRuntimeInfo,
    cancellation: CancellationToken,
    active_connections: Arc<AtomicUsize>,
    total_connections: Arc<AtomicUsize>,
    last_error: Arc<ParkingMutex<Option<String>>>,
    lease_key: String,
    lease_owner: String,
}

#[derive(Clone)]
pub struct TunnelManager {
    runtimes: Arc<RwLock<HashMap<String, TunnelRuntime>>>,
    pool: Arc<SshSessionPool>,
}

impl TunnelManager {
    pub fn new(pool: Arc<SshSessionPool>) -> Self {
        Self { runtimes: Arc::new(RwLock::new(HashMap::new())), pool }
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
        }

        let tunnel_id = Uuid::new_v4().to_string();
        let lease_owner = format!("tunnel:{tunnel_id}");
        let lease_key = session_pool_key(&connection_id, &target, &credential, &options);
        let session = self
            .pool
            .acquire(
                lease_key.clone(),
                lease_owner.clone(),
                backend,
                &target,
                &credential,
                &options,
            )
            .await?;
        let cancellation = CancellationToken::default();
        let active_connections = Arc::new(AtomicUsize::new(0));
        let total_connections = Arc::new(AtomicUsize::new(0));
        let last_error = Arc::new(ParkingMutex::new(None));
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
            total_connections: 0,
            error: None,
        };

        match rule.tunnel_type {
            TunnelType::Local | TunnelType::Dynamic => {
                let listener = match TcpListener::bind((rule.bind_host.as_str(), rule.bind_port)).await {
                    Ok(listener) => listener,
                    Err(error) => {
                        self.pool.release(&lease_key, &lease_owner).await;
                        return Err(Error::ConnectionFailed(format!(
                            "监听 {}:{} 失败: {error}", rule.bind_host, rule.bind_port
                        )));
                    }
                };
                info.status = TunnelStatus::Running;
                self.runtimes.write().insert(
                    tunnel_id.clone(),
                    TunnelRuntime {
                        info: info.clone(),
                        cancellation: cancellation.clone(),
                        active_connections: active_connections.clone(),
                        total_connections: total_connections.clone(),
                        last_error: last_error.clone(),
                        lease_key: lease_key.clone(),
                        lease_owner: lease_owner.clone(),
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
                        total_connections,
                        last_error,
                    )
                    .await;
                    manager.finish_runtime(&tunnel_id, result);
                });
            }
            TunnelType::Remote => {
                self.runtimes.write().insert(
                    tunnel_id.clone(),
                    TunnelRuntime {
                        info: info.clone(),
                        cancellation: cancellation.clone(),
                        active_connections: active_connections.clone(),
                        total_connections: total_connections.clone(),
                        last_error: last_error.clone(),
                        lease_key: lease_key.clone(),
                        lease_owner: lease_owner.clone(),
                    },
                );
                let (ready_sender, ready_receiver) = oneshot::channel();
                let bind_host = rule.bind_host.clone();
                let target_host = rule.target_host.clone().expect("validated remote target");
                let target_port = rule.target_port.expect("validated remote target port");
                let session_for_task = session.clone();
                let cancellation_for_task = cancellation.clone();
                let active_for_task = active_connections.clone();
                let error_for_task = last_error.clone();
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
                            total_connections.clone(),
                            Arc::new(move |message| *error_for_task.lock() = Some(message)),
                        )
                        .await;
                    manager.finish_runtime(&runtime_id, result);
                });
                let startup_timeout = std::time::Duration::from_millis(
                    options.timeout_ms.unwrap_or(30_000),
                );
                let allocated_result = match tokio::time::timeout(startup_timeout, ready_receiver).await {
                    Err(_) => Err(Error::Timeout("等待远程转发确认超时".to_string())),
                    Ok(Err(_)) => Err(Error::ConnectionFailed("远程转发启动任务意外结束".to_string())),
                    Ok(Ok(Err(message))) => Err(Error::ConnectionFailed(message)),
                    Ok(Ok(Ok(port))) => Ok(port),
                };
                let allocated = match allocated_result {
                    Ok(port) => port,
                    Err(error) => {
                        cancellation.cancel();
                        self.finish_runtime(&tunnel_id, Err(Error::ConnectionFailed(error.to_string())));
                        return Err(error);
                    }
                };
                info.bind_port = allocated;
                info.status = TunnelStatus::Running;
                let mut runtimes = self.runtimes.write();
                let runtime = runtimes.get_mut(&tunnel_id)
                    .ok_or_else(|| Error::ConnectionFailed("远程转发启动后状态丢失".to_string()))?;
                if runtime.info.status == TunnelStatus::Error {
                    return Err(Error::ConnectionFailed(runtime.info.error.clone().unwrap_or_else(|| "远程转发启动失败".to_string())));
                }
                runtime.info = info.clone();
            }
        }
        Ok(info)
    }

    pub async fn stop(&self, tunnel_id: &str) -> Result<()> {
        let (lease_key, lease_owner) = {
            let mut runtimes = self.runtimes.write();
            let runtime = runtimes
                .get_mut(tunnel_id)
                .ok_or_else(|| Error::InvalidConfig("隧道不存在或已经停止".to_string()))?;
            runtime.info.status = TunnelStatus::Stopping;
            runtime.cancellation.cancel();
            (runtime.lease_key.clone(), runtime.lease_owner.clone())
        };
        self.runtimes.write().remove(tunnel_id);
        self.pool.release(&lease_key, &lease_owner).await;
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

    pub async fn probe(&self, tunnel_id: &str, dynamic_host: &str, dynamic_port: u16) -> Result<String> {
        let info = self.runtimes.read().get(tunnel_id).map(runtime_info)
            .ok_or_else(|| Error::InvalidConfig("隧道不存在或已经停止".to_string()))?;
        if info.tunnel_type == TunnelType::Remote {
            return Ok(format!("远程监听 {}:{} 已由 SSH 服务端确认", info.bind_host, info.bind_port));
        }
        let mut stream = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            TcpStream::connect((info.bind_host.as_str(), info.bind_port)),
        ).await.map_err(|_| Error::Timeout("连接隧道监听端口超时".to_string()))?
            .map_err(Error::IoError)?;
        if info.tunnel_type == TunnelType::Dynamic {
            stream.write_all(&[5, 1, 0]).await.map_err(Error::IoError)?;
            let mut method = [0_u8; 2];
            stream.read_exact(&mut method).await.map_err(Error::IoError)?;
            if method != [5, 0] { return Err(Error::ProtocolError("动态 SOCKS5 协商失败".to_string())); }
            let host = dynamic_host.as_bytes();
            if host.len() > 255 { return Err(Error::InvalidConfig("测试目标主机名过长".to_string())); }
            let mut request = vec![5, 1, 0, 3, host.len() as u8];
            request.extend_from_slice(host);
            request.extend_from_slice(&dynamic_port.to_be_bytes());
            stream.write_all(&request).await.map_err(Error::IoError)?;
            let mut response = [0_u8; 10];
            stream.read_exact(&mut response).await.map_err(Error::IoError)?;
            if response[1] != 0 { return Err(Error::ConnectionFailed(format!("动态 SOCKS5 测试失败，错误码 {}", response[1]))); }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if let Some(error) = self.runtimes.read().get(tunnel_id).and_then(|runtime| runtime.last_error.lock().clone()) {
            return Err(Error::ConnectionFailed(error));
        }
        Ok(format!("已通过 SSH 打开目标通道；监听 {}:{} 可用", info.bind_host, info.bind_port))
    }

    fn finish_runtime(&self, tunnel_id: &str, result: Result<()>) {
        let lease = if let Some(runtime) = self.runtimes.write().get_mut(tunnel_id) {
            match result {
                Ok(()) => runtime.info.status = TunnelStatus::Stopped,
                Err(error) => {
                    runtime.info.status = TunnelStatus::Error;
                    runtime.info.error = Some(error.to_string());
                }
            }
            Some((runtime.lease_key.clone(), runtime.lease_owner.clone()))
        } else { None };
        if let Some((key, owner)) = lease {
            let pool = self.pool.clone();
            tokio::spawn(async move { pool.release(&key, &owner).await; });
        }
    }
}

fn runtime_info(runtime: &TunnelRuntime) -> TunnelRuntimeInfo {
    let mut info = runtime.info.clone();
    info.active_connections = runtime.active_connections.load(Ordering::Acquire);
    info.total_connections = runtime.total_connections.load(Ordering::Acquire);
    if let Some(error) = runtime.last_error.lock().clone() {
        info.error = Some(error);
    }
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
    total_connections: Arc<AtomicUsize>,
    last_error: Arc<ParkingMutex<Option<String>>>,
) -> Result<()> {
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Ok(()),
            accepted = listener.accept() => {
                let (mut stream, _) = accepted.map_err(Error::IoError)?;
                let session = session.clone();
                let rule = rule.clone();
                let active_connections = active_connections.clone();
                let total_connections = total_connections.clone();
                let last_error = last_error.clone();
                active_connections.fetch_add(1, Ordering::AcqRel);
                total_connections.fetch_add(1, Ordering::AcqRel);
                tokio::spawn(async move {
                    let result = async {
                        let (target_host, target_port) = if matches!(rule.tunnel_type, TunnelType::Dynamic) {
                            socks5_handshake(&mut stream).await?
                        } else {
                            (rule.target_host.clone().expect("validated target"), rule.target_port.expect("validated port"))
                        };
                        let origin = stream.peer_addr()
                            .map(|address| (address.ip().to_string(), address.port()))
                            .unwrap_or_else(|_| ("127.0.0.1".to_string(), 0));
                        let mut channel = match session
                            .open_direct_tcpip(&target_host, target_port, &origin.0, origin.1)
                            .await
                        {
                            Ok(channel) => channel,
                            Err(error) => {
                                if matches!(rule.tunnel_type, TunnelType::Dynamic) {
                                    let _ = stream.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                                }
                                return Err(error);
                            }
                        };
                        if matches!(rule.tunnel_type, TunnelType::Dynamic) {
                            stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.map_err(Error::IoError)?;
                        }
                        tokio::io::copy_bidirectional(&mut stream, &mut channel)
                            .await
                            .map_err(Error::IoError)?;
                        Ok(())
                    }.await;
                    if let Err(error) = result {
                        tracing::warn!("隧道连接失败: {error}");
                        *last_error.lock() = Some(error.to_string());
                    }
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
            let target = socks5_handshake(&mut stream).await?;
            stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.map_err(Error::IoError)?;
            Ok(target)
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
