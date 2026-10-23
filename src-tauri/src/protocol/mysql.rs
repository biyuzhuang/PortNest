//! MySQL 数据库协议插件
use async_trait::async_trait;
use mysql_async::{prelude::Queryable, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, SslOpts};
use std::time::Instant;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::protocol::{
    ConnectionHandle, ConnectionMetadata, ConnectionOptions, Credential, CredentialType,
    ProtocolCapability, ProtocolPlugin,
};

pub(crate) fn ssl_opts_from_mode(mode: &str) -> Result<Option<SslOpts>> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "" | "disabled" => Ok(None),
        "required" | "verify_identity" => Ok(Some(SslOpts::default())),
        "skip_verify" => Ok(Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true),
        )),
        other => Err(Error::InvalidConfig(format!(
            "不支持的 MySQL SSL 模式: {other}"
        ))),
    }
}

/// MySQL 连接句柄
pub struct MysqlConnectionHandle {
    id: Uuid,
    pool: Pool,
    remote_addr: (String, u16),
    connected_at: Instant,
}

impl MysqlConnectionHandle {
    pub fn new(id: Uuid, pool: Pool, remote_addr: (String, u16)) -> Self {
        Self {
            id,
            pool,
            remote_addr,
            connected_at: Instant::now(),
        }
    }

    pub async fn query(&self, sql: &str) -> Result<Vec<Row>> {
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| Error::DatabaseError(format!("获取连接失败: {}", e)))?;

        let result: Vec<Row> = conn
            .query(sql)
            .await
            .map_err(|e| Error::DatabaseError(format!("查询失败: {}", e)))?;

        Ok(result)
    }
}

impl ConnectionHandle for MysqlConnectionHandle {
    fn id(&self) -> Uuid {
        self.id
    }

    fn protocol(&self) -> &'static str {
        "mysql"
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

/// MySQL 协议插件
pub struct MysqlPlugin;

impl MysqlPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MysqlPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProtocolPlugin for MysqlPlugin {
    fn protocol_id(&self) -> &'static str {
        "mysql"
    }

    fn display_name(&self) -> &'static str {
        "MySQL"
    }

    fn capabilities(&self) -> Vec<ProtocolCapability> {
        vec![ProtocolCapability::Query, ProtocolCapability::AIAnalysis]
    }

    fn default_port(&self) -> u16 {
        3306
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        username: &str,
        credential: &Credential,
        _options: &ConnectionOptions,
    ) -> Result<Box<dyn ConnectionHandle>> {
        let password = match &credential.credential_type {
            CredentialType::Password => credential.password.clone(),
            _ => None,
        };

        // OptsBuilder 实现了 TryFrom<Opts>，Pool::new 可以直接接收
        let constraints = PoolConstraints::new(1, 4)
            .ok_or_else(|| Error::InvalidConfig("MySQL 连接池配置无效".to_string()))?;
        let pool_opts = PoolOpts::default().with_constraints(constraints);
        let ssl_mode = _options
            .protocol_options
            .get("ssl_mode")
            .map(String::as_str)
            .unwrap_or("disabled");
        let mut opts = OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port)
            .user(Some(username))
            .pass(password)
            .client_found_rows(true)
            .stmt_cache_size(64usize)
            .ssl_opts(ssl_opts_from_mode(ssl_mode)?)
            .pool_opts(pool_opts);
        if let Some(database) = _options
            .protocol_options
            .get("database")
            .filter(|value| !value.is_empty())
        {
            opts = opts.db_name(Some(database.clone()));
        }

        let pool = Pool::new(opts);
        let id = Uuid::new_v4();

        Ok(Box::new(MysqlConnectionHandle::new(
            id,
            pool,
            (host.to_string(), port),
        )))
    }

    async fn health_check(&self, handle: &dyn ConnectionHandle) -> Result<bool> {
        let mysql_handle = handle
            .as_any()
            .downcast_ref::<MysqlConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 MySQL 句柄".to_string()))?;

        match mysql_handle.query("SELECT 1").await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    async fn get_metadata(&self, handle: &dyn ConnectionHandle) -> Result<ConnectionMetadata> {
        let mysql_handle = handle
            .as_any()
            .downcast_ref::<MysqlConnectionHandle>()
            .ok_or_else(|| Error::ProtocolError("无效的 MySQL 句柄".to_string()))?;

        let elapsed = mysql_handle.connected_at.elapsed().as_millis() as u64;

        Ok(ConnectionMetadata {
            session_id: mysql_handle.id,
            protocol: "mysql".to_string(),
            server_version: None,
            connection_time_ms: elapsed,
            keepalive_interval: None,
        })
    }
}
