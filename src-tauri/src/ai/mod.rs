//! AI 连接分析模块

mod analyzer;

pub use analyzer::AIAnalyzer;

use crate::error::{Error, Result};
use futures_util::StreamExt;
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

// ==================== AI assistant / provider client ====================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AIProviderConfig {
    pub enabled: bool,
    pub provider: String,
    pub protocol: String,
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub display_name: String,
    pub context_window: u64,
    pub max_output: u32,
    pub temperature: Option<f64>,
    pub custom_headers: std::collections::HashMap<String, String>,
}

impl Default for AIProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "custom".to_string(),
            protocol: "openai_chat".to_string(),
            endpoint: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            model: String::new(),
            display_name: "默认模型".to_string(),
            context_window: 128_000,
            max_output: 4096,
            temperature: None,
            custom_headers: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AIChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AIChatRequest {
    pub mode: String,
    pub messages: Vec<AIChatMessage>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub user_context: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AIChatResponse {
    pub content: String,
    pub provider: String,
    pub model: String,
}

pub struct AIClient {
    client: reqwest::Client,
}

impl AIClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    pub async fn complete(
        &self,
        config: &AIProviderConfig,
        system_prompt: &str,
        messages: &[AIChatMessage],
    ) -> Result<String> {
        if !config.enabled {
            return Err(Error::InvalidConfig("AI 模型未启用".to_string()));
        }
        if config.model.trim().is_empty() {
            return Err(Error::InvalidConfig("请填写模型 ID".to_string()));
        }
        if config.endpoint.trim().is_empty() {
            return Err(Error::InvalidConfig("请填写 API Endpoint".to_string()));
        }
        match config.protocol.as_str() {
            "openai_chat" | "ollama" => {
                self.complete_openai_chat(config, system_prompt, messages)
                    .await
            }
            "anthropic" => {
                self.complete_anthropic(config, system_prompt, messages)
                    .await
            }
            other => Err(Error::InvalidConfig(format!("暂不支持的 AI 协议: {other}"))),
        }
    }

    pub async fn complete_stream<F>(
        &self,
        config: &AIProviderConfig,
        system_prompt: &str,
        messages: &[AIChatMessage],
        mut on_delta: F,
    ) -> Result<String>
    where
        F: FnMut(&str) + Send,
    {
        if !config.enabled {
            return Err(Error::InvalidConfig("AI 模型未启用".to_string()));
        }
        if config.model.trim().is_empty() {
            return Err(Error::InvalidConfig("请填写模型 ID".to_string()));
        }
        if config.endpoint.trim().is_empty() {
            return Err(Error::InvalidConfig("请填写 API Endpoint".to_string()));
        }
        match config.protocol.as_str() {
            "openai_chat" | "ollama" => {
                self.stream_openai_chat(config, system_prompt, messages, &mut on_delta)
                    .await
            }
            "anthropic" => {
                self.stream_anthropic(config, system_prompt, messages, &mut on_delta)
                    .await
            }
            other => Err(Error::InvalidConfig(format!("暂不支持的 AI 协议: {other}"))),
        }
    }

    async fn stream_openai_chat(
        &self,
        config: &AIProviderConfig,
        system_prompt: &str,
        messages: &[AIChatMessage],
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        let endpoint = endpoint_with_path(&config.endpoint, "/chat/completions");
        let mut payload_messages = vec![serde_json::json!({
            "role": "system",
            "content": system_prompt,
        })];
        for message in messages {
            payload_messages.push(serde_json::json!({
                "role": message.role,
                "content": message.content,
            }));
        }
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": payload_messages,
            "max_tokens": config.max_output.max(1),
            "stream": true,
        });
        if let Some(temperature) = config.temperature {
            body["temperature"] = serde_json::json!(temperature.clamp(0.0, 2.0));
        }
        let mut request = self
            .client
            .post(endpoint)
            .header("Content-Type", "application/json");
        if !config.api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", config.api_key.trim()));
        }
        for (key, value) in &config.custom_headers {
            if !key.trim().is_empty() {
                request = request.header(key, value);
            }
        }
        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::ProtocolError(format!("AI API 调用失败: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(Error::ProtocolError(format!(
                "AI API 返回 HTTP {}: {}",
                status.as_u16(),
                truncate_text(&text, 1200)
            )));
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut raw = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::ProtocolError(format!("读取 AI 流失败: {e}")))?;
            let text = String::from_utf8_lossy(&chunk);
            raw.push_str(&text);
            buffer.push_str(&text);
            while let Some(index) = buffer.find('\n') {
                let line = buffer.drain(..=index).collect::<String>();
                let line = line.trim_end_matches(['\r', '\n']);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) = json
                        .pointer("/choices/0/delta/content")
                        .and_then(|value| value.as_str())
                    {
                        if !delta.is_empty() {
                            full.push_str(delta);
                            on_delta(delta);
                        }
                    }
                }
            }
        }
        if full.is_empty() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(content) = json
                    .pointer("/choices/0/message/content")
                    .and_then(|value| value.as_str())
                {
                    full.push_str(content);
                    on_delta(content);
                }
            }
        }
        if full.is_empty() {
            return Err(Error::ProtocolError("流式接口没有返回文本内容".to_string()));
        }
        Ok(full)
    }

    async fn stream_anthropic(
        &self,
        config: &AIProviderConfig,
        system_prompt: &str,
        messages: &[AIChatMessage],
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        let endpoint = endpoint_with_path(&config.endpoint, "/messages");
        let payload_messages: Vec<serde_json::Value> = messages
            .iter()
            .filter(|message| message.role == "user" || message.role == "assistant")
            .map(|message| {
                serde_json::json!({
                    "role": message.role,
                    "content": message.content,
                })
            })
            .collect();
        let mut body = serde_json::json!({
            "model": config.model,
            "system": system_prompt,
            "messages": payload_messages,
            "max_tokens": config.max_output.max(1),
            "stream": true,
        });
        if let Some(temperature) = config.temperature {
            body["temperature"] = serde_json::json!(temperature.clamp(0.0, 1.0));
        }
        let mut request = self
            .client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01");
        if !config.api_key.trim().is_empty() {
            request = request.header("x-api-key", config.api_key.trim());
        }
        for (key, value) in &config.custom_headers {
            if !key.trim().is_empty() {
                request = request.header(key, value);
            }
        }
        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::ProtocolError(format!("AI API 调用失败: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(Error::ProtocolError(format!(
                "AI API 返回 HTTP {}: {}",
                status.as_u16(),
                truncate_text(&text, 1200)
            )));
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut raw = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::ProtocolError(format!("读取 AI 流失败: {e}")))?;
            let text = String::from_utf8_lossy(&chunk);
            raw.push_str(&text);
            buffer.push_str(&text);
            while let Some(index) = buffer.find('\n') {
                let line = buffer.drain(..=index).collect::<String>();
                let line = line.trim_end_matches(['\r', '\n']);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) =
                        json.pointer("/delta/text").and_then(|value| value.as_str())
                    {
                        if !delta.is_empty() {
                            full.push_str(delta);
                            on_delta(delta);
                        }
                    } else if let Some(content) = json
                        .pointer("/content_block/text")
                        .and_then(|value| value.as_str())
                    {
                        if !content.is_empty() {
                            full.push_str(content);
                            on_delta(content);
                        }
                    }
                }
            }
        }
        if full.is_empty() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(content) =
                    json.get("content")
                        .and_then(|value| value.as_array())
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| {
                                    part.get("text").and_then(|value| value.as_str())
                                })
                                .collect::<Vec<_>>()
                                .join("")
                        })
                {
                    if !content.is_empty() {
                        full.push_str(&content);
                        on_delta(&content);
                    }
                }
            }
        }
        if full.is_empty() {
            return Err(Error::ProtocolError("流式接口没有返回文本内容".to_string()));
        }
        Ok(full)
    }

    pub async fn list_models(&self, config: &AIProviderConfig) -> Result<Vec<String>> {
        if config.endpoint.trim().is_empty() {
            return Err(Error::InvalidConfig("请填写 API Endpoint".to_string()));
        }
        let (endpoint, headers) = match config.protocol.as_str() {
            "openai_chat" | "ollama" => (endpoint_with_path(&config.endpoint, "/models"), true),
            "anthropic" => (endpoint_with_path(&config.endpoint, "/models"), false),
            other => return Err(Error::InvalidConfig(format!("暂不支持的 AI 协议: {other}"))),
        };
        let mut request = self.client.get(endpoint);
        if headers {
            if !config.api_key.trim().is_empty() {
                request =
                    request.header("Authorization", format!("Bearer {}", config.api_key.trim()));
            }
        } else {
            request = request.header("anthropic-version", "2023-06-01");
            if !config.api_key.trim().is_empty() {
                request = request.header("x-api-key", config.api_key.trim());
            }
        }
        for (key, value) in &config.custom_headers {
            if !key.trim().is_empty() {
                request = request.header(key, value);
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| Error::ProtocolError(format!("获取模型列表失败: {e}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| Error::ProtocolError(format!("读取模型列表失败: {e}")))?;
        if !status.is_success() {
            return Err(Error::ProtocolError(format!(
                "模型列表接口返回 HTTP {}: {}",
                status.as_u16(),
                truncate_text(&text, 1000)
            )));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| Error::ProtocolError(format!("解析模型列表失败: {e}")))?;
        let mut models: Vec<String> = json
            .get("data")
            .and_then(|value| value.as_array())
            .or_else(|| json.get("models").and_then(|value| value.as_array()))
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("id")
                            .or_else(|| item.get("name"))
                            .and_then(|value| value.as_str())
                    })
                    .map(|value| value.to_string())
                    .collect()
            })
            .unwrap_or_default();
        models.sort();
        models.dedup();
        if models.is_empty() {
            return Err(Error::ProtocolError(
                "接口没有返回可用模型，请手动填写模型 ID".to_string(),
            ));
        }
        Ok(models)
    }

    async fn complete_openai_chat(
        &self,
        config: &AIProviderConfig,
        system_prompt: &str,
        messages: &[AIChatMessage],
    ) -> Result<String> {
        let endpoint = endpoint_with_path(&config.endpoint, "/chat/completions");
        let mut payload_messages = vec![serde_json::json!({
            "role": "system",
            "content": system_prompt,
        })];
        for message in messages {
            payload_messages.push(serde_json::json!({
                "role": message.role,
                "content": message.content,
            }));
        }
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": payload_messages,
            "max_tokens": config.max_output.max(1),
        });
        if let Some(temperature) = config.temperature {
            body["temperature"] = serde_json::json!(temperature.clamp(0.0, 2.0));
        }
        let mut request = self
            .client
            .post(endpoint)
            .header("Content-Type", "application/json");
        if !config.api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", config.api_key.trim()));
        }
        for (key, value) in &config.custom_headers {
            if !key.trim().is_empty() {
                request = request.header(key, value);
            }
        }
        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::ProtocolError(format!("AI API 调用失败: {e}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| Error::ProtocolError(format!("读取 AI 响应失败: {e}")))?;
        if !status.is_success() {
            return Err(Error::ProtocolError(format!(
                "AI API 返回 HTTP {}: {}",
                status.as_u16(),
                truncate_text(&text, 1200)
            )));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| Error::ProtocolError(format!("解析 AI 响应失败: {e}")))?;
        let content = json
            .pointer("/choices/0/message/content")
            .and_then(|value| value.as_str())
            .or_else(|| {
                json.pointer("/choices/0/text")
                    .and_then(|value| value.as_str())
            })
            .or_else(|| json.get("response").and_then(|value| value.as_str()))
            .ok_or_else(|| Error::ProtocolError("无法提取 AI 响应内容".to_string()))?;
        Ok(content.to_string())
    }

    async fn complete_anthropic(
        &self,
        config: &AIProviderConfig,
        system_prompt: &str,
        messages: &[AIChatMessage],
    ) -> Result<String> {
        let endpoint = endpoint_with_path(&config.endpoint, "/messages");
        let payload_messages: Vec<serde_json::Value> = messages
            .iter()
            .filter(|message| message.role == "user" || message.role == "assistant")
            .map(|message| {
                serde_json::json!({
                    "role": message.role,
                    "content": message.content,
                })
            })
            .collect();
        let mut body = serde_json::json!({
            "model": config.model,
            "system": system_prompt,
            "messages": payload_messages,
            "max_tokens": config.max_output.max(1),
        });
        if let Some(temperature) = config.temperature {
            body["temperature"] = serde_json::json!(temperature.clamp(0.0, 1.0));
        }
        let mut request = self
            .client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01");
        if !config.api_key.trim().is_empty() {
            request = request.header("x-api-key", config.api_key.trim());
        }
        for (key, value) in &config.custom_headers {
            if !key.trim().is_empty() {
                request = request.header(key, value);
            }
        }
        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::ProtocolError(format!("AI API 调用失败: {e}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| Error::ProtocolError(format!("读取 AI 响应失败: {e}")))?;
        if !status.is_success() {
            return Err(Error::ProtocolError(format!(
                "AI API 返回 HTTP {}: {}",
                status.as_u16(),
                truncate_text(&text, 1200)
            )));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| Error::ProtocolError(format!("解析 AI 响应失败: {e}")))?;
        let content = json
            .get("content")
            .and_then(|value| value.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::ProtocolError("无法提取 AI 响应内容".to_string()))?;
        Ok(content)
    }
}

impl Default for AIClient {
    fn default() -> Self {
        Self::new()
    }
}

fn endpoint_with_path(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with(path) {
        base.to_string()
    } else {
        format!("{base}{path}")
    }
}

fn truncate_text(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(limit).collect::<String>())
    }
}
