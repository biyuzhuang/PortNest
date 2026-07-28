//! Docker 协议插件

use async_trait::async_trait;
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, LogOutput, LogsOptions,
    RemoveContainerOptions, RestartContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::image::{ListImagesOptions, RemoveImageOptions};
use bollard::models::{Ipam, SystemInfo};
use bollard::network::{CreateNetworkOptions, ListNetworksOptions};
use bollard::volume::{CreateVolumeOptions, ListVolumesOptions, RemoveVolumeOptions};
use bollard::{ClientVersion, Docker};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::time::Instant;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, ProtocolCapability,
    ProtocolPlugin,
};

/// Docker 连接句柄
#[derive(Clone)]
pub struct DockerConnectionHandle {
    id: Uuid,
    docker: Docker,
    remote_addr: (String, u16),
    connected_at: Instant,
}

impl DockerConnectionHandle {
    pub fn new(id: Uuid, docker: Docker, remote_addr: (String, u16)) -> Self {
        Self {
            id,
            docker,
            remote_addr,
            connected_at: Instant::now(),
        }
    }

    pub fn docker(&self) -> &Docker {
        &self.docker
    }

    /// 列出容器
    pub async fn list_containers(&self, all: bool) -> Result<Vec<ContainerInfo>> {
        let opts = ListContainersOptions::<String> {
            all,
            ..Default::default()
        };
        let containers = self
            .docker
            .list_containers(Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;

        Ok(containers
            .into_iter()
            .map(|c| ContainerInfo {
                id: c.id.unwrap_or_default(),
                names: c.names.unwrap_or_default(),
                image: c.image.unwrap_or_default(),
                image_id: c.image_id.unwrap_or_default(),
                command: c.command.unwrap_or_default(),
                created: c.created.unwrap_or(0),
                state: c.state.unwrap_or_default(),
                status: c.status.unwrap_or_default(),
                ports: c
                    .ports
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| PortBinding {
                        private_port: p.private_port as u16,
                        public_port: p.public_port.map(|pp| pp as u16),
                        ip: p.ip,
                        protocol: "tcp".to_string(),
                    })
                    .collect(),
                labels: c.labels.unwrap_or_default(),
            })
            .collect())
    }

    /// 创建容器
    pub async fn create_container(&self, config: DockerContainerCreateConfig) -> Result<String> {
        let mut env = Vec::new();
        if let Some(e) = config.env {
            for (k, v) in e {
                env.push(format!("{}={}", k, v));
            }
        }

        let ports = config.ports.clone().unwrap_or_default();
        let volumes = config.volumes.clone().unwrap_or_default();
        let host_config = bollard::service::HostConfig {
            port_bindings: if !ports.is_empty() {
                let mut bindings = HashMap::new();
                for p in ports {
                    bindings.insert(
                        format!("{}/tcp", p.container_port),
                        Some(vec![bollard::service::PortBinding {
                            host_ip: Some("0.0.0.0".to_string()),
                            host_port: Some(p.host_port.to_string()),
                        }]),
                    );
                }
                Some(bindings)
            } else {
                None
            },
            binds: if !volumes.is_empty() {
                Some(
                    volumes
                        .into_iter()
                        .map(|v| {
                            if v.read_only {
                                format!("{}:{}:ro", v.source, v.target)
                            } else {
                                format!("{}:{}", v.source, v.target)
                            }
                        })
                        .collect(),
                )
            } else {
                None
            },
            ..Default::default()
        };

        let container_config = Config {
            image: Some(config.image.clone()),
            cmd: config.cmd,
            env: Some(env),
            host_config: Some(host_config),
            ..Default::default()
        };

        let opts = config
            .name
            .as_ref()
            .map(|n| CreateContainerOptions::<String> {
                name: n.clone(),
                platform: None,
            });

        let response = self
            .docker
            .create_container(opts, container_config)
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;

        Ok(response.id)
    }

    /// 启动容器
    pub async fn start_container(&self, container_id: &str) -> Result<()> {
        self.docker
            .start_container(container_id, None::<StartContainerOptions<String>>)
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 停止容器
    pub async fn stop_container(&self, container_id: &str, timeout: Option<u64>) -> Result<()> {
        let t = timeout.unwrap_or(10) as i64;
        let opts = StopContainerOptions { t };
        self.docker
            .stop_container(container_id, Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 重启容器
    pub async fn restart_container(&self, container_id: &str, timeout: Option<u64>) -> Result<()> {
        let t = timeout.unwrap_or(10) as isize;
        let opts = RestartContainerOptions { t };
        self.docker
            .restart_container(container_id, Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 终止容器
    pub async fn kill_container(&self, container_id: &str, signal: Option<&str>) -> Result<()> {
        let sig = signal.unwrap_or("SIGKILL").to_string();
        let opts = bollard::container::KillContainerOptions { signal: sig };
        self.docker
            .kill_container(container_id, Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 删除容器
    pub async fn remove_container(&self, container_id: &str, force: bool) -> Result<()> {
        let opts = RemoveContainerOptions {
            force,
            v: false,
            link: false,
        };
        self.docker
            .remove_container(container_id, Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 获取容器日志
    pub async fn logs(
        &self,
        container_id: &str,
        tail: Option<u64>,
        follow: bool,
    ) -> Result<String> {
        let opts = LogsOptions::<String> {
            stdout: true,
            stderr: true,
            tail: tail
                .map(|n| n.to_string())
                .unwrap_or_else(|| "100".to_string()),
            follow,
            timestamps: true,
            ..Default::default()
        };

        let mut stream = self.docker.logs(container_id, Some(opts));
        let mut output = String::new();

        while let Some(result) = stream.next().await {
            match result {
                Ok(log) => match log {
                    LogOutput::StdOut { message } => {
                        output.push_str(&String::from_utf8_lossy(&message));
                    }
                    LogOutput::StdErr { message } => {
                        output.push_str(&String::from_utf8_lossy(&message));
                    }
                    _ => {}
                },
                Err(e) => {
                    return Err(Error::DockerError(e.to_string()));
                }
            }
        }

        Ok(output)
    }

    /// 获取容器统计信息
    pub async fn stats(&self, container_id: &str) -> Result<ContainerStats> {
        use bollard::container::StatsOptions;

        let opts = StatsOptions {
            stream: false,
            one_shot: true,
        };
        let mut stream = self.docker.stats(container_id, Some(opts));

        if let Some(result) = stream.next().await {
            let stats = result.map_err(|e| Error::DockerError(e.to_string()))?;

            let cpu_percent = calculate_cpu_percent(&stats);
            let memory_usage = stats.memory_stats.usage.unwrap_or(0) as i64;
            let memory_limit = stats.memory_stats.limit.unwrap_or(1) as i64;
            let memory_percent = (memory_usage as f64 / memory_limit as f64 * 100.0).round() as f64;

            let (network_rx, network_tx) = stats
                .networks
                .as_ref()
                .map(|nets| {
                    nets.values().fold((0i64, 0i64), |(rx, tx), net| {
                        (rx + net.rx_bytes as i64, tx + net.tx_bytes as i64)
                    })
                })
                .unwrap_or((0, 0));

            return Ok(ContainerStats {
                id: container_id.to_string(),
                name: stats
                    .name
                    .strip_prefix('/')
                    .unwrap_or(&stats.name)
                    .to_string(),
                cpu_percent,
                memory_usage,
                memory_limit,
                memory_percent,
                network_rx,
                network_tx,
            });
        }

        Err(Error::DockerError("无法获取容器统计信息".to_string()))
    }

    /// 列出镜像
    pub async fn list_images(&self) -> Result<Vec<ImageInfo>> {
        let opts = ListImagesOptions::<String> {
            all: false,
            ..Default::default()
        };
        let images = self
            .docker
            .list_images(Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;

        Ok(images
            .into_iter()
            .map(|img| ImageInfo {
                id: img.id,
                repo_tags: img.repo_tags,
                size: img.size as i64,
                created: img.created,
            })
            .collect())
    }

    /// 拉取镜像
    pub async fn pull_image(&self, image: &str, tag: Option<&str>) -> Result<String> {
        use bollard::image::CreateImageOptions;

        let opts = CreateImageOptions {
            from_image: image,
            tag: tag.unwrap_or("latest"),
            ..Default::default()
        };

        let mut stream = self.docker.create_image(Some(opts), None, None);
        let mut status = String::new();

        while let Some(result) = stream.next().await {
            if let Ok(info) = result {
                if let Some(s) = info.status {
                    status = s;
                }
            } else {
                return Err(Error::DockerError("拉取镜像失败".to_string()));
            }
        }

        Ok(status)
    }

    /// 删除镜像
    pub async fn remove_image(&self, image_id: &str, force: bool) -> Result<()> {
        let opts = RemoveImageOptions {
            force,
            noprune: true,
        };
        self.docker
            .remove_image(image_id, Some(opts), None)
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 列出卷
    pub async fn list_volumes(&self) -> Result<Vec<VolumeInfo>> {
        let opts = ListVolumesOptions::<String> {
            filters: Default::default(),
        };
        let result = self
            .docker
            .list_volumes(Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;

        let volumes = result.volumes.unwrap_or_default();
        Ok(volumes
            .into_iter()
            .map(|v| VolumeInfo {
                name: v.name,
                driver: v.driver,
                mountpoint: v.mountpoint,
                created: v.created_at.unwrap_or_default(),
            })
            .collect())
    }

    /// 创建卷
    pub async fn create_volume(&self, name: &str, driver: &str) -> Result<String> {
        let opts = CreateVolumeOptions::<String> {
            name: name.to_string(),
            driver: driver.to_string(),
            driver_opts: Default::default(),
            labels: Default::default(),
        };
        let volume = self
            .docker
            .create_volume(opts)
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(volume.name)
    }

    /// 删除卷
    pub async fn remove_volume(&self, volume_name: &str) -> Result<()> {
        let opts = RemoveVolumeOptions { force: false };
        self.docker
            .remove_volume(volume_name, Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// 列出网络
    pub async fn list_networks(&self) -> Result<Vec<NetworkInfo>> {
        let opts = ListNetworksOptions::<String> {
            ..Default::default()
        };
        let networks = self
            .docker
            .list_networks(Some(opts))
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;

        Ok(networks
            .into_iter()
            .map(|n| NetworkInfo {
                id: n.id.unwrap_or_default(),
                name: n.name.unwrap_or_default(),
                driver: n.driver.unwrap_or_default(),
                scope: n.scope.unwrap_or_default(),
            })
            .collect())
    }

    /// 创建网络
    pub async fn create_network(&self, name: &str, driver: &str) -> Result<String> {
        let opts = CreateNetworkOptions {
            name: name.to_string(),
            check_duplicate: true,
            driver: driver.to_string(),
            internal: false,
            attachable: false,
            ingress: false,
            ipam: Ipam {
                driver: Some("default".to_string()),
                config: None,
                options: None,
            },
            enable_ipv6: false,
            options: Default::default(),
            labels: Default::default(),
        };
        let network = self
            .docker
            .create_network(opts)
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(network.id.unwrap_or_default())
    }

    /// 删除网络
    pub async fn remove_network(&self, network_id: &str) -> Result<()> {
        self.docker
            .remove_network(network_id)
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;
        Ok(())
    }

    /// Docker ping
    pub async fn ping(&self) -> Result<String> {
        self.docker
            .ping()
            .await
            .map_err(|e| Error::DockerError(e.to_string()))
    }

    /// Docker 系统信息
    pub async fn info(&self) -> Result<DockerSystemInfo> {
        let info: SystemInfo = self
            .docker
            .info()
            .await
            .map_err(|e| Error::DockerError(e.to_string()))?;

        Ok(DockerSystemInfo {
            containers: info.containers.unwrap_or(0) as i64,
            containers_running: info.containers_running.unwrap_or(0) as i64,
            images: info.images.unwrap_or(0) as i64,
            server_version: info.server_version.unwrap_or_default(),
            operating_system: info.operating_system.unwrap_or_default(),
            architecture: info.architecture.unwrap_or_default(),
        })
    }
}

impl ConnectionHandle for DockerConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        "docker"
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

/// Docker 协议插件
pub struct DockerPlugin;

impl DockerPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DockerPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProtocolPlugin for DockerPlugin {
    fn protocol_id(&self) -> &'static str {
        "docker"
    }

    fn display_name(&self) -> &'static str {
        "Docker"
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![ProtocolCapability::Terminal, ProtocolCapability::AIAnalysis]
    }

    fn default_port(&self) -> u16 {
        2375
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        _username: &str,
        _credential: &Credential,
        options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        let timeout = options
            .timeout_ms
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(30));

        let addr = format!("{}:{}", host, port);
        // bollard 0.17.1 的 ClientVersion 字段名是 major_version / minor_version
        let client_version = ClientVersion {
            major_version: 1,
            minor_version: 40,
        };

        let docker = tokio::time::timeout(timeout, async {
            // 支持远程 Docker daemon 连接 (HTTP/HTTPS)
            Docker::connect_with_http(addr.as_str(), 30, &client_version)
        })
        .await
        .map_err(|_| Error::Timeout(format!("连接 Docker daemon {} 超时", addr)))?
        .map_err(|e| Error::ConnectionFailed(format!("连接 Docker {} 失败: {}", addr, e)))?;

        let id = Uuid::new_v4();
        Ok(Box::new(DockerConnectionHandle::new(
            id,
            docker,
            (host.to_string(), port),
        )))
    }

    async fn health_check(&self, handle: &dyn ConnectionHandle) -> Result<bool> {
        let docker_handle = handle
            .as_any()
            .downcast_ref::<DockerConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 Docker 句柄".to_string()))?;

        match docker_handle.docker().ping().await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    async fn get_metadata(&self, handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        let docker_handle = handle
            .as_any()
            .downcast_ref::<DockerConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 Docker 句柄".to_string()))?;

        let elapsed = docker_handle.connected_at.elapsed().as_millis() as u64;

        Ok(ConnectionMetadata {
            session_id: docker_handle.id,
            protocol: "docker".to_string(),
            server_version: None,
            connection_time_ms: elapsed,
            keepalive_interval: None,
        })
    }
}

// ==================== 数据类型 ====================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContainerInfo {
    pub id: String,
    pub names: Vec<String>,
    pub image: String,
    pub image_id: String,
    pub command: String,
    pub created: i64,
    pub state: String,
    pub status: String,
    pub ports: Vec<PortBinding>,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PortBinding {
    pub private_port: u16,
    pub public_port: Option<u16>,
    pub ip: Option<String>,
    pub protocol: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageInfo {
    pub id: String,
    pub repo_tags: Vec<String>,
    pub size: i64,
    pub created: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VolumeInfo {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub created: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkInfo {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContainerStats {
    pub id: String,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_usage: i64,
    pub memory_limit: i64,
    pub memory_percent: f64,
    pub network_rx: i64,
    pub network_tx: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerSystemInfo {
    pub containers: i64,
    pub containers_running: i64,
    pub images: i64,
    pub server_version: String,
    pub operating_system: String,
    pub architecture: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerContainerCreateConfig {
    pub image: String,
    pub name: Option<String>,
    pub cmd: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub labels: Option<HashMap<String, String>>,
    pub ports: Option<Vec<PortMapping>>,
    pub volumes: Option<Vec<VolumeMount>>,
    pub network: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PortMapping {
    pub container_port: u16,
    pub host_port: u16,
    pub protocol: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VolumeMount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

// 计算 CPU 使用率
fn calculate_cpu_percent(stats: &bollard::container::Stats) -> f64 {
    let cpu_delta = stats.cpu_stats.cpu_usage.total_usage as f64
        - stats.precpu_stats.cpu_usage.total_usage as f64;
    let system_delta = stats.cpu_stats.system_cpu_usage.unwrap_or(0) as f64
        - stats.precpu_stats.system_cpu_usage.unwrap_or(0) as f64;
    let num_cpus = stats.cpu_stats.online_cpus.unwrap_or(1) as f64;

    if system_delta > 0.0 && cpu_delta > 0.0 {
        (cpu_delta / system_delta) * num_cpus * 100.0
    } else {
        0.0
    }
}
