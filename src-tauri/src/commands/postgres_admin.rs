//! PostgreSQL 数据库管理工作区后端。
//!
//! 该模块只负责 PostgreSQL 的具体 SQL；Tauri 的 `database_*` 命令会按连接
//! 协议分派到这里或 MySQL 实现，因此前端数据库工作区可以完全复用。

use super::mysql_admin::{
    MysqlCharsetInfo, MysqlColumnDefinition, MysqlColumnInfo, MysqlDatabaseInfo, MysqlDdlResult,
    MysqlExplainResult, MysqlIndexInfo, MysqlRowMutation, MysqlSqlExportOptions,
    MysqlSqlExportResult, MysqlSqlFailure, MysqlSqlImportOptions, MysqlSqlImportResult,
    MysqlTableChangeSet, MysqlTableDefinition, MysqlTableInfo,
};
use super::{AppState, QueryColumn, QueryResult, QueryResultRow};
use crate::protocol::pgsql::{PgClient, PgQueryResult};
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PG_DEFAULT_TIMEOUT_MS: u64 = 30_000;
const PG_MAX_RESULT_ROWS: usize = 5_000;

pub struct PostgresManager {
    clients: RwLock<HashMap<String, Arc<tokio::sync::Mutex<PgClient>>>>,
    build_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    cancel_tokens: RwLock<HashMap<String, crate::protocol::pgsql::PgCancelToken>>,
}

impl PostgresManager {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
            build_locks: Mutex::new(HashMap::new()),
            cancel_tokens: RwLock::new(HashMap::new()),
        }
    }

    fn client(&self, key: &str) -> Option<Arc<tokio::sync::Mutex<PgClient>>> {
        self.clients.read().get(key).cloned()
    }

    fn insert_client(&self, key: String, client: PgClient) {
        self.clients
            .write()
            .insert(key, Arc::new(tokio::sync::Mutex::new(client)));
    }

    fn remove_connection(&self, connection_id: &str) {
        let prefix = format!("{connection_id}\u{1f}");
        self.clients
            .write()
            .retain(|key, _| !key.starts_with(&prefix));
        self.cancel_tokens.write().remove(connection_id);
    }

    fn build_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.build_locks
            .lock()
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn set_cancel_token(&self, connection_id: &str, token: crate::protocol::pgsql::PgCancelToken) {
        self.cancel_tokens
            .write()
            .insert(connection_id.to_string(), token);
    }

    fn cancel_token(&self, connection_id: &str) -> Option<crate::protocol::pgsql::PgCancelToken> {
        self.cancel_tokens.read().get(connection_id).cloned()
    }
}

impl Default for PostgresManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
struct PgConnectionConfig {
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
    ssl_mode: String,
    timeout_ms: u64,
}

fn load_connection_config(
    state: &AppState,
    connection_id: &str,
    database_override: Option<&str>,
) -> Result<PgConnectionConfig, String> {
    let connection = state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|item| item.id == connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    if !matches!(connection.protocol.as_str(), "postgresql" | "highgo") {
        return Err("该连接不是 PostgreSQL / 瀚高数据库连接".to_string());
    }
    let credential = state
        .db
        .get_credential_structured(&connection.credential_id)
        .map_err(|e| e.to_string())?;
    let options = match connection.options.as_deref() {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str::<Value>(raw)
            .map_err(|e| format!("PostgreSQL 连接选项无效: {e}"))?,
        _ => serde_json::json!({}),
    };
    let configured_database = options
        .get("database")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let username = connection.username.clone().unwrap_or_default();
    let database = database_override
        .filter(|value| !value.trim().is_empty())
        .or(configured_database)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if username.trim().is_empty() {
                "postgres".to_string()
            } else {
                username.clone()
            }
        });
    let timeout_ms = options
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(PG_DEFAULT_TIMEOUT_MS)
        .clamp(1_000, 300_000);
    let ssl_mode = options
        .get("ssl_mode")
        .and_then(Value::as_str)
        .unwrap_or("prefer")
        .to_string();
    Ok(PgConnectionConfig {
        host: connection.host,
        port: connection.port,
        username,
        password: credential.password.unwrap_or_default(),
        database,
        ssl_mode,
        timeout_ms,
    })
}

async fn client_for(
    state: &AppState,
    connection_id: &str,
    database_override: Option<&str>,
) -> Result<Arc<tokio::sync::Mutex<PgClient>>, String> {
    let config = load_connection_config(state, connection_id, database_override)?;
    let key = format!("{connection_id}\u{1f}{}", config.database);
    if let Some(client) = state.postgres_manager.client(&key) {
        return Ok(client);
    }

    let build_lock = state.postgres_manager.build_lock(&key);
    let _guard = build_lock.lock().await;
    if let Some(client) = state.postgres_manager.client(&key) {
        return Ok(client);
    }
    let client = PgClient::connect(
        &config.host,
        config.port,
        &config.username,
        &config.password,
        &config.database,
        &config.ssl_mode,
        Duration::from_millis(config.timeout_ms),
    )
    .await
    .map_err(|e| format!("数据库连接失败: {e}"))?;
    let token = client.cancel_token();
    state.postgres_manager.insert_client(key.clone(), client);
    state
        .postgres_manager
        .set_cancel_token(connection_id, token);
    state
        .postgres_manager
        .client(&key)
        .ok_or_else(|| "数据库客户端初始化失败".to_string())
}

async fn query_raw(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    sql: &str,
) -> Result<PgQueryResult, String> {
    let client = client_for(state, connection_id, database).await?;
    let mut client = client.lock().await;
    client.query(sql).await.map_err(|e| e.to_string())
}

fn to_query_result(result: PgQueryResult, elapsed_ms: u64, truncated: bool) -> QueryResult {
    QueryResult {
        columns: result.column_names(),
        column_metadata: result
            .fields
            .iter()
            .map(|field| QueryColumn {
                name: field.name.clone(),
                type_name: field.type_name.clone(),
                charset: 0,
                flags: 0,
            })
            .collect(),
        rows: result
            .rows
            .into_iter()
            .map(|values| QueryResultRow { values })
            .collect(),
        affected_rows: result.affected_rows,
        execution_time_ms: elapsed_ms,
        last_insert_id: None,
        truncated,
    }
}

fn quote_identifier(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("数据库对象名称不能为空或包含 NUL 字符".to_string());
    }
    Ok(format!("\"{}\"", trimmed.replace('"', "\"\"")))
}

fn quote_qualified(value: &str) -> Result<String, String> {
    let parts: Vec<&str> = value
        .split('.')
        .filter(|part| !part.trim().is_empty())
        .collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err(format!("无效的 PostgreSQL 对象名称: {value}"));
    }
    parts
        .into_iter()
        .map(quote_identifier)
        .collect::<Result<Vec<_>, _>>()
        .map(|items| items.join("."))
}

fn split_relation(value: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = value
        .split('.')
        .filter(|part| !part.trim().is_empty())
        .collect();
    match parts.as_slice() {
        [table] => Ok(("public".to_string(), (*table).to_string())),
        [schema, table] => Ok(((*schema).to_string(), (*table).to_string())),
        _ => Err(format!("无效的表名: {value}")),
    }
}

fn display_table_name(schema: &str, table: &str) -> String {
    if schema == "public" {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

fn sql_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => format!("'{}'", value.replace('\'', "''")),
        Value::Array(_) | Value::Object(_) => format!(
            "'{}'",
            serde_json::to_string(value)
                .unwrap_or_else(|_| "null".to_string())
                .replace('\'', "''")
        ),
    }
}

async fn execute_statements(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    statements: &[String],
) -> Result<MysqlDdlResult, String> {
    let client = client_for(state, connection_id, database).await?;
    let mut client = client.lock().await;
    let mut completed = 0usize;
    for statement in statements {
        if let Err(error) = client.query(statement).await {
            return Ok(MysqlDdlResult {
                statements: statements.to_vec(),
                completed,
                error: Some(error.to_string()),
            });
        }
        completed += 1;
    }
    Ok(MysqlDdlResult {
        statements: statements.to_vec(),
        completed,
        error: None,
    })
}

fn pg_column_type(definition: &MysqlColumnDefinition) -> String {
    let raw = definition.column_type.trim();
    let upper = raw.to_ascii_uppercase();
    if definition.auto_increment {
        if upper.starts_with("BIGINT") {
            return "BIGSERIAL".to_string();
        }
        if upper.starts_with("SMALLINT") {
            return "SMALLSERIAL".to_string();
        }
        return "SERIAL".to_string();
    }
    if upper.starts_with("TINYINT") {
        return "SMALLINT".to_string();
    }
    if upper.starts_with("MEDIUMINT") {
        return "INTEGER".to_string();
    }
    if upper.starts_with("DATETIME") {
        return "TIMESTAMP".to_string();
    }
    if upper.starts_with("DOUBLE") {
        return "DOUBLE PRECISION".to_string();
    }
    if upper.starts_with("BLOB") || upper.starts_with("LONGBLOB") {
        return "BYTEA".to_string();
    }
    if upper == "JSON" {
        return "JSONB".to_string();
    }
    if upper.starts_with("ENUM(") || upper.starts_with("SET(") {
        return "TEXT".to_string();
    }
    raw.to_string()
}

fn column_definition_sql(column: &MysqlColumnDefinition) -> Result<String, String> {
    let mut sql = format!(
        "{} {}",
        quote_identifier(&column.name)?,
        pg_column_type(column)
    );
    if !column.nullable {
        sql.push_str(" NOT NULL");
    }
    if let Some(default) = column
        .default_value
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        if !column.auto_increment {
            sql.push_str(" DEFAULT ");
            sql.push_str(default);
        }
    }
    Ok(sql)
}

fn create_table_statements(definition: &MysqlTableDefinition) -> Result<Vec<String>, String> {
    let schema = if definition.database.trim().is_empty() {
        "public".to_string()
    } else {
        definition.database.trim().to_string()
    };
    let table = format!(
        "{}.{}",
        quote_identifier(&schema)?,
        quote_identifier(&definition.name)?
    );
    let mut columns = Vec::new();
    for column in &definition.columns {
        columns.push(column_definition_sql(column)?);
    }
    for index in &definition.indexes {
        if index.columns.is_empty() {
            continue;
        }
        let indexed_columns = index
            .columns
            .iter()
            .map(|column| quote_identifier(&column.name))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        match index.kind.as_str() {
            "PRIMARY" => columns.push(format!("PRIMARY KEY ({indexed_columns})")),
            "UNIQUE" => columns.push(format!(
                "CONSTRAINT {} UNIQUE ({indexed_columns})",
                quote_identifier(&index.name)?
            )),
            _ => {}
        }
    }
    let mut statements = vec![format!(
        "CREATE TABLE {table} (\n  {}\n)",
        columns.join(",\n  ")
    )];
    for index in &definition.indexes {
        if index.kind == "INDEX" && !index.columns.is_empty() {
            let indexed_columns = index
                .columns
                .iter()
                .map(|column| quote_identifier(&column.name))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            statements.push(format!(
                "CREATE INDEX {} ON {table} ({indexed_columns})",
                quote_identifier(&index.name)?
            ));
        }
    }
    if !definition.comment.trim().is_empty() {
        statements.push(format!(
            "COMMENT ON TABLE {table} IS '{}'",
            definition.comment.replace('\'', "''")
        ));
    }
    for column in &definition.columns {
        if !column.comment.trim().is_empty() {
            statements.push(format!(
                "COMMENT ON COLUMN {table}.{} IS '{}'",
                quote_identifier(&column.name)?,
                column.comment.replace('\'', "''")
            ));
        }
    }
    Ok(statements)
}

struct ExistingColumn {
    name: String,
    data_type: String,
    nullable: bool,
    default_value: Option<String>,
}

async fn existing_columns(
    client: &mut PgClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ExistingColumn>, String> {
    let sql = format!(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid) \
         FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
         LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum \
         WHERE n.nspname={} AND c.relname={} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
        sql_literal(&Value::String(schema.to_string())),
        sql_literal(&Value::String(table.to_string()))
    );
    let result = client.query(&sql).await.map_err(|e| e.to_string())?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| ExistingColumn {
            name: row
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            data_type: row
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            nullable: row.get(2).and_then(Value::as_bool).unwrap_or(true),
            default_value: row.get(3).and_then(Value::as_str).map(str::to_string),
        })
        .collect())
}

fn alter_table_statements(
    definition: &MysqlTableDefinition,
    existing: &[ExistingColumn],
) -> Result<Vec<String>, String> {
    let schema = if definition.database.trim().is_empty() {
        "public".to_string()
    } else {
        definition.database.trim().to_string()
    };
    let table = quote_identifier(&definition.name)?;
    let qualified = format!("{}.{}", quote_identifier(&schema)?, table);
    let old_name = definition
        .original_name
        .as_deref()
        .unwrap_or(&definition.name);
    let mut statements = Vec::new();
    if old_name != definition.name {
        statements.push(format!(
            "ALTER TABLE {}.{} RENAME TO {}",
            quote_identifier(&schema)?,
            quote_identifier(old_name)?,
            table
        ));
    }
    let by_name: HashMap<&str, &ExistingColumn> = existing
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let desired_names: HashSet<&str> = definition
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect();
    for column in existing {
        if !desired_names.contains(column.name.as_str()) {
            statements.push(format!(
                "ALTER TABLE {qualified} DROP COLUMN {}",
                quote_identifier(&column.name)?
            ));
        }
    }
    for column in &definition.columns {
        let definition_sql = column_definition_sql(column)?;
        if let Some(old) = by_name.get(column.name.as_str()) {
            if old.data_type != pg_column_type(column) {
                statements.push(format!(
                    "ALTER TABLE {qualified} ALTER COLUMN {} TYPE {}",
                    quote_identifier(&column.name)?,
                    pg_column_type(column)
                ));
            }
            if old.nullable != column.nullable {
                statements.push(format!(
                    "ALTER TABLE {qualified} ALTER COLUMN {} {} NOT NULL",
                    quote_identifier(&column.name)?,
                    if column.nullable { "DROP" } else { "SET" }
                ));
            }
            let desired_default = column
                .default_value
                .as_deref()
                .filter(|value| !value.trim().is_empty());
            if old.default_value.as_deref() != desired_default {
                statements.push(match desired_default {
                    Some(default) => format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} SET DEFAULT {default}",
                        quote_identifier(&column.name)?
                    ),
                    None => format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} DROP DEFAULT",
                        quote_identifier(&column.name)?
                    ),
                });
            }
        } else {
            statements.push(format!(
                "ALTER TABLE {qualified} ADD COLUMN {definition_sql}"
            ));
        }
    }
    Ok(statements)
}

#[tauri::command]
pub async fn postgres_connect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let client = client_for(&state, &connection_id, None).await?;
    let mut client = client.lock().await;
    let _ = client.query("SELECT 1").await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn postgres_disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    state.postgres_manager.remove_connection(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn postgres_cancel_query(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let token = state
        .postgres_manager
        .cancel_token(&connection_id)
        .ok_or_else(|| "当前没有正在执行的查询".to_string())?;
    token.cancel().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn postgres_save_sql(path: String, sql: String) -> Result<(), String> {
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

#[tauri::command]
pub async fn postgres_list_databases(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<MysqlDatabaseInfo>, String> {
    let result = query_raw(
        &state,
        &connection_id,
        None,
        "SELECT datname, pg_encoding_to_char(encoding), datcollate \
         FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
    )
    .await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| MysqlDatabaseInfo {
            name: row
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            charset: row.get(1).and_then(Value::as_str).map(str::to_string),
            collation: row.get(2).and_then(Value::as_str).map(str::to_string),
        })
        .collect())
}

#[tauri::command]
pub async fn postgres_list_charsets(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<MysqlCharsetInfo>, String> {
    let result = query_raw(&state, &connection_id, None, "SHOW server_encoding").await?;
    let encoding = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::as_str)
        .unwrap_or("UTF8");
    Ok(vec![MysqlCharsetInfo {
        name: encoding.to_string(),
        description: "数据库服务器编码".to_string(),
        default_collation: String::new(),
        collations: Vec::new(),
    }])
}

async fn list_tables_impl(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<MysqlTableInfo>, String> {
    let engine_label = state
        .db
        .get_connections()
        .ok()
        .and_then(|connections| {
            connections
                .into_iter()
                .find(|connection| connection.id == connection_id)
        })
        .map(|connection| {
            if connection.protocol == "highgo" {
                "HighGo"
            } else {
                "PostgreSQL"
            }
        })
        .unwrap_or("PostgreSQL");
    let sql = "SELECT n.nspname, c.relname, \
        CASE WHEN c.relkind IN ('r','p') THEN 'BASE TABLE' ELSE 'VIEW' END, \
        COALESCE(obj_description(c.oid, 'pg_class'), ''), \
        CASE WHEN c.reltuples < 0 THEN 0 ELSE c.reltuples::bigint END, \
        pg_total_relation_size(c.oid)::bigint, pg_indexes_size(c.oid)::bigint \
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
        WHERE c.relkind IN ('r','p','v','m') \
          AND n.nspname NOT IN ('pg_catalog','information_schema') \
          AND n.nspname NOT LIKE 'pg_toast%' \
        ORDER BY n.nspname, c.relname";
    let result = query_raw(state, connection_id, Some(database), sql).await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| {
            let schema = row.first().and_then(Value::as_str).unwrap_or("public");
            let table = row.get(1).and_then(Value::as_str).unwrap_or_default();
            MysqlTableInfo {
                name: display_table_name(schema, table),
                kind: row
                    .get(2)
                    .and_then(Value::as_str)
                    .unwrap_or("BASE TABLE")
                    .to_string(),
                engine: Some(engine_label.to_string()),
                rows: row.get(4).and_then(Value::as_u64),
                comment: row
                    .get(3)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                data_length: row.get(5).and_then(Value::as_u64),
                index_length: row.get(6).and_then(Value::as_u64),
                auto_increment: None,
                collation: None,
                created_at: None,
                updated_at: None,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn postgres_list_tables(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<MysqlTableInfo>, String> {
    list_tables_impl(&state, &connection_id, &database).await
}

async fn list_columns_impl(
    state: &AppState,
    connection_id: &str,
    database: &str,
    table: &str,
) -> Result<Vec<MysqlColumnInfo>, String> {
    let (schema, table) = split_relation(table)?;
    let sql = format!(
        "SELECT a.attname, t.typname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                pg_get_expr(ad.adbin, ad.adrelid), \
                CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated' ELSE '' END, \
                COALESCE(col_description(a.attrelid, a.attnum), ''), \
                CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) THEN 'PRI' ELSE '' END, \
                a.attnum \
         FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
         JOIN pg_type t ON t.oid=a.atttypid \
         LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum \
         WHERE n.nspname={} AND c.relname={} AND a.attnum>0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
        sql_literal(&Value::String(schema)),
        sql_literal(&Value::String(table))
    );
    let result = query_raw(state, connection_id, Some(database), &sql).await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| MysqlColumnInfo {
            name: row
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            data_type: row
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            column_type: row
                .get(2)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            nullable: row.get(3).and_then(Value::as_bool).unwrap_or(true),
            default_value: row.get(4).and_then(Value::as_str).map(str::to_string),
            extra: row
                .get(5)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            comment: row
                .get(6)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            key: row
                .get(7)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            charset: None,
            collation: None,
            ordinal: row.get(8).and_then(Value::as_u64).unwrap_or(0) as u32,
            generation_expression: None,
        })
        .collect())
}

#[tauri::command]
pub async fn postgres_list_columns(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlColumnInfo>, String> {
    list_columns_impl(&state, &connection_id, &database, &table).await
}

async fn list_indexes_impl(
    state: &AppState,
    connection_id: &str,
    database: &str,
    table: &str,
) -> Result<Vec<MysqlIndexInfo>, String> {
    let (schema, table) = split_relation(table)?;
    let sql = format!(
        "SELECT i.relname, ix.indisunique, a.attname, k.ord, am.amname \
         FROM pg_index ix JOIN pg_class t ON t.oid=ix.indrelid \
         JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class i ON i.oid=ix.indexrelid \
         JOIN pg_am am ON am.oid=i.relam \
         JOIN LATERAL unnest(ix.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON TRUE \
         LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum \
         WHERE n.nspname={} AND t.relname={} ORDER BY i.relname, k.ord",
        sql_literal(&Value::String(schema)),
        sql_literal(&Value::String(table))
    );
    let result = query_raw(state, connection_id, Some(database), &sql).await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| MysqlIndexInfo {
            name: row
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            unique: row.get(1).and_then(Value::as_bool).unwrap_or(false),
            column: row.get(2).and_then(Value::as_str).map(str::to_string),
            sequence: row.get(3).and_then(Value::as_u64).unwrap_or(0) as u32,
            prefix_length: None,
            direction: Some("ASC".to_string()),
            index_type: row
                .get(4)
                .and_then(Value::as_str)
                .unwrap_or("btree")
                .to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn postgres_list_indexes(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlIndexInfo>, String> {
    list_indexes_impl(&state, &connection_id, &database, &table).await
}

#[tauri::command]
pub async fn postgres_autocomplete(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<super::mysql_admin::MysqlAutocompleteItem>, String> {
    if database.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sql = "SELECT c.relname, a.attname FROM pg_attribute a \
        JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
        WHERE c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped \
          AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' \
        ORDER BY c.relname, a.attnum";
    let result = query_raw(&state, &connection_id, Some(&database), sql).await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| super::mysql_admin::MysqlAutocompleteItem {
            table: row
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            column: row
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn postgres_explain_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<MysqlExplainResult, String> {
    let sql = sql.trim().trim_end_matches(';');
    if sql.is_empty() {
        return Err("SQL 不能为空".to_string());
    }
    let explain_sql = format!("EXPLAIN (FORMAT JSON) {sql}");
    let result = query_raw(
        &state,
        &connection_id,
        database.as_deref().filter(|value| !value.is_empty()),
        &explain_sql,
    )
    .await?;
    let json_plan = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    Ok(MysqlExplainResult {
        json_plan,
        columns: result.column_names(),
        rows: result.rows,
        message: None,
    })
}

#[tauri::command]
pub async fn postgres_fetch_rows(
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
    let full = quote_qualified(&table)?;
    let sql = format!("SELECT * FROM {full} LIMIT {size} OFFSET {offset}");
    let started = Instant::now();
    let result = query_raw(&state, &connection_id, Some(&database), &sql).await?;
    let truncated = result.rows.len() >= size as usize;
    Ok(to_query_result(
        result,
        started.elapsed().as_millis() as u64,
        truncated,
    ))
}

#[tauri::command]
pub async fn postgres_execute_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<QueryResult, String> {
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".to_string());
    }
    let started = Instant::now();
    let result = query_raw(
        &state,
        &connection_id,
        database.as_deref().filter(|value| !value.is_empty()),
        &sql,
    )
    .await?;
    let truncated = result.rows.len() > PG_MAX_RESULT_ROWS;
    let mut result = result;
    if truncated {
        result.rows.truncate(PG_MAX_RESULT_ROWS);
    }
    Ok(to_query_result(
        result,
        started.elapsed().as_millis() as u64,
        truncated,
    ))
}

#[tauri::command]
pub async fn postgres_create_database(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    name: String,
    charset: Option<String>,
    _collation: Option<String>,
) -> Result<(), String> {
    let mut sql = format!("CREATE DATABASE {}", quote_identifier(&name)?);
    if let Some(charset) = charset.filter(|value| !value.trim().is_empty()) {
        let charset_lower = charset.to_ascii_lowercase();
        let encoding = match charset_lower.as_str() {
            "utf8mb4" | "utf-8" | "utf8" => "UTF8",
            other => other,
        };
        sql.push_str(&format!(" ENCODING '{}'", encoding.replace('\'', "''")));
    }
    query_raw(&state, &connection_id, None, &sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn postgres_drop_database(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    let config = load_connection_config(&state, &connection_id, None)?;
    let maintenance_database = if config.database == database {
        "postgres".to_string()
    } else {
        config.database
    };
    let sql = format!("DROP DATABASE {}", quote_identifier(&database)?);
    query_raw(&state, &connection_id, Some(&maintenance_database), &sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn postgres_table_action(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    action: String,
    target: Option<String>,
) -> Result<(), String> {
    let (schema, table_name) = split_relation(&table)?;
    let full = format!(
        "{}.{}",
        quote_identifier(&schema)?,
        quote_identifier(&table_name)?
    );
    let sql = match action.as_str() {
        "truncate" => format!("TRUNCATE TABLE {full}"),
        "drop" => format!("DROP TABLE {full}"),
        "rename" => {
            let target = target.ok_or_else(|| "请填写新表名".to_string())?;
            let (_, target_name) = split_relation(&target)?;
            format!(
                "ALTER TABLE {full} RENAME TO {}",
                quote_identifier(&target_name)?
            )
        }
        "clone" => {
            let target = target.ok_or_else(|| "请填写副本表名".to_string())?;
            let (_, target_name) = split_relation(&target)?;
            format!(
                "CREATE TABLE {}.{} AS TABLE {full}",
                quote_identifier(&schema)?,
                quote_identifier(&target_name)?
            )
        }
        other => return Err(format!("不支持的数据库表操作: {other}")),
    };
    query_raw(&state, &connection_id, Some(&database), &sql).await?;
    Ok(())
}

async fn show_create_impl(
    state: &AppState,
    connection_id: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let (schema, table_name) = split_relation(table)?;
    let columns = list_columns_impl(state, connection_id, database, table).await?;
    let indexes = list_indexes_impl(state, connection_id, database, table).await?;
    let full = format!(
        "{}.{}",
        quote_identifier(&schema)?,
        quote_identifier(&table_name)?
    );
    let mut definitions = Vec::new();
    let mut primary_columns = Vec::new();
    for column in &columns {
        let mut definition = format!("{} {}", quote_identifier(&column.name)?, column.column_type);
        if !column.nullable {
            definition.push_str(" NOT NULL");
        }
        if let Some(default) = column
            .default_value
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            definition.push_str(" DEFAULT ");
            definition.push_str(default);
        }
        definitions.push(definition);
        if column.key == "PRI" {
            primary_columns.push(quote_identifier(&column.name)?);
        }
    }
    if !primary_columns.is_empty() {
        definitions.push(format!("PRIMARY KEY ({})", primary_columns.join(", ")));
    }
    let mut sql = format!("CREATE TABLE {full} (\n  {}\n)", definitions.join(",\n  "));
    let mut index_names = HashSet::new();
    for index in &indexes {
        if index.name.ends_with("_pkey") || !index_names.insert(index.name.clone()) {
            continue;
        }
        if let Some(column) = index.column.as_deref() {
            let kind = if index.unique {
                "UNIQUE INDEX"
            } else {
                "INDEX"
            };
            sql.push_str(&format!(
                ";\nCREATE {kind} {} ON {full} ({})",
                quote_identifier(&index.name)?,
                quote_identifier(column)?
            ));
        }
    }
    Ok(sql)
}

#[tauri::command]
pub async fn postgres_show_create(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    show_create_impl(&state, &connection_id, &database, &table).await
}

#[tauri::command]
pub async fn postgres_preview_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
) -> Result<Vec<String>, String> {
    if definition.original_name.is_some() {
        let (schema, table) = split_relation(
            definition
                .original_name
                .as_deref()
                .unwrap_or(&definition.name),
        )?;
        let client = client_for(&state, &connection_id, Some(&definition.database)).await?;
        let mut client = client.lock().await;
        let existing = existing_columns(&mut client, &schema, &table).await?;
        alter_table_statements(&definition, &existing)
    } else {
        create_table_statements(&definition)
    }
}

#[tauri::command]
pub async fn postgres_create_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
) -> Result<MysqlDdlResult, String> {
    if definition.original_name.is_some() {
        return Err("现有表请使用表设计修改流程".to_string());
    }
    let statements = create_table_statements(&definition)?;
    execute_statements(
        &state,
        &connection_id,
        Some(&definition.database),
        &statements,
    )
    .await
}

#[tauri::command]
pub async fn postgres_apply_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
    preview: Option<Vec<String>>,
) -> Result<MysqlDdlResult, String> {
    let statements = match preview.filter(|items| !items.is_empty()) {
        Some(items) => items,
        None => {
            if definition.original_name.is_some() {
                let (schema, table) = split_relation(
                    definition
                        .original_name
                        .as_deref()
                        .unwrap_or(&definition.name),
                )?;
                let client = client_for(&state, &connection_id, Some(&definition.database)).await?;
                let mut client = client.lock().await;
                let existing = existing_columns(&mut client, &schema, &table).await?;
                alter_table_statements(&definition, &existing)?
            } else {
                create_table_statements(&definition)?
            }
        }
    };
    execute_statements(
        &state,
        &connection_id,
        Some(&definition.database),
        &statements,
    )
    .await
}

fn mutation_where(original: &HashMap<String, Value>) -> Result<String, String> {
    if original.is_empty() {
        return Err("缺少用于定位被修改行的原始数据".to_string());
    }
    original
        .iter()
        .map(|(name, value)| {
            Ok(format!(
                "{} IS NOT DISTINCT FROM {}",
                quote_identifier(name)?,
                sql_literal(value)
            ))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|items| items.join(" AND "))
}

async fn apply_mutation(
    client: &mut PgClient,
    full: &str,
    action: &str,
    mutation: &MysqlRowMutation,
) -> Result<u64, String> {
    let sql = match action {
        "insert" => {
            if mutation.values.is_empty() {
                return Err("新增记录至少需要填写一个字段".to_string());
            }
            let columns = mutation
                .values
                .keys()
                .map(|name| quote_identifier(name))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            let values = mutation
                .values
                .values()
                .map(sql_literal)
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {full} ({columns}) VALUES ({values})")
        }
        "update" => {
            if mutation.values.is_empty() {
                return Err("没有需要更新的字段".to_string());
            }
            let assignments = mutation
                .values
                .iter()
                .map(|(name, value)| {
                    Ok(format!(
                        "{} = {}",
                        quote_identifier(name)?,
                        sql_literal(value)
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(", ");
            format!(
                "UPDATE {full} SET {assignments} WHERE {}",
                mutation_where(&mutation.original)?
            )
        }
        "delete" => format!(
            "DELETE FROM {full} WHERE {}",
            mutation_where(&mutation.original)?
        ),
        other => return Err(format!("不支持的行操作: {other}")),
    };
    let result = client.query(&sql).await.map_err(|e| e.to_string())?;
    Ok(result.affected_rows)
}

#[tauri::command]
pub async fn postgres_mutate_row(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    action: String,
    mutation: MysqlRowMutation,
) -> Result<u64, String> {
    let full = quote_qualified(&table)?;
    let client = client_for(&state, &connection_id, Some(&database)).await?;
    let mut client = client.lock().await;
    apply_mutation(&mut client, &full, &action, &mutation).await
}

#[tauri::command]
pub async fn postgres_apply_table_changes(
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
    let full = quote_qualified(&table)?;
    let client = client_for(&state, &connection_id, Some(&database)).await?;
    let mut client = client.lock().await;
    client.query("BEGIN").await.map_err(|e| e.to_string())?;
    let mut affected = 0u64;
    let outcome = async {
        for values in &changes.inserts {
            let mutation = MysqlRowMutation {
                values: values.clone(),
                original: HashMap::new(),
            };
            affected += apply_mutation(&mut client, &full, "insert", &mutation).await?;
        }
        for mutation in &changes.updates {
            affected += apply_mutation(&mut client, &full, "update", mutation).await?;
        }
        for original in &changes.deletes {
            let mutation = MysqlRowMutation {
                values: HashMap::new(),
                original: original.clone(),
            };
            affected += apply_mutation(&mut client, &full, "delete", &mutation).await?;
        }
        Ok::<(), String>(())
    }
    .await;
    match outcome {
        Ok(()) => {
            client.query("COMMIT").await.map_err(|e| e.to_string())?;
            Ok(affected)
        }
        Err(error) => {
            let _ = client.query("ROLLBACK").await;
            Err(error)
        }
    }
}

fn parse_csv(input: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = input
        .strip_prefix('\u{feff}')
        .unwrap_or(input)
        .chars()
        .peekable();
    while let Some(character) = chars.next() {
        if in_quotes {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }
        match character {
            '"' if field.is_empty() => in_quotes = true,
            ',' => {
                row.push(std::mem::take(&mut field));
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(character),
        }
    }
    if in_quotes {
        return Err("CSV 引号未闭合".to_string());
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows.into_iter().filter(|row| !row.is_empty()).collect())
}

#[tauri::command]
pub async fn postgres_import_csv(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    csv: String,
) -> Result<u64, String> {
    if csv.len() > 64 * 1024 * 1024 {
        return Err("CSV 文件超过 64MB 限制，请拆分后导入".to_string());
    }
    let rows = parse_csv(&csv)?;
    if rows.len() < 2 {
        return Err("CSV 至少需要表头和一行数据".to_string());
    }
    let headers = &rows[0];
    let full = quote_qualified(&table)?;
    let client = client_for(&state, &connection_id, Some(&database)).await?;
    let mut client = client.lock().await;
    client.query("BEGIN").await.map_err(|e| e.to_string())?;
    let mut imported = 0u64;
    for row in rows.iter().skip(1) {
        if row.len() != headers.len() {
            let _ = client.query("ROLLBACK").await;
            return Err(format!("CSV 第 {} 行列数与表头不一致", imported + 2));
        }
        let columns = headers
            .iter()
            .map(|name| quote_identifier(name))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let values = row
            .iter()
            .map(|value| sql_literal(&Value::String(value.clone())))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("INSERT INTO {full} ({columns}) VALUES ({values})");
        if let Err(error) = client.query(&sql).await {
            let _ = client.query("ROLLBACK").await;
            return Err(format!("CSV 第 {} 行导入失败: {error}", imported + 2));
        }
        imported += 1;
    }
    client.query("COMMIT").await.map_err(|e| e.to_string())?;
    Ok(imported)
}

fn split_sql_script(input: &str) -> Result<Vec<String>, String> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut dollar_tag: Option<String> = None;
    while let Some(character) = chars.next() {
        if line_comment {
            if character == '\n' {
                line_comment = false;
                current.push(character);
            }
            continue;
        }
        if block_comment {
            if character == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block_comment = false;
                current.push(' ');
            }
            continue;
        }
        if let Some(tag) = dollar_tag.as_ref() {
            if character == '$' {
                let mut candidate = String::from("$");
                while let Some(next) = chars.peek().copied() {
                    candidate.push(next);
                    chars.next();
                    if next == '$' {
                        break;
                    }
                }
                if &candidate == tag {
                    current.push_str(&candidate);
                    dollar_tag = None;
                } else {
                    current.push_str(&candidate);
                }
            } else {
                current.push(character);
            }
            continue;
        }
        if single_quote {
            current.push(character);
            if character == '\'' {
                if chars.peek() == Some(&'\'') {
                    current.push(chars.next().unwrap());
                } else {
                    single_quote = false;
                }
            }
            continue;
        }
        if double_quote {
            current.push(character);
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    current.push(chars.next().unwrap());
                } else {
                    double_quote = false;
                }
            }
            continue;
        }
        match character {
            '\'' => {
                single_quote = true;
                current.push(character);
            }
            '"' => {
                double_quote = true;
                current.push(character);
            }
            '-' if chars.peek() == Some(&'-') => {
                chars.next();
                line_comment = true;
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                block_comment = true;
            }
            '$' => {
                let mut tag = String::from("$");
                while let Some(next) = chars.peek().copied() {
                    tag.push(next);
                    chars.next();
                    if next == '$' {
                        break;
                    }
                    if !(next.is_ascii_alphanumeric() || next == '_') {
                        break;
                    }
                }
                if tag.ends_with('$') && tag.len() > 1 {
                    current.push_str(&tag);
                    dollar_tag = Some(tag);
                } else {
                    current.push('$');
                    current.push_str(&tag[1..]);
                }
            }
            ';' => {
                let statement = current.trim();
                if !statement.is_empty() {
                    statements.push(statement.to_string());
                }
                current.clear();
            }
            _ => current.push(character),
        }
    }
    if single_quote || double_quote || block_comment || dollar_tag.is_some() {
        return Err("SQL 文件包含未闭合的引号、注释或 dollar quote".to_string());
    }
    let statement = current.trim();
    if !statement.is_empty() {
        statements.push(statement.to_string());
    }
    Ok(statements)
}

#[tauri::command]
pub async fn postgres_import_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: MysqlSqlImportOptions,
) -> Result<MysqlSqlImportResult, String> {
    if options.path.trim().is_empty() {
        return Err("导入路径不能为空".to_string());
    }
    let content = tokio::fs::read_to_string(&options.path)
        .await
        .map_err(|e| format!("读取 SQL 文件失败: {e}"))?;
    let statements = split_sql_script(&content)?;
    let total = statements.len();
    let mut completed = 0usize;
    let mut failures = Vec::new();
    let client = client_for(
        &state,
        &connection_id,
        options
            .database
            .as_deref()
            .filter(|value| !value.is_empty()),
    )
    .await?;
    let mut client = client.lock().await;
    for (index, statement) in statements.iter().enumerate() {
        match client.query(statement).await {
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
        total,
        completed,
        failures,
    })
}

#[tauri::command]
pub async fn postgres_export_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: MysqlSqlExportOptions,
) -> Result<MysqlSqlExportResult, String> {
    if options.path.trim().is_empty() {
        return Err("导出路径不能为空".to_string());
    }
    let tables = list_tables_impl(&state, &connection_id, &options.database).await?;
    let mut output = String::new();
    let mut exported_tables = 0usize;
    let mut exported_rows = 0u64;
    for table in tables.iter().filter(|table| table.kind == "BASE TABLE") {
        let create =
            show_create_impl(&state, &connection_id, &options.database, &table.name).await?;
        output.push_str(&create);
        output.push_str(";\n\n");
        let full = quote_qualified(&table.name)?;
        let client = client_for(&state, &connection_id, Some(&options.database)).await?;
        let mut client = client.lock().await;
        let result = client
            .query(&format!("SELECT * FROM {full}"))
            .await
            .map_err(|e| e.to_string())?;
        if !result.rows.is_empty() {
            let columns = result
                .fields
                .iter()
                .map(|field| quote_identifier(&field.name))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            for row in &result.rows {
                let values = row.iter().map(sql_literal).collect::<Vec<_>>().join(", ");
                output.push_str(&format!(
                    "INSERT INTO {full} ({columns}) VALUES ({values});\n"
                ));
                exported_rows += 1;
            }
            output.push('\n');
        }
        exported_tables += 1;
    }
    tokio::fs::write(&options.path, output.as_bytes())
        .await
        .map_err(|e| format!("写入 SQL 文件失败: {e}"))?;
    Ok(MysqlSqlExportResult {
        tables: exported_tables,
        rows: exported_rows,
        bytes: output.len() as u64,
    })
}
