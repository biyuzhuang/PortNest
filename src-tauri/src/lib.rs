//! PortNest - 一站式开发运维中枢

pub mod protocol;
pub mod connection;
pub mod storage;
pub mod ai;
pub mod commands;
pub mod error;

pub use error::{Error, Result};

use std::path::PathBuf;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn init_tracing(app_dir: &PathBuf) {
    let log_dir = app_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "portnest.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    std::mem::forget(_guard);

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .init();
}

fn init_app_state(app_dir: PathBuf) -> Result<commands::AppState> {
    init_tracing(&app_dir);
    tracing::info!("PortNest 启动中...");
    commands::AppState::new(app_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("PortNest");

    std::fs::create_dir_all(&app_dir).ok();

    let app_state = match init_app_state(app_dir.clone()) {
        Ok(state) => state,
        Err(e) => {
            eprintln!("初始化应用状态失败: {}", e);
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::save_connection,
            commands::get_connections,
            commands::delete_connection,
            commands::analyze_connection,
            commands::get_protocols,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}