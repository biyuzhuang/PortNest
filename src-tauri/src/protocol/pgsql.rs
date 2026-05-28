//! PostgreSQL 数据库协议插件

use async_trait::async_trait;
use std::time::Instant;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential,
    ProtocolCapability, ProtocolPlugin,
};

/// PostgreSQL 连接句柄
pub struct PgsqlConnectionHandle {
    id: Uuid,
    remote_addr: (String, u16),
    connected_at: Instant,
}

impl PgsqlConnectionHandle {
    pub fn new(id: Uuid, remote_addr: (String, u16)) -> Self {
        Self {
            id,
            remote_addr,
            connected_at: Instant::now(),
        }
    }
}

impl ConnectionHandle for PgsqlConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        "postgresql"
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

/// PostgreSQL 协议插件
pub struct PgsqlPlugin;

impl PgsqlPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PgsqlPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProtocolPlugin for PgsqlPlugin {
    fn protocol_id(&self) -> &'static str {
        "postgresql"
    }

    fn display_name(&self) -> &'static str {
        "PostgreSQL"
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![ProtocolCapability::Query, ProtocolCapability::AIAnalysis]
    }

    fn default_port(&self) -> u16 {
        5432
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        _username: &str,
        _credential: &Credential,
        _options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        let id = Uuid::new_v4();
        let remote_addr = (host.to_string(), port);

        Ok(Box::new(PgsqlConnectionHandle::new(id, remote_addr)))
    }

    async fn health_check(&self, _handle: &dyn ConnectionHandle) -> Result<bool> {
        Ok(true)
    }

    async fn get_metadata(&self, handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        let pgsql_handle = handle
            .as_any()
            .downcast_ref::<PgsqlConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 PostgreSQL 句柄".to_string()))?;

        let elapsed = pgsql_handle.connected_at.elapsed().as_millis() as u64;

        Ok(ConnectionMetadata {
            session_id: pgsql_handle.id,
            protocol: "postgresql".to_string(),
            server_version: None,
            connection_time_ms: elapsed,
            keepalive_interval: None,
        })
    }
}