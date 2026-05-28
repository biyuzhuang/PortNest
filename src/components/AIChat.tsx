import { Component, createSignal, For, Show, onMount } from "solid-js";
import { api, ConnectionRecord, ChatMessage, AIAnalyzeResult } from "../utils/api";

interface AIChatProps {
  connection: ConnectionRecord;
}

interface MessageItem {
  id: number;
  role: string;
  content: string;
  analysis?: AIAnalyzeResult;
}

export const AIChat: Component<AIChatProps> = (props) => {
  const [messages, setMessages] = createSignal<MessageItem[]>([]);
  const [input, setInput] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);
  const [showAnalysis, setShowAnalysis] = createSignal<number | null>(null);
  let messageIdCounter = 0;
  let messagesEndRef: HTMLDivElement | undefined;

  const scrollToBottom = () => {
    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
  };

  const sendMessage = async () => {
    const text = input().trim();
    if (!text || isLoading()) return;

    setIsLoading(true);
    const userMessage: MessageItem = {
      id: ++messageIdCounter,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");

    try {
      const response = await api.chatWithAI(props.connection.id, text);
      const assistantMessage: MessageItem = {
        id: ++messageIdCounter,
        role: response.message.role,
        content: response.message.content,
        analysis: response.analysis,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      scrollToBottom();
    } catch (e) {
      const errorMessage: MessageItem = {
        id: ++messageIdCounter,
        role: "assistant",
        content: "抱歉，AI 分析失败: " + e,
      };
      setMessages((prev) => [...prev, errorMessage]);
      scrollToBottom();
    } finally {
      setIsLoading(false);
    }
  };

  const toggleAnalysis = (id: number) => {
    setShowAnalysis((prev) => (prev === id ? null : id));
  };

  const getHealthColor = (score: number) => {
    if (score >= 80) return "var(--success)";
    if (score >= 60) return "var(--warning)";
    return "var(--error)";
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "Critical": return "var(--error)";
      case "Error": return "var(--error)";
      case "Warning": return "var(--warning)";
      default: return "var(--accent)";
    }
  };

  return (
    <div class="ai-chat">
      <div class="chat-header">
        <span class="chat-title">
          AI 健康诊断 - {props.connection.name}
        </span>
        <span class="chat-subtitle">
          连接 {props.connection.host}:{props.connection.port}
        </span>
      </div>

      <div class="chat-messages">
        <Show when={messages().length === 0}>
          <div class="chat-empty">
            <p>欢迎使用 AI 健康诊断助手</p>
            <p>您可以询问关于连接的任何问题，例如:</p>
            <ul>
              <li>连接状态是否正常？</li>
              <li>有什么安全建议？</li>
              <li>如何优化连接性能？</li>
            </ul>
          </div>
        </Show>

        <For each={messages()}>
          {(msg) => (
            <div class={`chat-message chat-message-${msg.role}`}>
              <div class="message-content">{msg.content}</div>
              <Show when={msg.analysis}>
                <div class="message-analysis">
                  <button
                    class="btn-analysis-toggle"
                    onClick={() => toggleAnalysis(msg.id)}
                  >
                    {showAnalysis() === msg.id ? "隐藏详情" : "显示详情"}
                  </button>
                  <Show when={showAnalysis() === msg.id}>
                    <div class="analysis-details">
                      <div
                        class="health-score"
                        style={{ color: getHealthColor(msg.analysis!.health_score) }}
                      >
                        健康评分: {msg.analysis!.health_score}/100
                      </div>
                      <Show when={msg.analysis!.issues.length > 0}>
                        <div class="issues-list">
                          <For each={msg.analysis!.issues}>
                            {(issue) => (
                              <div
                                class="issue-item"
                                style={{ "border-left-color": getSeverityColor(issue.severity) }}
                              >
                                <div class="issue-title">
                                  [{issue.severity}] {issue.title}
                                </div>
                                <div class="issue-description">
                                  {issue.description}
                                </div>
                                <Show when={issue.suggestion}>
                                  <div class="issue-suggestion">
                                    建议: {issue.suggestion}
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={msg.analysis!.recommendations.length > 0}>
                        <div class="recommendations">
                          <div class="recommendations-title">优化建议:</div>
                          <For each={msg.analysis!.recommendations}>
                            {(rec) => <div class="recommendation-item">• {rec}</div>}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
        <Show when={isLoading()}>
          <div class="chat-message chat-message-assistant">
            <div class="message-content typing">
              <span class="typing-dot">.</span>
              <span class="typing-dot">.</span>
              <span class="typing-dot">.</span>
            </div>
          </div>
        </Show>
        <div ref={messagesEndRef} />
      </div>

      <div class="chat-input-container">
        <input
          type="text"
          class="chat-input"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="输入您的问题..."
          disabled={isLoading()}
        />
        <button
          class="btn-send"
          onClick={sendMessage}
          disabled={isLoading() || !input().trim()}
        >
          发送
        </button>
      </div>
    </div>
  );
};