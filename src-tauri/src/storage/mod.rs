//! 存储层模块
//!
//! 负责 SQLite 数据库操作和凭据加密

mod vault;

pub use vault::CredentialVault;

use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use uuid::Uuid;

use crate::error::{Error, Result};

/// 数据库管理器
pub struct Database {
    conn: RwLock<Connection>,
    vault: Arc<CredentialVault>,
}

unsafe impl Send for Database {}
unsafe impl Sync for Database {}

impl Database {
    /// 创建或打开数据库
    pub fn new(app_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&app_dir).map_err(|e| Error::StorageError(e.to_string()))?;

        let db_path = app_dir.join("portnest.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| Error::StorageError(format!("打开数据库失败: {}", e)))?;

        let vault = Arc::new(CredentialVault::new(&db_path)?);

        let db = Self {
            conn: RwLock::new(conn),
            vault,
        };

        db.init_schema()?;
        Ok(db)
    }

    /// 初始化数据库表结构
    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.read().unwrap();

        conn.execute_batch(
            r#"
            -- 连接配置表
            CREATE TABLE IF NOT EXISTS connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                protocol TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT,
                credential_id TEXT NOT NULL,
                options TEXT,
                tags TEXT,
                color TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_connected_at INTEGER
            );

            -- 凭据表（加密存储）
            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                auth_type TEXT NOT NULL,
                encrypted_data TEXT NOT NULL,
                iv TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            -- 会话历史表
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                commands_executed INTEGER DEFAULT 0,
                FOREIGN KEY (connection_id) REFERENCES connections(id)
            );

            -- 标签表
            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL
            );

            -- 连接-标签关联表
            CREATE TABLE IF NOT EXISTS connection_tags (
                connection_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (connection_id, tag_id),
                FOREIGN KEY (connection_id) REFERENCES connections(id),
                FOREIGN KEY (tag_id) REFERENCES tags(id)
            );

            -- 创建索引
            CREATE INDEX IF NOT EXISTS idx_connections_protocol ON connections(protocol);
            CREATE INDEX IF NOT EXISTS idx_sessions_connection_id ON sessions(connection_id);
            "#,
        )
        .map_err(|e| Error::StorageError(format!("初始化表结构失败: {}", e)))?;

        Ok(())
    }

    /// 保存连接配置
    pub fn save_connection(
        &self,
        id: Uuid,
        name: &str,
        protocol: &str,
        host: &str,
        port: u16,
        username: Option<&str>,
        credential_id: Uuid,
        options: Option<&str>,
        tags: Option<&str>,
        color: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.read().unwrap();
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            r#"
            INSERT OR REPLACE INTO connections
            (id, name, protocol, host, port, username, credential_id, options, tags, color, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
            params![
                id.to_string(),
                name,
                protocol,
                host,
                port as i32,
                username,
                credential_id.to_string(),
                options,
                tags,
                color,
                now,
                now
            ],
        )
        .map_err(|e| Error::StorageError(format!("保存连接失败: {}", e)))?;

        Ok(())
    }

    /// 获取所有连接
    pub fn get_connections(&self) -> Result<Vec<ConnectionRecord>> {
        let conn = self.conn.read().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, protocol, host, port, username, credential_id, options, tags, color, created_at, last_connected_at FROM connections ORDER BY sort_order, name")
            .map_err(|e| Error::StorageError(e.to_string()))?;

        let records = stmt
            .query_map([], |row| {
                Ok(ConnectionRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    protocol: row.get(2)?,
                    host: row.get(3)?,
                    port: row.get::<_, i32>(4)? as u16,
                    username: row.get(5)?,
                    credential_id: row.get(6)?,
                    options: row.get(7)?,
                    tags: row.get(8)?,
                    color: row.get(9)?,
                    created_at: row.get(10)?,
                    last_connected_at: row.get(11)?,
                })
            })
            .map_err(|e| Error::StorageError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// 删除连接
    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let conn = self.conn.read().unwrap();
        conn.execute("DELETE FROM connections WHERE id = ?1", params![id])
            .map_err(|e| Error::StorageError(format!("删除连接失败: {}", e)))?;
        Ok(())
    }

    /// 保存凭据
    pub fn save_credential(&self, id: Uuid, name: &str, auth_type: &str, data: &[u8]) -> Result<()> {
        let (encrypted, iv) = self.vault.encrypt(data)?;
        let conn = self.conn.read().unwrap();
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            r#"
            INSERT OR REPLACE INTO credentials (id, name, auth_type, encrypted_data, iv, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                id.to_string(),
                name,
                auth_type,
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &encrypted),
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &iv),
                now,
                now
            ],
        )
        .map_err(|e| Error::StorageError(format!("保存凭据失败: {}", e)))?;

        Ok(())
    }

    /// 获取凭据解密数据
    pub fn get_credential_data(&self, id: &str) -> Result<Vec<u8>> {
        let conn = self.conn.read().unwrap();
        let mut stmt = conn
            .prepare("SELECT encrypted_data, iv FROM credentials WHERE id = ?1")
            .map_err(|e| Error::StorageError(e.to_string()))?;

        let result = stmt.query_row(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });

        match result {
            Ok((encrypted_b64, iv_b64)) => {
                let encrypted = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &encrypted_b64)
                    .map_err(|e| Error::EncryptionError(e.to_string()))?;
                let iv = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &iv_b64)
                    .map_err(|e| Error::EncryptionError(e.to_string()))?;
                self.vault.decrypt(&encrypted, &iv)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Err(Error::StorageError("凭据未找到".to_string())),
            Err(e) => Err(Error::StorageError(e.to_string())),
        }
    }

    /// 获取凭据记录
    pub fn get_credential(&self, id: &str) -> Result<CredentialRecord> {
        let conn = self.conn.read().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, auth_type, created_at, updated_at FROM credentials WHERE id = ?1")
            .map_err(|e| Error::StorageError(e.to_string()))?;

        stmt.query_row(params![id], |row| {
            Ok(CredentialRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                auth_type: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| Error::StorageError(format!("获取凭据失败: {}", e)))
    }

    /// 保存会话历史
    pub fn save_session(&self, id: Uuid, connection_id: &str, started_at: i64) -> Result<()> {
        let conn = self.conn.read().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, connection_id, started_at) VALUES (?1, ?2, ?3)",
            params![id.to_string(), connection_id, started_at],
        )
        .map_err(|e| Error::StorageError(format!("保存会话失败: {}", e)))?;
        Ok(())
    }

    /// 更新会话结束时间
    pub fn end_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.read().unwrap();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "UPDATE sessions SET ended_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(|e| Error::StorageError(format!("更新会话失败: {}", e)))?;
        Ok(())
    }
}

/// 连接记录
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConnectionRecord {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub credential_id: String,
    pub options: Option<String>,
    pub tags: Option<String>,
    pub color: Option<String>,
    pub created_at: i64,
    pub last_connected_at: Option<i64>,
}

/// 凭据记录
#[derive(Debug, Clone)]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub auth_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}