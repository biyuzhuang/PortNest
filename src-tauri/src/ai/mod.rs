//! AI 连接分析模块

mod analyzer;

pub use analyzer::AIAnalyzer;

use serde::{Deserialize, Serialize};

/// AI 提供商类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AIProvider {
    OpenAI,
    Anthropic,
    Local,
    Custom { name: String, endpoint: String },
}

/// AI 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub provider: AIProvider,
    pub api_key: Option<String>,
    pub model: String,
    pub max_tokens: Option<u32>,
}

impl Default for AIConfig {
    fn default() -> Self {
        Self {
            provider: AIProvider::OpenAI,
            api_key: None,
            model: "gpt-4".to_string(),
            max_tokens: Some(4096),
        }
    }
}

/// 连接分析请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeRequest {
    pub session_id: String,
    pub command_history: Vec<String>,
    pub connection_metadata: ConnectionInfo,
}

/// 连接信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub connection_time_ms: u64,
}

/// 分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeResult {
    pub summary: String,
    pub issues: Vec<Issue>,
    pub recommendations: Vec<String>,
    pub health_score: u8,
}

/// 问题
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub severity: IssueSeverity,
    pub title: String,
    pub description: String,
    pub suggestion: Option<String>,
}

/// 问题严重性
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum IssueSeverity {
    Info,
    Warning,
    Error,
    Critical,
}