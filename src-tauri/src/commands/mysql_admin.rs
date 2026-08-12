use super::{AppState, QueryResult, QueryResultRow};
use base64::Engine;
use mysql_async::{prelude::Queryable, OptsBuilder, Params, Pool, Row, Value};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};

pub struct MysqlManager {
    pools: RwLock<HashMap<String, Pool>>,
}

impl MysqlManager {
    pub fn new() -> Self {
        Self { pools: RwLock::new(HashMap::new()) }
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
}

fn quote_identifier(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("数据库对象名称不能为空或包含 NUL 字符".to_string());
    }
    Ok(format!("`{}`", trimmed.replace('`', "``")))
}

fn single_statement(sql: &str) -> Result<&str, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() { return Err("SQL 不能为空".to_string()); }
    let without_tail = trimmed.trim_end_matches(';').trim_end();
    if without_tail.contains(';') {
        return Err("SQL 工作台每次只允许执行一条语句".to_string());
    }
    Ok(without_tail)
}

async fn build_pool(state: &AppState, connection_id: &str) -> Result<Pool, String> {
    let connection = state.db.get_connections().map_err(|e| e.to_string())?
        .into_iter().find(|item| item.id == connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    if connection.protocol != "mysql" { return Err("该连接不是 MySQL 连接".to_string()); }
    let credential = state.db.get_credential_structured(&connection.credential_id).map_err(|e| e.to_string())?;
    let options = connection.options.as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .unwrap_or_default();
    let database = options.get("database").and_then(|v| v.as_str()).filter(|v| !v.is_empty());
    let builder = OptsBuilder::default()
        .ip_or_hostname(connection.host)
        .tcp_port(connection.port)
        .user(connection.username)
        .pass(credential.password)
        .db_name(database);
    let pool = Pool::new(builder);
    let mut conn = pool.get_conn().await.map_err(|e| format!("MySQL 连接失败: {e}"))?;
    conn.query_drop("SELECT 1").await.map_err(|e| format!("MySQL 连接验证失败: {e}"))?;
    drop(conn);
    Ok(pool)
}

async fn pool_for(state: &AppState, connection_id: &str) -> Result<Pool, String> {
    if let Some(pool) = state.mysql_manager.get(connection_id) { return Ok(pool); }
    let pool = build_pool(state, connection_id).await?;
    state.mysql_manager.insert(connection_id.to_string(), pool.clone());
    Ok(pool)
}

#[tauri::command]
pub async fn mysql_connect(state: tauri::State<'_, AppState>, connection_id: String) -> Result<(), String> {
    if let Some(old) = state.mysql_manager.remove(&connection_id) { let _ = old.disconnect().await; }
    let pool = build_pool(&state, &connection_id).await?;
    state.mysql_manager.insert(connection_id, pool);
    Ok(())
}

#[tauri::command]
pub async fn mysql_disconnect(state: tauri::State<'_, AppState>, connection_id: String) -> Result<(), String> {
    if let Some(pool) = state.mysql_manager.remove(&connection_id) {
        pool.disconnect().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlDatabaseInfo { pub name: String, pub charset: Option<String>, pub collation: Option<String> }

#[derive(Debug, Clone, Serialize)]
pub struct MysqlCharsetInfo {
    pub name: String,
    pub description: String,
    pub default_collation: String,
    pub collations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlTableInfo {
    pub name: String, pub kind: String, pub engine: Option<String>, pub rows: Option<u64>, pub comment: String,
    pub data_length: Option<u64>, pub index_length: Option<u64>, pub auto_increment: Option<u64>,
    pub collation: Option<String>, pub created_at: Option<String>, pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlColumnInfo {
    pub name: String, pub data_type: String, pub column_type: String, pub nullable: bool,
    pub default_value: Option<String>, pub extra: String, pub comment: String, pub key: String,
    pub charset: Option<String>, pub collation: Option<String>, pub ordinal: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlIndexInfo { pub name: String, pub unique: bool, pub column: String, pub sequence: u32, pub prefix_length: Option<u64>, pub direction: Option<String> }

#[tauri::command]
pub async fn mysql_list_databases(state: tauri::State<'_, AppState>, connection_id: String) -> Result<Vec<MysqlDatabaseInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>, Option<String>)> = conn.exec(
        "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME", ()
    ).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(name, charset, collation)| MysqlDatabaseInfo { name, charset, collation }).collect())
}

#[tauri::command]
pub async fn mysql_list_charsets(state: tauri::State<'_, AppState>, connection_id: String) -> Result<Vec<MysqlCharsetInfo>, String> {
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
            result.push(MysqlCharsetInfo { name, description, default_collation, collations: vec![collation] });
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn mysql_list_tables(state: tauri::State<'_, AppState>, connection_id: String, database: String) -> Result<Vec<MysqlTableInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<String>, Option<u64>, String, Option<u64>, Option<u64>, Option<u64>, Option<String>, Option<String>, Option<String>)> = conn.exec(
        "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, TABLE_COLLATION, CAST(CREATE_TIME AS CHAR), CAST(UPDATE_TIME AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", (database,)
    ).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| MysqlTableInfo { name:r.0, kind:r.1, engine:r.2, rows:r.3, comment:r.4, data_length:r.5, index_length:r.6, auto_increment:r.7, collation:r.8, created_at:r.9, updated_at:r.10 }).collect())
}

#[tauri::command]
pub async fn mysql_list_columns(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String) -> Result<Vec<MysqlColumnInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String,String,String,String,Option<String>,String,String,String,Option<String>,Option<String>,u32)> = conn.exec(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLUMN_KEY, CHARACTER_SET_NAME, COLLATION_NAME, ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (database, table)
    ).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| MysqlColumnInfo { name:r.0, data_type:r.1, column_type:r.2, nullable:r.3=="YES", default_value:r.4, extra:r.5, comment:r.6, key:r.7, charset:r.8, collation:r.9, ordinal:r.10 }).collect())
}

#[tauri::command]
pub async fn mysql_list_indexes(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String) -> Result<Vec<MysqlIndexInfo>, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String,u8,String,u32,Option<u64>,Option<String>)> = conn.exec(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART, COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX", (database, table)
    ).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| MysqlIndexInfo { name:r.0, unique:r.1==0, column:r.2, sequence:r.3, prefix_length:r.4, direction:r.5 }).collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlColumnDefinition {
    pub name: String, pub column_type: String, #[serde(default)] pub nullable: bool,
    pub default_value: Option<String>, #[serde(default)] pub auto_increment: bool, pub charset: Option<String>,
    pub collation: Option<String>, #[serde(default)] pub comment: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlIndexColumn { pub name: String, pub prefix_length: Option<u32>, pub direction: Option<String> }

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlIndexDefinition { pub name: String, pub kind: String, pub columns: Vec<MysqlIndexColumn> }

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlTableDefinition {
    pub database: String, pub name: String, pub original_name: Option<String>, pub engine: Option<String>,
    pub charset: Option<String>, pub collation: Option<String>, #[serde(default)] pub comment: String,
    pub columns: Vec<MysqlColumnDefinition>, #[serde(default)] pub indexes: Vec<MysqlIndexDefinition>,
}

fn sql_string(value: &str) -> String { format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''")) }

fn validated_column_type(value: &str) -> Result<String, String> {
    let value = value.trim();
    let base = value.split(|c: char| c == '(' || c.is_whitespace()).next().unwrap_or("").to_ascii_uppercase();
    const TYPES: &[&str] = &["TINYINT","SMALLINT","MEDIUMINT","INT","INTEGER","BIGINT","DECIMAL","NUMERIC","FLOAT","DOUBLE","BIT","BOOLEAN","BOOL","DATE","DATETIME","TIMESTAMP","TIME","YEAR","CHAR","VARCHAR","BINARY","VARBINARY","TINYBLOB","BLOB","MEDIUMBLOB","LONGBLOB","TINYTEXT","TEXT","MEDIUMTEXT","LONGTEXT","ENUM","SET","JSON"];
    if !TYPES.contains(&base.as_str()) || value.contains(';') || value.contains('`') { return Err(format!("不支持的字段类型: {value}")); }
    Ok(value.to_string())
}

fn build_column(def: &MysqlColumnDefinition) -> Result<String, String> {
    let mut sql = format!("{} {}", quote_identifier(&def.name)?, validated_column_type(&def.column_type)?);
    if let Some(charset) = def.charset.as_deref().filter(|v| !v.is_empty()) { sql.push_str(&format!(" CHARACTER SET {}", quote_identifier(charset)?)); }
    if let Some(collation) = def.collation.as_deref().filter(|v| !v.is_empty()) { sql.push_str(&format!(" COLLATE {}", quote_identifier(collation)?)); }
    sql.push_str(if def.nullable { " NULL" } else { " NOT NULL" });
    if let Some(default) = &def.default_value {
        let upper = default.to_ascii_uppercase();
        if upper == "NULL" || upper == "CURRENT_TIMESTAMP" || upper.starts_with("CURRENT_TIMESTAMP(") { sql.push_str(&format!(" DEFAULT {default}")); }
        else { sql.push_str(&format!(" DEFAULT {}", sql_string(default))); }
    }
    if def.auto_increment { sql.push_str(" AUTO_INCREMENT"); }
    if !def.comment.is_empty() { sql.push_str(&format!(" COMMENT {}", sql_string(&def.comment))); }
    Ok(sql)
}

fn build_index(def: &MysqlIndexDefinition) -> Result<String, String> {
    if def.columns.is_empty() { return Err("索引至少需要一个字段".to_string()); }
    let columns = def.columns.iter().map(|column| {
        let mut value = quote_identifier(&column.name)?;
        if let Some(length) = column.prefix_length { value.push_str(&format!("({length})")); }
        if matches!(column.direction.as_deref(), Some("ASC") | Some("DESC")) { value.push_str(&format!(" {}", column.direction.as_deref().unwrap())); }
        Ok(value)
    }).collect::<Result<Vec<_>, String>>()?.join(", ");
    match def.kind.as_str() {
        "PRIMARY" => Ok(format!("PRIMARY KEY ({columns})")),
        "UNIQUE" => Ok(format!("UNIQUE KEY {} ({columns})", quote_identifier(&def.name)?)),
        "INDEX" => Ok(format!("KEY {} ({columns})", quote_identifier(&def.name)?)),
        _ => Err("不支持的索引类型".to_string()),
    }
}

fn create_table_sql(def: &MysqlTableDefinition) -> Result<String, String> {
    if def.columns.is_empty() { return Err("表至少需要一个字段".to_string()); }
    let mut parts = def.columns.iter().map(build_column).collect::<Result<Vec<_>, _>>()?;
    parts.extend(def.indexes.iter().map(build_index).collect::<Result<Vec<_>, _>>()?);
    let mut sql = format!("CREATE TABLE {}.{} (\n  {}\n)", quote_identifier(&def.database)?, quote_identifier(&def.name)?, parts.join(",\n  "));
    sql.push_str(&format!(" ENGINE={}", quote_identifier(def.engine.as_deref().unwrap_or("InnoDB"))?));
    if let Some(charset) = def.charset.as_deref().filter(|v| !v.is_empty()) { sql.push_str(&format!(" DEFAULT CHARSET={}", quote_identifier(charset)?)); }
    if let Some(collation) = def.collation.as_deref().filter(|v| !v.is_empty()) { sql.push_str(&format!(" COLLATE={}", quote_identifier(collation)?)); }
    if !def.comment.is_empty() { sql.push_str(&format!(" COMMENT={}", sql_string(&def.comment))); }
    Ok(sql)
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlDdlResult { pub statements: Vec<String>, pub completed: usize, pub error: Option<String> }

async fn alter_table_plan(pool: &Pool, def: &MysqlTableDefinition) -> Result<Vec<String>, String> {
    let original = def.original_name.as_deref().ok_or("缺少原始表名")?;
    let db = quote_identifier(&def.database)?;
    let old = quote_identifier(original)?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let current_columns: Vec<String> = conn.exec(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (&def.database, original)
    ).await.map_err(|e| e.to_string())?;
    let current_indexes: Vec<String> = conn.exec(
        "SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", (&def.database, original)
    ).await.map_err(|e| e.to_string())?;
    if current_columns.is_empty() { return Err("原表不存在或无权访问".to_string()); }
    let desired = def.columns.iter().map(|column| column.name.as_str()).collect::<HashSet<_>>();
    let mut statements = Vec::new();
    for index in current_indexes {
        statements.push(if index == "PRIMARY" { format!("ALTER TABLE {db}.{old} DROP PRIMARY KEY") } else { format!("ALTER TABLE {db}.{old} DROP INDEX {}", quote_identifier(&index)?) });
    }
    for column in current_columns.iter().filter(|column| !desired.contains(column.as_str())) {
        statements.push(format!("ALTER TABLE {db}.{old} DROP COLUMN {}", quote_identifier(column)?));
    }
    let current = current_columns.into_iter().collect::<HashSet<_>>();
    for column in &def.columns {
        let verb = if current.contains(&column.name) { "MODIFY COLUMN" } else { "ADD COLUMN" };
        statements.push(format!("ALTER TABLE {db}.{old} {verb} {}", build_column(column)?));
    }
    for index in &def.indexes { statements.push(format!("ALTER TABLE {db}.{old} ADD {}", build_index(index)?)); }
    let mut options = format!("ALTER TABLE {db}.{old} ENGINE={}", quote_identifier(def.engine.as_deref().unwrap_or("InnoDB"))?);
    if let Some(charset) = def.charset.as_deref().filter(|v| !v.is_empty()) { options.push_str(&format!(" DEFAULT CHARACTER SET {}", quote_identifier(charset)?)); }
    if let Some(collation) = def.collation.as_deref().filter(|v| !v.is_empty()) { options.push_str(&format!(" COLLATE {}", quote_identifier(collation)?)); }
    options.push_str(&format!(" COMMENT={}", sql_string(&def.comment))); statements.push(options);
    if original != def.name { statements.push(format!("RENAME TABLE {db}.{old} TO {db}.{}", quote_identifier(&def.name)?)); }
    Ok(statements)
}

#[tauri::command]
pub async fn mysql_preview_table(state: tauri::State<'_, AppState>, connection_id: String, definition: MysqlTableDefinition) -> Result<Vec<String>, String> {
    if definition.original_name.is_some() {
        let pool = pool_for(&state, &connection_id).await?; alter_table_plan(&pool, &definition).await
    } else { Ok(vec![create_table_sql(&definition)?]) }
}

#[tauri::command]
pub async fn mysql_create_table(state: tauri::State<'_, AppState>, connection_id: String, definition: MysqlTableDefinition) -> Result<MysqlDdlResult, String> {
    if definition.original_name.is_some() { return Err("现有表请使用 SQL 工作台执行预览后的 ALTER TABLE".to_string()); }
    let sql = create_table_sql(&definition)?;
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(&sql).await.map_err(|e| e.to_string())?;
    Ok(MysqlDdlResult { statements: vec![sql], completed: 1, error: None })
}

#[tauri::command]
pub async fn mysql_apply_table(state: tauri::State<'_, AppState>, connection_id: String, definition: MysqlTableDefinition) -> Result<MysqlDdlResult, String> {
    if definition.original_name.is_none() { return mysql_create_table(state, connection_id, definition).await; }
    let pool = pool_for(&state, &connection_id).await?; let statements = alter_table_plan(&pool, &definition).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?; let mut completed = 0;
    for statement in &statements {
        if let Err(error) = conn.query_drop(statement).await { return Ok(MysqlDdlResult { statements, completed, error: Some(error.to_string()) }); }
        completed += 1;
    }
    Ok(MysqlDdlResult { statements, completed, error: None })
}

#[tauri::command]
pub async fn mysql_create_database(state: tauri::State<'_, AppState>, connection_id: String, name: String, charset: Option<String>, collation: Option<String>) -> Result<(), String> {
    let mut sql = format!("CREATE DATABASE {}", quote_identifier(&name)?);
    if let Some(value) = charset.filter(|v| !v.is_empty()) { sql.push_str(&format!(" CHARACTER SET {}", quote_identifier(&value)?)); }
    if let Some(value) = collation.filter(|v| !v.is_empty()) { sql.push_str(&format!(" COLLATE {}", quote_identifier(&value)?)); }
    let pool = pool_for(&state, &connection_id).await?; let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(sql).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_drop_database(state: tauri::State<'_, AppState>, connection_id: String, database: String) -> Result<(), String> {
    let pool = pool_for(&state, &connection_id).await?; let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("DROP DATABASE {}", quote_identifier(&database)?)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_table_action(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String, action: String, target: Option<String>) -> Result<(), String> {
    let full = format!("{}.{}", quote_identifier(&database)?, quote_identifier(&table)?);
    let sql = match action.as_str() {
        "truncate" => format!("TRUNCATE TABLE {full}"),
        "drop" => format!("DROP TABLE {full}"),
        "rename" => format!("RENAME TABLE {full} TO {}.{}", quote_identifier(&database)?, quote_identifier(target.as_deref().ok_or("缺少目标表名")?)?),
        "clone" => format!("CREATE TABLE {}.{} LIKE {full}", quote_identifier(&database)?, quote_identifier(target.as_deref().ok_or("缺少目标表名")?)?),
        _ => return Err("不支持的表操作".to_string()),
    };
    let pool = pool_for(&state, &connection_id).await?; let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(sql).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mysql_show_create(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String) -> Result<String, String> {
    let pool = pool_for(&state, &connection_id).await?; let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let row: Option<(String,String)> = conn.query_first(format!("SHOW CREATE TABLE {}.{}", quote_identifier(&database)?, quote_identifier(&table)?)).await.map_err(|e| e.to_string())?;
    row.map(|value| value.1).ok_or_else(|| "未返回建表语句".to_string())
}

fn json_to_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::NULL,
        serde_json::Value::Bool(v) => Value::Int(if *v { 1 } else { 0 }),
        serde_json::Value::Number(v) if v.is_i64() => Value::Int(v.as_i64().unwrap()),
        serde_json::Value::Number(v) if v.is_u64() => Value::UInt(v.as_u64().unwrap()),
        serde_json::Value::Number(v) => Value::Double(v.as_f64().unwrap_or_default()),
        serde_json::Value::String(v) => Value::Bytes(v.as_bytes().to_vec()),
        other => Value::Bytes(other.to_string().into_bytes()),
    }
}

fn value_to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::NULL => serde_json::Value::Null,
        Value::Bytes(v) => match String::from_utf8(v.clone()) {
            Ok(text) => serde_json::Value::String(text),
            Err(_) => serde_json::json!({ "$binary": base64::engine::general_purpose::STANDARD.encode(v) }),
        },
        Value::Int(v) => serde_json::json!(v), Value::UInt(v) => serde_json::json!(v),
        Value::Float(v) => serde_json::json!(v), Value::Double(v) => serde_json::json!(v),
        Value::Date(y,m,d,h,min,s,micros) => serde_json::Value::String(format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}:{s:02}.{:06}", micros)),
        Value::Time(negative,days,h,min,s,micros) => serde_json::Value::String(format!("{}{} {:02}:{:02}:{:02}.{:06}", if *negative {"-"} else {""}, days, h, min, s, micros)),
    }
}

#[tauri::command]
pub async fn mysql_fetch_rows(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String, page: u64, page_size: u64) -> Result<QueryResult, String> {
    let size = page_size.clamp(1, 1000); let offset = page.saturating_sub(1) * size;
    let sql = format!("SELECT * FROM {}.{} LIMIT {size} OFFSET {offset}", quote_identifier(&database)?, quote_identifier(&table)?);
    mysql_execute_sql(state, connection_id, sql, None).await
}

#[tauri::command]
pub async fn mysql_execute_sql(state: tauri::State<'_, AppState>, connection_id: String, sql: String, database: Option<String>) -> Result<QueryResult, String> {
    let sql = single_statement(&sql)?.to_string();
    let pool = pool_for(&state, &connection_id).await?; let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    if let Some(database) = database.as_deref().filter(|value| !value.is_empty()) {
        conn.query_drop(format!("USE {}", quote_identifier(database)?)).await.map_err(|e| e.to_string())?;
    }
    let start = std::time::Instant::now();
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let affected_rows = result.affected_rows(); let last_insert_id = result.last_insert_id();
    let columns = result.columns().unwrap_or_default().iter().map(|c| c.name_str().to_string()).collect::<Vec<_>>();
    let rows: Vec<Row> = result.collect().await.map_err(|e| e.to_string())?;
    Ok(QueryResult { columns, rows: rows.iter().map(|row| QueryResultRow { values: (0..row.len()).map(|i| row.as_ref(i).map(value_to_json).unwrap_or_default()).collect() }).collect(), affected_rows, execution_time_ms: start.elapsed().as_millis() as u64, last_insert_id })
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlRowMutation { pub values: HashMap<String, serde_json::Value>, #[serde(default)] pub original: HashMap<String, serde_json::Value> }

async fn table_columns_and_keys(pool: &Pool, database: &str, table: &str) -> Result<(HashSet<String>, Vec<String>), String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows: Vec<(String,String)> = conn.exec("SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", (database,table)).await.map_err(|e| e.to_string())?;
    if rows.is_empty() { return Err("表不存在或无权访问".to_string()); }
    Ok((rows.iter().map(|r| r.0.clone()).collect(), rows.into_iter().filter(|r| r.1=="PRI").map(|r| r.0).collect()))
}

#[tauri::command]
pub async fn mysql_mutate_row(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String, action: String, mutation: MysqlRowMutation) -> Result<u64, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let (allowed, primary) = table_columns_and_keys(&pool, &database, &table).await?;
    if mutation.values.keys().chain(mutation.original.keys()).any(|key| !allowed.contains(key)) { return Err("请求包含未知字段".to_string()); }
    let full = format!("{}.{}", quote_identifier(&database)?, quote_identifier(&table)?);
    let mut params = Vec::new();
    let sql = if action == "insert" {
        let columns = mutation.values.keys().cloned().collect::<Vec<_>>();
        if columns.is_empty() { return Err("没有可插入的数据".to_string()); }
        params.extend(columns.iter().map(|key| json_to_value(&mutation.values[key])));
        format!("INSERT INTO {full} ({}) VALUES ({})", columns.iter().map(|v| quote_identifier(v)).collect::<Result<Vec<_>,_>>()?.join(","), vec!["?";columns.len()].join(","))
    } else {
        if mutation.original.is_empty() { return Err("缺少原始行数据".to_string()); }
        let where_keys = if primary.is_empty() { mutation.original.keys().cloned().collect::<Vec<_>>() } else { primary };
        let where_sql = where_keys.iter().map(|key| quote_identifier(key).map(|q| format!("{q} <=> ?"))).collect::<Result<Vec<_>,_>>()?.join(" AND ");
        if action == "delete" {
            params.extend(where_keys.iter().map(|key| json_to_value(mutation.original.get(key).unwrap_or(&serde_json::Value::Null))));
            format!("DELETE FROM {full} WHERE {where_sql} LIMIT 1")
        } else if action == "update" {
            let columns = mutation.values.keys().cloned().collect::<Vec<_>>();
            if columns.is_empty() { return Err("没有需要更新的数据".to_string()); }
            params.extend(columns.iter().map(|key| json_to_value(&mutation.values[key])));
            params.extend(where_keys.iter().map(|key| json_to_value(mutation.original.get(key).unwrap_or(&serde_json::Value::Null))));
            format!("UPDATE {full} SET {} WHERE {where_sql} LIMIT 1", columns.iter().map(|key| quote_identifier(key).map(|q| format!("{q}=?"))).collect::<Result<Vec<_>,_>>()?.join(","))
        } else { return Err("不支持的行操作".to_string()); }
    };
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.exec_drop(sql, Params::Positional(params)).await.map_err(|e| e.to_string())?;
    let affected = conn.affected_rows();
    if action != "insert" && affected == 0 { return Err("数据已被其他操作修改，请刷新后重试".to_string()); }
    Ok(affected)
}

fn parse_csv(input: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new(); let mut row = Vec::new(); let mut field = String::new(); let mut quoted = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => { field.push('"'); chars.next(); }
            '"' => quoted = !quoted,
            ',' if !quoted => { row.push(std::mem::take(&mut field)); }
            '\n' if !quoted => { if field.ends_with('\r') { field.pop(); } row.push(std::mem::take(&mut field)); if row.iter().any(|v| !v.is_empty()) { rows.push(std::mem::take(&mut row)); } else { row.clear(); } }
            _ => field.push(ch),
        }
    }
    if quoted { return Err("CSV 引号未闭合".to_string()); }
    if !field.is_empty() || !row.is_empty() { row.push(field); rows.push(row); }
    Ok(rows)
}

#[tauri::command]
pub async fn mysql_import_csv(state: tauri::State<'_, AppState>, connection_id: String, database: String, table: String, csv: String) -> Result<u64, String> {
    let rows = parse_csv(&csv)?; if rows.len() < 2 { return Err("CSV 至少需要表头和一行数据".to_string()); }
    let headers = rows[0].iter().map(|v| v.trim().to_string()).collect::<Vec<_>>();
    if headers.iter().any(|v| v.is_empty()) { return Err("CSV 表头不能为空".to_string()); }
    let pool = pool_for(&state, &connection_id).await?; let (allowed, _) = table_columns_and_keys(&pool, &database, &table).await?;
    if headers.iter().any(|key| !allowed.contains(key)) { return Err("CSV 包含目标表中不存在的字段".to_string()); }
    let sql = format!("INSERT INTO {}.{} ({}) VALUES ({})", quote_identifier(&database)?, quote_identifier(&table)?, headers.iter().map(|v| quote_identifier(v)).collect::<Result<Vec<_>,_>>()?.join(","), vec!["?";headers.len()].join(","));
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut tx = conn.start_transaction(mysql_async::TxOpts::default()).await.map_err(|e| e.to_string())?;
    for (index, row) in rows.iter().skip(1).enumerate() {
        if row.len() != headers.len() { return Err(format!("CSV 第 {} 行字段数不一致", index + 2)); }
        let params = row.iter().map(|value| if value == "\\N" { Value::NULL } else { Value::Bytes(value.as_bytes().to_vec()) }).collect();
        tx.exec_drop(&sql, Params::Positional(params)).await.map_err(|e| format!("CSV 第 {} 行导入失败: {e}", index + 2))?;
    }
    tx.commit().await.map_err(|e| e.to_string())?; Ok((rows.len() - 1) as u64)
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlSqlImportOptions {
    pub path: String,
    pub database: Option<String>,
    #[serde(default)]
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlSqlFailure { pub statement: usize, pub summary: String }

#[derive(Debug, Clone, Serialize)]
pub struct MysqlSqlImportResult {
    pub total: usize,
    pub completed: usize,
    pub failures: Vec<MysqlSqlFailure>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MysqlSqlExportOptions { pub path: String, pub database: String }

#[derive(Debug, Clone, Serialize)]
pub struct MysqlSqlExportResult { pub tables: usize, pub rows: u64, pub bytes: u64 }

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
            if ch == '\n' { line_comment = false; line_start = true; }
            continue;
        }
        if block_comment {
            current.push(ch);
            if ch == '*' && chars.peek() == Some(&'/') { current.push('/'); chars.next(); block_comment = false; }
            line_start = ch == '\n';
            continue;
        }
        if let Some(q) = quote {
            current.push(ch);
            if escaped { escaped = false; continue; }
            if ch == '\\' { escaped = true; continue; }
            if ch == q {
                if chars.peek() == Some(&q) { current.push(q); chars.next(); } else { quote = None; }
            }
            line_start = ch == '\n';
            continue;
        }
        if line_start && current.trim().is_empty() {
            let mut probe = String::new();
            if !ch.is_whitespace() { probe.push(ch); }
            while probe.len() < 9 {
                match chars.peek().copied() { Some(c) if c != '\n' && c != '\r' => { probe.push(c); chars.next(); }, _ => break }
            }
            if probe.to_ascii_uppercase().starts_with("DELIMITER") {
                let mut rest = probe[9.min(probe.len())..].to_string();
                while let Some(c) = chars.next() { if c == '\n' { break; } if c != '\r' { rest.push(c); } }
                let next = rest.trim();
                if next.is_empty() { return Err("DELIMITER 指令缺少分隔符".to_string()); }
                delimiter = next.to_string(); current.clear(); line_start = true; continue;
            }
            current.push_str(&probe);
            line_start = false;
            continue;
        }
        if ch == '-' && chars.peek() == Some(&'-') { current.push(ch); current.push('-'); chars.next(); line_comment = true; continue; }
        if ch == '#' { current.push(ch); line_comment = true; continue; }
        if ch == '/' && chars.peek() == Some(&'*') { current.push(ch); current.push('*'); chars.next(); block_comment = true; continue; }
        if matches!(ch, '\'' | '"' | '`') { quote = Some(ch); current.push(ch); continue; }
        current.push(ch);
        if current.ends_with(&delimiter) {
            let new_len = current.len() - delimiter.len(); current.truncate(new_len);
            if !current.trim().is_empty() { statements.push(current.trim().to_string()); }
            current.clear(); line_start = true;
        } else { line_start = ch == '\n'; }
    }
    if quote.is_some() || block_comment { return Err("SQL 文件包含未闭合的引号或注释".to_string()); }
    if !current.trim().is_empty() { statements.push(current.trim().to_string()); }
    Ok(statements)
}

#[tauri::command]
pub async fn mysql_import_sql(state: tauri::State<'_, AppState>, connection_id: String, options: MysqlSqlImportOptions) -> Result<MysqlSqlImportResult, String> {
    let content = std::fs::read_to_string(&options.path).map_err(|e| format!("读取 SQL 文件失败: {e}"))?;
    let statements = split_sql_script(&content)?;
    if statements.is_empty() { return Err("SQL 文件中没有可执行语句".to_string()); }
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    if let Some(database) = options.database.as_deref().filter(|v| !v.is_empty()) {
        conn.query_drop(format!("USE {}", quote_identifier(database)?)).await.map_err(|e| e.to_string())?;
    }
    let mut completed = 0; let mut failures = Vec::new();
    for (index, statement) in statements.iter().enumerate() {
        match conn.query_drop(statement).await {
            Ok(_) => completed += 1,
            Err(error) => {
                failures.push(MysqlSqlFailure { statement: index + 1, summary: error.to_string() });
                if !options.continue_on_error { break; }
            }
        }
    }
    Ok(MysqlSqlImportResult { total: statements.len(), completed, failures })
}

fn sql_literal(value: &Value) -> String {
    match value {
        Value::NULL => "NULL".to_string(),
        Value::Bytes(bytes) => format!("X'{}'", bytes.iter().map(|b| format!("{b:02X}")).collect::<String>()),
        Value::Int(v) => v.to_string(), Value::UInt(v) => v.to_string(),
        Value::Float(v) => v.to_string(), Value::Double(v) => v.to_string(),
        Value::Date(y,m,d,h,min,s,micros) => format!("'{y:04}-{m:02}-{d:02} {h:02}:{min:02}:{s:02}.{:06}'", micros),
        Value::Time(negative,days,h,min,s,micros) => format!("'{}{} {:02}:{:02}:{:02}.{:06}'", if *negative {"-"} else {""}, days, h, min, s, micros),
    }
}

#[tauri::command]
pub async fn mysql_export_sql(state: tauri::State<'_, AppState>, connection_id: String, options: MysqlSqlExportOptions) -> Result<MysqlSqlExportResult, String> {
    let pool = pool_for(&state, &connection_id).await?;
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let schema: Option<(String, String)> = conn.exec_first("SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", (&options.database,)).await.map_err(|e| e.to_string())?;
    let (charset, collation) = schema.ok_or_else(|| "数据库不存在或无权访问".to_string())?;
    let table_names: Vec<String> = conn.exec("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", (&options.database,)).await.map_err(|e| e.to_string())?;
    let file = File::create(&options.path).map_err(|e| format!("创建 SQL 文件失败: {e}"))?;
    let mut writer = BufWriter::new(file);
    writeln!(writer, "-- PortNest MySQL export\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nCREATE DATABASE IF NOT EXISTS {} CHARACTER SET {} COLLATE {};\nUSE {};\n", quote_identifier(&options.database)?, quote_identifier(&charset)?, quote_identifier(&collation)?, quote_identifier(&options.database)?).map_err(|e| e.to_string())?;
    let mut exported_rows = 0u64;
    for table in &table_names {
        let create: Option<(String,String)> = conn.query_first(format!("SHOW CREATE TABLE {}.{}", quote_identifier(&options.database)?, quote_identifier(table)?)).await.map_err(|e| e.to_string())?;
        let create = create.ok_or_else(|| format!("无法读取表 {table} 的结构"))?.1;
        writeln!(writer, "DROP TABLE IF EXISTS {};\n{};\n", quote_identifier(table)?, create).map_err(|e| e.to_string())?;
        let mut offset = 0u64;
        loop {
            let rows: Vec<Row> = conn.query(format!("SELECT * FROM {}.{} LIMIT 500 OFFSET {offset}", quote_identifier(&options.database)?, quote_identifier(table)?)).await.map_err(|e| e.to_string())?;
            if rows.is_empty() { break; }
            for row in &rows {
                let values = (0..row.len()).map(|i| row.as_ref(i).map(sql_literal).unwrap_or_else(|| "NULL".to_string())).collect::<Vec<_>>().join(",");
                writeln!(writer, "INSERT INTO {} VALUES ({});", quote_identifier(table)?, values).map_err(|e| e.to_string())?;
            }
            exported_rows += rows.len() as u64; offset += rows.len() as u64;
            if rows.len() < 500 { break; }
        }
        writeln!(writer).map_err(|e| e.to_string())?;
    }
    writeln!(writer, "SET FOREIGN_KEY_CHECKS=1;").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    let bytes = std::fs::metadata(&options.path).map_err(|e| e.to_string())?.len();
    Ok(MysqlSqlExportResult { tables: table_names.len(), rows: exported_rows, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn identifiers_are_quoted() { assert_eq!(quote_identifier("a`b").unwrap(), "`a``b`"); }
    #[test] fn rejects_multiple_statements() { assert!(single_statement("SELECT 1; SELECT 2").is_err()); assert!(single_statement("SELECT 1;").is_ok()); }
    #[test] fn validates_types() { assert!(validated_column_type("varchar(255)").is_ok()); assert!(validated_column_type("varchar(1); drop table x").is_err()); }
    #[test] fn parses_quoted_csv() { let rows=parse_csv("a,b\n\"x,y\",\"q\"\"z\"").unwrap(); assert_eq!(rows[1], vec!["x,y", "q\"z"]); }
    #[test] fn splits_sql_with_strings_and_comments() {
        let sql = "-- comment\nINSERT INTO t VALUES ('a;b');\n/* x;y */ SELECT 2;";
        let statements = split_sql_script(sql).unwrap();
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("'a;b'"));
    }
    #[test] fn splits_sql_with_custom_delimiter() {
        let sql = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;";
        let statements = split_sql_script(sql).unwrap();
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("SELECT 2;"));
    }
}
