import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { api, isDatabaseProtocol, type AIChatMessage, type AIProviderConfig, type ConnectionRecord } from "../utils/api";
import { openSettingsWindow } from "../utils/settingsWindow";
import { Icon } from "./Icon";
import "./AIAssistant.css";

interface AIAssistantProps {
  connection?: ConnectionRecord;
  shellId?: string;
  initialMode?: AssistantMode;
  onModeChange?: (mode: AssistantMode) => void;
  terminalContext?: () => string;
  sqlContext?: () => string;
  onClose: () => void;
}

export type AssistantMode = "general" | "terminal" | "sql";
type ToolCallStatus = "pending" | "running" | "success" | "error" | "rejected";
interface ToolCallState {
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  confirmingRisk?: boolean;
}
interface ChatItem { id: number; role: "user" | "assistant"; content: string; apiContent?: string; toolCall?: ToolCallState }

interface AIConversation {
  id: string;
  title: string;
  mode: AssistantMode;
  messages: ChatItem[];
  presetId?: string;
  createdAt: number;
  updatedAt: number;
}

interface AIPromptPreset {
  id: string;
  title: string;
  content: string;
  createdAt: number;
}

interface AISilentPermissions {
  silentReadFiles: boolean;
  silentModifyFiles: boolean;
  silentReadOnlySql: boolean;
  silentRunCommands: boolean;
  blockUnreferencedAssets: boolean;
  disableLocalExecution: boolean;
}

const AI_CONVERSATIONS_STORAGE_KEY = "portnest-ai-conversations-v1";
const AI_ACTIVE_CONVERSATION_STORAGE_KEY = "portnest-ai-active-conversation-v1";
const AI_PROMPT_PRESETS_STORAGE_KEY = "portnest-ai-prompt-presets-v1";
const AI_PERMISSIONS_STORAGE_KEY = "portnest-ai-permissions-v1";
const AI_CONVERSATION_LIMIT = 30;

const DEFAULT_AI_PERMISSIONS: AISilentPermissions = {
  silentReadFiles: true,
  silentModifyFiles: false,
  silentReadOnlySql: true,
  silentRunCommands: false,
  blockUnreferencedAssets: false,
  disableLocalExecution: false,
};

const PERMISSION_ROWS: Array<{
  key: keyof AISilentPermissions;
  label: string;
  description: string;
  icon: "file" | "edit" | "database" | "terminal" | "link" | "lock";
}> = [
  { key: "silentReadFiles", label: "静默读取文件", description: "读取工作区文件时不逐次确认", icon: "file" },
  { key: "silentModifyFiles", label: "静默修改文件", description: "允许 AI 自动修改文件内容", icon: "edit" },
  { key: "silentReadOnlySql", label: "静默执行只读 SQL", description: "SELECT / SHOW / EXPLAIN 自动执行", icon: "database" },
  { key: "silentRunCommands", label: "静默执行命令", description: "低风险终端命令自动执行", icon: "terminal" },
  { key: "blockUnreferencedAssets", label: "拦截未 @ 引用资产", description: "只允许操作消息中显式引用的资产", icon: "link" },
  { key: "disableLocalExecution", label: "禁止本地执行", description: "禁止 AI 在本地终端执行命令", icon: "lock" },
];

const loadAIPermissions = (): AISilentPermissions => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_PERMISSIONS_STORAGE_KEY) || "{}") as Partial<AISilentPermissions>;
    return { ...DEFAULT_AI_PERMISSIONS, ...parsed };
  } catch {
    return { ...DEFAULT_AI_PERMISSIONS };
  }
};

const loadPromptPresets = (): AIPromptPreset[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_PROMPT_PRESETS_STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const preset = value as Partial<AIPromptPreset>;
      if (typeof preset.id !== "string" || typeof preset.title !== "string" || typeof preset.content !== "string") return [];
      return [{
        id: preset.id,
        title: preset.title,
        content: preset.content,
        createdAt: typeof preset.createdAt === "number" ? preset.createdAt : Date.now(),
      }];
    });
  } catch {
    return [];
  }
};

const newConversationId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const createConversationRecord = (mode: AssistantMode): AIConversation => ({
  id: newConversationId(),
  title: "新对话",
  mode,
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const loadConversationRecords = (): AIConversation[] => {
  try {
    const raw = localStorage.getItem(AI_CONVERSATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const record = value as Partial<AIConversation>;
      if (typeof record.id !== "string" || !Array.isArray(record.messages)) return [];
      const mode: AssistantMode = record.mode === "terminal" || record.mode === "sql" ? record.mode : "general";
      const messages = record.messages.filter((message): message is ChatItem =>
        Boolean(message) && typeof message === "object"
        && typeof (message as ChatItem).id === "number"
        && ((message as ChatItem).role === "user" || (message as ChatItem).role === "assistant")
        && typeof (message as ChatItem).content === "string"
      );
      return [{
        id: record.id,
        title: typeof record.title === "string" && record.title.trim() ? record.title : "新对话",
        mode,
        messages,
        presetId: typeof record.presetId === "string" ? record.presetId : undefined,
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
      }];
    }).slice(0, AI_CONVERSATION_LIMIT);
  } catch {
    return [];
  }
};

const conversationTitleFrom = (content: string) => {
  const title = content.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 28) : "新对话";
};

const modeLabel = (mode: AssistantMode) => MODES.find(item => item.id === mode)?.label || "通用 Agent";

const formatConversationTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
};

const MODES: Array<{ id: AssistantMode; label: string; description: string; icon: "sparkles" | "terminal" | "database" }> = [
  { id: "general", label: "通用 Agent", description: "运维、配置与日常开发问题", icon: "sparkles" },
  { id: "terminal", label: "终端增强", description: "命令、排障与 Shell 操作", icon: "terminal" },
  { id: "sql", label: "SQL Agent", description: "查询、表结构与 SQL 审查", icon: "database" },
];

const SUGGESTIONS: Record<AssistantMode, string[]> = {
  general: ["帮我梳理这台服务器的排查思路", "根据当前连接给出安全加固建议", "解释这个项目可能的部署方式"],
  terminal: ["检查磁盘占用并给出清理命令", "如何排查 SSH 连接超时？", "写一个安全的日志轮转脚本"],
  sql: ["帮我优化一条慢查询", "解释当前数据库表结构设计", "生成一个带索引建议的建表 SQL"],
};

type MessagePart = { type: "text" | "code"; content: string; language?: string };

const visibleAssistantText = (content: string) => {
  const marker = content.indexOf("<portnest_tool_call>");
  return (marker >= 0 ? content.slice(0, marker) : content).trimEnd();
};

const parseToolCall = (content: string): { text: string; toolCall?: Omit<ToolCallState, "status"> } => {
  const match = content.match(/<portnest_tool_call>\s*([\s\S]*?)\s*<\/portnest_tool_call>/i);
  if (!match) return { text: content.trim() };
  const text = content.replace(match[0], "").trim();
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed?.name === "string" && parsed.name.trim()) {
      return {
        text,
        toolCall: {
          name: parsed.name,
          arguments: parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {},
        },
      };
    }
  } catch {
    // Malformed tool call: keep model text so the user can inspect it.
  }
  return { text: content.replace(match[0], "").trim() };
};

const toolPayload = (tool: ToolCallState) =>
  tool.name === "terminal.run"
    ? String(tool.arguments.command || "")
    : String(tool.arguments.sql || "");

const toolRisk = (tool: ToolCallState): "low" | "medium" | "high" => {
  const payload = toolPayload(tool);
  if (tool.name === "terminal.run") {
    return /(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|init\s+0|:\(\)\s*\{|chmod\s+-R\s+777|>\s*\/dev\/sd|curl[^\n]*\|\s*(sh|bash))/i.test(payload)
      ? "high"
      : /(sudo|systemctl|service\s+\w+\s+(stop|restart)|kill\s+-9|mv\s+)/i.test(payload)
        ? "medium"
        : "low";
  }
  if (tool.name === "sql.execute") {
    return /(drop\s+(database|table)|truncate\s+table|delete\s+from|alter\s+table|update\s+\w+\s+set)/i.test(payload)
      ? "high"
      : /(insert\s+into|create\s+table|create\s+index|replace\s+into)/i.test(payload)
        ? "medium"
        : "low";
  }
  return "medium";
};

const toolTitle = (name: string) =>
  name === "terminal.run" ? "请求执行终端命令" : name === "sql.execute" ? "请求执行 SQL" : "请求执行工具";

const splitMessage = (content: string): MessagePart[] => {
  const parts: MessagePart[] = [];
  const pattern = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ type: "text", content: content.slice(lastIndex, index) });
    parts.push({ type: "code", language: match[1] || undefined, content: match[2].trimEnd() });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < content.length) parts.push({ type: "text", content: content.slice(lastIndex) });
  return parts.length ? parts : [{ type: "text", content }];
};

export const AIAssistant: Component<AIAssistantProps> = (props) => {
  const loadedConversations = loadConversationRecords();
  const requestedMode = props.initialMode || "general";
  if (loadedConversations.length === 0) loadedConversations.push(createConversationRecord(requestedMode));
  const storedActiveId = localStorage.getItem(AI_ACTIVE_CONVERSATION_STORAGE_KEY);
  const initialConversation = loadedConversations.find(item => item.id === storedActiveId) || loadedConversations[0];
  const [conversations, setConversations] = createSignal<AIConversation[]>(loadedConversations);
  const [activeConversationId, setActiveConversationId] = createSignal(initialConversation.id);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [permissions, setPermissions] = createSignal<AISilentPermissions>(loadAIPermissions());
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [promptPresets, setPromptPresets] = createSignal<AIPromptPreset[]>(loadPromptPresets());
  const [presetsOpen, setPresetsOpen] = createSignal(false);
  const [presetSearch, setPresetSearch] = createSignal("");
  const [presetDraft, setPresetDraft] = createSignal<{ title: string; content: string } | null>(null);
  const [modelInfoOpen, setModelInfoOpen] = createSignal(false);
  const [mode, setMode] = createSignal<AssistantMode>(requestedMode || initialConversation.mode);
  const [panelWidth, setPanelWidth] = createSignal(
    Math.max(50, Math.min(620, Number(localStorage.getItem("portnest-ai-panel-width")) || 390))
  );
  const [input, setInput] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [config, setConfig] = createSignal<AIProviderConfig | null>(null);
  const [configLoading, setConfigLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  let nextId = loadedConversations.reduce(
    (max, conversation) => Math.max(max, ...conversation.messages.map(message => message.id), 0),
    0,
  );
  let messagesEnd: HTMLDivElement | undefined;
  let persistTimer: number | undefined;

  const activeConversation = createMemo(() => conversations().find(item => item.id === activeConversationId()) || conversations()[0]);
  const sortedConversations = createMemo(() =>
    [...conversations()].sort((left, right) => right.updatedAt - left.updatedAt)
  );
  const messages = createMemo<ChatItem[]>(() => activeConversation()?.messages || []);
  const activePreset = createMemo(() =>
    promptPresets().find(preset => preset.id === activeConversation()?.presetId)
  );
  const filteredPromptPresets = createMemo(() => {
    const query = presetSearch().trim().toLowerCase();
    if (!query) return promptPresets();
    return promptPresets().filter(preset =>
      preset.title.toLowerCase().includes(query) || preset.content.toLowerCase().includes(query)
    );
  });
  const contextWindowLabel = createMemo(() => {
    const value = config()?.context_window;
    if (!value) return "--";
    return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
  });

  const setMessages = (updater: ChatItem[] | ((previous: ChatItem[]) => ChatItem[])) => {
    const conversationId = activeConversationId();
    setConversations(previous => previous.map(conversation => {
      if (conversation.id !== conversationId) return conversation;
      const nextMessages = typeof updater === "function" ? updater(conversation.messages) : updater;
      const firstUserMessage = nextMessages.find(message => message.role === "user");
      return {
        ...conversation,
        title: conversation.title === "新对话" && firstUserMessage
          ? conversationTitleFrom(firstUserMessage.content)
          : conversation.title,
        messages: nextMessages,
        updatedAt: Date.now(),
      };
    }));
  };

  const applyMode = (nextMode: AssistantMode, notify = true) => {
    setMode(nextMode);
    const conversationId = activeConversationId();
    setConversations(previous => previous.map(conversation =>
      conversation.id === conversationId ? { ...conversation, mode: nextMode } : conversation
    ));
    if (notify) props.onModeChange?.(nextMode);
    setError("");
  };

  const closeUtilityPopovers = () => {
    setPermissionsOpen(false);
    setPresetsOpen(false);
    setModelInfoOpen(false);
  };

  const togglePermissionsPopover = () => {
    const next = !permissionsOpen();
    closeUtilityPopovers();
    setPermissionsOpen(next);
  };

  const togglePresetsPopover = () => {
    const next = !presetsOpen();
    closeUtilityPopovers();
    setPresetsOpen(next);
  };

  const toggleModelInfoPopover = () => {
    const next = !modelInfoOpen();
    closeUtilityPopovers();
    setModelInfoOpen(next);
  };

  const togglePermission = (key: keyof AISilentPermissions) => {
    setPermissions(previous => ({ ...previous, [key]: !previous[key] }));
  };

  const choosePreset = (presetId: string | null) => {
    const conversationId = activeConversationId();
    setConversations(previous => previous.map(conversation =>
      conversation.id === conversationId ? { ...conversation, presetId: presetId || undefined } : conversation
    ));
    setPresetSearch("");
    setPresetDraft(null);
    setPresetsOpen(false);
  };

  const startNewPreset = () => {
    setPresetDraft({ title: "", content: "" });
  };

  const extractCurrentConversation = () => {
    const transcript = messages()
      .filter(message => message.content.trim())
      .slice(-8)
      .map(message => `${message.role === "user" ? "用户" : "助手"}：${message.content.trim()}`)
      .join("\n\n");
    setPresetDraft({
      title: `${activeConversation()?.title || "当前会话"} · 提取`,
      content: transcript
        ? `以下是从当前会话中提取的上下文，请延续其中的沟通方式和任务目标：\n\n${transcript}`
        : "请基于当前会话继续提供简洁、准确、可执行的回答。",
    });
  };

  const savePresetDraft = () => {
    const draft = presetDraft();
    if (!draft || !draft.title.trim() || !draft.content.trim()) return;
    const preset: AIPromptPreset = {
      id: newConversationId(),
      title: draft.title.trim().slice(0, 40),
      content: draft.content.trim(),
      createdAt: Date.now(),
    };
    setPromptPresets(previous => [preset, ...previous]);
    choosePreset(preset.id);
  };

  const deletePromptPreset = (presetId: string, event: MouseEvent) => {
    event.stopPropagation();
    setPromptPresets(previous => previous.filter(preset => preset.id !== presetId));
    const conversationId = activeConversationId();
    setConversations(previous => previous.map(conversation =>
      conversation.id === conversationId && conversation.presetId === presetId
        ? { ...conversation, presetId: undefined }
        : conversation
    ));
  };

  const hasReferencedCurrentAsset = () => {
    const connection = props.connection;
    if (!connection) return false;
    const recentUserText = messages()
      .filter(message => message.role === "user")
      .slice(-6)
      .map(message => message.content)
      .join("\n");
    return [connection.name, connection.host, connection.username, connection.id]
      .filter(Boolean)
      .some(value => recentUserText.includes(`@${value}`));
  };

  const isReadOnlySql = (sql: string) => /^(select|show|describe|desc|explain)\b/i.test(sql.trim());

  const shouldAutoApprove = (tool: Omit<ToolCallState, "status"> | ToolCallState) => {
    const currentPermissions = permissions();
    if (currentPermissions.blockUnreferencedAssets && !hasReferencedCurrentAsset()) return false;
    if (tool.name === "terminal.run" && currentPermissions.disableLocalExecution && props.connection?.protocol === "local") return false;
    if (tool.name === "file.read" && currentPermissions.silentReadFiles) return true;
    if (tool.name === "file.write" && currentPermissions.silentModifyFiles) return true;
    if (tool.name === "sql.execute" && currentPermissions.silentReadOnlySql && isReadOnlySql(toolPayload(tool as ToolCallState))) return true;
    if (tool.name === "terminal.run" && currentPermissions.silentRunCommands && toolRisk(tool as ToolCallState) === "low") return true;
    return false;
  };

  const startNewConversation = () => {
    const conversation = createConversationRecord(mode());
    setConversations(previous => [conversation, ...previous].slice(0, AI_CONVERSATION_LIMIT));
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setInput("");
    setError("");
    requestAnimationFrame(() => messagesEnd?.scrollIntoView({ behavior: "smooth" }));
  };

  const switchConversation = (conversationId: string) => {
    const conversation = conversations().find(item => item.id === conversationId);
    if (!conversation) return;
    setActiveConversationId(conversation.id);
    setMode(conversation.mode);
    props.onModeChange?.(conversation.mode);
    setHistoryOpen(false);
    setError("");
    requestAnimationFrame(() => messagesEnd?.scrollIntoView({ behavior: "smooth" }));
  };

  const deleteConversation = (conversationId: string, event: MouseEvent) => {
    event.stopPropagation();
    const remaining = conversations().filter(item => item.id !== conversationId);
    if (remaining.length === 0) remaining.push(createConversationRecord(mode()));
    setConversations(remaining);
    if (conversationId === activeConversationId()) {
      setActiveConversationId(remaining[0].id);
      setMode(remaining[0].mode);
      props.onModeChange?.(remaining[0].mode);
    }
  };

  createEffect(() => {
    const snapshot = conversations();
    const activeId = activeConversationId();
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AI_CONVERSATIONS_STORAGE_KEY, JSON.stringify(snapshot.slice(0, AI_CONVERSATION_LIMIT)));
        localStorage.setItem(AI_ACTIVE_CONVERSATION_STORAGE_KEY, activeId);
      } catch (error) {
        console.warn("[ai] unable to persist conversations", error);
      }
    }, 260);
  });

  createEffect(() => {
    try {
      localStorage.setItem(AI_PERMISSIONS_STORAGE_KEY, JSON.stringify(permissions()));
    } catch (error) {
      console.warn("[ai] unable to persist permissions", error);
    }
  });

  createEffect(() => {
    try {
      localStorage.setItem(AI_PROMPT_PRESETS_STORAGE_KEY, JSON.stringify(promptPresets()));
    } catch (error) {
      console.warn("[ai] unable to persist prompt presets", error);
    }
  });

  onCleanup(() => window.clearTimeout(persistTimer));
  const configured = createMemo(() => Boolean(config()?.enabled && config()?.endpoint && config()?.model));
  const modeInfo = createMemo(() => MODES.find(item => item.id === mode()) || MODES[0]);
  const scrollToBottom = () => requestAnimationFrame(() => messagesEnd?.scrollIntoView({ behavior: "smooth" }));
  const loadConfig = () => {
    void api.aiGetConfig()
      .then(value => { setConfig(value); setError(""); })
      .catch(value => setError(String(value)))
      .finally(() => setConfigLoading(false));
  };

  let lastInitialMode = props.initialMode;
  createEffect(() => {
    const incoming = props.initialMode;
    if (incoming && incoming !== lastInitialMode) {
      lastInitialMode = incoming;
      applyMode(incoming, false);
    }
  });

  onMount(() => {
    loadConfig();
    const conversationId = activeConversationId();
    setConversations(previous => previous.map(conversation =>
      conversation.id === conversationId ? { ...conversation, mode: mode() } : conversation
    ));
    window.addEventListener("focus", loadConfig);
    onCleanup(() => window.removeEventListener("focus", loadConfig));
  });

  const startPanelResize = (event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth();
    const closeWidth = 50;
    let closed = false;
    document.body.style.userSelect = "none";
    const onMove = (move: MouseEvent) => {
      if (closed) return;
      const nextWidth = Math.min(620, startWidth + move.clientX - startX);
      if (nextWidth <= closeWidth) {
        closed = true;
        stop();
        props.onClose();
        return;
      }
      setPanelWidth(nextWidth);
    };
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      document.body.style.userSelect = "";
      if (!closed && panelWidth() > closeWidth) {
        localStorage.setItem("portnest-ai-panel-width", String(panelWidth()));
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  const runAssistant = async (conversation: ChatItem[]) => {
    let assistantId: number | null = null;
    let assistantContent = "";
    setError(""); setLoading(true); scrollToBottom();
    const appendAssistantDelta = (delta: string) => {
      if (!delta) return;
      if (assistantId === null) {
        assistantId = ++nextId;
        setMessages(previous => [...previous, { id: assistantId!, role: "assistant", content: "" }]);
      }
      assistantContent += delta;
      setMessages(previous => previous.map(message => message.id === assistantId ? { ...message, content: visibleAssistantText(assistantContent) } : message));
      scrollToBottom();
    };
    try {
      const preset = activePreset();
      const apiMessages: AIChatMessage[] = [
        ...(preset ? [{ role: "system", content: preset.content }] : []),
        ...conversation.map(message => ({ role: message.role, content: message.apiContent ?? message.content })),
      ];
      await api.aiChatStream({
        mode: mode(),
        messages: apiMessages,
        connection_id: props.connection?.id ?? null,
        user_context: mode() === "terminal"
          ? props.terminalContext?.().slice(-16000) || null
          : mode() === "sql"
            ? props.sqlContext?.().slice(-16000) || null
            : null,
      }, event => {
        if (event.kind === "delta" && event.delta) appendAssistantDelta(event.delta);
      });
      const parsed = parseToolCall(assistantContent);
      if (assistantId !== null) {
        const pendingTool = parsed.toolCall ? { ...parsed.toolCall, status: "pending" as const } : null;
        setMessages(previous => previous.map(message =>
          message.id === assistantId
            ? {
                ...message,
                content: parsed.text,
                toolCall: pendingTool || message.toolCall,
              }
            : message
        ));
        if (pendingTool && shouldAutoApprove(pendingTool)) {
          window.setTimeout(() => void handleToolDecision(assistantId!, true), 0);
        }
      }
      if (!parsed.text && !parsed.toolCall) setError("模型没有返回文本内容，请检查模型或接口配置。");
    } catch (value) {
      if (assistantId !== null) {
        setMessages(previous => previous.filter(message => !(message.id === assistantId && !message.content.trim())));
      }
      setError(String(value));
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  };

  const send = async (preset?: string) => {
    const content = (preset ?? input()).trim();
    if (!content || loading()) return;
    if (!configured()) { setError("请先在 设置 → AI → 模型配置 中启用一个可用模型。"); return; }
    const userMessage: ChatItem = { id: ++nextId, role: "user", content };
    const nextMessages = [...messages(), userMessage];
    setMessages(nextMessages);
    setInput("");
    await runAssistant(nextMessages);
  };

  const updateToolCall = (messageId: number, patch: Partial<ToolCallState>) => {
    setMessages(previous => previous.map(message =>
      message.id === messageId && message.toolCall
        ? { ...message, toolCall: { ...message.toolCall, ...patch } }
        : message
    ));
  };

  const logToolAudit = async (tool: ToolCallState, status: string, result?: string) => {
    try {
      await api.aiAuditTool({
        connection_id: props.connection?.id ?? null,
        mode: mode(),
        tool_name: tool.name,
        payload: toolPayload(tool),
        risk: toolRisk(tool),
        status,
        result: result ? result.slice(0, 8_000) : null,
      });
    } catch (error) {
      console.warn("[ai] failed to persist tool audit", error);
    }
  };

  const continueAfterTool = async (tool: ToolCallState, result: string) => {
    const summary = `工具执行结果已返回：${tool.name}`;
    const toolContext = [
      "[PortNest 工具执行结果]",
      `工具: ${tool.name}`,
      `风险等级: ${toolRisk(tool)}`,
      `参数:`,
      toolPayload(tool),
      `结果:`,
      result,
      "请基于以上真实执行结果继续分析。不要声称执行了其他未发生的操作；如无必要不要重复相同工具调用。",
    ].join("\n");
    const resultMessage: ChatItem = {
      id: ++nextId,
      role: "user",
      content: summary,
      apiContent: toolContext,
    };
    const nextMessages = [...messages(), resultMessage];
    setMessages(nextMessages);
    await runAssistant(nextMessages);
  };

  const handleToolDecision = async (messageId: number, approved: boolean) => {
    const message = messages().find(item => item.id === messageId);
    const tool = message?.toolCall;
    if (!tool || tool.status !== "pending") return;
    if (!approved) {
      updateToolCall(messageId, { status: "rejected", result: "用户取消了执行。", confirmingRisk: false });
      await logToolAudit(tool, "rejected", "用户取消了执行。");
      return;
    }
    const policy = permissions();
    if (tool.name === "terminal.run" && policy.disableLocalExecution && props.connection?.protocol === "local") {
      const policyMessage = "已拦截：静默权限中启用了禁止本地执行。";
      updateToolCall(messageId, { status: "error", result: policyMessage, confirmingRisk: false });
      await logToolAudit(tool, "blocked", policyMessage);
      return;
    }
    if (policy.blockUnreferencedAssets && (tool.name === "terminal.run" || tool.name === "sql.execute") && !hasReferencedCurrentAsset()) {
      const policyMessage = "已拦截：当前资产未通过 @ 显式引用。请在消息中 @ 当前连接后再执行。";
      updateToolCall(messageId, { status: "error", result: policyMessage, confirmingRisk: false });
      await logToolAudit(tool, "blocked", policyMessage);
      return;
    }
    updateToolCall(messageId, { status: "running", confirmingRisk: false });
    try {
      let resultText = "";
      if (tool.name === "terminal.run") {
        const command = String(tool.arguments.command || "").trim();
        if (!command) throw new Error("工具调用没有提供命令");
        if (!props.shellId) throw new Error("当前没有可用的终端会话，请先打开一个已连接的 SSH 或本地终端");
        await api.writeShell(props.shellId, `${command}\r`);
        await new Promise(resolve => setTimeout(resolve, 900));
        const transcript = props.terminalContext?.()?.split("\n").slice(-40).join("\n").trim();
        resultText = transcript ? `命令已发送到当前终端。\n\n最近终端输出：\n${transcript}` : "命令已发送到当前终端。";
      } else if (tool.name === "sql.execute") {
        const sql = String(tool.arguments.sql || "").trim();
        if (!sql) throw new Error("工具调用没有提供 SQL");
        if (!props.connection || !isDatabaseProtocol(props.connection.protocol)) {
          throw new Error("当前连接不是可执行的数据库连接");
        }
        const database = String(tool.arguments.database || "").trim() || undefined;
        const result = await api.databaseExecuteSql(props.connection.id, sql, database);
        const preview = result.rows.slice(0, 5).map(row => row.values);
        resultText = [
          `执行成功：返回 ${result.rows.length} 行，受影响 ${result.affected_rows} 行，耗时 ${result.execution_time_ms}ms。`,
          preview.length ? `结果预览：\n${JSON.stringify(preview, null, 2)}` : "",
        ].filter(Boolean).join("\n\n");
      } else {
        throw new Error(`不支持的工具：${tool.name}`);
      }
      updateToolCall(messageId, { status: "success", result: resultText });
      await logToolAudit(tool, "success", resultText);
      await continueAfterTool(tool, resultText);
    } catch (value) {
      const errorText = String(value);
      updateToolCall(messageId, { status: "error", result: errorText });
      await logToolAudit(tool, "error", errorText);
    }
  };

  return (
    <section
      class={`ai-assistant-panel ai-assistant-dock mode-${mode()}`}
      style={{ width: `${panelWidth()}px` }}
      role="complementary"
      aria-label="PortNest AI 协作面板"
    >
      <div class="ai-assistant-resizer" onMouseDown={startPanelResize} title="拖动调整 AI 面板宽度" aria-hidden="true" />
        <button
          class={`ai-conversation-drawer-toggle ${historyOpen() ? "open" : ""}`}
          title={historyOpen() ? "收起会话列表" : "展开会话列表"}
          aria-label={historyOpen() ? "收起会话列表" : "展开会话列表"}
          onClick={() => setHistoryOpen(value => !value)}
        >
          <Icon name={historyOpen() ? "arrowLeft" : "arrowRight"} size={13} />
        </button>

        <Show when={historyOpen()}>
          <div class="ai-conversation-drawer-scrim" onClick={() => setHistoryOpen(false)} />
          <aside class="ai-conversation-drawer" aria-label="AI 会话列表">
            <header>
              <span><strong>会话列表</strong><small>{conversations().length} 个对话</small></span>
              <button class="ai-conversation-drawer-new" onClick={startNewConversation}><Icon name="plus" size={13} />新建</button>
            </header>
            <div class="ai-conversation-items">
              <For each={sortedConversations()}>{conversation => (
                <div
                  class={`ai-conversation-item ${conversation.id === activeConversationId() ? "active" : ""}`}
                  onClick={() => switchConversation(conversation.id)}
                >
                  <span class="ai-conversation-item-icon"><Icon name={conversation.mode === "sql" ? "database" : conversation.mode === "terminal" ? "terminal" : "sparkles"} size={13} /></span>
                  <span class="ai-conversation-item-copy">
                    <strong>{conversation.title}</strong>
                    <small>{modeLabel(conversation.mode)} · {conversation.messages.length} 条 · {formatConversationTime(conversation.updatedAt)}</small>
                  </span>
                  <button
                    class="ai-conversation-delete"
                    title="删除对话"
                    aria-label="删除对话"
                    onClick={event => deleteConversation(conversation.id, event)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              )}</For>
            </div>
            <footer>
              <button onClick={() => setHistoryOpen(false)}>收起</button>
              <button onClick={props.onClose}><Icon name="close" size={12} />关闭 AI</button>
            </footer>
          </aside>
        </Show>

        <main class="ai-chat-area">
          <Show when={configLoading()}><div class="ai-config-loading"><Icon name="refresh" size={15} /> 正在读取模型配置…</div></Show>
          <Show when={!configLoading() && !configured()}>
            <div class="ai-setup-card">
              <span class="ai-setup-icon"><Icon name="sparkles" size={24} /></span>
              <h3>先接入一个 AI 模型</h3>
              <p>PortNest 支持 OpenAI Chat Completions、Anthropic Messages 和 Ollama 兼容接口，API Key 会加密保存在本机。</p>
              <button onClick={() => void openSettingsWindow("aiModels")}><Icon name="settings" size={14} />打开模型配置</button>
            </div>
          </Show>
          <Show when={messages().length === 0 && configured()}>
            <div class="ai-empty-state">
              <span class="ai-empty-mark"><Icon name={modeInfo().icon} size={25} /></span>
              <h3>{modeInfo().label}</h3>
              <p>{modeInfo().description}。你可以直接描述问题，AI 会结合{props.connection ? "当前连接上下文" : "你的描述"}给出建议。</p>
              <div class="ai-suggestion-grid">
                <For each={SUGGESTIONS[mode()]}>{suggestion => <button onClick={() => void send(suggestion)}>{suggestion}<Icon name="chevronRight" size={13} /></button>}</For>
              </div>
            </div>
          </Show>
          <div class="ai-message-list">
            <For each={messages()}>{message => (
              <article class={`ai-message ${message.role}`}>
                <span class="ai-message-avatar">{message.role === "user" ? "你" : <Icon name="sparkles" size={14} />}</span>
                <div class="ai-message-body">
                  <Show when={message.content.trim()}>
                    <For each={splitMessage(message.content)}>{part => (
                      <Show when={part.type === "code"} fallback={<div class="ai-message-text">{part.content}</div>}>
                        <pre class="ai-code-block"><Show when={part.language}><span>{part.language}</span></Show><code>{part.content}</code></pre>
                      </Show>
                    )}</For>
                  </Show>
                  <Show when={message.toolCall}>{tool => (
                    <div class={`ai-tool-card risk-${toolRisk(tool())} status-${tool().status}`}>
                      <div class="ai-tool-head">
                        <span class="ai-tool-icon"><Icon name={tool().name === "terminal.run" ? "terminal" : "database"} size={15} /></span>
                        <div><strong>{toolTitle(tool().name)}</strong><small>{tool().name}</small></div>
                        <em class={`ai-tool-risk risk-${toolRisk(tool())}`}>{toolRisk(tool()) === "high" ? "高风险" : toolRisk(tool()) === "medium" ? "需注意" : "低风险"}</em>
                      </div>
                      <pre class="ai-tool-payload"><code>{toolPayload(tool())}</code></pre>
                      <Show when={tool().status === "pending"}>
                        <Show when={tool().confirmingRisk} fallback={
                          <div class="ai-tool-actions">
                            <button class="ai-tool-reject" onClick={() => void handleToolDecision(message.id, false)}>拒绝</button>
                            <button
                              class="ai-tool-approve"
                              onClick={() => {
                                if (toolRisk(tool()) === "high") updateToolCall(message.id, { confirmingRisk: true });
                                else void handleToolDecision(message.id, true);
                              }}
                            >
                              <Icon name="play" size={13} />{toolRisk(tool()) === "high" ? "继续确认" : "允许执行"}
                            </button>
                          </div>
                        }>
                          <div class="ai-tool-risk-confirm">
                            <div><Icon name="info" size={14} /><span>此操作可能修改或删除数据，且不一定可撤销。确认继续执行？</span></div>
                            <div class="ai-tool-actions">
                              <button class="ai-tool-reject" onClick={() => updateToolCall(message.id, { confirmingRisk: false })}>返回</button>
                              <button class="ai-tool-approve danger" onClick={() => void handleToolDecision(message.id, true)}><Icon name="play" size={13} />确认执行</button>
                            </div>
                          </div>
                        </Show>
                      </Show>
                      <Show when={tool().status === "running"}><div class="ai-tool-status running"><Icon name="refresh" size={13} />正在执行…</div></Show>
                      <Show when={tool().status === "rejected"}><div class="ai-tool-status rejected">已取消执行</div></Show>
                      <Show when={tool().status === "success" && tool().result}><pre class="ai-tool-result">{tool().result}</pre></Show>
                      <Show when={tool().status === "error" && tool().result}><pre class="ai-tool-result error">{tool().result}</pre></Show>
                    </div>
                  )}</Show>
                </div>
              </article>
            )}</For>
            <Show when={loading()}><div class="ai-message assistant"><span class="ai-message-avatar"><Icon name="sparkles" size={14} /></span><div class="ai-typing"><i /><i /><i /></div></div></Show>
          </div>
          <div ref={messagesEnd} />
        </main>
        <Show when={error()}><div class="ai-assistant-error"><Icon name="info" size={14} /><span>{error()}</span></div></Show>

        <footer class="ai-composer">
          <Show when={activePreset()}>{preset => (
            <div class="ai-active-preset">
              <Icon name="sparkles" size={12} />
              <span>{preset().title}</span>
              <button title="不使用预设" aria-label="不使用预设" onClick={() => choosePreset(null)}><Icon name="close" size={11} /></button>
            </div>
          )}</Show>
          <div class="ai-composer-shell">
            <textarea
              value={input()}
              placeholder="向 PortNest AI 任意提问，@ 引用资产或终端标签，可直接粘贴图片"
              onInput={event => setInput(event.currentTarget.value)}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
            />
            <div class="ai-composer-bottom">
              <div class="ai-composer-left">
                <button class="ai-add-model" onClick={toggleModelInfoPopover} title={`模型与上下文 · ${contextWindowLabel()}`}>
                  <Icon name={configured() ? "sparkles" : "plus"} size={13} />
                  <span>{configured() ? (config()?.display_name || config()?.model || "模型") : "添加模型"}</span>
                </button>
                <button class="ai-composer-icon-button" onClick={() => loadConfig()} title="刷新模型配置">
                  <Icon name="refresh" size={13} />
                </button>
                <button class={`ai-composer-icon-button ${permissionsOpen() ? "active" : ""}`} onClick={togglePermissionsPopover} title="静默权限">
                  <Icon name="shield" size={13} />
                </button>
                <button class={`ai-composer-icon-button ${presetsOpen() ? "active" : ""}`} onClick={togglePresetsPopover} title="提示词预设">
                  <Icon name="sparkles" size={13} />
                </button>
                <button class="ai-composer-icon-button" disabled title="图片输入暂未开放">
                  <Icon name="image" size={13} />
                </button>
              </div>
              <div class="ai-composer-right">
                <button class="ai-composer-round-button" disabled title="语音输入暂未开放">
                  <Icon name="mic" size={13} />
                </button>
                <button class="ai-send-circle" disabled={!configured() || loading() || !input().trim()} onClick={() => void send()} title="Enter 发送 · Shift+Enter 换行">
                  <Icon name="arrowUp" size={15} />
                </button>
              </div>
            </div>
          </div>

          <Show when={permissionsOpen()}>
            <div class="ai-permissions-popover">
              <header>
                <span><strong>静默权限</strong><small>控制 AI 工具调用的自动执行范围</small></span>
                <button title="关闭" aria-label="关闭" onClick={() => setPermissionsOpen(false)}><Icon name="close" size={12} /></button>
              </header>
              <div class="ai-permission-rows">
                <For each={PERMISSION_ROWS}>{row => (
                  <div class="ai-permission-row">
                    <span class="ai-permission-icon"><Icon name={row.icon} size={13} /></span>
                    <span class="ai-permission-copy"><strong>{row.label}</strong><small>{row.description}</small></span>
                    <button
                      class={`ai-permission-switch ${permissions()[row.key] ? "on" : ""}`}
                      role="switch"
                      aria-checked={permissions()[row.key]}
                      aria-label={row.label}
                      onClick={() => togglePermission(row.key)}
                    ><span /></button>
                  </div>
                )}</For>
              </div>
              <footer>权限设置保存在本机，仅对 AI 工具调用生效。</footer>
            </div>
          </Show>

          <Show when={presetsOpen()}>
            <div class="ai-preset-popover">
              <header>
                <span><strong>提示词预设</strong><small>为当前对话附加系统提示词</small></span>
                <button title="关闭" aria-label="关闭" onClick={() => setPresetsOpen(false)}><Icon name="close" size={12} /></button>
              </header>
              <Show when={presetDraft()} fallback={
                <>
                  <label class="ai-preset-search">
                    <Icon name="search" size={12} />
                    <input value={presetSearch()} onInput={event => setPresetSearch(event.currentTarget.value)} placeholder="搜索提示词…" />
                  </label>
                  <div class="ai-preset-list">
                    <button class={`ai-preset-none ${!activePreset() ? "active" : ""}`} onClick={() => choosePreset(null)}>
                      <Icon name="check" size={12} />不使用预设
                    </button>
                    <Show when={filteredPromptPresets().length > 0} fallback={<div class="ai-preset-empty">暂无提示词预设</div>}>
                      <For each={filteredPromptPresets()}>{preset => (
                        <div class={`ai-preset-item ${activePreset()?.id === preset.id ? "active" : ""}`} onClick={() => choosePreset(preset.id)}>
                          <span class="ai-preset-item-icon"><Icon name="file" size={12} /></span>
                          <span class="ai-preset-item-copy"><strong>{preset.title}</strong><small>{preset.content}</small></span>
                          <button class="ai-preset-delete" title="删除预设" aria-label="删除预设" onClick={event => deletePromptPreset(preset.id, event)}><Icon name="trash" size={12} /></button>
                        </div>
                      )}</For>
                    </Show>
                  </div>
                  <footer>
                    <button onClick={extractCurrentConversation}><Icon name="sparkles" size={12} />提取当前会话</button>
                    <button onClick={startNewPreset}><Icon name="plus" size={12} />新建</button>
                  </footer>
                </>
              }>
                {draft => (
                  <div class="ai-preset-editor">
                    <label><span>预设名称</span><input value={draft().title} onInput={event => setPresetDraft(previous => previous ? { ...previous, title: event.currentTarget.value } : previous)} placeholder="例如：生产环境排障助手" /></label>
                    <label><span>系统提示词</span><textarea value={draft().content} onInput={event => setPresetDraft(previous => previous ? { ...previous, content: event.currentTarget.value } : previous)} placeholder="描述 AI 的角色、约束和输出格式…" /></label>
                    <footer>
                      <button onClick={() => setPresetDraft(null)}>取消</button>
                      <button class="primary" disabled={!draft().title.trim() || !draft().content.trim()} onClick={savePresetDraft}>保存预设</button>
                    </footer>
                  </div>
                )}
              </Show>
            </div>
          </Show>

          <Show when={modelInfoOpen()}>
            <div class="ai-model-popover">
              <header>
                <span><strong>上下文窗口</strong><small>当前模型与上下文配置</small></span>
                <button title="关闭" aria-label="关闭" onClick={() => setModelInfoOpen(false)}><Icon name="close" size={12} /></button>
              </header>
              <Show when={configured()} fallback={
                <div class="ai-model-empty">
                  <span>--</span>
                  <p>暂无模型配置，请先到设置中添加 LLM 模型</p>
                  <button onClick={() => void openSettingsWindow("aiModels")}><Icon name="plus" size={12} />添加模型</button>
                </div>
              }>
                <div class="ai-model-grid">
                  <div><span>模型</span><strong>{config()?.display_name || config()?.model || "--"}</strong></div>
                  <div><span>上下文窗口</span><strong>{contextWindowLabel()}</strong></div>
                  <div><span>最大输出</span><strong>{config()?.max_output ? `${Math.round(config()!.max_output / 1000)}K` : "--"}</strong></div>
                  <div><span>接口协议</span><strong>{config()?.protocol || "--"}</strong></div>
                </div>
                <footer><button onClick={() => void openSettingsWindow("aiModels")}><Icon name="settings" size={12} />模型设置</button></footer>
              </Show>
            </div>
          </Show>
        </footer>
    </section>
  );
};





