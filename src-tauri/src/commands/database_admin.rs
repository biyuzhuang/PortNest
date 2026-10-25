//! 通用数据库管理命令。
//!
//! 前端只依赖这一组 `database_*` 命令。命令内部根据连接协议分派到 MySQL
//! 或 PostgreSQL 实现；以后新增数据库时只需增加一个协议实现，不需要再复制
//! 一套数据库工作区 UI。

use super::mysql_admin::{
    MysqlAutocompleteItem, MysqlCharsetInfo, MysqlColumnInfo, MysqlDatabaseInfo, MysqlDdlResult,
    MysqlExplainResult, MysqlIndexInfo, MysqlRowMutation, MysqlSqlExportOptions,
    MysqlSqlExportResult, MysqlSqlImportOptions, MysqlSqlImportResult, MysqlTableChangeSet,
    MysqlTableDefinition, MysqlTableInfo,
};
use super::{AppState, QueryResult};

fn connection_protocol(state: &AppState, connection_id: &str) -> Result<String, String> {
    state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .map(|connection| connection.protocol)
        .ok_or_else(|| "连接不存在".to_string())
}

#[tauri::command]
pub async fn database_connect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_connect(state, connection_id).await,
        "postgresql" => super::postgres_admin::postgres_connect(state, connection_id).await,
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_disconnect(state, connection_id).await,
        "postgresql" => super::postgres_admin::postgres_disconnect(state, connection_id).await,
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_cancel_query(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_cancel_query(state, connection_id).await,
        "postgresql" => super::postgres_admin::postgres_cancel_query(state, connection_id).await,
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_save_sql(path: String, sql: String) -> Result<(), String> {
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
pub async fn database_list_databases(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<MysqlDatabaseInfo>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_list_databases(state, connection_id).await,
        "postgresql" => super::postgres_admin::postgres_list_databases(state, connection_id).await,
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_list_charsets(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<MysqlCharsetInfo>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_list_charsets(state, connection_id).await,
        "postgresql" => super::postgres_admin::postgres_list_charsets(state, connection_id).await,
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_list_tables(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<MysqlTableInfo>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_list_tables(state, connection_id, database).await,
        "postgresql" => {
            super::postgres_admin::postgres_list_tables(state, connection_id, database).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_list_columns(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlColumnInfo>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_list_columns(state, connection_id, database, table).await
        }
        "postgresql" => {
            super::postgres_admin::postgres_list_columns(state, connection_id, database, table)
                .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_list_indexes(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<MysqlIndexInfo>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_list_indexes(state, connection_id, database, table).await
        }
        "postgresql" => {
            super::postgres_admin::postgres_list_indexes(state, connection_id, database, table)
                .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_autocomplete(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<MysqlAutocompleteItem>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_autocomplete(state, connection_id, database).await,
        "postgresql" => {
            super::postgres_admin::postgres_autocomplete(state, connection_id, database).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_explain_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<MysqlExplainResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_explain_sql(state, connection_id, sql, database).await,
        "postgresql" => {
            super::postgres_admin::postgres_explain_sql(state, connection_id, sql, database).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_fetch_rows(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    page: u64,
    page_size: u64,
) -> Result<QueryResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_fetch_rows(
                state,
                connection_id,
                database,
                table,
                page,
                page_size,
            )
            .await
        }
        "postgresql" => {
            super::postgres_admin::postgres_fetch_rows(
                state,
                connection_id,
                database,
                table,
                page,
                page_size,
            )
            .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_execute_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
) -> Result<QueryResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_execute_sql(state, connection_id, sql, database).await,
        "postgresql" => {
            super::postgres_admin::postgres_execute_sql(state, connection_id, sql, database).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_create_database(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<(), String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_create_database(
                state,
                connection_id,
                name,
                charset,
                collation,
            )
            .await
        }
        "postgresql" => {
            super::postgres_admin::postgres_create_database(
                state,
                connection_id,
                name,
                charset,
                collation,
            )
            .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_drop_database(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_drop_database(state, connection_id, database).await,
        "postgresql" => {
            super::postgres_admin::postgres_drop_database(state, connection_id, database).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_create_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
) -> Result<MysqlDdlResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_create_table(state, connection_id, definition).await,
        "postgresql" => {
            super::postgres_admin::postgres_create_table(state, connection_id, definition).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_preview_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
) -> Result<Vec<String>, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_preview_table(state, connection_id, definition).await,
        "postgresql" => {
            super::postgres_admin::postgres_preview_table(state, connection_id, definition).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_apply_table(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    definition: MysqlTableDefinition,
    preview: Option<Vec<String>>,
) -> Result<MysqlDdlResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_apply_table(state, connection_id, definition, preview).await
        }
        "postgresql" => {
            super::postgres_admin::postgres_apply_table(state, connection_id, definition, preview)
                .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_table_action(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    action: String,
    target: Option<String>,
) -> Result<(), String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_table_action(
                state,
                connection_id,
                database,
                table,
                action,
                target,
            )
            .await
        }
        "postgresql" => {
            super::postgres_admin::postgres_table_action(
                state,
                connection_id,
                database,
                table,
                action,
                target,
            )
            .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_show_create(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_show_create(state, connection_id, database, table).await
        }
        "postgresql" => {
            super::postgres_admin::postgres_show_create(state, connection_id, database, table).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_mutate_row(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    action: String,
    mutation: MysqlRowMutation,
) -> Result<u64, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_mutate_row(
                state,
                connection_id,
                database,
                table,
                action,
                mutation,
            )
            .await
        }
        "postgresql" => {
            super::postgres_admin::postgres_mutate_row(
                state,
                connection_id,
                database,
                table,
                action,
                mutation,
            )
            .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_apply_table_changes(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    changes: MysqlTableChangeSet,
) -> Result<u64, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_apply_table_changes(
                state,
                connection_id,
                database,
                table,
                changes,
            )
            .await
        }
        "postgresql" => {
            super::postgres_admin::postgres_apply_table_changes(
                state,
                connection_id,
                database,
                table,
                changes,
            )
            .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_import_csv(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
    csv: String,
) -> Result<u64, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => {
            super::mysql_admin::mysql_import_csv(state, connection_id, database, table, csv).await
        }
        "postgresql" => {
            super::postgres_admin::postgres_import_csv(state, connection_id, database, table, csv)
                .await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_import_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: MysqlSqlImportOptions,
) -> Result<MysqlSqlImportResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_import_sql(state, connection_id, options).await,
        "postgresql" => {
            super::postgres_admin::postgres_import_sql(state, connection_id, options).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}

#[tauri::command]
pub async fn database_export_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: MysqlSqlExportOptions,
) -> Result<MysqlSqlExportResult, String> {
    match connection_protocol(&state, &connection_id)?.as_str() {
        "mysql" => super::mysql_admin::mysql_export_sql(state, connection_id, options).await,
        "postgresql" => {
            super::postgres_admin::postgres_export_sql(state, connection_id, options).await
        }
        protocol => Err(format!("暂不支持的数据库协议: {protocol}")),
    }
}
