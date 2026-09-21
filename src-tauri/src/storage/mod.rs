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
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub proxy_password: Option<String>,
}

/// 数据库管理器
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    vault: Arc<CredentialVault>,
}

unsafe impl Send for Database {}
unsafe impl Sync for Database {}

impl Database {
    /// 创建或打开数据库
    pub fn new(app_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&app_dir).map_err(|e| Error::StorageError(e.to_string()))?;

        let database_name = if cfg!(dev) {
            "portnest-dev.db"
        } else {
            "portnest.db"
        };
        let db_path = app_dir.join(database_name);
        let legacy_vault = if CredentialVault::needs_legacy_migration(&db_path) {
            Some(CredentialVault::legacy(&db_path)?)
        } else {
            None
        };
        let conn = Connection::open(&db_path)
            .map_err(|e| Error::StorageError(format!("打开数据库失败: {}", e)))?;

        let vault = Arc::new(CredentialVault::new(&db_path)?);

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
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
                        key_id: None,
                        proxy_password: None,
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
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 schema_migrations 表失败: {}", e)))?;

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
            "CREATE TABLE IF NOT EXISTS ssh_keys (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                file_name TEXT NOT NULL,
                key_type TEXT NOT NULL,
                encrypted_data TEXT NOT NULL,
                iv TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 ssh_keys 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                commands_executed INTEGER DEFAULT 0,
                FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
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
            "CREATE TABLE IF NOT EXISTS sftp_transfers (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                direction TEXT NOT NULL,
                source_path TEXT NOT NULL,
                destination_path TEXT NOT NULL,
                actual_destination TEXT NOT NULL,
                file_name TEXT NOT NULL,
                conflict_policy TEXT NOT NULL,
                verify_checksum INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                transferred INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                checksum TEXT,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
            )",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 sftp_transfers 表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS command_snippets (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK(kind IN ('snippet', 'task')),
                name TEXT NOT NULL,
                description TEXT,
                content TEXT NOT NULL,
                folder TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                variables TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            [],
        ).map_err(|e| Error::StorageError(format!("创建命令片段表失败: {}", e)))?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_command_snippets_kind ON command_snippets(kind, updated_at DESC)", [])
            .map_err(|e| Error::StorageError(format!("创建命令片段索引失败: {}", e)))?;

        // 上次进程退出时仍在运行的任务不能继续持有内存中的 SFTP 句柄，启动后明确标记为中断。
        conn.execute(
            "UPDATE sftp_transfers
             SET status = 'interrupted', error = COALESCE(error, '应用退出或连接中断'), updated_at = ?1
             WHERE status IN ('queued', 'running', 'cancelling')",
            params![chrono::Utc::now().timestamp()],
        )
        .map_err(|e| Error::StorageError(format!("恢复 SFTP 传输状态失败: {}", e)))?;

        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
             VALUES (1, 'sftp_transfer_queue', ?1)",
            params![chrono::Utc::now().timestamp()],
        )
        .map_err(|e| Error::StorageError(format!("记录数据库迁移失败: {}", e)))?;

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

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sftp_transfers_connection_updated
             ON sftp_transfers(connection_id, updated_at DESC)",
            [],
        )
        .map_err(|e| Error::StorageError(format!("创建 SFTP 传输索引失败: {}", e)))?;

        Ok(())
    }

    pub fn save_command_snippet(&self, item: &CommandSnippetRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO command_snippets (id, kind, name, description, content, folder, tags, variables, favorite, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, description=excluded.description,
             content=excluded.content, folder=excluded.folder, tags=excluded.tags, variables=excluded.variables,
             favorite=excluded.favorite, updated_at=excluded.updated_at",
            params![item.id, item.kind, item.name, item.description, item.content, item.folder, item.tags, item.variables, item.favorite as i32, item.created_at, item.updated_at],
        ).map_err(|e| Error::StorageError(format!("保存命令片段失败: {}", e)))?;
        Ok(())
    }

    pub fn list_command_snippets(&self, kind: Option<&str>, query: Option<&str>) -> Result<Vec<CommandSnippetRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, description, content, folder, tags, variables, favorite, created_at, updated_at
             FROM command_snippets WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR name LIKE '%' || ?2 || '%' OR content LIKE '%' || ?2 || '%')
             ORDER BY favorite DESC, updated_at DESC"
        ).map_err(|e| Error::StorageError(format!("读取命令片段失败: {}", e)))?;
        let rows = stmt.query_map(params![kind, query], |row| Ok(CommandSnippetRecord {
            id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?, description: row.get(3)?, content: row.get(4)?,
            folder: row.get(5)?, tags: row.get(6)?, variables: row.get(7)?, favorite: row.get::<_, i32>(8)? != 0,
            created_at: row.get(9)?, updated_at: row.get(10)?,
        })).map_err(|e| Error::StorageError(format!("读取命令片段失败: {}", e)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| Error::StorageError(format!("读取命令片段失败: {}", e)))
    }

    pub fn delete_command_snippet(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM command_snippets WHERE id = ?1", params![id])
            .map_err(|e| Error::StorageError(format!("删除命令片段失败: {}", e)))?;
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
            INSERT INTO connections
            (id, name, protocol, host, port, username, credential_id, options, tags, color, folder_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                protocol = excluded.protocol,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                credential_id = excluded.credential_id,
                options = excluded.options,
                tags = excluded.tags,
                color = excluded.color,
                folder_id = excluded.folder_id,
                updated_at = excluded.updated_at
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

    pub fn mark_connection_used(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "UPDATE connections SET last_connected_at = ?1 WHERE id = ?2",
                params![chrono::Utc::now().timestamp(), id],
            )
            .map_err(|error| Error::StorageError(format!("更新最近连接时间失败: {error}")))?;
        Ok(())
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

    pub fn rename_folder(&self, id: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::StorageError("文件夹名称不能为空".to_string()));
        }
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE folders SET name = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(|e| Error::StorageError(format!("重命名文件夹失败: {}", e)))?;
        if changed == 0 {
            return Err(Error::StorageError("文件夹不存在".to_string()));
        }
        Ok(())
    }

    pub fn save_ssh_key(
        &self,
        id: Uuid,
        name: &str,
        file_name: &str,
        key_type: &str,
        private_key: &str,
    ) -> Result<()> {
        let (encrypted, iv) = self.vault.encrypt(private_key.as_bytes())?;
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO ssh_keys
             (id, name, file_name, key_type, encrypted_data, iv, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id.to_string(),
                name.trim(),
                file_name,
                key_type,
                base64::engine::general_purpose::STANDARD.encode(encrypted),
                base64::engine::general_purpose::STANDARD.encode(iv),
                now,
                now
            ],
        )
        .map_err(|e| Error::StorageError(format!("保存密钥失败: {}", e)))?;
        Ok(())
    }

    pub fn get_ssh_keys(&self) -> Result<Vec<SshKeyRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, file_name, key_type, created_at, updated_at FROM ssh_keys ORDER BY name")
            .map_err(|e| Error::StorageError(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SshKeyRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    file_name: row.get(2)?,
                    key_type: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| Error::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::StorageError(e.to_string()))?;
        Ok(rows)
    }

    pub fn get_ssh_key_material(&self, id: &str) -> Result<String> {
        let conn = self.conn.lock();
        let (encrypted, iv): (String, String) = conn
            .query_row(
                "SELECT encrypted_data, iv FROM ssh_keys WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| Error::StorageError(format!("读取密钥失败: {}", e)))?;
        let encrypted = base64::engine::general_purpose::STANDARD
            .decode(encrypted)
            .map_err(|e| Error::EncryptionError(e.to_string()))?;
        let iv = base64::engine::general_purpose::STANDARD
            .decode(iv)
            .map_err(|e| Error::EncryptionError(e.to_string()))?;
        String::from_utf8(self.vault.decrypt(&encrypted, &iv)?)
            .map_err(|e| Error::EncryptionError(e.to_string()))
    }

    pub fn delete_ssh_key(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM ssh_keys WHERE id = ?1", params![id])
            .map_err(|e| Error::StorageError(format!("删除密钥失败: {}", e)))?;
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

    /// 原子保存资产树的父级和显示顺序。
    pub fn update_asset_order(
        &self,
        connections: &[(String, Option<String>, i32)],
        folders: &[(String, Option<String>, i32)],
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| Error::StorageError(format!("开始更新资产排序失败: {}", e)))?;

        for (id, folder_id, sort_order) in connections {
            tx.execute(
                "UPDATE connections SET folder_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
                params![folder_id, sort_order, chrono::Utc::now().timestamp(), id],
            )
            .map_err(|e| Error::StorageError(format!("更新会话排序失败: {}", e)))?;
        }

        for (id, parent_id, sort_order) in folders {
            tx.execute(
                "UPDATE folders SET parent_id = ?1, sort_order = ?2 WHERE id = ?3",
                params![parent_id, sort_order, id],
            )
            .map_err(|e| Error::StorageError(format!("更新文件夹排序失败: {}", e)))?;
        }

        tx.commit()
            .map_err(|e| Error::StorageError(format!("提交资产排序失败: {}", e)))?;
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

    pub fn save_sftp_transfer(&self, transfer: &SftpTransferRecord) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT OR REPLACE INTO sftp_transfers
                 (id, connection_id, direction, source_path, destination_path, actual_destination,
                  file_name, conflict_policy, verify_checksum, status, transferred, total, checksum,
                  error, created_at, updated_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    transfer.id,
                    transfer.connection_id,
                    transfer.direction,
                    transfer.source_path,
                    transfer.destination_path,
                    transfer.actual_destination,
                    transfer.file_name,
                    transfer.conflict_policy,
                    transfer.verify_checksum as i32,
                    transfer.status,
                    transfer.transferred as i64,
                    transfer.total as i64,
                    transfer.checksum,
                    transfer.error,
                    transfer.created_at,
                    transfer.updated_at,
                    transfer.completed_at,
                ],
            )
            .map_err(|e| Error::StorageError(format!("保存 SFTP 传输失败: {}", e)))?;
        Ok(())
    }

    pub fn update_sftp_transfer(
        &self,
        id: &str,
        status: &str,
        transferred: u64,
        total: u64,
        actual_destination: &str,
        checksum: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let completed_at = matches!(status, "done" | "skipped" | "cancelled" | "error")
            .then_some(now);
        self.conn
            .lock()
            .execute(
                "UPDATE sftp_transfers
                 SET status = ?1, transferred = ?2, total = ?3, actual_destination = ?4,
                     checksum = ?5, error = ?6, updated_at = ?7, completed_at = ?8
                 WHERE id = ?9",
                params![
                    status,
                    transferred as i64,
                    total as i64,
                    actual_destination,
                    checksum,
                    error,
                    now,
                    completed_at,
                    id,
                ],
            )
            .map_err(|e| Error::StorageError(format!("更新 SFTP 传输失败: {}", e)))?;
        Ok(())
    }

    pub fn get_sftp_transfer(&self, id: &str) -> Result<SftpTransferRecord> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, connection_id, direction, source_path, destination_path, actual_destination,
                    file_name, conflict_policy, verify_checksum, status, transferred, total, checksum,
                    error, created_at, updated_at, completed_at
             FROM sftp_transfers WHERE id = ?1",
            params![id],
            map_sftp_transfer,
        )
        .map_err(|e| Error::StorageError(format!("读取 SFTP 传输失败: {}", e)))
    }

    pub fn list_sftp_transfers(&self, connection_id: &str) -> Result<Vec<SftpTransferRecord>> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare(
                "SELECT id, connection_id, direction, source_path, destination_path, actual_destination,
                        file_name, conflict_policy, verify_checksum, status, transferred, total, checksum,
                        error, created_at, updated_at, completed_at
                 FROM sftp_transfers WHERE connection_id = ?1
                 ORDER BY created_at DESC LIMIT 200",
            )
            .map_err(|e| Error::StorageError(format!("读取 SFTP 传输列表失败: {}", e)))?;
        let records = statement
            .query_map(params![connection_id], map_sftp_transfer)
            .map_err(|e| Error::StorageError(format!("读取 SFTP 传输列表失败: {}", e)))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::StorageError(format!("解析 SFTP 传输列表失败: {}", e)))?;
        Ok(records)
    }

    pub fn clear_sftp_transfer_history(&self, connection_id: &str) -> Result<usize> {
        self.conn
            .lock()
            .execute(
                "DELETE FROM sftp_transfers
                 WHERE connection_id = ?1 AND status NOT IN ('queued', 'running', 'cancelling')",
                params![connection_id],
            )
            .map_err(|e| Error::StorageError(format!("清理 SFTP 传输记录失败: {}", e)))
    }
}

fn map_sftp_transfer(row: &rusqlite::Row<'_>) -> rusqlite::Result<SftpTransferRecord> {
    Ok(SftpTransferRecord {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        direction: row.get(2)?,
        source_path: row.get(3)?,
        destination_path: row.get(4)?,
        actual_destination: row.get(5)?,
        file_name: row.get(6)?,
        conflict_policy: row.get(7)?,
        verify_checksum: row.get::<_, i32>(8)? != 0,
        status: row.get(9)?,
        transferred: row.get::<_, i64>(10)? as u64,
        total: row.get::<_, i64>(11)? as u64,
        checksum: row.get(12)?,
        error: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        completed_at: row.get(16)?,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandSnippetRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    pub folder: Option<String>,
    pub tags: String,
    pub variables: String,
    pub favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SshKeyRecord {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub key_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SftpTransferRecord {
    pub id: String,
    pub connection_id: String,
    pub direction: String,
    pub source_path: String,
    pub destination_path: String,
    pub actual_destination: String,
    pub file_name: String,
    pub conflict_policy: String,
    pub verify_checksum: bool,
    pub status: String,
    pub transferred: u64,
    pub total: u64,
    pub checksum: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[cfg(test)]
mod sftp_transfer_tests {
    use super::{Database, SftpTransferRecord};

    fn record(status: &str) -> SftpTransferRecord {
        SftpTransferRecord {
            id: "transfer-1".to_string(),
            connection_id: "connection-1".to_string(),
            direction: "download".to_string(),
            source_path: "/remote/file.bin".to_string(),
            destination_path: "C:\\tmp\\file.bin".to_string(),
            actual_destination: "C:\\tmp\\file.bin".to_string(),
            file_name: "file.bin".to_string(),
            conflict_policy: "resume".to_string(),
            verify_checksum: true,
            status: status.to_string(),
            transferred: 128,
            total: 1024,
            checksum: None,
            error: None,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
        }
    }

    #[test]
    fn persists_progress_and_marks_running_tasks_interrupted_after_restart() {
        let directory = std::env::temp_dir().join(format!("portnest-sftp-test-{}", uuid::Uuid::new_v4()));
        {
            let database = Database::new(directory.clone()).unwrap();
            database.conn.lock().execute(
                "INSERT INTO connections
                 (id, name, protocol, host, port, credential_id, created_at, updated_at)
                 VALUES ('connection-1', 'test', 'sftp', 'localhost', 22, 'credential-1', 1, 1)",
                [],
            ).unwrap();
            database.save_sftp_transfer(&record("running")).unwrap();
            database.update_sftp_transfer("transfer-1", "running", 512, 1024, "C:\\tmp\\file.bin", None, None).unwrap();
            assert_eq!(database.get_sftp_transfer("transfer-1").unwrap().transferred, 512);
        }
        {
            let database = Database::new(directory.clone()).unwrap();
            let recovered = database.get_sftp_transfer("transfer-1").unwrap();
            assert_eq!(recovered.status, "interrupted");
            assert_eq!(recovered.transferred, 512);
            assert_eq!(database.list_sftp_transfers("connection-1").unwrap().len(), 1);
        }
        let _ = std::fs::remove_dir_all(directory);
    }
}
