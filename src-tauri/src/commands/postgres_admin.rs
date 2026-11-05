//! PostgreSQL 数据库管理工作区后端。
//!
//! 该模块只负责 PostgreSQL 的具体 SQL；Tauri 的 `database_*` 命令会按连接
//! 协议分派到这里或 MySQL 实现，因此前端数据库工作区可以完全复用。

use super::mysql_admin::{
    MysqlCharsetInfo, MysqlColumnDefinition, MysqlColumnInfo, MysqlDatabaseInfo, MysqlDdlResult,
    MysqlExplainResult, MysqlForeignKeyDefinition, MysqlIndexColumn, MysqlIndexDefinition,
    MysqlIndexInfo, MysqlRowMutation, MysqlSqlExportOptions,
    MysqlSqlExportResult, MysqlSqlFailure, MysqlSqlImportOptions, MysqlSqlImportResult,
    MysqlTableChangeSet, MysqlTableDefinition, MysqlTableInfo,
};
use super::{AppState, QueryColumn, QueryResult, QueryResultRow, RowFilter, RowFilterSpec, RowOrderBy};
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

fn to_query_result(
    result: PgQueryResult,
    elapsed_ms: u64,
    truncated: bool,
    statement: Option<String>,
) -> QueryResult {
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
        statement,
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
    pg_type_of(definition, definition.auto_increment)
}

/// 自增标志会换成 SERIAL 家族；比较已有列的类型时要用 false，
/// 否则「给 INTEGER 列勾上自增」会被算成一次 ALTER COLUMN TYPE SERIAL。
fn pg_base_type(definition: &MysqlColumnDefinition) -> String {
    pg_type_of(definition, false)
}

fn pg_type_of(definition: &MysqlColumnDefinition, auto_increment: bool) -> String {
    let raw = definition.column_type.trim();
    let upper = raw.to_ascii_uppercase();
    if auto_increment {
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

/// 读取某张表的外键，按约束名把多列外键聚合成一条。
async fn load_foreign_keys(
    client: &mut PgClient,
    schema: &str,
    table: &str,
) -> Result<Vec<MysqlForeignKeyDefinition>, String> {
    let sql = format!(
        "SELECT c.conname, a.attname, rn.nspname, rt.relname, ra.attname, \
                CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' \
                     WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END, \
                CASE c.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' \
                     WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END \
         FROM pg_constraint c \
         JOIN pg_class t ON t.oid = c.conrelid \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_class rt ON rt.oid = c.confrelid \
         JOIN pg_namespace rn ON rn.oid = rt.relnamespace \
         JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(child, parent, ord) ON TRUE \
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child \
         JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.parent \
         WHERE c.contype = 'f' AND n.nspname = {} AND t.relname = {} \
         ORDER BY c.conname, k.ord",
        sql_literal(&Value::String(schema.to_string())),
        sql_literal(&Value::String(table.to_string()))
    );
    let result = client.query(&sql).await.map_err(|e| e.to_string())?;
    let mut grouped: Vec<MysqlForeignKeyDefinition> = Vec::new();
    for row in result.rows {
        let name = row.first().and_then(Value::as_str).unwrap_or_default().to_string();
        let column = row.get(1).and_then(Value::as_str).unwrap_or_default().to_string();
        let referenced_schema = row.get(2).and_then(Value::as_str).map(str::to_string);
        let referenced_table = row.get(3).and_then(Value::as_str).unwrap_or_default().to_string();
        let referenced_column = row.get(4).and_then(Value::as_str).unwrap_or_default().to_string();
        let on_delete = row.get(5).and_then(Value::as_str).map(str::to_string);
        let on_update = row.get(6).and_then(Value::as_str).map(str::to_string);
        // 同 schema 的引用不写 schema 前缀，跟设计器里的输入习惯保持一致
        let schema_prefix = referenced_schema.filter(|item| item != schema);
        match grouped.iter_mut().find(|item| item.name == name) {
            Some(item) => {
                item.columns.push(column);
                item.referenced_columns.push(referenced_column);
            }
            None => grouped.push(MysqlForeignKeyDefinition {
                name,
                columns: vec![column],
                referenced_table,
                referenced_schema: schema_prefix,
                referenced_columns: vec![referenced_column],
                on_delete,
                on_update,
            }),
        }
    }
    Ok(grouped)
}

fn fk_action(value: Option<&str>) -> Result<Option<String>, String> {
    let action = value
        .map(|item| item.trim().to_ascii_uppercase())
        .filter(|item| !item.is_empty());
    match action {
        None => Ok(None),
        Some(action)
            if matches!(
                action.as_str(),
                "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" | "SET DEFAULT"
            ) =>
        {
            Ok(Some(action))
        }
        Some(other) => Err(format!("不支持的外键动作: {other}")),
    }
}

fn foreign_key_sql(def: &MysqlForeignKeyDefinition) -> Result<String, String> {
    if def.columns.is_empty() || def.referenced_columns.is_empty() {
        return Err(format!("外键 {} 至少需要一个字段", def.name));
    }
    if def.columns.len() != def.referenced_columns.len() {
        return Err(format!("外键 {} 的字段数与被引用字段数不一致", def.name));
    }
    let columns = def
        .columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Result<Vec<_>, _>>()?
        .join(", ");
    let referenced_columns = def
        .referenced_columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Result<Vec<_>, _>>()?
        .join(", ");
    let target = match def
        .referenced_schema
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        Some(schema) => format!(
            "{}.{}",
            quote_identifier(schema)?,
            quote_identifier(&def.referenced_table)?
        ),
        None => quote_identifier(&def.referenced_table)?,
    };
    let mut sql = format!(
        "CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {target} ({referenced_columns})",
        quote_identifier(&def.name)?
    );
    if let Some(action) = fk_action(def.on_delete.as_deref())? {
        sql.push_str(&format!(" ON DELETE {action}"));
    }
    if let Some(action) = fk_action(def.on_update.as_deref())? {
        sql.push_str(&format!(" ON UPDATE {action}"));
    }
    Ok(sql)
}

fn foreign_key_matches(current: &MysqlForeignKeyDefinition, desired: &MysqlForeignKeyDefinition) -> bool {
    let action = |value: &Option<String>| {
        value
            .as_deref()
            .map(|item| item.trim().to_ascii_uppercase())
            .filter(|item| !item.is_empty() && item != "NO ACTION")
    };
    current.columns == desired.columns
        && current.referenced_table == desired.referenced_table
        && current.referenced_schema == desired.referenced_schema
        && current.referenced_columns == desired.referenced_columns
        && action(&current.on_delete) == action(&desired.on_delete)
        && action(&current.on_update) == action(&desired.on_update)
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
        let indexed_columns = index_column_list(&index.columns)?;
        match normalize_index_kind(&index.kind).as_str() {
            "PRIMARY" => columns.push(format!("PRIMARY KEY ({indexed_columns})")),
            "UNIQUE" => columns.push(format!(
                "CONSTRAINT {} UNIQUE ({indexed_columns})",
                quote_identifier(&index.name)?
            )),
            _ => {}
        }
    }
    for key in &definition.foreign_keys {
        columns.push(foreign_key_sql(key)?);
    }
    let mut statements = vec![format!(
        "CREATE TABLE {table} (\n  {}\n)",
        columns.join(",\n  ")
    )];
    for index in &definition.indexes {
        if normalize_index_kind(&index.kind) == "INDEX" && !index.columns.is_empty() {
            let indexed_columns = index_column_list(&index.columns)?;
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

#[derive(Default)]
struct ExistingColumn {
    name: String,
    data_type: String,
    nullable: bool,
    default_value: Option<String>,
    comment: String,
    /// `GENERATED ... AS IDENTITY` 列。SERIAL 列的这个标志为空，靠默认值里的 nextval 识别。
    identity: bool,
}

impl ExistingColumn {
    fn serial(&self) -> bool {
        self.default_value
            .as_deref()
            .map(|value| {
                value
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("nextval(")
            })
            .unwrap_or(false)
    }

    fn auto_increment(&self) -> bool {
        self.identity || self.serial()
    }

    /// 参与默认值比较的值：自增列的 nextval 不属于用户可编辑的默认值
    fn comparable_default(&self) -> Option<&str> {
        if self.auto_increment() {
            None
        } else {
            self.default_value.as_deref()
        }
    }
}

#[derive(Default)]
struct ExistingIndex {
    name: String,
    primary: bool,
    unique: bool,
    /// 索引若由约束派生（PRIMARY KEY / UNIQUE），删除必须走 DROP CONSTRAINT
    constraint: Option<String>,
    /// (列名, ASC/DESC)
    columns: Vec<(String, String)>,
    /// 表达式索引 / 部分索引 / 非 btree 索引不支持在设计器里改
    advanced: Option<String>,
}

#[derive(Default)]
struct ExistingTable {
    columns: Vec<ExistingColumn>,
    indexes: Vec<ExistingIndex>,
    foreign_keys: Vec<MysqlForeignKeyDefinition>,
    comment: String,
}

async fn existing_columns(
    client: &mut PgClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ExistingColumn>, String> {
    let sql = format!(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), \
                COALESCE(col_description(a.attrelid, a.attnum), ''), a.attidentity <> '' \
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
            comment: row
                .get(4)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            identity: row.get(5).and_then(Value::as_bool).unwrap_or(false),
        })
        .collect())
}

/// 读取现存索引。表达式索引取不到列名，会带上 advanced 说明并拒绝在设计器里改写。
async fn load_indexes(
    client: &mut PgClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ExistingIndex>, String> {
    let sql = format!(
        "SELECT i.relname, ix.indisprimary, ix.indisunique, COALESCE(con.conname, ''), am.amname, \
                (ix.indpred IS NOT NULL OR ix.indexprs IS NOT NULL), a.attname, \
                CASE WHEN (ix.indoption[(k.ord - 1)::int] & 1) = 1 THEN 'DESC' ELSE 'ASC' END \
         FROM pg_index ix \
         JOIN pg_class t ON t.oid = ix.indrelid \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_am am ON am.oid = i.relam \
         LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid \
         JOIN LATERAL unnest(ix.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON TRUE \
         LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
         WHERE n.nspname={} AND t.relname={} ORDER BY i.relname, k.ord",
        sql_literal(&Value::String(schema.to_string())),
        sql_literal(&Value::String(table.to_string()))
    );
    let result = client.query(&sql).await.map_err(|e| e.to_string())?;
    let mut grouped: Vec<ExistingIndex> = Vec::new();
    for row in result.rows {
        let name = row.first().and_then(Value::as_str).unwrap_or_default().to_string();
        let primary = row.get(1).and_then(Value::as_bool).unwrap_or(false);
        let unique = row.get(2).and_then(Value::as_bool).unwrap_or(false);
        let constraint = row
            .get(3)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let method = row.get(4).and_then(Value::as_str).unwrap_or("btree").to_string();
        let special = row.get(5).and_then(Value::as_bool).unwrap_or(false);
        let column = row.get(6).and_then(Value::as_str).map(str::to_string);
        let direction = row
            .get(7)
            .and_then(Value::as_str)
            .unwrap_or("ASC")
            .to_string();
        let advanced = if special {
            Some("表达式索引或部分索引".to_string())
        } else if !method.eq_ignore_ascii_case("btree") {
            Some(format!("{method} 索引"))
        } else if column.is_none() {
            Some("表达式索引".to_string())
        } else {
            None
        };
        match grouped.iter_mut().find(|item| item.name == name) {
            Some(item) => {
                if let Some(column) = &column {
                    item.columns.push((column.clone(), direction));
                }
            }
            None => grouped.push(ExistingIndex {
                name,
                primary,
                unique,
                constraint,
                columns: column.map(|value| vec![(value, direction)]).unwrap_or_default(),
                advanced,
            }),
        }
    }
    Ok(grouped)
}

async fn load_existing_table(
    client: &mut PgClient,
    schema: &str,
    table: &str,
) -> Result<ExistingTable, String> {
    let comment_sql = format!(
        "SELECT COALESCE(obj_description(c.oid, 'pg_class'), '') FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname={} AND c.relname={}",
        sql_literal(&Value::String(schema.to_string())),
        sql_literal(&Value::String(table.to_string()))
    );
    let comment = client
        .query(&comment_sql)
        .await
        .map_err(|e| e.to_string())?
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(ExistingTable {
        columns: existing_columns(client, schema, table).await?,
        indexes: load_indexes(client, schema, table).await?,
        foreign_keys: load_foreign_keys(client, schema, table).await?,
        comment,
    })
}

fn comment_literal(value: &str) -> String {
    if value.trim().is_empty() {
        "NULL".to_string()
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

fn index_column_list(columns: &[MysqlIndexColumn]) -> Result<String, String> {
    columns
        .iter()
        .map(|column| {
            let name = quote_identifier(&column.name)?;
            Ok(match column.direction.as_deref() {
                Some(direction) if direction.eq_ignore_ascii_case("DESC") => {
                    format!("{name} DESC")
                }
                _ => name,
            })
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|items| items.join(", "))
}

fn normalize_index_kind(kind: &str) -> String {
    match kind.trim().to_ascii_uppercase().as_str() {
        "PRIMARY" | "PRIMARY KEY" => "PRIMARY".to_string(),
        "UNIQUE" | "UNIQUE KEY" => "UNIQUE".to_string(),
        _ => "INDEX".to_string(),
    }
}

fn index_signature(kind: &str, columns: &[(String, String)]) -> String {
    let mut items: Vec<String> = columns
        .iter()
        .map(|(name, direction)| {
            let dir = if direction.eq_ignore_ascii_case("DESC") {
                "DESC"
            } else {
                "ASC"
            };
            format!("{name}:{dir}")
        })
        .collect();
    items.insert(0, normalize_index_kind(kind));
    items.join(",")
}

fn desired_index_signature(index: &MysqlIndexDefinition) -> String {
    let columns: Vec<(String, String)> = index
        .columns
        .iter()
        .map(|column| {
            let direction = match column.direction.as_deref() {
                Some(value) if value.eq_ignore_ascii_case("DESC") => "DESC",
                _ => "ASC",
            };
            (column.name.clone(), direction.to_string())
        })
        .collect();
    index_signature(&index.kind, &columns)
}

fn existing_index_signature(index: &ExistingIndex) -> String {
    let kind = if index.primary {
        "PRIMARY"
    } else if index.unique {
        "UNIQUE"
    } else {
        "INDEX"
    };
    index_signature(kind, &index.columns)
}

fn drop_index_statement(
    index: &ExistingIndex,
    schema: &str,
    qualified: &str,
) -> Result<String, String> {
    match index.constraint.as_deref() {
        Some(constraint) => Ok(format!(
            "ALTER TABLE {qualified} DROP CONSTRAINT {}",
            quote_identifier(constraint)?
        )),
        None => Ok(format!(
            "DROP INDEX {}.{}",
            quote_identifier(schema)?,
            quote_identifier(&index.name)?
        )),
    }
}

fn add_index_statement(index: &MysqlIndexDefinition, qualified: &str) -> Result<String, String> {
    if index.name.trim().is_empty() {
        return Err("索引名不能为空".to_string());
    }
    if index.columns.is_empty() {
        return Err(format!("索引 {} 至少需要一个字段", index.name));
    }
    let columns = index_column_list(&index.columns)?;
    match normalize_index_kind(&index.kind).as_str() {
        "PRIMARY" => Ok(format!(
            "ALTER TABLE {qualified} ADD CONSTRAINT {} PRIMARY KEY ({columns})",
            quote_identifier(&index.name)?
        )),
        "UNIQUE" => Ok(format!(
            "ALTER TABLE {qualified} ADD CONSTRAINT {} UNIQUE ({columns})",
            quote_identifier(&index.name)?
        )),
        _ => Ok(format!(
            "CREATE INDEX {} ON {qualified} ({columns})",
            quote_identifier(&index.name)?
        )),
    }
}

/// 自增列必须是整数类型，否则 PostgreSQL 会在执行时才报错
fn identity_type_supported(column: &MysqlColumnDefinition) -> bool {
    let raw = column.column_type.trim().to_ascii_uppercase();
    let base = raw.split('(').next().unwrap_or_default().trim();
    matches!(
        base,
        "TINYINT"
            | "SMALLINT"
            | "MEDIUMINT"
            | "INT"
            | "INTEGER"
            | "BIGINT"
            | "INT2"
            | "INT4"
            | "INT8"
            | "SMALLSERIAL"
            | "SERIAL"
            | "BIGSERIAL"
    )
}

fn alter_table_statements(
    definition: &MysqlTableDefinition,
    existing: &ExistingTable,
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

    // 索引与字段的合法性先校验，避免生成到一半才报错
    let mut desired_indexes = HashMap::new();
    for index in &definition.indexes {
        let kind = normalize_index_kind(&index.kind);
        if index.name.trim().is_empty() {
            return Err("索引名不能为空".to_string());
        }
        if desired_indexes
            .insert(index.name.as_str(), (index, kind))
            .is_some()
        {
            return Err(format!("索引名重复: {}", index.name));
        }
        for column in &index.columns {
            if !definition.columns.iter().any(|item| item.name == column.name) {
                return Err(format!("索引 {} 引用了不存在的字段: {}", index.name, column.name));
            }
        }
    }

    // 外键先比差异再动字段：旧约束引用着即将被改/删的列时，顺序反了会报错
    let mut desired_foreign_keys = HashMap::new();
    for key in &definition.foreign_keys {
        if key.name.trim().is_empty() {
            return Err("外键名不能为空".to_string());
        }
        if desired_foreign_keys.insert(key.name.as_str(), key).is_some() {
            return Err(format!("外键名重复: {}", key.name));
        }
        for column in &key.columns {
            if !definition.columns.iter().any(|item| item.name == *column) {
                return Err(format!("外键 {} 引用了不存在的字段: {column}", key.name));
            }
        }
    }
    let mut foreign_key_adds: Vec<String> = Vec::new();
    for current in &existing.foreign_keys {
        match desired_foreign_keys.get(current.name.as_str()) {
            Some(desired) if foreign_key_matches(current, desired) => {}
            Some(desired) => {
                statements.push(format!(
                    "ALTER TABLE {qualified} DROP CONSTRAINT {}",
                    quote_identifier(&current.name)?
                ));
                foreign_key_adds.push(format!(
                    "ALTER TABLE {qualified} ADD {}",
                    foreign_key_sql(desired)?
                ));
            }
            None => statements.push(format!(
                "ALTER TABLE {qualified} DROP CONSTRAINT {}",
                quote_identifier(&current.name)?
            )),
        }
    }
    for desired in &definition.foreign_keys {
        if !existing
            .foreign_keys
            .iter()
            .any(|current| current.name == desired.name)
        {
            foreign_key_adds.push(format!(
                "ALTER TABLE {qualified} ADD {}",
                foreign_key_sql(desired)?
            ));
        }
    }

    let by_name: HashMap<&str, &ExistingColumn> = existing
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let desired_names: HashSet<&str> = definition
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect();
    let mut dropped_columns: HashSet<&str> = HashSet::new();
    for column in &existing.columns {
        if !desired_names.contains(column.name.as_str()) {
            dropped_columns.insert(column.name.as_str());
            statements.push(format!(
                "ALTER TABLE {qualified} DROP COLUMN {}",
                quote_identifier(&column.name)?
            ));
        }
    }

    for column in &definition.columns {
        let definition_sql = column_definition_sql(column)?;
        match by_name.get(column.name.as_str()) {
            Some(old) => {
                if old.data_type != pg_base_type(column) {
                    statements.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} TYPE {}",
                        quote_identifier(&column.name)?,
                        pg_base_type(column)
                    ));
                }
                if old.nullable != column.nullable {
                    statements.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} {} NOT NULL",
                        quote_identifier(&column.name)?,
                        if column.nullable { "DROP" } else { "SET" }
                    ));
                }
                let old_auto = old.auto_increment();
                if column.auto_increment && !old_auto {
                    if !identity_type_supported(column) {
                        return Err(format!(
                            "字段 {} 的类型 {} 不能自增，请改成整数类型",
                            column.name, column.column_type
                        ));
                    }
                    if old.default_value.is_some() {
                        statements.push(format!(
                            "ALTER TABLE {qualified} ALTER COLUMN {} DROP DEFAULT",
                            quote_identifier(&column.name)?
                        ));
                    }
                    statements.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} ADD GENERATED BY DEFAULT AS IDENTITY",
                        quote_identifier(&column.name)?
                    ));
                } else if !column.auto_increment && old.identity {
                    statements.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} DROP IDENTITY IF EXISTS",
                        quote_identifier(&column.name)?
                    ));
                } else if !column.auto_increment && old.serial() {
                    // SERIAL 的默认值是 nextval()，只能去掉默认值；序列本身会随列一起被删
                    statements.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {} DROP DEFAULT",
                        quote_identifier(&column.name)?
                    ));
                }
                if !old_auto && !column.auto_increment {
                    let desired_default = column
                        .default_value
                        .as_deref()
                        .filter(|value| !value.trim().is_empty());
                    if old.comparable_default() != desired_default {
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
                }
                if old.comment != column.comment {
                    statements.push(format!(
                        "COMMENT ON COLUMN {qualified}.{} IS {}",
                        quote_identifier(&column.name)?,
                        comment_literal(&column.comment)
                    ));
                }
            }
            None => {
                statements.push(format!(
                    "ALTER TABLE {qualified} ADD COLUMN {definition_sql}"
                ));
                if !column.comment.trim().is_empty() {
                    statements.push(format!(
                        "COMMENT ON COLUMN {qualified}.{} IS {}",
                        quote_identifier(&column.name)?,
                        comment_literal(&column.comment)
                    ));
                }
            }
        }
    }

    // 索引：PostgreSQL 改索引只能 DROP + CREATE，代价是全表重建
    let mut index_adds: Vec<String> = Vec::new();
    for current in &existing.indexes {
        match desired_indexes.get(current.name.as_str()) {
            Some((desired, _)) if existing_index_signature(current) == desired_index_signature(desired) => {}
            target => {
                if let Some(reason) = &current.advanced {
                    return Err(format!(
                        "索引 {} 是{reason}，请在 SQL 工作台修改",
                        current.name
                    ));
                }
                // 索引所在列被删时 PostgreSQL 会自动删索引，再显式 DROP 会报「不存在」
                if !current
                    .columns
                    .iter()
                    .any(|(name, _)| dropped_columns.contains(name.as_str()))
                {
                    statements.push(drop_index_statement(current, &schema, &qualified)?);
                }
                if let Some((desired, _)) = target {
                    index_adds.push(add_index_statement(desired, &qualified)?);
                }
            }
        }
    }
    for (name, (index, _)) in &desired_indexes {
        if !existing.indexes.iter().any(|current| current.name == *name) {
            index_adds.push(add_index_statement(index, &qualified)?);
        }
    }
    statements.extend(index_adds);

    if existing.comment != definition.comment {
        statements.push(format!(
            "COMMENT ON TABLE {qualified} IS {}",
            comment_literal(&definition.comment)
        ));
    }

    statements.extend(foreign_key_adds);
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

/// 连通性检查 + 服务器信息，供状态栏与重连按钮使用。
pub(crate) async fn ping_and_info(
    state: &AppState,
    connection_id: &str,
) -> Result<crate::db::DbConnectionInfo, String> {
    let protocol = state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|item| item.id == connection_id)
        .map(|item| item.protocol)
        .ok_or_else(|| "连接不存在".to_string())?;

    let client = client_for(state, connection_id, None).await?;
    let mut client = client.lock().await;
    let started = Instant::now();
    let result = client
        .query("SELECT current_database(), current_setting('transaction_read_only')")
        .await
        .map_err(|e| format!("读取服务器信息失败: {e}"))?;
    let latency_ms = started.elapsed().as_millis() as u64;
    let row = result.rows.first();

    Ok(crate::db::DbConnectionInfo {
        protocol,
        state: "connected".to_string(),
        latency_ms: Some(latency_ms),
        server_version: client.server_version().map(str::to_string),
        current_database: row
            .and_then(|row| row.first())
            .and_then(Value::as_str)
            .map(str::to_string),
        read_only: row
            .and_then(|row| row.get(1))
            .and_then(Value::as_str)
            .map(|value| value.eq_ignore_ascii_case("on")),
        tls_mode: None,
        // PostgreSQL 走单条长连接，不存在连接池
        pool_min: 1,
        pool_max: 1,
    })
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
        "SELECT i.relname, ix.indisunique, a.attname, k.ord, am.amname, ix.indisprimary, \
                CASE WHEN (ix.indoption[(k.ord - 1)::int] & 1) = 1 THEN 'DESC' ELSE 'ASC' END \
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
            primary: row.get(5).and_then(Value::as_bool).unwrap_or(false),
            column: row.get(2).and_then(Value::as_str).map(str::to_string),
            sequence: row.get(3).and_then(Value::as_u64).unwrap_or(0) as u32,
            prefix_length: None,
            direction: row.get(6).and_then(Value::as_str).map(str::to_string),
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
pub async fn postgres_list_foreign_keys(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlForeignKeyDefinition>, String> {
    let (schema, table_name) = split_relation(&table)?;
    let client = client_for(&state, &connection_id, Some(&database)).await?;
    let mut client = client.lock().await;
    load_foreign_keys(&mut client, &schema, &table_name).await
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
    order_by: Option<RowOrderBy>,
    filter: Option<RowFilter>,
    orders: Option<Vec<RowOrderBy>>,
    filters: Option<RowFilterSpec>,
) -> Result<QueryResult, String> {
    let size = page_size.clamp(1, 1000);
    let offset = page
        .checked_sub(1)
        .and_then(|page_index| page_index.checked_mul(size))
        .ok_or_else(|| "页码或分页大小无效".to_string())?;
    let full = quote_qualified(&table)?;

    let columns: Vec<String> = list_columns_impl(&state, &connection_id, &database, &table)
        .await?
        .into_iter()
        .map(|column| column.name)
        .collect();

    let mut order_terms = super::row_order_terms(orders.as_deref().unwrap_or(&[]), &columns, quote_identifier)?;
    if order_terms.is_empty() {
        if let Some(order) = order_by.as_ref().filter(|item| !item.column.trim().is_empty()) {
            let column = order.column.trim();
            if !columns.iter().any(|item| item == column) {
                return Err(format!("排序字段不存在：{column}"));
            }
            let direction = if order.direction.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
            order_terms.push(format!("{} {direction}", quote_identifier(column)?));
        }
    }
    let order_clause = if order_terms.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_terms.join(","))
    };

    let multi_where = match filters.as_ref() {
        Some(spec) if !spec.conditions.is_empty() => {
            super::build_row_filter_clause(spec, &columns, quote_identifier)?
        }
        _ => String::new(),
    };
    let where_clause = if !multi_where.is_empty() {
        multi_where
    } else {
        match filter.as_ref().map(|item| (item, item.text.trim())) {
        Some((item, text)) if !text.is_empty() => {
            let pattern = like_pattern(text);
            let targets: Vec<String> = match item.column.as_deref() {
                Some(column) if !column.trim().is_empty() => {
                    let column = column.trim();
                    if !columns.iter().any(|item| item == column) {
                        return Err(format!("筛选字段不存在：{column}"));
                    }
                    vec![quote_identifier(column)?]
                }
                _ => columns
                    .iter()
                    .map(|column| quote_identifier(column))
                    .collect::<Result<Vec<_>, _>>()?,
            };
            let clause = targets
                .iter()
                .map(|column| format!("{column} LIKE {pattern} ESCAPE '!'"))
                .collect::<Vec<_>>()
                .join(" OR ");
            format!(" WHERE {clause}")
        }
        _ => String::new(),
        }
    };

    let sql = format!("SELECT * FROM {full}{where_clause}{order_clause} LIMIT {size} OFFSET {offset}");
    let started = Instant::now();
    let result = query_raw(&state, &connection_id, Some(&database), &sql).await?;
    let truncated = result.rows.len() >= size as usize;
    Ok(to_query_result(
        result,
        started.elapsed().as_millis() as u64,
        truncated,
        Some(sql),
    ))
}

/// 生成 LIKE 模式串：转义 `!`（转义符）、`%`、`_` 与单引号
fn like_pattern(text: &str) -> String {
    let escaped = text
        .replace('!', "!!")
        .replace('%', "!%")
        .replace('_', "!_")
        .replace('\'', "''");
    format!("'%{escaped}%'")
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
        Some(sql.clone()),
    ))
}

/// 顺序执行多条语句，遇到第一条失败就停下并回滚整批。
///
/// PostgreSQL 的 DDL 也是事务性的，所以这里能真正做到整批回滚；但是
/// `CREATE DATABASE`、`VACUUM`、`CREATE INDEX CONCURRENTLY` 这类语句不能进事务，
/// 遇到时按"未包裹"处理，交由用户自己确认。
fn unable_in_transaction(statement: &str) -> bool {
    let head = super::leading_keyword(statement);
    if head == "VACUUM" {
        return true;
    }
    let upper = statement.to_ascii_uppercase();
    head == "CREATE" && (upper.contains("CONCURRENTLY") || upper.starts_with("CREATE DATABASE"))
}

fn manages_transaction(statement: &str) -> bool {
    matches!(
        super::leading_keyword(statement).as_str(),
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE"
    )
}

#[tauri::command]
pub async fn postgres_execute_sql_batch(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<super::BatchExecutionResult, String> {
    let statements = super::split_statements(&sql)?;
    let database = database.as_deref().filter(|value| !value.is_empty());
    let manual = statements.iter().any(|item| manages_transaction(item));
    let blocked = statements.iter().any(|item| unable_in_transaction(item));
    let wrap = statements.len() > 1 && !manual && !blocked;

    let client = client_for(&state, &connection_id, database).await?;
    let mut client = client.lock().await;
    if wrap {
        client
            .query("BEGIN")
            .await
            .map_err(|e| format!("开启事务失败: {e}"))?;
    }

    let mut outcomes = Vec::with_capacity(statements.len());
    let mut failure: Option<String> = None;
    for (offset, statement) in statements.iter().enumerate() {
        let started = Instant::now();
        let index = offset + 1;
        match client.query(statement).await {
            Ok(result) => {
                let truncated = result.rows.len() > PG_MAX_RESULT_ROWS;
                let mut result = result;
                if truncated {
                    result.rows.truncate(PG_MAX_RESULT_ROWS);
                }
                outcomes.push(super::StatementOutcome {
                    index,
                    statement: statement.clone(),
                    result: Some(to_query_result(
                        result,
                        started.elapsed().as_millis() as u64,
                        truncated,
                        Some(statement.clone()),
                    )),
                    error: None,
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(error) => {
                let message = error.to_string();
                outcomes.push(super::StatementOutcome {
                    index,
                    statement: statement.clone(),
                    result: None,
                    error: Some(message.clone()),
                    duration_ms: started.elapsed().as_millis() as u64,
                });
                failure = Some(message);
                break;
            }
        }
    }

    let mut transaction = if manual {
        "manual".to_string()
    } else if wrap {
        "committed".to_string()
    } else {
        "none".to_string()
    };

    if wrap {
        if failure.is_some() {
            match client.query("ROLLBACK").await {
                Ok(_) => transaction = "rolled_back".to_string(),
                Err(rollback) => {
                    transaction = "rollback_failed".to_string();
                    failure = failure.map(|error| format!("{error}\n回滚失败: {rollback}"));
                }
            }
        } else {
            client
                .query("COMMIT")
                .await
                .map_err(|e| format!("提交事务失败: {e}"))?;
        }
    }

    Ok(super::BatchExecutionResult {
        statements: outcomes,
        transaction,
        // PG 的事务回滚是完整的，不存在 MySQL 那种隐式提交
        partial: false,
        error: failure,
    })
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
    // DDL 预览也要带外键，否则用户复制出去重建表会丢约束
    let client = client_for(state, connection_id, Some(database)).await?;
    let mut client = client.lock().await;
    for key in load_foreign_keys(&mut client, &schema, &table_name).await? {
        definitions.push(foreign_key_sql(&key)?);
    }
    drop(client);
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
        let existing = load_existing_table(&mut client, &schema, &table).await?;
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
                let existing = load_existing_table(&mut client, &schema, &table).await?;
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

/// 只能用主键定位单行：没有主键时退回「全列匹配」会一次改掉多行，
/// 而且 `IS NOT DISTINCT FROM` 对 NULL 也成立，风险比收益大得多。
fn mutation_where(original: &HashMap<String, Value>, primary: &[String]) -> Result<String, String> {
    if primary.is_empty() {
        return Err("表没有主键，无法安全地定位单行；请到 SQL 工作台按条件修改".to_string());
    }
    primary
        .iter()
        .map(|name| {
            let value = original
                .get(name)
                .ok_or_else(|| format!("缺少主键字段 {name} 的原始值，请刷新后重试"))?;
            Ok(format!(
                "{} IS NOT DISTINCT FROM {}",
                quote_identifier(name)?,
                sql_literal(value)
            ))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|items| items.join(" AND "))
}

/// 表的主键列。没主键时返回空数组，调用方据此拒绝按行更新/删除。
async fn primary_key_columns(
    state: &AppState,
    connection_id: &str,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    Ok(list_columns_impl(state, connection_id, database, table)
        .await?
        .into_iter()
        .filter(|column| column.key == "PRI")
        .map(|column| column.name)
        .collect())
}

async fn apply_mutation(
    client: &mut PgClient,
    full: &str,
    action: &str,
    mutation: &MysqlRowMutation,
    primary: &[String],
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
                mutation_where(&mutation.original, primary)?
            )
        }
        "delete" => format!(
            "DELETE FROM {full} WHERE {}",
            mutation_where(&mutation.original, primary)?
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
    let primary = primary_key_columns(&state, &connection_id, &database, &table).await?;
    if action != "insert" && primary.is_empty() {
        return Err(format!(
            "表 {table} 没有主键，无法安全地更新或删除单行。请改用 SQL 工作台。"
        ));
    }
    let client = client_for(&state, &connection_id, Some(&database)).await?;
    let mut client = client.lock().await;
    apply_mutation(&mut client, &full, &action, &mutation, &primary).await
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
    let primary = primary_key_columns(&state, &connection_id, &database, &table).await?;
    if (!changes.updates.is_empty() || !changes.deletes.is_empty()) && primary.is_empty() {
        return Err(format!(
            "表 {table} 没有主键，无法安全地更新或删除单行。请改用 SQL 工作台。"
        ));
    }
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
            affected += apply_mutation(&mut client, &full, "insert", &mutation, &primary).await?;
        }
        for mutation in &changes.updates {
            affected += apply_mutation(&mut client, &full, "update", mutation, &primary).await?;
        }
        for original in &changes.deletes {
            let mutation = MysqlRowMutation {
                values: HashMap::new(),
                original: original.clone(),
            };
            affected += apply_mutation(&mut client, &full, "delete", &mutation, &primary).await?;
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

#[cfg(test)]
mod batch_tests {
    use super::{unable_in_transaction, manages_transaction};

    #[test]
    fn detects_statements_that_cannot_run_in_transaction() {
        assert!(unable_in_transaction("VACUUM ANALYZE t"));
        assert!(unable_in_transaction("CREATE INDEX CONCURRENTLY idx ON t (a)"));
        assert!(unable_in_transaction("CREATE DATABASE app"));
        assert!(!unable_in_transaction("CREATE TABLE t (id INT)"));
        assert!(!unable_in_transaction("INSERT INTO t VALUES (1)"));
    }

    #[test]
    fn leaves_transaction_control_to_user() {
        assert!(manages_transaction("BEGIN"));
        assert!(manages_transaction("ROLLBACK"));
        assert!(!manages_transaction("SELECT 1"));
    }
}

#[cfg(test)]
mod foreign_key_tests {
    use super::*;

    fn definition(keys: Vec<MysqlForeignKeyDefinition>) -> MysqlTableDefinition {
        MysqlTableDefinition {
            database: "public".to_string(),
            name: "film".to_string(),
            original_name: None,
            engine: None,
            charset: None,
            collation: None,
            comment: String::new(),
            columns: vec![MysqlColumnDefinition {
                name: "language_id".to_string(),
                column_type: "smallint".to_string(),
                nullable: false,
                default_value: None,
                auto_increment: false,
                charset: None,
                collation: None,
                comment: String::new(),
                generation_expression: None,
                extra: String::new(),
            }],
            indexes: Vec::new(),
            foreign_keys: keys,
        }
    }

    fn key(on_delete: &str) -> MysqlForeignKeyDefinition {
        MysqlForeignKeyDefinition {
            name: "fk_film_language".to_string(),
            columns: vec!["language_id".to_string()],
            referenced_table: "language".to_string(),
            referenced_schema: None,
            referenced_columns: vec!["language_id".to_string()],
            on_delete: Some(on_delete.to_string()),
            on_update: None,
        }
    }

    #[test]
    fn renders_foreign_key_in_create_table() {
        let statements = create_table_statements(&definition(vec![key("CASCADE")])).unwrap();
        assert!(statements[0].contains(
            "CONSTRAINT \"fk_film_language\" FOREIGN KEY (\"language_id\") REFERENCES \"language\" (\"language_id\") ON DELETE CASCADE"
        ));
    }

    #[test]
    fn qualifies_referenced_schema_when_present() {
        let mut value = key("RESTRICT");
        value.referenced_schema = Some("lookup".to_string());
        assert!(foreign_key_sql(&value)
            .unwrap()
            .contains("REFERENCES \"lookup\".\"language\" (\"language_id\")"));
    }

    #[test]
    fn rejects_unknown_action_and_mismatched_columns() {
        let mut unknown = key("EXPLODE");
        unknown.on_delete = Some("EXPLODE".to_string());
        assert!(foreign_key_sql(&unknown).is_err());
        let mut mismatched = key("RESTRICT");
        mismatched.referenced_columns.push("extra".to_string());
        assert!(foreign_key_sql(&mismatched).is_err());
    }

    fn existing_with_foreign_keys(keys: Vec<MysqlForeignKeyDefinition>) -> ExistingTable {
        ExistingTable {
            foreign_keys: keys,
            ..Default::default()
        }
    }

    #[test]
    fn alter_drops_and_recreates_changed_foreign_key() {
        let statements = alter_table_statements(
            &definition(vec![key("CASCADE")]),
            &existing_with_foreign_keys(vec![key("RESTRICT")]),
        )
        .unwrap();
        assert!(statements
            .iter()
            .any(|item| item.contains("DROP CONSTRAINT \"fk_film_language\"")));
        assert!(statements
            .iter()
            .any(|item| item.contains("ADD CONSTRAINT \"fk_film_language\"")));
        assert!(statements
            .iter()
            .any(|item| item.contains("ON DELETE CASCADE")));
    }

    #[test]
    fn alter_keeps_unchanged_foreign_key() {
        let statements = alter_table_statements(
            &definition(vec![key("CASCADE")]),
            &existing_with_foreign_keys(vec![key("CASCADE")]),
        )
        .unwrap();
        assert!(!statements.iter().any(|item| item.contains("CONSTRAINT")));
    }

    #[test]
    fn alter_rejects_foreign_key_on_missing_column() {
        let mut value = key("CASCADE");
        value.columns = vec!["nope".to_string()];
        assert!(alter_table_statements(&definition(vec![value]), &ExistingTable::default()).is_err());
    }
}


#[cfg(test)]
mod designer_tests {
    use super::*;

    fn column(name: &str, column_type: &str) -> MysqlColumnDefinition {
        MysqlColumnDefinition {
            name: name.to_string(),
            column_type: column_type.to_string(),
            nullable: false,
            default_value: None,
            auto_increment: false,
            charset: None,
            collation: None,
            comment: String::new(),
            generation_expression: None,
            extra: String::new(),
        }
    }

    fn table(columns: Vec<MysqlColumnDefinition>, indexes: Vec<MysqlIndexDefinition>) -> MysqlTableDefinition {
        MysqlTableDefinition {
            database: "public".to_string(),
            name: "film".to_string(),
            original_name: Some("film".to_string()),
            engine: None,
            charset: None,
            collation: None,
            comment: String::new(),
            columns,
            indexes,
            foreign_keys: Vec::new(),
        }
    }

    fn existing_column(name: &str, data_type: &str) -> ExistingColumn {
        ExistingColumn {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: false,
            default_value: None,
            comment: String::new(),
            identity: false,
        }
    }

    fn index(name: &str, kind: &str, columns: &[&str]) -> MysqlIndexDefinition {
        MysqlIndexDefinition {
            name: name.to_string(),
            kind: kind.to_string(),
            columns: columns
                .iter()
                .map(|name| MysqlIndexColumn {
                    name: name.to_string(),
                    prefix_length: None,
                    direction: None,
                })
                .collect(),
        }
    }

    #[test]
    fn creates_missing_index_and_drops_removed_one() {
        let definition = table(vec![column("id", "integer")], vec![index("idx_film_id", "INDEX", &["id"])]);
        let existing = ExistingTable {
            columns: vec![existing_column("id", "integer")],
            indexes: vec![ExistingIndex {
                name: "film_old_idx".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements
            .iter()
            .any(|item| item == "CREATE INDEX \"idx_film_id\" ON \"public\".\"film\" (\"id\")"));
        assert!(statements
            .iter()
            .any(|item| item == "DROP INDEX \"public\".\"film_old_idx\""));
    }

    #[test]
    fn keeps_unchanged_primary_key() {
        let definition = table(
            vec![column("film_id", "integer")],
            vec![index("film_pkey", "PRIMARY", &["film_id"])],
        );
        let existing = ExistingTable {
            columns: vec![existing_column("film_id", "integer")],
            indexes: vec![ExistingIndex {
                name: "film_pkey".to_string(),
                primary: true,
                unique: true,
                constraint: Some("film_pkey".to_string()),
                columns: vec![("film_id".to_string(), "ASC".to_string())],
                advanced: None,
            }],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements.is_empty(), "{statements:?}");
    }

    #[test]
    fn drops_unique_constraint_by_constraint_name() {
        let definition = table(vec![column("code", "text")], Vec::new());
        let existing = ExistingTable {
            columns: vec![existing_column("code", "text")],
            indexes: vec![ExistingIndex {
                name: "film_code_key".to_string(),
                unique: true,
                constraint: Some("film_code_key".to_string()),
                columns: vec![("code".to_string(), "ASC".to_string())],
                ..Default::default()
            }],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements
            .iter()
            .any(|item| item == "ALTER TABLE \"public\".\"film\" DROP CONSTRAINT \"film_code_key\""));
    }

    #[test]
    fn refuses_expression_index() {
        let definition = table(vec![column("code", "text")], Vec::new());
        let existing = ExistingTable {
            columns: vec![existing_column("code", "text")],
            indexes: vec![ExistingIndex {
                name: "film_lower_idx".to_string(),
                advanced: Some("表达式索引或部分索引".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(alter_table_statements(&definition, &existing).is_err());
    }

    #[test]
    fn writes_table_and_column_comments() {
        let mut code = column("code", "text");
        code.comment = "编码".to_string();
        let mut definition = table(vec![code], Vec::new());
        definition.comment = "电影表".to_string();
        let existing = ExistingTable {
            columns: vec![existing_column("code", "text")],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements
            .iter()
            .any(|item| item == "COMMENT ON TABLE \"public\".\"film\" IS '电影表'"));
        assert!(statements
            .iter()
            .any(|item| item == "COMMENT ON COLUMN \"public\".\"film\".\"code\" IS '编码'"));
    }

    #[test]
    fn clears_comment_with_null() {
        let definition = table(vec![column("code", "text")], Vec::new());
        let existing = ExistingTable {
            columns: vec![ExistingColumn {
                comment: "旧注释".to_string(),
                ..existing_column("code", "text")
            }],
            comment: "旧表注释".to_string(),
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements
            .iter()
            .any(|item| item == "COMMENT ON TABLE \"public\".\"film\" IS NULL"));
    }

    #[test]
    fn adds_identity_without_retyping_column() {
        let mut id = column("id", "integer");
        id.auto_increment = true;
        let definition = table(vec![id], Vec::new());
        let existing = ExistingTable {
            columns: vec![existing_column("id", "integer")],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements.iter().any(|item| item.contains("ADD GENERATED BY DEFAULT AS IDENTITY")));
        assert!(!statements.iter().any(|item| item.contains("TYPE SERIAL")));
    }

    #[test]
    fn drops_identity_when_unchecked() {
        let definition = table(vec![column("id", "integer")], Vec::new());
        let existing = ExistingTable {
            columns: vec![ExistingColumn {
                identity: true,
                ..existing_column("id", "integer")
            }],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements
            .iter()
            .any(|item| item.contains("DROP IDENTITY IF EXISTS")));
    }

    #[test]
    fn drops_serial_default_when_unchecked() {
        let definition = table(vec![column("id", "integer")], Vec::new());
        let existing = ExistingTable {
            columns: vec![ExistingColumn {
                default_value: Some("nextval('film_id_seq'::regclass)".to_string()),
                ..existing_column("id", "integer")
            }],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(statements
            .iter()
            .any(|item| item.contains("ALTER COLUMN \"id\" DROP DEFAULT")));
    }

    #[test]
    fn rejects_auto_increment_on_text_column() {
        let mut name = column("name", "text");
        name.auto_increment = true;
        let definition = table(vec![name], Vec::new());
        let existing = ExistingTable {
            columns: vec![existing_column("name", "text")],
            ..Default::default()
        };
        assert!(alter_table_statements(&definition, &existing).is_err());
    }

    #[test]
    fn ignores_index_on_dropped_column() {
        let definition = table(vec![column("code", "text")], Vec::new());
        let existing = ExistingTable {
            columns: vec![
                existing_column("code", "text"),
                existing_column("legacy", "text"),
            ],
            indexes: vec![ExistingIndex {
                name: "film_legacy_idx".to_string(),
                columns: vec![("legacy".to_string(), "ASC".to_string())],
                ..Default::default()
            }],
            ..Default::default()
        };
        let statements = alter_table_statements(&definition, &existing).unwrap();
        assert!(!statements
            .iter()
            .any(|item| item.contains("DROP INDEX")));
    }
}
