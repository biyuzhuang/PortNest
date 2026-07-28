//! 存储层模块
//!
//! 负责 SQLite 数据库操作和凭证加密

mod vault;

pub use vault::CredentialVault;

use base64::Engine;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{Error, Result};

/// 凭证数据结构（用于 JSON 序列化）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CredentialData {
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

/// 数据库管理器
pub struct Database {
    conn: Mutex<Connection>,
    vault: Arc<CredentialVault>,
}

unsafe impl Send for Database {}
unsafe impl Sync for Database {}

impl Database {
    /// 创建或打开数据库
    pub fn new(app_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&app_dir).map_err(|e| Error::StorageError(e.to_string()))?;

        let db_path = app_dir.join("portnest.db");
        let legacy_vault = if CredentialVault::needs_legacy_migration(&db_path) {
            Some(CredentialVault::legacy(&db_path)?)
        } else {
            None
        };
        let conn = Connection::open(&db_path)
            .map_err(|e| Error::StorageError(format!("打开数据库失败: {}", e)))?;

        let vault = Arc::new(CredentialVault::new(&db_path)?);

        let db = Self {
            conn: Mutex::new(conn),
            vault,
        };

        db.init_schema()?;
        if let Some(legacy_vault) = legacy_vault {
            if let Err(error) = db.migrate_legacy_credentials(&legacy_vault) {
                let _ = std::fs::remove_file(db_path.with_file_name("vault.key"));
                return Err(error);
            }
        }
        db.remove_builtin_demo_data()?;
        Ok(db)
    }

    fn remove_builtin_demo_data(&self) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| Error::StorageError(format!("开始清理演示数据失败: {}", e)))?;
        tx.execute("DELETE FROM connections WHERE id = 'builtin-test-ssh'", [])
            .map_err(|e| Error::StorageError(format!("清理演示连接失败: {}", e)))?;
        tx.execute("DELETE FROM credentials WHERE id = 'builtin-test-cred'", [])
            .map_err(|e| Error::StorageError(format!("清理演示凭据失败: {}", e)))?;
        tx.commit()
            .map_err(|e| Error::StorageError(format!("提交演示数据清理失败: {}", e)))?;
        Ok(())
    }

    fn migrate_legacy_credentials(&self, legacy_vault: &CredentialVault) -> Result<()> {
        let mut conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, auth_type, encrypted_data, iv FROM credentials")
            .map_err(|e| Error::StorageError(format!("读取旧凭据失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| Error::StorageError(format!("读取旧凭据失败: {}", e)))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::StorageError(format!("读取旧凭据失败: {}", e)))?;
        drop(stmt);

        let tx = conn
            .transaction()
            .map_err(|e| Error::StorageError(format!("开始凭据迁移失败: {}", e)))?;
        for (id, auth_type, encrypted, iv) in rows {
            let encrypted = base64::engine::general_purpose::STANDARD
                .decode(encrypted)
                .map_err(|e| Error::EncryptionError(format!("解码旧凭据失败: {}", e)))?;
            let iv = base64::engine::general_purpose::STANDARD
                .decode(iv)
                .map_err(|e| Error::EncryptionError(format!("解码旧凭据 IV 失败: {}", e)))?;
            let plaintext = match legacy_vault.decrypt(&encrypted, &iv) {
                Ok(plaintext) => plaintext,
                Err(error) => {
                    tracing::warn!(
                        "凭据 {} 无法使用旧版密钥解密，将保留连接配置并清空敏感字段: {}",
                        id,
                        error
                    );
                    serde_json::to_vec(&CredentialData {
                        auth_type,
                        password: None,
                        private_key: None,
                        passphrase: None,
                    })
                    .map_err(|e| Error::EncryptionError(format!("重置损坏凭据失败: {}", e)))?
                }
            };
            let (encrypted, iv) = self.vault.encrypt(&plaintext)?;
            tx.execute(
                "UPDATE credentials SET encrypted_data = ?1, iv = ?2 WHERE id = ?3",
                params![
                    base64::engine::general_purpose::STANDARD.encode(encrypted),
                    base64::engine::general_purpose::STANDARD.encode(iv),
                    id
                ],
            )
            .map_err(|e| Error::StorageError(format!("迁移凭据失败: {}", e)))?;
        }
        tx.commit()
            .map_err(|e| Error::StorageError(format!("提交凭据迁移失败: {}", e)))?;
        Ok(())
    }

    /// 初始化数据库表结构
    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 folders 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS connections (
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
                folder_id TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_connected_at INTEGER
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 connections 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                auth_type TEXT NOT NULL,
                encrypted_data TEXT NOT NULL,
                iv TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 credentials 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                commands_executed INTEGER DEFAULT 0,
                FOREIGN KEY (connection_id) REFERENCES connections(id)
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 sessions 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 tags 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS connection_tags (
                connection_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (connection_id, tag_id),
                FOREIGN KEY (connection_id) REFERENCES connections(id),
                FOREIGN KEY (tag_id) REFERENCES tags(id)
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 connection_tags 表失败: {}", e)))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_connections_protocol ON connections(protocol)",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建索引失败: {}", e)))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_connections_folder_id ON connections(folder_id)",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建索引失败: {}", e)))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_connection_id ON sessions(connection_id)",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建索引失败: {}", e)))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id)",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建索引失败: {}", e)))?;

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
        folder_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            r#"
            INSERT OR REPLACE INTO connections
            (id, name, protocol, host, port, username, credential_id, options, tags, color, folder_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
                folder_id,
                now,
                now
            ],
        )
        .map_err(|e| Error::StorageError(format!("保存连接失败: {}", e)))?;

        Ok(())
    }

    /// 获取所有连接
    pub fn get_connections(&self) -> Result<Vec<ConnectionRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, protocol, host, port, username, credential_id, options, tags, color, folder_id, sort_order, created_at, last_connected_at FROM connections ORDER BY sort_order, name")
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
                    folder_id: row.get(10)?,
                    sort_order: row.get::<_, i32>(11)?,
                    created_at: row.get(12)?,
                    last_connected_at: row.get(13)?,
                })
            })
            .map_err(|e| Error::StorageError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// 删除连接
    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| Error::StorageError(format!("开始删除事务失败: {}", e)))?;
        let credential_id: Option<String> = tx
            .query_row(
                "SELECT credential_id FROM connections WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        tx.execute("DELETE FROM connections WHERE id = ?1", params![id])
            .map_err(|e| Error::StorageError(format!("删除连接失败: {}", e)))?;
        if let Some(credential_id) = credential_id {
            tx.execute(
                "DELETE FROM credentials WHERE id = ?1 AND NOT EXISTS (
                    SELECT 1 FROM connections WHERE credential_id = ?1
                )",
                params![credential_id],
            )
            .map_err(|e| Error::StorageError(format!("清理连接凭据失败: {}", e)))?;
        }
        tx.commit()
            .map_err(|e| Error::StorageError(format!("提交删除事务失败: {}", e)))?;
        Ok(())
    }

    /// 保存文件夹
    pub fn save_folder(
        &self,
        id: Uuid,
        name: &str,
        parent_id: Option<&str>,
        sort_order: i32,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            r#"
            INSERT OR REPLACE INTO folders (id, name, parent_id, sort_order, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![id.to_string(), name, parent_id, sort_order, now],
        )
        .map_err(|e| Error::StorageError(format!("保存文件夹失败: {}", e)))?;

        Ok(())
    }

    /// 获取所有文件夹
    pub fn get_folders(&self) -> Result<Vec<FolderRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, parent_id, sort_order, created_at FROM folders ORDER BY sort_order, name")
            .map_err(|e| Error::StorageError(e.to_string()))?;

        let records = stmt
            .query_map([], |row| {
                Ok(FolderRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    sort_order: row.get::<_, i32>(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| Error::StorageError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// 删除文件夹
    pub fn delete_folder(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| Error::StorageError(format!("开始删除文件夹失败: {}", e)))?;
        let parent_id: Option<String> = tx
            .query_row(
                "SELECT parent_id FROM folders WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        tx.execute(
            "UPDATE connections SET folder_id = ?1 WHERE folder_id = ?2",
            params![parent_id, id],
        )
        .map_err(|e| Error::StorageError(format!("移动文件夹内连接失败: {}", e)))?;
        tx.execute(
            "UPDATE folders SET parent_id = ?1 WHERE parent_id = ?2",
            params![parent_id, id],
        )
        .map_err(|e| Error::StorageError(format!("移动子文件夹失败: {}", e)))?;
        tx.execute("DELETE FROM folders WHERE id = ?1", params![id])
            .map_err(|e| Error::StorageError(format!("删除文件夹失败: {}", e)))?;
        tx.commit()
            .map_err(|e| Error::StorageError(format!("提交删除文件夹失败: {}", e)))?;
        Ok(())
    }

    /// 更新连接的文件夹
    pub fn update_connection_folder(
        &self,
        connection_id: &str,
        folder_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE connections SET folder_id = ?1 WHERE id = ?2",
            params![folder_id, connection_id],
        )
        .map_err(|e| Error::StorageError(format!("更新连接文件夹失败: {}", e)))?;
        Ok(())
    }

    /// 保存凭证（使用 JSON 结构化存储）
    pub fn save_credential_structured(
        &self,
        id: Uuid,
        name: &str,
        auth_type: &str,
        cred_data: &CredentialData,
    ) -> Result<()> {
        let json = serde_json::to_string(cred_data)
            .map_err(|e| Error::StorageError(format!("序列化凭证失败: {}", e)))?;
        self.save_credential_raw(id, name, auth_type, json.as_bytes())
    }

    /// 保存凭证（原始字节）
    pub fn save_credential_raw(
        &self,
        id: Uuid,
        name: &str,
        auth_type: &str,
        data: &[u8],
    ) -> Result<()> {
        let (encrypted, iv) = self.vault.encrypt(data)?;
        let conn = self.conn.lock();
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
                base64::engine::general_purpose::STANDARD.encode(&encrypted),
                base64::engine::general_purpose::STANDARD.encode(&iv),
                now,
                now
            ],
        )
        .map_err(|e| Error::StorageError(format!("保存凭证失败: {}", e)))?;

        Ok(())
    }

    /// 获取凭证解密数据（返回 JSON 格式的 CredentialData）
    pub fn get_credential_structured(&self, id: &str) -> Result<CredentialData> {
        let data = self.get_credential_data(id)?;
        serde_json::from_slice(&data)
            .map_err(|e| Error::StorageError(format!("解析凭证数据失败: {}", e)))
    }

    /// 获取凭证解密数据（原始字节）
    pub fn get_credential_data(&self, id: &str) -> Result<Vec<u8>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT encrypted_data, iv FROM credentials WHERE id = ?1")
            .map_err(|e| Error::StorageError(e.to_string()))?;

        let result = stmt.query_row(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });

        match result {
            Ok((encrypted_b64, iv_b64)) => {
                let encrypted = base64::engine::general_purpose::STANDARD
                    .decode(&encrypted_b64)
                    .map_err(|e| Error::EncryptionError(e.to_string()))?;
                let iv = base64::engine::general_purpose::STANDARD
                    .decode(&iv_b64)
                    .map_err(|e| Error::EncryptionError(e.to_string()))?;
                self.vault.decrypt(&encrypted, &iv)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Err(Error::StorageError("凭证未找到".to_string()))
            }
            Err(e) => Err(Error::StorageError(e.to_string())),
        }
    }

    /// 获取凭证记录
    pub fn get_credential(&self, id: &str) -> Result<CredentialRecord> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, auth_type, created_at, updated_at FROM credentials WHERE id = ?1",
            )
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
        .map_err(|e| Error::StorageError(format!("获取凭证失败: {}", e)))
    }

    /// 保存会话历史
    pub fn save_session(&self, id: Uuid, connection_id: &str, started_at: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO sessions (id, connection_id, started_at) VALUES (?1, ?2, ?3)",
            params![id.to_string(), connection_id, started_at],
        )
        .map_err(|e| Error::StorageError(format!("保存会话失败: {}", e)))?;
        Ok(())
    }

    /// 更新会话结束时间
    pub fn end_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
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
    pub folder_id: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
    pub last_connected_at: Option<i64>,
}

/// 文件夹记录
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FolderRecord {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
}

/// 凭证记录
#[derive(Debug, Clone)]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub auth_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}
