//! AI assistant commands and encrypted provider configuration.

use super::AppState;
use crate::ai::{
    AIChatMessage, AIChatRequest, AIChatResponse, AIClient, AIProviderConfig, AIProviderModel,
};

const AI_CONFIG_SECRET_ID: &str = "ai_provider_config";
const AI_PROVIDERS_SECRET_ID: &str = "ai_provider_configs";

fn normalize_provider_config(mut config: AIProviderConfig) -> AIProviderConfig {
    if config.id.trim().is_empty() {
        config.id = uuid::Uuid::new_v4().to_string();
    }
    if config.provider.trim().is_empty() {
        config.provider = "custom".to_string();
    }
    if config.protocol.trim().is_empty() {
        config.protocol = "openai_chat".to_string();
    }
    if config.display_name.trim().is_empty() {
        config.display_name = if config.provider == "custom" {
            "自定义供应商".to_string()
        } else {
            config.provider.clone()
        };
    }
    if config.proxy_mode.trim().is_empty() {
        config.proxy_mode = "auto".to_string();
    }
    // Migrate the legacy single-model fields into the model list.
    if config.models.is_empty() && !config.model.trim().is_empty() {
        config.models.push(AIProviderModel {
            model: config.model.clone(),
            enabled: config.enabled,
            context_window: config.context_window,
            max_output: config.max_output,
            temperature: config.temperature,
            ..AIProviderModel::default()
        });
    }
    let mut seen = std::collections::HashSet::new();
    config.models.retain(|model| {
        let name = model.model.trim();
        !name.is_empty() && seen.insert(name.to_string())
    });
    materialize_provider_config(config)
}

fn materialize_provider_config(mut config: AIProviderConfig) -> AIProviderConfig {
    if let Some(active_model) = config
        .models
        .iter()
        .find(|model| model.enabled)
        .or_else(|| config.models.first())
        .cloned()
    {
        config.model = active_model.model;
        config.context_window = active_model.context_window;
        config.max_output = active_model.max_output;
        config.temperature = active_model.temperature;
    }
    config
}

fn validate_provider_draft(config: &AIProviderConfig) -> Result<(), String> {
    if !config.endpoint.trim().is_empty()
        && !config.endpoint.trim().starts_with("http://")
        && !config.endpoint.trim().starts_with("https://")
    {
        return Err("API Endpoint 必须以 http:// 或 https:// 开头".to_string());
    }
    match config.protocol.as_str() {
        "openai_chat" | "anthropic" | "ollama" => Ok(()),
        other => Err(format!("暂不支持的 AI 协议: {other}")),
    }
}

fn load_provider_configs(state: &AppState) -> Result<Vec<AIProviderConfig>, String> {
    if let Some(value) = state
        .db
        .get_secret_json(AI_PROVIDERS_SECRET_ID)
        .map_err(|e| e.to_string())?
    {
        let configs = serde_json::from_value::<Vec<AIProviderConfig>>(value)
            .map_err(|e| format!("读取 AI 供应商配置失败: {e}"))?;
        return Ok(configs.into_iter().map(normalize_provider_config).collect());
    }

    // Migrate the legacy single-provider secret into the new provider list.
    if let Some(value) = state
        .db
        .get_secret_json(AI_CONFIG_SECRET_ID)
        .map_err(|e| e.to_string())?
    {
        let config = serde_json::from_value::<AIProviderConfig>(value)
            .map_err(|e| format!("读取旧版 AI 配置失败: {e}"))
            .map(normalize_provider_config)?;
        let configs = vec![config];
        save_provider_configs(state, &configs)?;
        return Ok(configs);
    }

    Ok(Vec::new())
}

fn save_provider_configs(state: &AppState, configs: &[AIProviderConfig]) -> Result<(), String> {
    let value = serde_json::to_value(configs).map_err(|e| e.to_string())?;
    state
        .db
        .save_secret_json(AI_PROVIDERS_SECRET_ID, &value)
        .map_err(|e| e.to_string())
}

fn active_provider_config(configs: &[AIProviderConfig]) -> Option<AIProviderConfig> {
    let normalized: Vec<AIProviderConfig> = configs
        .iter()
        .cloned()
        .map(normalize_provider_config)
        .collect();
    normalized
        .iter()
        .find(|config| {
            config.enabled
                && !config.endpoint.trim().is_empty()
                && config
                    .models
                    .iter()
                    .any(|model| model.enabled && !model.model.trim().is_empty())
        })
        .cloned()
        .or_else(|| normalized.first().cloned())
}

fn load_active_provider_config(state: &AppState) -> Result<AIProviderConfig, String> {
    let configs = load_provider_configs(state)?;
    let config = active_provider_config(&configs)
        .ok_or_else(|| "尚未配置 AI 模型，请先在 设置 → AI → 模型配置 中完成配置".to_string())?;
    validate_config(&config)?;
    Ok(config)
}

/// Resolve the provider/model requested by the Agent model switcher.
/// When no override is supplied, keep the legacy first-enabled-provider behavior.
fn resolve_chat_provider_config(
    state: &AppState,
    provider_id: Option<&str>,
    model_name: Option<&str>,
) -> Result<AIProviderConfig, String> {
    let requested_provider = provider_id.filter(|value| !value.trim().is_empty());
    let requested_model = model_name.filter(|value| !value.trim().is_empty());
    let mut config = if let Some(requested_provider) = requested_provider {
        let configs = load_provider_configs(state)?;
        let config = configs
            .into_iter()
            .map(normalize_provider_config)
            .find(|config| config.id == requested_provider)
            .ok_or_else(|| "所选 AI 供应商不存在，请重新选择模型".to_string())?;
        if !config.enabled {
            return Err("所选 AI 供应商已停用，请重新选择模型".to_string());
        }
        config
    } else if let Some(requested_model) = requested_model {
        let configs = load_provider_configs(state)?;
        let config = configs
            .into_iter()
            .map(normalize_provider_config)
            .find(|config| {
                config.enabled
                    && config.models.iter().any(|model| model.enabled && model.model == requested_model)
            })
            .ok_or_else(|| "所选模型未在任何已启用供应商中启用".to_string())?;
        config
    } else {
        load_active_provider_config(state)?
    };

    if let Some(requested_model) = requested_model {
        let selected = config
            .models
            .iter()
            .find(|model| model.enabled && model.model == requested_model)
            .cloned()
            .ok_or_else(|| format!("模型 {requested_model} 未在当前供应商中启用"))?;
        config.model = selected.model;
        config.context_window = selected.context_window;
        config.max_output = selected.max_output;
        config.temperature = selected.temperature;
    }

    validate_config(&config)?;
    Ok(config)
}

fn system_prompt(
    mode: &str,
    connection_context: Option<&str>,
    user_context: Option<&str>,
) -> String {
    let mode_instruction = match mode {
        "terminal" => {
            "你是 PortNest 的终端增强 Agent。请基于给出的主机和终端上下文，给出可执行的命令、排障步骤和风险提示。不要声称你已经执行了命令；涉及危险操作时必须明确警告。"
        }
        "sql" => {
            "你是 PortNest 的 SQL Agent。请帮助分析 SQL、解释执行计划、生成查询或修改语句，并说明表结构假设和潜在风险。删除、更新、DDL 等高风险语句必须明确提示确认。不要声称你已经执行了 SQL。"
        }
        _ => {
            "你是 PortNest 的通用开发运维 Agent。请结合服务器、终端、数据库和 Docker 上下文回答问题，优先给出清晰、可执行的步骤。"
        }
    };
    let mut prompt = String::from(mode_instruction);
    prompt.push_str("\n\n回答要求：\n1. 先给出结论或直接答案。\n2. 代码、命令和 SQL 使用 Markdown 代码块。\n3. 不确定的信息要明确说明，不要编造执行结果。\n4. 对高风险操作给出确认和回滚建议。\n");
    prompt.push_str(
        "\n## 工具调用协议\n你可以在用户明确需要执行操作时提出工具调用，但你绝对不会自行执行。需要执行时，在回复末尾单独输出一个标签：\n<portnest_tool_call>{\"name\":\"terminal.run\",\"arguments\":{\"command\":\"要执行的命令\"}}</portnest_tool_call>\n或：\n<portnest_tool_call>{\"name\":\"sql.execute\",\"arguments\":{\"sql\":\"要执行的 SQL\",\"database\":\"可选数据库名\"}}</portnest_tool_call>\n规则：一次只提出一个工具调用；如果只是解释、建议或代码示例，不要输出该标签；工具调用必须等待用户在 PortNest 界面中确认后才会执行。\n",
    );
    if let Some(context) = connection_context.filter(|value| !value.trim().is_empty()) {
        prompt.push_str("\n## 当前连接上下文\n");
        prompt.push_str(context);
        prompt.push('\n');
    }
    if let Some(context) = user_context.filter(|value| !value.trim().is_empty()) {
        prompt.push_str("\n## 用户提供的上下文\n");
        prompt.push_str(context);
        prompt.push('\n');
    }
    prompt
}

fn connection_context(
    state: &AppState,
    connection_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(connection_id) = connection_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let connection = state
        .db
        .get_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|item| item.id == connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    let options = connection
        .options
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let database = options
        .get("database")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(|value| format!("\n- 默认数据库: {value}"))
        .unwrap_or_default();
    Ok(Some(format!(
        "- 名称: {}\n- 协议: {}\n- 主机: {}:{}\n- 用户名: {}{}",
        connection.name,
        connection.protocol,
        connection.host,
        connection.port,
        connection.username.as_deref().unwrap_or("—"),
        database
    )))
}

fn validate_connection_config(config: &AIProviderConfig) -> Result<(), String> {
    if config.endpoint.trim().is_empty() {
        return Err("请填写 API Endpoint".to_string());
    }
    if !config.endpoint.trim().starts_with("http://")
        && !config.endpoint.trim().starts_with("https://")
    {
        return Err("API Endpoint 必须以 http:// 或 https:// 开头".to_string());
    }
    match config.protocol.as_str() {
        "openai_chat" | "anthropic" => {
            if config.api_key.trim().is_empty() {
                return Err("当前协议需要填写 API Key".to_string());
            }
        }
        "ollama" => {}
        other => return Err(format!("暂不支持的 AI 协议: {other}")),
    }
    Ok(())
}

fn validate_config(config: &AIProviderConfig) -> Result<(), String> {
    validate_connection_config(config)?;
    if config.model.trim().is_empty() {
        return Err("请填写模型 ID".to_string());
    }
    Ok(())
}

fn trim_messages(
    messages: &[AIChatMessage],
    context_window: u64,
    max_output: u32,
    system_prompt: &str,
) -> Vec<AIChatMessage> {
    if messages.is_empty() {
        return Vec::new();
    }
    let context_tokens = context_window.max(8_192);
    let output_tokens = u64::from(max_output.max(256));
    let budget_tokens = context_tokens.saturating_sub(output_tokens).max(2_048);
    // Rough token-to-character approximation for mixed Chinese and code.
    let budget_chars = budget_tokens.saturating_mul(3) as usize;
    let system_chars = system_prompt.chars().count();
    let mut remaining = budget_chars.saturating_sub(system_chars).max(1_024);
    let mut selected = Vec::new();
    for message in messages.iter().rev() {
        let chars = message.content.chars().count() + 24;
        if !selected.is_empty() && chars > remaining {
            break;
        }
        if chars > remaining {
            let kept: String = message
                .content
                .chars()
                .rev()
                .take(remaining)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            selected.push(AIChatMessage {
                role: message.role.clone(),
                content: kept,
            });
            break;
        }
        selected.push(message.clone());
        remaining = remaining.saturating_sub(chars);
    }
    selected.reverse();
    selected
}

#[tauri::command]
pub async fn ai_list_models(config: AIProviderConfig) -> Result<Vec<String>, String> {
    validate_connection_config(&config)?;
    let mut config = config;
    config.enabled = true;
    AIClient::new()
        .list_models(&config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_get_configs(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AIProviderConfig>, String> {
    load_provider_configs(&state)
}

/// 返回当前用于 AI 助手对话的供应商配置（第一个已启用且模型完整的配置）。
#[tauri::command]
pub async fn ai_get_config(
    state: tauri::State<'_, AppState>,
) -> Result<Option<AIProviderConfig>, String> {
    let configs = load_provider_configs(&state)?;
    Ok(active_provider_config(&configs))
}

#[tauri::command]
pub async fn ai_save_config(
    state: tauri::State<'_, AppState>,
    config: AIProviderConfig,
) -> Result<AIProviderConfig, String> {
    validate_provider_draft(&config)?;
    let config = normalize_provider_config(config);
    let mut configs = load_provider_configs(&state)?;
    if let Some(index) = configs.iter().position(|item| item.id == config.id) {
        configs[index] = config.clone();
    } else {
        configs.push(config.clone());
    }
    save_provider_configs(&state, &configs)?;
    Ok(config)
}

#[tauri::command]
pub async fn ai_delete_config(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut configs = load_provider_configs(&state)?;
    let previous_len = configs.len();
    configs.retain(|config| config.id != id);
    if configs.len() == previous_len {
        return Err("供应商配置不存在".to_string());
    }
    save_provider_configs(&state, &configs)
}

#[tauri::command]
pub async fn ai_test_config(config: AIProviderConfig) -> Result<String, String> {
    let mut config = materialize_provider_config(config);
    validate_config(&config)?;
    config.enabled = true;
    let client = AIClient::new();
    let messages = vec![AIChatMessage {
        role: "user".to_string(),
        content: "这是一次连接测试。请只回复：连接成功".to_string(),
    }];
    let content = client
        .complete(&config, "你是 API 连通性测试助手。", &messages)
        .await
        .map_err(|e| e.to_string())?;
    Ok(content.trim().to_string())
}

#[tauri::command]
pub async fn ai_chat(
    state: tauri::State<'_, AppState>,
    request: AIChatRequest,
) -> Result<AIChatResponse, String> {
    if request.messages.is_empty() {
        return Err("消息不能为空".to_string());
    }
    let config = resolve_chat_provider_config(&state, request.provider_id.as_deref(), request.model.as_deref())?;
    let context = connection_context(&state, request.connection_id.as_deref())?;
    let system = system_prompt(
        request.mode.as_str(),
        context.as_deref(),
        request.user_context.as_deref(),
    );
    let messages = trim_messages(
        &request.messages,
        config.context_window,
        config.max_output,
        &system,
    );
    let client = AIClient::new();
    let content = client
        .complete(&config, &system, &messages)
        .await
        .map_err(|e| e.to_string())?;
    Ok(AIChatResponse {
        content,
        provider: config.provider,
        model: config.model,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AIChatStreamEvent {
    pub kind: String,
    pub delta: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn ai_chat_stream(
    state: tauri::State<'_, AppState>,
    request: AIChatRequest,
    on_event: tauri::ipc::Channel<AIChatStreamEvent>,
) -> Result<(), String> {
    if request.messages.is_empty() {
        return Err("消息不能为空".to_string());
    }
    let config = resolve_chat_provider_config(&state, request.provider_id.as_deref(), request.model.as_deref())?;
    let context = connection_context(&state, request.connection_id.as_deref())?;
    let system = system_prompt(
        request.mode.as_str(),
        context.as_deref(),
        request.user_context.as_deref(),
    );
    let messages = trim_messages(
        &request.messages,
        config.context_window,
        config.max_output,
        &system,
    );
    let _ = on_event.send(AIChatStreamEvent {
        kind: "start".to_string(),
        delta: None,
        provider: Some(config.provider.clone()),
        model: Some(config.model.clone()),
    });
    let client = AIClient::new();
    let result = client
        .complete_stream(&config, &system, &messages, |delta| {
            let _ = on_event.send(AIChatStreamEvent {
                kind: "delta".to_string(),
                delta: Some(delta.to_string()),
                provider: None,
                model: None,
            });
        })
        .await;
    match result {
        Ok(content) => {
            let _ = on_event.send(AIChatStreamEvent {
                kind: "done".to_string(),
                delta: None,
                provider: Some(config.provider),
                model: Some(config.model),
            });
            let _ = content;
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AiToolAuditRequest {
    pub connection_id: Option<String>,
    pub mode: String,
    pub tool_name: String,
    pub payload: String,
    pub risk: String,
    pub status: String,
    pub result: Option<String>,
}

#[tauri::command]
pub async fn ai_audit_tool(
    state: tauri::State<'_, AppState>,
    request: AiToolAuditRequest,
) -> Result<crate::storage::AiToolAuditRecord, String> {
    let record = crate::storage::AiToolAuditRecord {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().timestamp(),
        connection_id: request.connection_id,
        mode: request.mode,
        tool_name: request.tool_name,
        payload: request.payload,
        risk: request.risk,
        status: request.status,
        result: request.result,
    };
    state
        .db
        .save_ai_tool_audit(&record)
        .map_err(|e| e.to_string())?;
    Ok(record)
}

#[tauri::command]
pub async fn ai_list_tool_audit(
    state: tauri::State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<crate::storage::AiToolAuditRecord>, String> {
    state
        .db
        .list_ai_tool_audit(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_clear_tool_audit(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.clear_ai_tool_audit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, enabled: bool, model: &str) -> AIProviderConfig {
        AIProviderConfig {
            id: id.to_string(),
            enabled,
            provider: "custom".to_string(),
            endpoint: "https://example.com/v1".to_string(),
            model: model.to_string(),
            ..AIProviderConfig::default()
        }
    }

    #[test]
    fn normalizes_missing_provider_id() {
        let normalized = normalize_provider_config(provider("", false, ""));
        assert!(!normalized.id.trim().is_empty());
    }

    #[test]
    fn prefers_first_enabled_and_complete_provider() {
        let configs = vec![
            provider("disabled", false, "model-a"),
            provider("incomplete", true, ""),
            provider("ready", true, "model-b"),
        ];
        let active = active_provider_config(&configs).expect("active provider");
        assert_eq!(active.id, "ready");
    }

    #[test]
    fn materializes_first_enabled_model_from_model_list() {
        let mut config = provider("provider", true, "legacy-model");
        config.models = vec![
            AIProviderModel {
                model: "model-a".to_string(),
                enabled: false,
                ..AIProviderModel::default()
            },
            AIProviderModel {
                model: "model-b".to_string(),
                enabled: true,
                context_window: 200_000,
                max_output: 8_192,
                temperature: Some(0.2),
                ..AIProviderModel::default()
            },
        ];
        let normalized = normalize_provider_config(config);
        assert_eq!(normalized.model, "model-b");
        assert_eq!(normalized.context_window, 200_000);
        assert_eq!(normalized.max_output, 8_192);
        assert_eq!(normalized.temperature, Some(0.2));
    }

    #[test]
    fn falls_back_to_first_provider_when_none_are_ready() {
        let configs = vec![provider("first", false, ""), provider("second", true, "")];
        let active = active_provider_config(&configs).expect("fallback provider");
        assert_eq!(active.id, "first");
    }
}
