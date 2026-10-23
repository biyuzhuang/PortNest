use super::{AppState, QueryColumn, QueryResult, QueryResultRow};
use base64::Engine;
use mysql_async::consts::ColumnType;
use mysql_async::{
    prelude::Queryable, Column, OptsBuilder, Params, Pool, PoolConstraints, PoolOpts, Row, Value,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub struct MysqlManager {
    pools: RwLock<HashMap<String, Pool>>,
    build_locks: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    running_queries: RwLock<HashMap<String, u64>>,
}

impl MysqlManager {
    pub fn new() -> Self {
        Self {
            pools: RwLock::new(HashMap::new()),
            build_locks: parking_lot::Mutex::new(HashMap::new()),
            running_queries: RwLock::new(HashMap::new()),
        }
    }

    fn set_running(&self, connection_id: &str, thread_id: u64) {
        self.running_queries
            .write()
            .insert(connection_id.to_string(), thread_id);
    }

    fn running_thread(&self, connection_id: &str) -> Option<u64> {
        self.running_queries.read().get(connection_id).copied()
    }

    fn clear_running(&self, connection_id: &str) {
        self.running_queries.write().remove(connection_id);
    }

    fn get(&self, connection_id: &str) -> Option<Pool> {
        self.pools.read().get(connection_id).cloned()
    }

    fn insert(&self, connection_id: String, pool: Pool) {
        self.pools.write().insert(connection_id, pool);
    }

    fn remove(&self, connection_id: &str) -> Option<Pool> {
        self.pools.write().remove(connection_id)
    }

    fn build_lock(&self, connection_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.build_locks
            .lock()
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

struct RunningQueryGuard {
    manager: Arc<MysqlManager>,
    connection_id: String,
}

impl Drop for RunningQueryGuard {
    fn drop(&mut self) {
        self.manager.clear_running(&self.connection_id);
    }
}

impl Default for MysqlManager {
    fn default() -> Self {
        Self::new()
    }
}

fn quote_identifier(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("数据库对象名称不能为空或包含 NUL 字符".to_string());
    }
    Ok(format!("`{}`", trimmed.replace('`', "``")))
}

fn single_statement(sql: &str) -> Result<&str, String> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err("SQL 不能为空".to_string());
    }

    let bytes = sql.as_bytes();
    let mut index = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut statement_end: Option<usize> = None;

    while index < bytes.len() {
        let current = bytes[index];

        if let Some(end) = statement_end {
            if current.is_ascii_whitespace() || current == b';' {
                index += 1;
                continue;
            }
            if current == b'#' {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            if current == b'-' && index + 1 < bytes.len() && bytes[index + 1] == b'-' {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            if current == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                if index + 1 >= bytes.len() {
                    return Err("SQL 注释未闭合".to_string());
                }
                index += 2;
                continue;
            }
            let _ = end;
            return Err("SQL 工作台每次只允许执行一条语句".to_string());
        }

        if line_comment {
            if current == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }

        if block_comment {
            if current == b'*' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }
            if current == b'\\' && delimiter != b'`' {
                escaped = true;
                index += 1;
                continue;
            }
            if current == delimiter {
                if index + 1 < bytes.len() && bytes[index + 1] == delimiter {
                    index += 2;
                } else {
                    quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match current {
            b'\'' | b'"' | b'`' => {
                quote = Some(current);
                index += 1;
            }
            b'#' => {
                line_comment = true;
                index += 1;
            }
            b'-' if index + 1 < bytes.len() && bytes[index + 1] == b'-' => {
                let followed_by_space = index + 2 >= bytes.len()
                    || bytes[index + 2].is_ascii_whitespace()
                    || bytes[index + 2].is_ascii_control();
                if followed_by_space {
                    line_comment = true;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                block_comment = true;
                index += 2;
            }
            b';' => {
                if sql[..index].trim().is_empty() {
                    return Err("SQL 不能为空".to_string());
                }
                statement_end = Some(index);
                index += 1;
            }
            _ => index += 1,
        }
    }

    if quote.is_some() || block_comment {
        return Err("SQL 包含未闭合的引号或注释".to_string());
    }

    let end = statement_end.unwrap_or(sql.len());
    let statement = sql[..end].trim();
    if statement.is_empty() {
        return Err("SQL 不能为空".to_string());
    }
    Ok(statement)
}

const MYSQL_POOL_MIN: usize = 1;
const MYSQL_POOL_MAX: usize = 4;
const MYSQL_DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MYSQL_QUERY_TIMEOUT_MS: u64 = 60_000;
const MYSQL_MAX_RESULT_ROWS: usize = 5_000;

async fn build_pool(state: &AppState, connection_id: &str) -> Result<Pool, String> {
    let connection = state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|item| item.id == connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    if connection.protocol != "mysql" {
        return Err("该连接不是 MySQL 连接".to_string());
    }
    let credential = state
        .db
        .get_credential_structured(&connection.credential_id)
        .map_err(|e| e.to_string())?;
    let options = match connection.options.as_deref() {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str::<serde_json::Value>(raw)
            .map_err(|e| format!("MySQL 连接选项无效: {e}"))?,
        _ => serde_json::json!({}),
    };
    let database = options
        .get("database")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let timeout_ms = options
        .get("timeout_ms")
        .and_then(|value| value.as_u64())
        .unwrap_or(MYSQL_DEFAULT_TIMEOUT_MS)
        .clamp(1_000, 300_000);
    let ssl_mode = options
        .get("ssl_mode")
        .and_then(|value| value.as_str())
        .unwrap_or("disabled");
    let ssl_opts =
        crate::protocol::mysql::ssl_opts_from_mode(ssl_mode).map_err(|error| error.to_string())?;
    let constraints = PoolConstraints::new(MYSQL_POOL_MIN, MYSQL_POOL_MAX)
        .ok_or_else(|| "MySQL 连接池配置无效".to_string())?;
    let pool_opts = PoolOpts::default()
        .with_constraints(constraints)
        .with_inactive_connection_ttl(Duration::ZERO);
    let builder = OptsBuilder::default()
        .ip_or_hostname(connection.host)
        .tcp_port(connection.port)
        .user(connection.username)
        .pass(credential.password)
        .db_name(database)
        .client_found_rows(true)
        .stmt_cache_size(64usize)
        .ssl_opts(ssl_opts)
        .pool_opts(pool_opts);
    let pool = Pool::new(builder);

    let validate = async {
        let mut conn = pool
            .get_conn()
            .await
            .map_err(|e| format!("MySQL 连接失败: {e}"))?;
        conn.query_drop("SELECT 1")
            .await
            .map_err(|e| format!("MySQL 连接验证失败: {e}"))?;
        Ok::<(), String>(())
    };

    tokio::time::timeout(Duration::from_millis(timeout_ms), validate)
        .await
        .map_err(|_| format!("MySQL 连接超时（{timeout_ms}ms）"))??;
    Ok(pool)
}

async fn pool_for(state: &AppState, connection_id: &str) -> Result<Pool, String> {
    if let Some(pool) = state.mysql_manager.get(connection_id) {
        return Ok(pool);
    }

    let build_lock = state.mysql_manager.build_lock(connection_id);
    let _guard = build_lock.lock().await;
    if let Some(pool) = state.mysql_manager.get(connection_id) {
        return Ok(pool);
    }
    let pool = build_pool(state, connection_id).await?;
    state
        .mysql_manager
        .insert(connection_id.to_string(), pool.clone());
    Ok(pool)
}

async fn pool_is_healthy(pool: &Pool, timeout_ms: u64) -> bool {
    let check = async {
        let mut conn = pool.get_conn().await.ok()?;
        conn.query_drop("SELECT 1").await.ok()?;
        Some(())
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms), check)
        .await
        .ok()
        .flatten()
        .is_some()
}

#[tauri::command]
pub async fn mysql_connect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let build_lock = state.mysql_manager.build_lock(&connection_id);
    let _guard = build_lock.lock().await;

    if let Some(pool) = state.mysql_manager.get(&connection_id) {
        if pool_is_healthy(&pool, 5_000).await {
            return Ok(());
        }
        if let Some(old) = state.mysql_manager.remove(&connection_id) {
            let _ = tokio::time::timeout(Duration::from_secs(5), old.disconnect()).await;
        }
    }

    let pool = build_pool(&state, &connection_id).await?;
    state.mysql_manager.insert(connection_id, pool);
    Ok(())
}

#[tauri::command]
pub async fn mysql_disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    if let Some(pool) = state.mysql_manager.remove(&connection_id) {
        match tokio::time::timeout(Duration::from_secs(5), pool.disconnect()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => tracing::warn!("MySQL 连接池断开超时: {connection_id}"),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mysql_cancel_query(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let thread_id = state
        .mysql_manager
        .running_thread(&connection_id)
        .ok_or_else(|| "当前没有正在执行的查询".to_string())?;
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("KILL QUERY {thread_id}"))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_save_sql(path: String, sql: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("保存路径不能为空".to_string());
    }
    if sql.len() > 16 * 1024 * 1024 {
        return Err("SQL 内容超过 16MB 限制".to_string());
    }
    tokio::fs::write(&path, sql.as_bytes())
        .await
        .map_err(|e| format!("保存 SQL 文件失败: {e}"))
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlDatabaseInfo {
    pub name: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlCharsetInfo {
    pub name: String,
    pub description: String,
    pub default_collation: String,
    pub collations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlTableInfo {
    pub name: String,
    pub kind: String,
    pub engine: Option<String>,
    pub rows: Option<u64>,
    pub comment: String,
    pub data_length: Option<u64>,
    pub index_length: Option<u64>,
    pub auto_increment: Option<u64>,
    pub collation: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlColumnInfo {
    pub name: String,
    pub data_type: String,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub extra: String,
    pub comment: String,
    pub key: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub ordinal: u32,
    pub generation_expression: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlIndexInfo {
    pub name: String,
    pub unique: bool,
    pub column: Option<String>,
    pub sequence: u32,
    pub prefix_length: Option<u64>,
    pub direction: Option<String>,
    pub index_type: String,
}

#[tauri::command]
pub async fn mysql_list_databases(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<MysqlDatabaseInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>, Option<String>)> = conn.exec(
        "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME", ()
    ).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(name, charset, collation)| MysqlDatabaseInfo {
            name,
            charset,
            collation,
        })
        .collect())
}

#[tauri::command]
pub async fn mysql_list_charsets(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<MysqlCharsetInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String)> = conn.query(
        "SELECT c.CHARACTER_SET_NAME, c.DESCRIPTION, c.DEFAULT_COLLATE_NAME, co.COLLATION_NAME FROM information_schema.CHARACTER_SETS c JOIN information_schema.COLLATIONS co ON co.CHARACTER_SET_NAME=c.CHARACTER_SET_NAME ORDER BY c.CHARACTER_SET_NAME, co.COLLATION_NAME"
    ).await.map_err(|e| e.to_string())?;
    let mut result: Vec<MysqlCharsetInfo> = Vec::new();
    for (name, description, default_collation, collation) in rows {
        if let Some(item) = result.last_mut().filter(|item| item.name == name) {
            item.collations.push(collation);
        } else {
            result.push(MysqlCharsetInfo {
                name,
                description,
                default_collation,
                collations: vec![collation],
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn mysql_list_tables(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<MysqlTableInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<String>, Option<u64>, String, Option<u64>, Option<u64>, Option<u64>, Option<String>, Option<String>, Option<String>)> = conn.exec(
        "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, TABLE_COLLATION, CAST(CREATE_TIME AS CHAR), CAST(UPDATE_TIME AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", (database,)
    ).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| MysqlTableInfo {
            name: r.0,
            kind: r.1,
            engine: r.2,
            rows: r.3,
            comment: r.4,
            data_length: r.5,
            index_length: r.6,
            auto_increment: r.7,
            collation: r.8,
            created_at: r.9,
            updated_at: r.10,
        })
        .collect())
}

#[tauri::command]
pub async fn mysql_list_columns(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlColumnInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String,String,String,String,Option<String>,String,String,String,Option<String>,Option<String>,u32,Option<String>)> = conn.exec(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLUMN_KEY, CHARACTER_SET_NAME, COLLATION_NAME, ORDINAL_POSITION, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (database, table)
    ).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| MysqlColumnInfo {
            name: r.0,
            data_type: r.1,
            column_type: r.2,
            nullable: r.3 == "YES",
            default_value: r.4,
            extra: r.5,
            comment: r.6,
            key: r.7,
            charset: r.8,
            collation: r.9,
            ordinal: r.10,
            generation_expression: r.11,
        })
        .collect())
}

#[tauri::command]
pub async fn mysql_list_indexes(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlIndexInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String,u8,Option<String>,u32,Option<u64>,Option<String>,String)> = conn.exec(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART, COLLATION, INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX", (database, table)
    ).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| MysqlIndexInfo {
            name: r.0,
            unique: r.1 == 0,
            column: r.2,
            sequence: r.3,
            prefix_length: r.4,
            direction: r.5,
            index_type: r.6,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlAutocompleteItem {
    pub table: String,
    pub column: String,
}

#[tauri::command]
pub async fn mysql_autocomplete(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<MysqlAutocompleteItem>, String> {
    if database.trim().is_empty() {
        return Ok(vec![]);
    }
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = conn.exec(
        "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, ORDINAL_POSITION",
        (&database,),
    ).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(table, column)| MysqlAutocompleteItem { table, column }).collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlExplainResult {
    pub json_plan: Option<serde_json::Value>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn mysql_explain_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<MysqlExplainResult, String> {
    let sql = single_statement(&sql)?.to_string();
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    if let Some(database) = database.as_deref().filter(|value| !value.is_empty()) {
        conn.query_drop(format!("USE {}", quote_identifier(database)?))
            .await
            .map_err(|e| e.to_string())?;
    }
    let json_sql = format!("EXPLAIN FORMAT=JSON {sql}");
    if let Ok(Some(text)) = conn.query_first::<String, _>(json_sql).await {
        if let Ok(json_plan) = serde_json::from_str::<serde_json::Value>(&text) {
            return Ok(MysqlExplainResult {
                json_plan: Some(json_plan),
                columns: vec![],
                rows: vec![],
                message: None,
            });
        }
    }
    let mut result = conn
        .query_iter(format!("EXPLAIN {sql}"))
        .await
        .map_err(|e| e.to_string())?;
    let column_meta: Vec<Column> = result.columns().map(|columns| columns.to_vec()).unwrap_or_default();
    let columns = column_meta
        .iter()
        .map(|column| column.name_str().to_string())
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
        rows.push(
            (0..row.len())
                .map(|index| {
                    row.as_ref(index)
                        .map(|value| value_to_json(value, column_meta.get(index)))
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect(),
        );
    }
    Ok(MysqlExplainResult {
        json_plan: None,
        columns,
        rows,
        message: Some("当前 MySQL 版本不支持 EXPLAIN FORMAT=JSON，已回退为表格执行计划".to_string()),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlColumnDefinition {
    pub name: String,
    pub column_type: String,
    #[serde(default)]
    pub nullable: bool,
    pub default_value: Option<String>,
    #[serde(default)]
    pub auto_increment: bool,
    pub charset: Option<String>,
    pub collation: Option<String>,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub generation_expression: Option<String>,
    #[serde(default)]
    pub extra: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlIndexColumn {
    pub name: String,
    pub prefix_length: Option<u32>,
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlIndexDefinition {
    pub name: String,
    pub kind: String,
    pub columns: Vec<MysqlIndexColumn>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlTableDefinition {
    pub database: String,
    pub name: String,
    pub original_name: Option<String>,
    pub engine: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    #[serde(default)]
    pub comment: String,
    pub columns: Vec<MysqlColumnDefinition>,
    #[serde(default)]
    pub indexes: Vec<MysqlIndexDefinition>,
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn validate_sql_fragment(value: &str, label: &str, allow_backtick: bool) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label}不能为空"));
    }
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' && delimiter != '`' {
                escaped = true;
                continue;
            }
            if ch == delimiter {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' | '`' => {
                if ch == '`' && !allow_backtick {
                    return Err(format!("{label}不能包含反引号"));
                }
                quote = Some(ch);
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("{label}括号不匹配"));
                }
            }
            ',' if depth == 0 => {
                return Err(format!("{label}包含非法逗号"));
            }
            ';' | '\0' | '\r' | '\n' => {
                return Err(format!("{label}包含非法字符"));
            }
            '#' => return Err(format!("{label}不能包含注释")),
            '-' if chars.peek() == Some(&'-') => {
                return Err(format!("{label}不能包含注释"));
            }
            '/' if chars.peek() == Some(&'*') => {
                return Err(format!("{label}不能包含注释"));
            }
            '*' if chars.peek() == Some(&'/') => {
                return Err(format!("{label}不能包含注释"));
            }
            _ => {}
        }
    }
    if quote.is_some() {
        return Err(format!("{label}引号未闭合"));
    }
    if depth != 0 {
        return Err(format!("{label}括号不匹配"));
    }
    Ok(())
}

fn validated_column_type(value: &str) -> Result<String, String> {
    let value = value.trim();
    let base = value
        .split(|c: char| c == '(' || c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    const TYPES: &[&str] = &[
        "TINYINT",
        "SMALLINT",
        "MEDIUMINT",
        "INT",
        "INTEGER",
        "BIGINT",
        "DECIMAL",
        "NUMERIC",
        "FLOAT",
        "DOUBLE",
        "BIT",
        "BOOLEAN",
        "BOOL",
        "DATE",
        "DATETIME",
        "TIMESTAMP",
        "TIME",
        "YEAR",
        "CHAR",
        "VARCHAR",
        "BINARY",
        "VARBINARY",
        "TINYBLOB",
        "BLOB",
        "MEDIUMBLOB",
        "LONGBLOB",
        "TINYTEXT",
        "TEXT",
        "MEDIUMTEXT",
        "LONGTEXT",
        "ENUM",
        "SET",
        "JSON",
    ];
    if !TYPES.contains(&base.as_str()) {
        return Err(format!("不支持的字段类型: {value}"));
    }
    validate_sql_fragment(value, "字段类型", false)?;
    Ok(value.to_string())
}

fn validated_generation_expression(value: &str) -> Result<String, String> {
    let value = value.trim();
    validate_sql_fragment(value, "生成列表达式", true)?;
    Ok(value.to_string())
}

fn is_current_timestamp_default(value: &str) -> bool {
    let upper = value.trim().to_ascii_uppercase();
    if upper == "CURRENT_TIMESTAMP" {
        return true;
    }
    let Some(rest) = upper.strip_prefix("CURRENT_TIMESTAMP(") else {
        return false;
    };
    let Some(digits) = rest.strip_suffix(')') else {
        return false;
    };
    !digits.is_empty()
        && digits.chars().all(|ch| ch.is_ascii_digit())
        && digits.parse::<u8>().is_ok_and(|precision| precision <= 6)
}

fn extract_on_update_clause(extra: &str) -> Option<String> {
    let lower = extra.to_ascii_lowercase();
    let start = lower.find("on update current_timestamp")?;
    let clause = extra[start..].trim();
    let upper = clause.to_ascii_uppercase();
    if upper == "ON UPDATE CURRENT_TIMESTAMP" {
        return Some(clause.to_string());
    }
    let rest = upper.strip_prefix("ON UPDATE CURRENT_TIMESTAMP(")?;
    let digits = rest.strip_suffix(')')?;
    if !digits.is_empty()
        && digits.chars().all(|ch| ch.is_ascii_digit())
        && digits.parse::<u8>().is_ok_and(|precision| precision <= 6)
    {
        Some(clause.to_string())
    } else {
        None
    }
}

fn build_column(def: &MysqlColumnDefinition) -> Result<String, String> {
    let mut sql = format!(
        "{} {}",
        quote_identifier(&def.name)?,
        validated_column_type(&def.column_type)?
    );
    if let Some(charset) = def.charset.as_deref().filter(|v| !v.is_empty()) {
        sql.push_str(&format!(" CHARACTER SET {}", quote_identifier(charset)?));
    }
    if let Some(collation) = def.collation.as_deref().filter(|v| !v.is_empty()) {
        sql.push_str(&format!(" COLLATE {}", quote_identifier(collation)?));
    }

    let generation = def
        .generation_expression
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if let Some(expression) = generation {
        if def.auto_increment || def.default_value.is_some() {
            return Err("生成列不能设置默认值或 AUTO_INCREMENT".to_string());
        }
        let expression = validated_generation_expression(expression)?;
        let storage = if def.extra.to_ascii_uppercase().contains("STORED GENERATED") {
            "STORED"
        } else {
            "VIRTUAL"
        };
        sql.push_str(&format!(" GENERATED ALWAYS AS ({expression}) {storage}"));
        sql.push_str(if def.nullable { " NULL" } else { " NOT NULL" });
    } else {
        sql.push_str(if def.nullable { " NULL" } else { " NOT NULL" });
        if let Some(default) = &def.default_value {
            let trimmed = default.trim();
            let upper = trimmed.to_ascii_uppercase();
            if upper == "NULL" || is_current_timestamp_default(trimmed) {
                sql.push_str(&format!(" DEFAULT {trimmed}"));
            } else if def.extra.to_ascii_uppercase().contains("DEFAULT_GENERATED")
                && trimmed.starts_with('(')
                && trimmed.ends_with(')')
                && validate_sql_fragment(trimmed, "默认值表达式", true).is_ok()
            {
                sql.push_str(&format!(" DEFAULT {trimmed}"));
            } else {
                sql.push_str(&format!(" DEFAULT {}", sql_string(trimmed)));
            }
        }
        if def.auto_increment {
            sql.push_str(" AUTO_INCREMENT");
        }
        if let Some(on_update) = extract_on_update_clause(&def.extra) {
            sql.push_str(&format!(" {on_update}"));
        }
    }

    if !def.comment.is_empty() {
        sql.push_str(&format!(" COMMENT {}", sql_string(&def.comment)));
    }
    Ok(sql)
}

fn build_index(def: &MysqlIndexDefinition) -> Result<String, String> {
    if def.columns.is_empty() {
        return Err("索引至少需要一个字段".to_string());
    }
    let columns = def
        .columns
        .iter()
        .map(|column| {
            let mut value = quote_identifier(&column.name)?;
            if let Some(length) = column.prefix_length {
                value.push_str(&format!("({length})"));
            }
            if matches!(column.direction.as_deref(), Some("ASC") | Some("DESC")) {
                value.push_str(&format!(" {}", column.direction.as_deref().unwrap()));
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, String>>()?
        .join(", ");
    match def.kind.as_str() {
        "PRIMARY" => Ok(format!("PRIMARY KEY ({columns})")),
        "UNIQUE" => Ok(format!(
            "UNIQUE KEY {} ({columns})",
            quote_identifier(&def.name)?
        )),
        "INDEX" => Ok(format!("KEY {} ({columns})", quote_identifier(&def.name)?)),
        _ => Err("不支持的索引类型".to_string()),
    }
}

fn create_table_sql(def: &MysqlTableDefinition) -> Result<String, String> {
    if def.columns.is_empty() {
        return Err("表至少需要一个字段".to_string());
    }
    let mut parts = def
        .columns
        .iter()
        .map(build_column)
        .collect::<Result<Vec<_>, _>>()?;
    parts.extend(
        def.indexes
            .iter()
            .map(build_index)
            .collect::<Result<Vec<_>, _>>()?,
    );
    let mut sql = format!(
        "CREATE TABLE {}.{} (\n  {}\n)",
        quote_identifier(&def.database)?,
        quote_identifier(&def.name)?,
        parts.join(",\n  ")
    );
    sql.push_str(&format!(
        " ENGINE={}",
        quote_identifier(def.engine.as_deref().unwrap_or("InnoDB"))?
    ));
    if let Some(charset) = def.charset.as_deref().filter(|v| !v.is_empty()) {
        sql.push_str(&format!(" DEFAULT CHARSET={}", quote_identifier(charset)?));
    }
    if let Some(collation) = def.collation.as_deref().filter(|v| !v.is_empty()) {
        sql.push_str(&format!(" COLLATE={}", quote_identifier(collation)?));
    }
    if !def.comment.is_empty() {
        sql.push_str(&format!(" COMMENT={}", sql_string(&def.comment)));
    }
    Ok(sql)
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlDdlResult {
    pub statements: Vec<String>,
    pub completed: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct CurrentColumn {
    name: String,
    column_type: String,
    nullable: bool,
    default_value: Option<String>,
    extra: String,
    comment: String,
    charset: Option<String>,
    collation: Option<String>,
    generation_expression: Option<String>,
}

async fn load_current_columns(
    conn: &mut mysql_async::Conn,
    database: &str,
    table: &str,
) -> Result<Vec<CurrentColumn>, String> {
    let rows: Vec<(String,String,String,Option<String>,String,String,Option<String>,Option<String>,Option<String>)> = conn.exec(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
        (database, table),
    ).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| CurrentColumn {
            name: row.0,
            column_type: row.1,
            nullable: row.2 == "YES",
            default_value: row.3,
            extra: row.4,
            comment: row.5,
            charset: row.6,
            collation: row.7,
            generation_expression: row.8,
        })
        .collect())
}

fn normalized_optional(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim)
}

fn column_changed(def: &MysqlColumnDefinition, current: &CurrentColumn) -> bool {
    def.column_type.trim().to_ascii_lowercase() != current.column_type.trim().to_ascii_lowercase()
        || def.nullable != current.nullable
        || normalized_optional(&def.default_value) != normalized_optional(&current.default_value)
        || def.charset.as_deref() != current.charset.as_deref()
        || def.collation.as_deref() != current.collation.as_deref()
        || def.comment != current.comment
        || def.auto_increment
            != current
                .extra
                .to_ascii_lowercase()
                .contains("auto_increment")
        || def.generation_expression.as_deref().unwrap_or("").trim()
            != current
                .generation_expression
                .as_deref()
                .unwrap_or("")
                .trim()
        || extract_on_update_clause(&def.extra) != extract_on_update_clause(&current.extra)
}

#[derive(Clone, Debug)]
struct CurrentIndexColumn {
    name: Option<String>,
    prefix_length: Option<u64>,
    direction: String,
}

#[derive(Clone, Debug)]
struct CurrentIndex {
    name: String,
    unique: bool,
    index_type: String,
    columns: Vec<CurrentIndexColumn>,
}

fn normalize_direction(value: Option<&str>) -> String {
    match value.map(|item| item.to_ascii_uppercase()) {
        Some(value) if value == "D" || value == "DESC" => "DESC".to_string(),
        _ => "ASC".to_string(),
    }
}

async fn load_current_indexes(
    conn: &mut mysql_async::Conn,
    database: &str,
    table: &str,
) -> Result<Vec<CurrentIndex>, String> {
    let rows: Vec<(String,u8,Option<String>,Option<u64>,Option<String>,String)> = conn.exec(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART, COLLATION, INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        (database, table),
    ).await.map_err(|e| e.to_string())?;
    let mut grouped: BTreeMap<String, CurrentIndex> = BTreeMap::new();
    for (name, non_unique, column, prefix_length, collation, index_type) in rows {
        let entry = grouped.entry(name.clone()).or_insert_with(|| CurrentIndex {
            name,
            unique: non_unique == 0,
            index_type,
            columns: Vec::new(),
        });
        entry.columns.push(CurrentIndexColumn {
            name: column,
            prefix_length,
            direction: normalize_direction(collation.as_deref()),
        });
    }
    Ok(grouped.into_values().collect())
}

fn desired_index_unique(index: &MysqlIndexDefinition) -> Result<bool, String> {
    match index.kind.as_str() {
        "PRIMARY" | "UNIQUE" => Ok(true),
        "INDEX" => Ok(false),
        _ => Err(format!("不支持的索引类型: {}", index.kind)),
    }
}

fn index_matches(index: &CurrentIndex, desired: &MysqlIndexDefinition) -> Result<bool, String> {
    if index.name != desired.name {
        return Ok(false);
    }
    if index.unique != desired_index_unique(desired)? {
        return Ok(false);
    }
    if index.columns.len() != desired.columns.len() {
        return Ok(false);
    }
    for (current, desired) in index.columns.iter().zip(desired.columns.iter()) {
        if current.name.as_deref() != Some(desired.name.as_str()) {
            return Ok(false);
        }
        if current.prefix_length != desired.prefix_length.map(u64::from) {
            return Ok(false);
        }
        if current.direction != normalize_direction(desired.direction.as_deref()) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn index_is_advanced(index: &CurrentIndex) -> bool {
    index.columns.iter().any(|column| column.name.is_none())
        || matches!(
            index.index_type.to_ascii_uppercase().as_str(),
            "FULLTEXT" | "SPATIAL" | "HASH"
        )
}

fn drop_index_clause(name: &str) -> Result<String, String> {
    if name == "PRIMARY" {
        Ok("DROP PRIMARY KEY".to_string())
    } else {
        Ok(format!("DROP INDEX {}", quote_identifier(name)?))
    }
}

async fn alter_table_plan(pool: &Pool, def: &MysqlTableDefinition) -> Result<Vec<String>, String> {
    let original = def.original_name.as_deref().ok_or("缺少原始表名")?;
    let db = quote_identifier(&def.database)?;
    let old = quote_identifier(original)?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let current_columns = load_current_columns(&mut conn, &def.database, original).await?;
    let current_indexes = load_current_indexes(&mut conn, &def.database, original).await?;
    if current_columns.is_empty() {
        return Err("原表不存在或无权访问".to_string());
    }

    let mut desired_columns = HashSet::new();
    for column in &def.columns {
        if !desired_columns.insert(column.name.as_str()) {
            return Err(format!("字段名重复: {}", column.name));
        }
    }
    let mut desired_indexes = HashMap::new();
    for index in &def.indexes {
        if desired_indexes.insert(index.name.as_str(), index).is_some() {
            return Err(format!("索引名重复: {}", index.name));
        }
    }

    let current_columns_by_name: HashMap<&str, &CurrentColumn> = current_columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut statements = Vec::new();

    for column in &def.columns {
        match current_columns_by_name.get(column.name.as_str()) {
            Some(current) if !column_changed(column, current) => {}
            Some(_) => statements.push(format!(
                "ALTER TABLE {db}.{old} MODIFY COLUMN {}",
                build_column(column)?
            )),
            None => statements.push(format!(
                "ALTER TABLE {db}.{old} ADD COLUMN {}",
                build_column(column)?
            )),
        }
    }

    for current in &current_indexes {
        match desired_indexes.get(current.name.as_str()) {
            Some(desired) if index_matches(current, desired)? => {}
            Some(desired) => {
                if index_is_advanced(current) {
                    return Err(format!(
                        "索引 {} 使用函数表达式或 FULLTEXT/SPATIAL/HASH 类型，请使用 SQL 工作台修改",
                        current.name
                    ));
                }
                statements.push(format!(
                    "ALTER TABLE {db}.{old} {}, ADD {}",
                    drop_index_clause(&current.name)?,
                    build_index(desired)?
                ));
            }
            None => {
                if index_is_advanced(current) {
                    return Err(format!(
                        "索引 {} 使用函数表达式或 FULLTEXT/SPATIAL/HASH 类型，请使用 SQL 工作台修改",
                        current.name
                    ));
                }
                statements.push(format!(
                    "ALTER TABLE {db}.{old} {}",
                    drop_index_clause(&current.name)?
                ));
            }
        }
    }

    for index in &def.indexes {
        if !current_indexes
            .iter()
            .any(|current| current.name == index.name)
        {
            statements.push(format!(
                "ALTER TABLE {db}.{old} ADD {}",
                build_index(index)?
            ));
        }
    }

    for current in &current_columns {
        if !desired_columns.contains(current.name.as_str()) {
            statements.push(format!(
                "ALTER TABLE {db}.{old} DROP COLUMN {}",
                quote_identifier(&current.name)?
            ));
        }
    }

    let mut options = format!(
        "ALTER TABLE {db}.{old} ENGINE={}",
        quote_identifier(def.engine.as_deref().unwrap_or("InnoDB"))?
    );
    if let Some(charset) = def.charset.as_deref().filter(|value| !value.is_empty()) {
        options.push_str(&format!(
            " DEFAULT CHARACTER SET {}",
            quote_identifier(charset)?
        ));
    }
    if let Some(collation) = def.collation.as_deref().filter(|value| !value.is_empty()) {
        options.push_str(&format!(" COLLATE {}", quote_identifier(collation)?));
    }
    options.push_str(&format!(" COMMENT={}", sql_string(&def.comment)));
    statements.push(options);

    if original != def.name {
        statements.push(format!(
            "RENAME TABLE {db}.{old} TO {db}.{}",
            quote_identifier(&def.name)?
        ));
    }
    Ok(statements)
}
#[tauri::command]
pub async fn mysql_preview_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
) -> Result<Vec<String>, String> {
    if definition.original_name.is_some() {
        let pool = pool_for(&state, &connection_id).await?;
        alter_table_plan(&pool, &definition).await
    } else {
        Ok(vec![create_table_sql(&definition)?])
    }
}

#[tauri::command]
pub async fn mysql_create_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
) -> Result<MysqlDdlResult, String> {
    if definition.original_name.is_some() {
        return Err("现有表请使用 SQL 工作台执行预览后的 ALTER TABLE".to_string());
    }
    let sql = create_table_sql(&definition)?;
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(&sql).await.map_err(|e| e.to_string())?;
    Ok(MysqlDdlResult {
        statements: vec![sql],
        completed: 1,
        error: None,
    })
}

#[tauri::command]
pub async fn mysql_apply_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
    preview: Option<Vec<String>>,
) -> Result<MysqlDdlResult, String> {
    if definition.original_name.is_none() {
        return mysql_create_table(state, connection_id, definition).await;
    }
    let pool = pool_for(&state, &connection_id).await?;
    let statements = match preview.filter(|items| !items.is_empty()) {
        Some(items) => {
            if items.len() > 100 {
                return Err("DDL 预览语句过多，已拒绝执行".to_string());
            }
            for statement in &items {
                let upper = statement.trim_start().to_ascii_uppercase();
                if !(upper.starts_with("ALTER TABLE ") || upper.starts_with("RENAME TABLE ")) {
                    return Err("DDL 预览包含非 ALTER/RENAME 语句，已拒绝执行".to_string());
                }
            }
            items
        }
        None => alter_table_plan(&pool, &definition).await?,
    };
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut completed = 0;
    for statement in &statements {
        if let Err(error) = conn.query_drop(statement).await {
            return Ok(MysqlDdlResult {
                statements,
                completed,
                error: Some(error.to_string()),
            });
        }
        completed += 1;
    }
    Ok(MysqlDdlResult {
        statements,
        completed,
        error: None,
    })
}

#[tauri::command]
pub async fn mysql_create_database(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<(), String> {
    let mut sql = format!("CREATE DATABASE {}", quote_identifier(&name)?);
    if let Some(value) = charset.filter(|v| !v.is_empty()) {
        sql.push_str(&format!(" CHARACTER SET {}", quote_identifier(&value)?));
    }
    if let Some(value) = collation.filter(|v| !v.is_empty()) {
        sql.push_str(&format!(" COLLATE {}", quote_identifier(&value)?));
    }
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(sql).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_drop_database(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("DROP DATABASE {}", quote_identifier(&database)?))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_table_action(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    action: String,
    target: Option<String>,
) -> Result<(), String> {
    let full = format!(
        "{}.{}",
        quote_identifier(&database)?,
        quote_identifier(&table)?
    );
    let sql = match action.as_str() {
        "truncate" => format!("TRUNCATE TABLE {full}"),
        "drop" => format!("DROP TABLE {full}"),
        "rename" => format!(
            "RENAME TABLE {full} TO {}.{}",
            quote_identifier(&database)?,
            quote_identifier(target.as_deref().ok_or("缺少目标表名")?)?
        ),
        "clone" => format!(
            "CREATE TABLE {}.{} LIKE {full}",
            quote_identifier(&database)?,
            quote_identifier(target.as_deref().ok_or("缺少目标表名")?)?
        ),
        _ => return Err("不支持的表操作".to_string()),
    };
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(sql).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_show_create(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let row: Option<(String, String)> = conn
        .query_first(format!(
            "SHOW CREATE TABLE {}.{}",
            quote_identifier(&database)?,
            quote_identifier(&table)?
        ))
        .await
        .map_err(|e| e.to_string())?;
    row.map(|value| value.1)
        .ok_or_else(|| "未返回建表语句".to_string())
}

const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

fn json_to_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::NULL,
        serde_json::Value::Bool(value) => Value::Int(if *value { 1 } else { 0 }),
        serde_json::Value::Number(value) if value.is_i64() => {
            Value::Int(value.as_i64().unwrap_or_default())
        }
        serde_json::Value::Number(value) if value.is_u64() => {
            Value::UInt(value.as_u64().unwrap_or_default())
        }
        serde_json::Value::Number(value) => Value::Double(value.as_f64().unwrap_or_default()),
        serde_json::Value::String(value) => Value::Bytes(value.as_bytes().to_vec()),
        serde_json::Value::Object(map) => {
            if map.len() == 1 {
                if let Some(encoded) = map.get("$binary").and_then(|value| value.as_str()) {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) {
                        return Value::Bytes(bytes);
                    }
                }
            }
            Value::Bytes(serde_json::to_vec(value).unwrap_or_default())
        }
        other => Value::Bytes(other.to_string().into_bytes()),
    }
}

fn json_integer(value: i64) -> serde_json::Value {
    if value.unsigned_abs() > MAX_SAFE_JS_INTEGER {
        serde_json::Value::String(value.to_string())
    } else {
        serde_json::json!(value)
    }
}

fn json_unsigned_integer(value: u64) -> serde_json::Value {
    if value > MAX_SAFE_JS_INTEGER {
        serde_json::Value::String(value.to_string())
    } else {
        serde_json::json!(value)
    }
}

fn json_float(value: f64) -> serde_json::Value {
    if value.is_finite() {
        serde_json::json!(value)
    } else {
        serde_json::Value::String(value.to_string())
    }
}

fn column_is_binary(column: Option<&Column>) -> bool {
    let Some(column) = column else {
        return false;
    };
    matches!(
        column.column_type(),
        ColumnType::MYSQL_TYPE_TINY_BLOB
            | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
            | ColumnType::MYSQL_TYPE_LONG_BLOB
            | ColumnType::MYSQL_TYPE_BLOB
            | ColumnType::MYSQL_TYPE_GEOMETRY
            | ColumnType::MYSQL_TYPE_BIT
    ) || (column.character_set() == 63
        && matches!(
            column.column_type(),
            ColumnType::MYSQL_TYPE_STRING
                | ColumnType::MYSQL_TYPE_VAR_STRING
                | ColumnType::MYSQL_TYPE_VARCHAR
        ))
}

fn column_type_name(column: &Column) -> String {
    format!("{:?}", column.column_type())
        .trim_start_matches("MYSQL_TYPE_")
        .to_ascii_lowercase()
}

fn query_column_metadata(column: &Column) -> QueryColumn {
    QueryColumn {
        name: column.name_str().to_string(),
        type_name: column_type_name(column),
        charset: column.character_set(),
        flags: column.flags().bits(),
    }
}

fn format_mysql_date(
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    micros: u32,
    column: Option<&Column>,
) -> String {
    let date_only = column.is_some_and(|column| {
        matches!(
            column.column_type(),
            ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE
        )
    });
    if date_only || (hour == 0 && minute == 0 && second == 0 && micros == 0) {
        format!("{year:04}-{month:02}-{day:02}")
    } else if micros == 0 {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{micros:06}")
    }
}

fn format_mysql_time(
    negative: bool,
    days: u32,
    hours: u8,
    minutes: u8,
    seconds: u8,
    micros: u32,
) -> String {
    let total_hours = days.saturating_mul(24).saturating_add(u32::from(hours));
    let sign = if negative { "-" } else { "" };
    if micros == 0 {
        format!("{sign}{total_hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{sign}{total_hours:02}:{minutes:02}:{seconds:02}.{micros:06}")
    }
}

fn value_to_json(value: &Value, column: Option<&Column>) -> serde_json::Value {
    match value {
        Value::NULL => serde_json::Value::Null,
        Value::Bytes(bytes) => {
            if column_is_binary(column) {
                return serde_json::json!({
                    "$binary": base64::engine::general_purpose::STANDARD.encode(bytes)
                });
            }
            match String::from_utf8(bytes.clone()) {
                Ok(text) => serde_json::Value::String(text),
                Err(_) => serde_json::json!({
                    "$binary": base64::engine::general_purpose::STANDARD.encode(bytes)
                }),
            }
        }
        Value::Int(value) => json_integer(*value),
        Value::UInt(value) => json_unsigned_integer(*value),
        Value::Float(value) => json_float(f64::from(*value)),
        Value::Double(value) => json_float(*value),
        Value::Date(year, month, day, hour, minute, second, micros) => {
            serde_json::Value::String(format_mysql_date(
                *year, *month, *day, *hour, *minute, *second, *micros, column,
            ))
        }
        Value::Time(negative, days, hours, minutes, seconds, micros) => serde_json::Value::String(
            format_mysql_time(*negative, *days, *hours, *minutes, *seconds, *micros),
        ),
    }
}

#[tauri::command]
pub async fn mysql_fetch_rows(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    page: u64,
    page_size: u64,
) -> Result<QueryResult, String> {
    let size = page_size.clamp(1, 1000);
    let offset = page
        .checked_sub(1)
        .and_then(|page_index| page_index.checked_mul(size))
        .ok_or_else(|| "页码或分页大小无效".to_string())?;
    let pool = pool_for(&state, &connection_id).await?;
    let (_, primary) = table_columns_and_keys(&pool, &database, &table).await?;
    let order_by = if primary.is_empty() {
        String::new()
    } else {
        let columns = primary
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        format!(" ORDER BY {columns}")
    };
    let fetch_size = size.saturating_add(1);
    let sql = format!(
        "SELECT * FROM {}.{}{order_by} LIMIT {fetch_size} OFFSET {offset}",
        quote_identifier(&database)?,
        quote_identifier(&table)?
    );
    let mut result = mysql_execute_sql(state, connection_id, sql, None).await?;
    let size_usize = size as usize;
    if result.rows.len() > size_usize {
        result.rows.truncate(size_usize);
        result.truncated = true;
    }
    Ok(result)
}

#[tauri::command]
pub async fn mysql_execute_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<QueryResult, String> {
    let sql = single_statement(&sql)?.to_string();
    let manager = state.mysql_manager.clone();
    let running_connection_id = connection_id.clone();
    let pool = pool_for(&state, &connection_id).await?;
    let query = async move {
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
        let thread_id: Option<u64> = conn
            .query_first("SELECT CONNECTION_ID()")
            .await
            .ok()
            .flatten();
        let _running_guard = thread_id.map(|thread_id| {
            manager.set_running(&running_connection_id, thread_id);
            RunningQueryGuard {
                manager: manager.clone(),
                connection_id: running_connection_id,
            }
        });
        if let Some(database) = database.as_deref().filter(|value| !value.is_empty()) {
            conn.query_drop(format!("USE {}", quote_identifier(database)?))
                .await
                .map_err(|e| e.to_string())?;
        }
        let start = std::time::Instant::now();
        let mut result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
        let affected_rows = result.affected_rows();
        let last_insert_id = result.last_insert_id();
        let column_meta: Vec<Column> = result
            .columns()
            .map(|columns| columns.to_vec())
            .unwrap_or_default();
        let columns = column_meta
            .iter()
            .map(|column| column.name_str().to_string())
            .collect::<Vec<_>>();
        let column_metadata = column_meta
            .iter()
            .map(query_column_metadata)
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut truncated = false;
        while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
            if rows.len() >= MYSQL_MAX_RESULT_ROWS {
                truncated = true;
                result.drop_result().await.map_err(|e| e.to_string())?;
                break;
            }
            let values = (0..row.len())
                .map(|index| {
                    row.as_ref(index)
                        .map(|value| value_to_json(value, column_meta.get(index)))
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect();
            rows.push(QueryResultRow { values });
        }
        Ok::<QueryResult, String>(QueryResult {
            columns,
            column_metadata,
            rows,
            affected_rows,
            execution_time_ms: start.elapsed().as_millis() as u64,
            last_insert_id,
            truncated,
        })
    };

    tokio::time::timeout(Duration::from_millis(MYSQL_QUERY_TIMEOUT_MS), query)
        .await
        .map_err(|_| format!("SQL 执行超时（{} 秒）", MYSQL_QUERY_TIMEOUT_MS / 1000))?
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlRowMutation {
    pub values: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub original: HashMap<String, serde_json::Value>,
}

async fn table_columns_and_keys(
    pool: &Pool,
    database: &str,
    table: &str,
) -> Result<(HashSet<String>, Vec<String>), String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String,String)> = conn.exec("SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (database,table)).await.map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err("表不存在或无权访问".to_string());
    }
    Ok((
        rows.iter().map(|r| r.0.clone()).collect(),
        rows.into_iter()
            .filter(|r| r.1 == "PRI")
            .map(|r| r.0)
            .collect(),
    ))
}

fn build_row_mutation_sql(
    full: &str,
    action: &str,
    values: &HashMap<String, serde_json::Value>,
    original: &HashMap<String, serde_json::Value>,
    primary: &[String],
    allowed: &HashSet<String>,
) -> Result<(String, Vec<Value>), String> {
    if values.keys().chain(original.keys()).any(|key| !allowed.contains(key)) {
        return Err("请求包含未知字段".to_string());
    }
    let mut params = Vec::new();
    let sql = if action == "insert" {
        let columns = values.keys().cloned().collect::<Vec<_>>();
        if columns.is_empty() {
            return Err("没有可插入的数据".to_string());
        }
        params.extend(columns.iter().map(|key| json_to_value(&values[key])));
        format!(
            "INSERT INTO {full} ({}) VALUES ({})",
            columns
                .iter()
                .map(|v| quote_identifier(v))
                .collect::<Result<Vec<_>, _>>()?
                .join(","),
            vec!["?"; columns.len()].join(",")
        )
    } else {
        if original.is_empty() {
            return Err("缺少原始行数据".to_string());
        }
        let where_keys = if primary.is_empty() {
            original.keys().cloned().collect::<Vec<_>>()
        } else {
            primary.to_vec()
        };
        let where_sql = where_keys
            .iter()
            .map(|key| quote_identifier(key).map(|q| format!("{q} <=> ?")))
            .collect::<Result<Vec<_>, _>>()?
            .join(" AND ");
        if action == "delete" {
            params.extend(where_keys.iter().map(|key| {
                json_to_value(original.get(key).unwrap_or(&serde_json::Value::Null))
            }));
            format!("DELETE FROM {full} WHERE {where_sql} LIMIT 1")
        } else if action == "update" {
            let columns = values.keys().cloned().collect::<Vec<_>>();
            if columns.is_empty() {
                return Err("没有需要更新的数据".to_string());
            }
            params.extend(columns.iter().map(|key| json_to_value(&values[key])));
            params.extend(where_keys.iter().map(|key| {
                json_to_value(original.get(key).unwrap_or(&serde_json::Value::Null))
            }));
            format!(
                "UPDATE {full} SET {} WHERE {where_sql} LIMIT 1",
                columns
                    .iter()
                    .map(|key| quote_identifier(key).map(|q| format!("{q}=?")))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(",")
            )
        } else {
            return Err("不支持的行操作".to_string());
        }
    };
    Ok((sql, params))
}

#[tauri::command]
pub async fn mysql_mutate_row(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    action: String,
    mutation: MysqlRowMutation,
) -> Result<u64, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let (allowed, primary) = table_columns_and_keys(&pool, &database, &table).await?;
    let full = format!(
        "{}.{}",
        quote_identifier(&database)?,
        quote_identifier(&table)?
    );
    let (sql, params) = build_row_mutation_sql(
        &full,
        &action,
        &mutation.values,
        &mutation.original,
        &primary,
        &allowed,
    )?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.exec_drop(sql, Params::Positional(params))
        .await
        .map_err(|e| e.to_string())?;
    let affected = conn.affected_rows();
    if action != "insert" && affected == 0 {
        return Err("数据已被其他操作修改，请刷新后重试".to_string());
    }
    Ok(affected)
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MysqlTableChangeSet {
    #[serde(default)]
    pub inserts: Vec<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub updates: Vec<MysqlRowMutation>,
    #[serde(default)]
    pub deletes: Vec<HashMap<String, serde_json::Value>>,
}

#[tauri::command]
pub async fn mysql_apply_table_changes(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    changes: MysqlTableChangeSet,
) -> Result<u64, String> {
    let total = changes.inserts.len() + changes.updates.len() + changes.deletes.len();
    if total == 0 {
        return Err("没有待应用的修改".to_string());
    }
    if total > 5_000 {
        return Err("单次提交的修改不能超过 5000 条".to_string());
    }
    let pool = pool_for(&state, &connection_id).await?;
    let (allowed, primary) = table_columns_and_keys(&pool, &database, &table).await?;
    let full = format!(
        "{}.{}",
        quote_identifier(&database)?,
        quote_identifier(&table)?
    );
    let manager = state.mysql_manager.clone();
    let running_connection_id = connection_id.clone();
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let thread_id: Option<u64> = conn
        .query_first("SELECT CONNECTION_ID()")
        .await
        .ok()
        .flatten();
    let _running_guard = thread_id.map(|thread_id| {
        manager.set_running(&running_connection_id, thread_id);
        RunningQueryGuard {
            manager: manager.clone(),
            connection_id: running_connection_id,
        }
    });

    let mut tx = conn
        .start_transaction(mysql_async::TxOpts::default())
        .await
        .map_err(|e| e.to_string())?;
    for values in &changes.inserts {
        let (sql, params) = build_row_mutation_sql(
            &full,
            "insert",
            values,
            &HashMap::new(),
            &primary,
            &allowed,
        )?;
        tx.exec_drop(sql, Params::Positional(params))
            .await
            .map_err(|e| format!("新增记录失败: {e}"))?;
    }
    for mutation in &changes.updates {
        let (sql, params) = build_row_mutation_sql(
            &full,
            "update",
            &mutation.values,
            &mutation.original,
            &primary,
            &allowed,
        )?;
        tx.exec_drop(sql, Params::Positional(params))
            .await
            .map_err(|e| format!("更新记录失败: {e}"))?;
    }
    for original in &changes.deletes {
        let (sql, params) = build_row_mutation_sql(
            &full,
            "delete",
            &HashMap::new(),
            original,
            &primary,
            &allowed,
        )?;
        tx.exec_drop(sql, Params::Positional(params))
            .await
            .map_err(|e| format!("删除记录失败: {e}"))?;
    }
    tx.commit().await.map_err(|e| format!("提交失败: {e}"))?;
    Ok(total as u64)
}

fn parse_csv(input: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' if !quoted => {
                if field.ends_with('\r') {
                    field.pop();
                }
                row.push(std::mem::take(&mut field));
                if row.iter().any(|value| !value.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => field.push(ch),
        }
    }
    if quoted {
        return Err("CSV 引号未闭合".to_string());
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

#[tauri::command]
pub async fn mysql_import_csv(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    csv: String,
) -> Result<u64, String> {
    const MAX_CSV_IMPORT_BYTES: usize = 64 * 1024 * 1024;
    if csv.len() > MAX_CSV_IMPORT_BYTES {
        return Err("CSV 文件超过 64MB 限制，请拆分后导入".to_string());
    }
    let csv = csv.strip_prefix('\u{feff}').unwrap_or(&csv);
    let rows = parse_csv(csv)?;
    if rows.len() < 2 {
        return Err("CSV 至少需要表头和一行数据".to_string());
    }
    let headers = rows[0]
        .iter()
        .map(|value| value.trim().to_string())
        .collect::<Vec<_>>();
    if headers.iter().any(|value| value.is_empty()) {
        return Err("CSV 表头不能为空".to_string());
    }
    let mut seen = HashSet::new();
    for header in &headers {
        if !seen.insert(header.as_str()) {
            return Err(format!("CSV 表头重复: {header}"));
        }
    }
    let pool = pool_for(&state, &connection_id).await?;
    let (allowed, _) = table_columns_and_keys(&pool, &database, &table).await?;
    if headers.iter().any(|key| !allowed.contains(key)) {
        return Err("CSV 包含目标表中不存在的字段".to_string());
    }

    let column_list = headers
        .iter()
        .map(|value| quote_identifier(value))
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let row_placeholder = format!("({})", vec!["?"; headers.len()].join(","));
    let batch_size = (200usize).min(60_000 / headers.len().max(1)).max(1);
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut tx = conn
        .start_transaction(mysql_async::TxOpts::default())
        .await
        .map_err(|e| e.to_string())?;

    for (batch_index, batch) in rows[1..].chunks(batch_size).enumerate() {
        let start_row = batch_index * batch_size + 2;
        let mut params = Vec::with_capacity(batch.len() * headers.len());
        for (offset, row) in batch.iter().enumerate() {
            if row.len() != headers.len() {
                return Err(format!("CSV 第 {} 行字段数不一致", start_row + offset));
            }
            params.extend(row.iter().map(|value| {
                if value == "\\N" {
                    Value::NULL
                } else {
                    Value::Bytes(value.as_bytes().to_vec())
                }
            }));
        }
        let sql = format!(
            "INSERT INTO {}.{} ({column_list}) VALUES {}",
            quote_identifier(&database)?,
            quote_identifier(&table)?,
            vec![row_placeholder.as_str(); batch.len()].join(",")
        );
        tx.exec_drop(sql, Params::Positional(params))
            .await
            .map_err(|e| format!("CSV 第 {} 行批次导入失败: {e}", start_row))?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok((rows.len() - 1) as u64)
}
#[derive(Debug, Clone, Deserialize)]
pub struct MysqlSqlImportOptions {
    pub path: String,
    pub database: Option<String>,
    #[serde(default)]
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlSqlFailure {
    pub statement: usize,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlSqlImportResult {
    pub total: usize,
    pub completed: usize,
    pub failures: Vec<MysqlSqlFailure>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlSqlExportOptions {
    pub path: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlSqlExportResult {
    pub tables: usize,
    pub rows: u64,
    pub bytes: u64,
}

fn split_sql_script(input: &str) -> Result<Vec<String>, String> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut delimiter = ";".to_string();
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quote: Option<char> = None;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut escaped = false;
    let mut line_start = true;
    while let Some(ch) = chars.next() {
        if line_comment {
            current.push(ch);
            if ch == '\n' {
                line_comment = false;
                line_start = true;
            }
            continue;
        }
        if block_comment {
            current.push(ch);
            if ch == '*' && chars.peek() == Some(&'/') {
                current.push('/');
                chars.next();
                block_comment = false;
            }
            line_start = ch == '\n';
            continue;
        }
        if let Some(q) = quote {
            current.push(ch);
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == q {
                if chars.peek() == Some(&q) {
                    current.push(q);
                    chars.next();
                } else {
                    quote = None;
                }
            }
            line_start = ch == '\n';
            continue;
        }
        if line_start && current.trim().is_empty() {
            let mut probe = String::new();
            if !ch.is_whitespace() {
                probe.push(ch);
            }
            while probe.len() < 9 {
                match chars.peek().copied() {
                    Some(c) if c != '\n' && c != '\r' => {
                        probe.push(c);
                        chars.next();
                    }
                    _ => break,
                }
            }
            if probe.to_ascii_uppercase().starts_with("DELIMITER") {
                let mut rest = probe[9.min(probe.len())..].to_string();
                while let Some(c) = chars.next() {
                    if c == '\n' {
                        break;
                    }
                    if c != '\r' {
                        rest.push(c);
                    }
                }
                let next = rest.trim();
                if next.is_empty() {
                    return Err("DELIMITER 指令缺少分隔符".to_string());
                }
                delimiter = next.to_string();
                current.clear();
                line_start = true;
                continue;
            }
            current.push_str(&probe);
            line_start = false;
            continue;
        }
        if ch == '-' && chars.peek() == Some(&'-') {
            current.push(ch);
            current.push('-');
            chars.next();
            line_comment = true;
            continue;
        }
        if ch == '#' {
            current.push(ch);
            line_comment = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            current.push(ch);
            current.push('*');
            chars.next();
            block_comment = true;
            continue;
        }
        if matches!(ch, '\'' | '"' | '`') {
            quote = Some(ch);
            current.push(ch);
            continue;
        }
        current.push(ch);
        if current.ends_with(&delimiter) {
            let new_len = current.len() - delimiter.len();
            current.truncate(new_len);
            if !current.trim().is_empty() {
                statements.push(current.trim().to_string());
            }
            current.clear();
            line_start = true;
        } else {
            line_start = ch == '\n';
        }
    }
    if quote.is_some() || block_comment {
        return Err("SQL 文件包含未闭合的引号或注释".to_string());
    }
    if !current.trim().is_empty() {
        statements.push(current.trim().to_string());
    }
    Ok(statements)
}

#[tauri::command]
pub async fn mysql_import_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: MysqlSqlImportOptions,
) -> Result<MysqlSqlImportResult, String> {
    const MAX_SQL_IMPORT_BYTES: u64 = 128 * 1024 * 1024;
    let metadata = tokio::fs::metadata(&options.path)
        .await
        .map_err(|e| format!("读取 SQL 文件信息失败: {e}"))?;
    if metadata.len() > MAX_SQL_IMPORT_BYTES {
        return Err("SQL 文件超过 128MB 限制，请拆分后导入".to_string());
    }
    let content = tokio::fs::read_to_string(&options.path)
        .await
        .map_err(|e| format!("读取 SQL 文件失败: {e}"))?;
    let statements = split_sql_script(&content)?;
    if statements.is_empty() {
        return Err("SQL 文件中没有可执行语句".to_string());
    }
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    if let Some(database) = options.database.as_deref().filter(|v| !v.is_empty()) {
        conn.query_drop(format!("USE {}", quote_identifier(database)?))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut completed = 0;
    let mut failures = Vec::new();
    for (index, statement) in statements.iter().enumerate() {
        match conn.query_drop(statement).await {
            Ok(_) => completed += 1,
            Err(error) => {
                failures.push(MysqlSqlFailure {
                    statement: index + 1,
                    summary: error.to_string(),
                });
                if !options.continue_on_error {
                    break;
                }
            }
        }
    }
    Ok(MysqlSqlImportResult {
        total: statements.len(),
        completed,
        failures,
    })
}

fn sql_literal(value: &Value) -> String {
    value.as_sql(false)
}

async fn show_create_statement(
    conn: &mut mysql_async::Conn,
    sql: String,
    create_index: usize,
) -> Result<Option<String>, String> {
    let row: Option<Row> = conn.query_first(sql).await.map_err(|e| e.to_string())?;
    Ok(row.and_then(|row| row.get(create_index)))
}

async fn write_export(file: &mut tokio::fs::File, data: &str) -> Result<(), String> {
    file.write_all(data.as_bytes())
        .await
        .map_err(|e| format!("写入 SQL 文件失败: {e}"))
}

async fn export_table_data(
    conn: &mut mysql_async::Conn,
    database: &str,
    table: &str,
    file: &mut tokio::fs::File,
) -> Result<u64, String> {
    let columns: Vec<(String, String)> = conn.exec(
        "SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
        (database, table),
    ).await.map_err(|e| e.to_string())?;
    let export_columns = columns
        .into_iter()
        .filter(|(_, extra)| !extra.to_ascii_lowercase().contains("generated"))
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    if export_columns.is_empty() {
        return Ok(0);
    }
    let column_list = export_columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let select_sql = format!(
        "SELECT {column_list} FROM {}.{}",
        quote_identifier(database)?,
        quote_identifier(table)?
    );
    let insert_prefix = format!(
        "INSERT INTO {} ({column_list}) VALUES ",
        quote_identifier(table)?
    );
    let mut result = conn
        .query_iter(select_sql)
        .await
        .map_err(|e| e.to_string())?;
    let mut exported_rows = 0u64;
    let mut batch = Vec::new();
    while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
        let values = (0..row.len())
            .map(|index| {
                row.as_ref(index)
                    .map(sql_literal)
                    .unwrap_or_else(|| "NULL".to_string())
            })
            .collect::<Vec<_>>()
            .join(",");
        batch.push(format!("({values})"));
        exported_rows += 1;
        if batch.len() >= 200 {
            write_export(file, &format!("{insert_prefix}{};\n", batch.join(","))).await?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        write_export(file, &format!("{insert_prefix}{};\n", batch.join(","))).await?;
    }
    Ok(exported_rows)
}
#[tauri::command]
pub async fn mysql_export_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: MysqlSqlExportOptions,
) -> Result<MysqlSqlExportResult, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

    let _ = conn
        .query_drop("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .await;
    let snapshot_started = conn
        .query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT")
        .await
        .is_ok();
    if !snapshot_started {
        let _ = conn.query_drop("START TRANSACTION").await;
    }

    let schema: Option<(String, String)> = conn.exec_first(
        "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
        (&options.database,),
    ).await.map_err(|e| e.to_string())?;
    let (charset, collation) = schema.ok_or_else(|| "数据库不存在或无权访问".to_string())?;
    let table_names: Vec<String> = conn.exec(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
        (&options.database,),
    ).await.map_err(|e| e.to_string())?;
    let view_names: Vec<String> = conn.exec(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='VIEW' ORDER BY TABLE_NAME",
        (&options.database,),
    ).await.map_err(|e| e.to_string())?;
    let routines: Vec<(String, String)> = conn.exec(
        "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME",
        (&options.database,),
    ).await.map_err(|e| e.to_string())?;
    let triggers: Vec<String> = conn.exec(
        "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME",
        (&options.database,),
    ).await.map_err(|e| e.to_string())?;
    let events: Vec<String> = conn.exec(
        "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY EVENT_NAME",
        (&options.database,),
    ).await.map_err(|e| e.to_string())?;

    let tmp_path = format!("{}.portnest-{}.tmp", options.path, Uuid::new_v4());
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("创建 SQL 文件失败: {e}"))?;
    let header = format!(
        "-- PortNest MySQL export\nSET NAMES utf8mb4;\nSET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\nSET FOREIGN_KEY_CHECKS=0;\nCREATE DATABASE IF NOT EXISTS {} CHARACTER SET {} COLLATE {};\nUSE {};\n\n",
        quote_identifier(&options.database)?,
        quote_identifier(&charset)?,
        quote_identifier(&collation)?,
        quote_identifier(&options.database)?
    );
    write_export(&mut file, &header).await?;

    let mut exported_rows = 0u64;
    for table in &table_names {
        let create = show_create_statement(
            &mut conn,
            format!(
                "SHOW CREATE TABLE {}.{}",
                quote_identifier(&options.database)?,
                quote_identifier(table)?
            ),
            1,
        )
        .await?
        .ok_or_else(|| format!("无法读取表 {table} 的结构"))?;
        write_export(
            &mut file,
            &format!(
                "DROP TABLE IF EXISTS {};\n{};\n\n",
                quote_identifier(table)?,
                create
            ),
        )
        .await?;
        exported_rows += export_table_data(&mut conn, &options.database, table, &mut file).await?;
    }

    for view in &view_names {
        let create = show_create_statement(
            &mut conn,
            format!(
                "SHOW CREATE VIEW {}.{}",
                quote_identifier(&options.database)?,
                quote_identifier(view)?
            ),
            1,
        )
        .await?
        .ok_or_else(|| format!("无法读取视图 {view} 的结构"))?;
        write_export(
            &mut file,
            &format!(
                "DROP VIEW IF EXISTS {};\n{};\n\n",
                quote_identifier(view)?,
                create
            ),
        )
        .await?;
    }

    for (name, routine_type) in &routines {
        let show_sql = if routine_type.eq_ignore_ascii_case("PROCEDURE") {
            format!(
                "SHOW CREATE PROCEDURE {}.{}",
                quote_identifier(&options.database)?,
                quote_identifier(name)?
            )
        } else {
            format!(
                "SHOW CREATE FUNCTION {}.{}",
                quote_identifier(&options.database)?,
                quote_identifier(name)?
            )
        };
        let routine_kind = if routine_type.eq_ignore_ascii_case("PROCEDURE") {
            "PROCEDURE"
        } else {
            "FUNCTION"
        };
        write_export(
            &mut file,
            &format!(
                "DROP {routine_kind} IF EXISTS {}.{};\n",
                quote_identifier(&options.database)?,
                quote_identifier(name)?
            ),
        )
        .await?;
        if let Some(create) = show_create_statement(&mut conn, show_sql, 2).await? {
            write_export(
                &mut file,
                &format!("DELIMITER $$\n{}$$\nDELIMITER ;\n\n", create),
            )
            .await?;
        }
    }

    for trigger in &triggers {
        let show_sql = format!(
            "SHOW CREATE TRIGGER {}.{}",
            quote_identifier(&options.database)?,
            quote_identifier(trigger)?
        );
        write_export(
            &mut file,
            &format!(
                "DROP TRIGGER IF EXISTS {}.{};\n",
                quote_identifier(&options.database)?,
                quote_identifier(trigger)?
            ),
        )
        .await?;
        if let Some(create) = show_create_statement(&mut conn, show_sql, 2).await? {
            write_export(
                &mut file,
                &format!("DELIMITER $$\n{}$$\nDELIMITER ;\n\n", create),
            )
            .await?;
        }
    }

    for event in &events {
        let show_sql = format!(
            "SHOW CREATE EVENT {}.{}",
            quote_identifier(&options.database)?,
            quote_identifier(event)?
        );
        write_export(
            &mut file,
            &format!(
                "DROP EVENT IF EXISTS {}.{};\n",
                quote_identifier(&options.database)?,
                quote_identifier(event)?
            ),
        )
        .await?;
        if let Some(create) = show_create_statement(&mut conn, show_sql, 3).await? {
            write_export(
                &mut file,
                &format!("DELIMITER $$\n{}$$\nDELIMITER ;\n\n", create),
            )
            .await?;
        }
    }

    write_export(
        &mut file,
        "SET FOREIGN_KEY_CHECKS=1;\nSET SQL_MODE=@OLD_SQL_MODE;\n",
    )
    .await?;
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if snapshot_started {
        let _ = conn.query_drop("COMMIT").await;
    }

    if tokio::fs::try_exists(&options.path).await.unwrap_or(false) {
        tokio::fs::remove_file(&options.path)
            .await
            .map_err(|e| format!("替换旧导出文件失败: {e}"))?;
    }
    tokio::fs::rename(&tmp_path, &options.path)
        .await
        .map_err(|e| format!("保存 SQL 文件失败: {e}"))?;
    let bytes = tokio::fs::metadata(&options.path)
        .await
        .map_err(|e| e.to_string())?
        .len();
    Ok(MysqlSqlExportResult {
        tables: table_names.len(),
        rows: exported_rows,
        bytes,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_quoted() {
        assert_eq!(quote_identifier("a`b").unwrap(), "`a``b`");
    }
    #[test]
    fn rejects_multiple_statements() {
        assert!(single_statement("SELECT 1; SELECT 2").is_err());
        assert!(single_statement("SELECT 1;").is_ok());
    }
    #[test]
    fn validates_types() {
        assert!(validated_column_type("varchar(255)").is_ok());
        assert!(validated_column_type("varchar(1); drop table x").is_err());
    }
    #[test]
    fn parses_quoted_csv() {
        let rows = parse_csv("a,b\n\"x,y\",\"q\"\"z\"").unwrap();
        assert_eq!(rows[1], vec!["x,y", "q\"z"]);
    }
    #[test]
    fn splits_sql_with_strings_and_comments() {
        let sql = "-- comment\nINSERT INTO t VALUES ('a;b');\n/* x;y */ SELECT 2;";
        let statements = split_sql_script(sql).unwrap();
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("'a;b'"));
    }
    #[test]
    fn splits_sql_with_custom_delimiter() {
        let sql = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;";
        let statements = split_sql_script(sql).unwrap();
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("SELECT 2;"));
    }
    #[test]
    fn allows_semicolon_in_literals_and_comments() {
        assert_eq!(single_statement("SELECT ';';").unwrap(), "SELECT ';'");
        assert!(single_statement("SELECT 1 -- semicolon ; in comment\n").is_ok());
        assert!(single_statement("SELECT 1 /* ; */").is_ok());
        assert!(single_statement(";").is_err());
    }

    #[test]
    fn formats_time_with_day_rollover() {
        assert_eq!(format_mysql_time(false, 1, 2, 3, 4, 0), "26:03:04");
        assert_eq!(
            format_mysql_time(true, 0, 1, 2, 3, 500_000),
            "-01:02:03.500000"
        );
    }

    #[test]
    fn keeps_large_integers_as_strings() {
        assert_eq!(
            json_unsigned_integer(9_007_199_254_740_992),
            serde_json::Value::String("9007199254740992".to_string())
        );
        assert_eq!(json_unsigned_integer(42), serde_json::json!(42));
    }
}
