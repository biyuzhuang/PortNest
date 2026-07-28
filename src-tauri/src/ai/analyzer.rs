//! AI 分析器实现

use super::{AIConfig, AnalyzeRequest, AnalyzeResult, Issue, IssueSeverity};
use crate::error::Result;

/// AI 分析器
pub struct AIAnalyzer {
    config: AIConfig,
    client: reqwest::Client,
}

impl AIAnalyzer {
    pub fn new(config: AIConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// 分析连接健康状况
    pub async fn analyze(&self, request: AnalyzeRequest) -> Result<AnalyzeResult> {
        let prompt = self.build_prompt(&request);
        let response = self.call_ai(&prompt).await?;
        self.parse_response(response)
    }

    fn build_prompt(&self, request: &AnalyzeRequest) -> String {
        let mut prompt = String::new();
        prompt.push_str("## 连接分析报告\n\n");
        prompt.push_str(&format!(
            "### 连接信息\n- 协议: {}\n- 主机: {}:{}\n- 连接耗时: {}ms\n\n",
            request.connection_metadata.protocol,
            request.connection_metadata.host,
            request.connection_metadata.port,
            request.connection_metadata.connection_time_ms
        ));
        if !request.command_history.is_empty() {
            prompt.push_str("### 命令历史\n");
            for (i, cmd) in request.command_history.iter().enumerate() {
                prompt.push_str(&format!("{}. {}\n", i + 1, cmd));
            }
            prompt.push('\n');
        }
        prompt.push_str(
            "请分析以上连接信息，提供:\n1. 健康评分 (0-100)\n2. 发现的问题列表\n3. 优化建议\n",
        );
        prompt
    }

    async fn call_ai(&self, prompt: &str) -> Result<String> {
        let endpoint = match &self.config.provider {
            super::AIProvider::OpenAI => "https://api.openai.com/v1/chat/completions",
            super::AIProvider::Anthropic => {
                return Err(crate::error::Error::ProtocolError(
                    "Anthropic API 暂未实现".to_string(),
                ))
            }
            super::AIProvider::Local => {
                return Err(crate::error::Error::ProtocolError(
                    "本地模型暂未实现".to_string(),
                ))
            }
            super::AIProvider::Custom { endpoint, .. } => endpoint.as_str(),
        };

        let api_key = self
            .config
            .api_key
            .as_ref()
            .ok_or_else(|| crate::error::Error::InvalidConfig("缺少 API key".to_string()))?;

        let body = serde_json::json!({
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": "你是一个运维专家，专注于分析和诊断服务器连接问题。"},
                {"role": "user", "content": prompt}
            ],
            "max_tokens": self.config.max_tokens.unwrap_or(4096)
        });

        let response = self
            .client
            .post(endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| crate::error::Error::ProtocolError(format!("AI API 调用失败: {}", e)))?;

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| crate::error::Error::ProtocolError(format!("解析 AI 响应失败: {}", e)))?;

        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                crate::error::Error::ProtocolError("无法提取 AI 响应内容".to_string())
            })?;

        Ok(content.to_string())
    }

    fn parse_response(&self, response: String) -> Result<AnalyzeResult> {
        let health_score = if response.contains("健康") || response.contains("良好") {
            85
        } else if response.contains("警告") || response.contains("问题") {
            60
        } else {
            70
        };

        let issues = if response.contains("延迟") {
            vec![Issue {
                severity: IssueSeverity::Warning,
                title: "检测到延迟问题".to_string(),
                description: "连接存在延迟，可能影响操作体验".to_string(),
                suggestion: Some("检查网络状况或使用压缩".to_string()),
            }]
        } else {
            vec![]
        };

        Ok(AnalyzeResult {
            summary: response,
            issues,
            recommendations: vec!["定期监控连接状态".to_string()],
            health_score,
        })
    }
}

impl Default for AIAnalyzer {
    fn default() -> Self {
        Self::new(AIConfig::default())
    }
}
