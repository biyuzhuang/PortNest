import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  themeMode, setThemeMode, type ThemeMode, themeSkin, setThemeSkin, themeSkins, type ThemeSkin,
  terminalThemes, getTerminalTheme,
  getTerminalThemePreferences, setTerminalThemePreferences, effectiveTheme, getTerminalSettings, setTerminalSettings,
  terminalBackgroundConfig, setTerminalBackgroundConfig, getEffectiveTerminalBackgroundStyle, type TerminalBackgroundStyle, type TerminalBackgroundConfig,
  TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, isTerminalFontSizeValid,
  type TerminalSettings,
} from "../stores/themeStore";
import { uiStore, type WindowCloseAction } from "../stores/uiStore";
import { REFRESH_OPTIONS, getOverviewSettings, setOverviewSettings } from "../stores/dashboardStore";
import { clearTerminalBackgroundImage, loadTerminalBackgroundImage, saveTerminalBackgroundImage, terminalBackgroundImageUrl } from "../stores/terminalBackgroundStore";
import { Icon } from "./Icon";
import { BrandMark } from "./BrandMark";
import { AIProviderIcon } from "./AIProviderIcon";
import { TextContextMenu } from "./TextContextMenu";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { api, type AIProviderConfig, type AIProviderModel } from "../utils/api";
import packageInfo from "../../package.json";
import { templateStore } from "../stores/templateStore";
import { feedback } from "../stores/feedbackStore";
import "./SettingsModal.css";

interface SettingsModalProps { onClose: () => void; standalone?: boolean; }
type Page = "appearance" | "terminal" | "general" | "ssh" | "database" | "cli" | "aiModels" | "aiMcp" | "aiSearch" | "account" | "shortcutsBasic" | "shortcutsEditor" | "shortcutsSsh" | "shortcutsDatabase" | "shortcutsDocker" | "storage" | "templates" | "version";

const SETTINGS_PAGES: Page[] = ["appearance", "terminal", "general", "ssh", "database", "cli", "aiModels", "aiMcp", "aiSearch", "account", "shortcutsBasic", "shortcutsEditor", "shortcutsSsh", "shortcutsDatabase", "shortcutsDocker", "storage", "templates", "version"];
const isSettingsPage = (value: string | null): value is Page => Boolean(value && SETTINGS_PAGES.includes(value as Page));
const requestedSettingsPage = (): Page => {
  const query = new URLSearchParams(window.location.search).get("page");
  const stored = localStorage.getItem("portnest-settings-page");
  return isSettingsPage(query) ? query : isSettingsPage(stored) ? stored : "appearance";
};

const BACKGROUNDS: Array<[TerminalBackgroundStyle, string]> = [
  ["theme", "跟随主题"], ["solid", "自定义纯色"], ["midnight", "午夜渐变"], ["aurora", "极光渐变"], ["image", "背景图片"],
];

type AIProviderTemplate = {
  id: string;
  label: string;
  protocol: "openai_chat" | "anthropic" | "ollama" | string;
  endpoint: string;
  model?: string;
  disabled?: boolean;
};

const AI_PROVIDER_TEMPLATES: AIProviderTemplate[] = [
  { id: "openai", label: "OpenAI", protocol: "openai_chat", endpoint: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Claude", protocol: "anthropic", endpoint: "https://api.anthropic.com/v1" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai_chat", endpoint: "https://api.deepseek.com" },
  { id: "kimi", label: "Kimi", protocol: "openai_chat", endpoint: "https://api.moonshot.cn/v1" },
  { id: "glm", label: "GLM", protocol: "openai_chat", endpoint: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai_chat", endpoint: "https://openrouter.ai/api/v1" },
  { id: "alibaba", label: "阿里百炼", protocol: "openai_chat", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "volcano", label: "火山方舟", protocol: "openai_chat", endpoint: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "tencent", label: "腾讯云混元", protocol: "openai_chat", endpoint: "https://api.hunyuan.cloud.tencent.com/v1" },
  { id: "minimax", label: "MiniMax", protocol: "openai_chat", endpoint: "https://api.minimax.chat/v1" },
  { id: "xiaomi_mimo", label: "小米 MiMo", protocol: "openai_chat", endpoint: "" },
  { id: "ollama", label: "Ollama", protocol: "ollama", endpoint: "http://localhost:11434/v1" },
  { id: "gemini", label: "Gemini", protocol: "gemini", endpoint: "https://generativelanguage.googleapis.com", disabled: true },
  { id: "custom", label: "自定义供应商", protocol: "openai_chat", endpoint: "" },
];

const defaultAIProviderConfig = (): AIProviderConfig => ({
  id: "",
  enabled: false,
  provider: "custom",
  protocol: "openai_chat",
  endpoint: "",
  api_key: "",
  model: "",
  models: [],
  display_name: "默认模型",
  context_window: 128000,
  max_output: 4096,
  temperature: null,
  custom_headers: {},
  custom_user_agent: "",
  proxy_mode: "auto",
  remark: "",
});

const Toggle: Component<{ checked: boolean; onChange: (value: boolean) => void }> = (props) => (
  <button
    type="button"
    class={`settings-switch ${props.checked ? "on" : ""}`}
    role="switch"
    aria-checked={props.checked}
    onClick={() => props.onChange(!props.checked)}
  ><span /></button>
);

const UnavailableBadge: Component = () => <span class="settings-unavailable-badge">暂不可用</span>;

const DisabledSelect: Component<{ value: string }> = (props) => (
  <span class="settings-disabled-select" aria-disabled="true">
    <span>{props.value}</span>
    <Icon name="chevronDown" size={12} />
  </span>
);

const DisabledToggle: Component = () => <span class="settings-disabled-toggle" aria-hidden="true"><i /></span>;

export const CommandTemplatesSettings: Component = () => {
  void templateStore.refresh();
  const [templateQuery, setTemplateQuery] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");
  const [editContent, setEditContent] = createSignal("");

  const filtered = () => {
    const query = templateQuery().trim().toLowerCase();
    const list = templateStore.templates().filter(item => (item.id.startsWith("draft-") ? true : true));
    if (!query) return list;
    return list.filter(item => `${item.name} ${item.content}`.toLowerCase().includes(query));
  };
  const beginEdit = (item: { id: string; name: string; content: string }) => { setEditingId(item.id); setEditName(item.name); setEditContent(item.content); };
  const createTemplate = () => {
    const draft = templateStore.addDraft();
    setEditingId(draft.id); setEditName(draft.name); setEditContent("");
  };
  const saveEditing = async () => {
    const id = editingId();
    if (!id || !editName().trim() || !editContent().trim()) return;
    const saved = await templateStore.save({ id: id.startsWith("draft-") ? undefined : id, name: editName().trim(), content: editContent() });
    if (id.startsWith("draft-")) setEditingId(saved.id);
  };
  const cancelEditing = () => {
    const id = editingId();
    if (id?.startsWith("draft-")) templateStore.discardDraft(id);
    setEditingId(null); setEditName(""); setEditContent("");
  };
  const deleteTemplate = async (id: string) => {
    if (id.startsWith("draft-")) { templateStore.discardDraft(id); if (editingId() === id) { setEditingId(null); setEditName(""); setEditContent(""); } return; }
    await templateStore.remove(id);
    if (editingId() === id) { setEditingId(null); setEditName(""); setEditContent(""); }
  };

  return <div class="settings-page">
    <div class="settings-page-heading"><h2>命令模板</h2><p>管理命令广播撰写窗格共用的命令模板列表，修改即时同步。</p></div>
    <h3>模板列表</h3>
    <div class="settings-grid settings-grid-single"><div class="settings-card templates-card">
      <div class="templates-toolbar">
        <input class="templates-search" placeholder="搜索模板名称或命令" value={templateQuery()} onInput={event => setTemplateQuery(event.currentTarget.value)} />
        <button class="settings-inline-button" onClick={createTemplate}>＋ 新增模板</button>
      </div>
      <Show when={!filtered().length}><p class="templates-empty">暂无模板，点击“新增模板”创建第一条命令。</p></Show>
      <div class="templates-list">
        <For each={filtered()}>{item => (
          <div class={`templates-row ${editingId() === item.id ? "editing" : ""}`}>
            <Show when={editingId() === item.id} fallback={
              <><div class="templates-row-main"><strong>{item.name}</strong><code>{item.content.split("\n")[0] || "（空）"}</code></div>
                <span class="settings-image-actions"><button class="settings-inline-button" onClick={() => beginEdit(item)}>编辑</button><button class="settings-inline-button danger" onClick={() => void deleteTemplate(item.id)}>删除</button></span></>
            }>
              <div class="templates-editor">
                <label><span>模板名称</span><input value={editName()} onInput={event => setEditName(event.currentTarget.value)} /></label>
                <label><span>命令内容</span><textarea value={editContent()} rows={3} onInput={event => setEditContent(event.currentTarget.value)} /></label>
                <span class="settings-image-actions">
                  <button class="settings-inline-button" onClick={() => void saveEditing()}>保存</button>
                  <button class="settings-inline-button" onClick={cancelEditing}>取消</button>
                </span>
              </div>
            </Show>
          </div>
        )}</For>
      </div>
    </div></div>
  </div>;
};

type PlaceholderRowSpec = {
  label: string;
  hint?: string;
  value?: string;
  toggle?: boolean;
};

type PlaceholderSectionSpec = {
  title: string;
  groups: PlaceholderRowSpec[][];
};

const PlaceholderSettingsPage: Component<{
  title: string;
  description: string;
  sections: PlaceholderSectionSpec[];
  note?: string;
  readOnly?: boolean;
}> = (props) => (
  <div class="settings-page">
    <div class="settings-page-heading">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
    </div>
    <div class="settings-unavailable-note">
      <Icon name="info" size={13} />
      <span>{props.note || "以下设置项已预留界面，但当前版本暂不可用。"}</span>
      <Show when={!props.readOnly}><UnavailableBadge /></Show>
    </div>
    <For each={props.sections}>{section => (
      <>
        <h3>{section.title}</h3>
        <div class="settings-grid">
          <For each={section.groups}>{rows => (
            <div class={`settings-card${props.readOnly ? " settings-shortcut-card" : " settings-card-unavailable"}`}>
              <For each={rows}>{row => (
                <Show when={props.readOnly} fallback={
                  <label class="settings-row-unavailable">
                    <span>
                      <b>{row.label}</b>
                      <Show when={row.hint}><small>{row.hint}</small></Show>
                    </span>
                    <Show when={row.toggle} fallback={<DisabledSelect value={row.value || "暂不可用"} />}>
                      <DisabledToggle />
                    </Show>
                  </label>
                }>
                  <div class="settings-shortcut-row">
                    <span>
                      <b>{row.label}</b>
                      <Show when={row.hint}><small>{row.hint}</small></Show>
                    </span>
                    <kbd class="settings-shortcut-key">{row.value || "—"}</kbd>
                  </div>
                </Show>
              )}</For>
            </div>
          )}</For>
        </div>
      </>
    )}</For>
  </div>
);

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [page, setPage] = createSignal<Page>(requestedSettingsPage());
  const [currentTerminalTheme, setCurrentTerminalTheme] = createSignal(getTerminalTheme());
  const [terminalThemePreferences, setThemePreferences] = createSignal(getTerminalThemePreferences());
  const [terminalSettings, setSettings] = createSignal<TerminalSettings>(getTerminalSettings());
  const [fontSizeDraft, setFontSizeDraft] = createSignal(String(terminalSettings().fontSize));
  const fontSizeDraftValid = createMemo(() => isTerminalFontSizeValid(Number(fontSizeDraft())));
  const [updateStatus, setUpdateStatus] = createSignal("检查更新");
  const [checkingUpdate, setCheckingUpdate] = createSignal(false);
  const [background, setBackground] = createSignal<TerminalBackgroundConfig>(terminalBackgroundConfig());
  const [imageError, setImageError] = createSignal("");
  const [appVersion, setAppVersion] = createSignal(packageInfo.version);
  const [pinned, setPinned] = createSignal(false);
  const [maximized, setMaximized] = createSignal(false);
  const [storageMessage, setStorageMessage] = createSignal("");
  const [storageBusy, setStorageBusy] = createSignal(false);
  const [aiConfig, setAIConfig] = createSignal<AIProviderConfig>(defaultAIProviderConfig());
  const [aiProviders, setAIProviders] = createSignal<AIProviderConfig[]>([]);
  const [activeAIProviderId, setActiveAIProviderId] = createSignal<string | null>(null);
  const [showAIProviderPicker, setShowAIProviderPicker] = createSignal(false);
  const [aiProviderSearch, setAIProviderSearch] = createSignal("");
  const [aiApiKeyVisible, setAIApiKeyVisible] = createSignal(false);
  const [aiExpandedModel, setAIExpandedModel] = createSignal<string | null>(null);
  const [aiManualModel, setAIManualModel] = createSignal("");
  const [aiModelPickerOpen, setAIModelPickerOpen] = createSignal(false);
  const [aiHeaderRows, setAIHeaderRows] = createSignal<Array<{ key: string; value: string }>>([]);
  const [aiConfigLoading, setAIConfigLoading] = createSignal(false);
  const [aiTesting, setAITesting] = createSignal(false);
  const [aiSaving, setAISaving] = createSignal(false);
  const [aiTestResult, setAITestResult] = createSignal("");
  const [aiSettingsMessage, setAISettingsMessage] = createSignal("");
  const [aiModelOptions, setAIModelOptions] = createSignal<string[]>([]);
  const [aiModelsLoading, setAIModelsLoading] = createSignal(false);
  const readFileViewOptions = (): Record<string, unknown> => {
    try { return JSON.parse(localStorage.getItem("portnest-file-view-options") || "{}"); }
    catch { return {}; }
  };
  const [showHiddenFiles, setShowHiddenFiles] = createSignal(readFileViewOptions().showHidden === true);
  const setShowHiddenFilesPreference = (value: boolean) => {
    const options = readFileViewOptions();
    options.showHidden = value;
    localStorage.setItem("portnest-file-view-options", JSON.stringify(options));
    setShowHiddenFiles(value);
  };
  let importSessionsInput: HTMLInputElement | undefined;
  let imageInputRef: HTMLInputElement | undefined;
  const isTauriRuntime = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

  onMount(() => {
    const handleSettingsPage = (event: StorageEvent) => {
      if (event.key === "portnest-settings-page" && isSettingsPage(event.newValue)) setPage(event.newValue);
    };
    window.addEventListener("storage", handleSettingsPage);
    onCleanup(() => window.removeEventListener("storage", handleSettingsPage));
    void loadTerminalBackgroundImage(background().imageAssetId);
    void getVersion().then(setAppVersion).catch(() => setAppVersion(packageInfo.version));
    setAIConfigLoading(true);
    void api.aiGetConfigs()
      .then(configs => {
        setAIProviders(configs);
        const first = configs[0];
        if (first) {
          setAIConfig({ ...defaultAIProviderConfig(), ...first, custom_headers: first.custom_headers || {} });
          setActiveAIProviderId(first.id);
          syncAIHeaderRows(first);
        }
      })
      .catch(error => setAISettingsMessage(`读取 AI 配置失败：${String(error)}`))
      .finally(() => setAIConfigLoading(false));
    if (isTauriRuntime()) {
      void getCurrentWindow().isMaximized().then(setMaximized).catch(() => undefined);
    }
  });

  const configuredAIProviderIds = createMemo(() => new Set(aiProviders().map(item => item.provider)));
  const filteredAIProviderTemplates = createMemo(() => {
    const query = aiProviderSearch().trim().toLowerCase();
    return AI_PROVIDER_TEMPLATES.filter(item =>
      !item.disabled
      && !configuredAIProviderIds().has(item.id)
      && (!query || `${item.label} ${item.protocol}`.toLowerCase().includes(query))
    );
  });

  const patchAIConfig = (updater: Partial<AIProviderConfig> | ((previous: AIProviderConfig) => AIProviderConfig)) => {
    const next = typeof updater === "function" ? updater(aiConfig()) : { ...aiConfig(), ...updater };
    setAIConfig(next);
    if (next.id) setAIProviders(previous => previous.map(item => item.id === next.id ? next : item));
    return next;
  };

  const syncAIHeaderRows = (config: AIProviderConfig) => {
    setAIHeaderRows(Object.entries(config.custom_headers || {}).map(([key, value]) => ({ key, value })));
  };

  const commitAIHeaderRows = (rows: Array<{ key: string; value: string }>) => {
    setAIHeaderRows(rows);
    const headers: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key) headers[key] = row.value;
    }
    patchAIConfig({ custom_headers: headers });
  };

  const configuredAIModels = () => aiConfig().models || [];
  const selectedAIModel = () =>
    configuredAIModels().find(model => model.enabled) || configuredAIModels()[0];
  const effectiveAIConfig = (): AIProviderConfig => {
    const model = selectedAIModel();
    if (!model) return aiConfig();
    return {
      ...aiConfig(),
      model: model.model,
      context_window: model.context_window,
      max_output: model.max_output,
      temperature: model.temperature,
    };
  };
  const persistAIProvider = async (config: AIProviderConfig) => {
    const saved = await api.aiSaveConfig(config);
    setAIConfig(saved);
    setActiveAIProviderId(saved.id);
    setAIProviders(previous => {
      const exists = previous.some(item => item.id === saved.id);
      return exists ? previous.map(item => item.id === saved.id ? saved : item) : [...previous, saved];
    });
    return saved;
  };

  const availableAIModels = () => {
    const configured = new Set(configuredAIModels().map(model => model.model));
    return aiModelOptions().filter(model => !configured.has(model));
  };
  const addAIModel = async (modelName: string) => {
    const name = modelName.trim();
    if (!name || configuredAIModels().some(model => model.model === name)) return;
    const config = aiConfig();
    const next: AIProviderConfig = {
      ...config,
      models: [...configuredAIModels(), {
        model: name,
        enabled: true,
        context_window: config.context_window,
        max_output: config.max_output,
        temperature: config.temperature,
        supports_tool_calling: true,
        supports_image_input: false,
        supports_image_output: false,
      }],
      model: name,
    };
    try {
      await persistAIProvider(next);
      setAIModelPickerOpen(false);
      feedback.success(`已添加模型 ${name}`);
    } catch (error) {
      setAISettingsMessage(`添加模型失败：${String(error)}`);
    }
  };
  const updateAIModelConfig = (modelName: string, patch: Partial<AIProviderModel>) => {
    const models = configuredAIModels().map(model => model.model === modelName ? { ...model, ...patch } : model);
    patchAIConfig({ models });
  };

  const toggleAIModel = async (modelName: string, enabled: boolean) => {
    const models = configuredAIModels().map(model => model.model === modelName ? { ...model, enabled } : model);
    const active = models.find(model => model.enabled) || models[0];
    try {
      await persistAIProvider({ ...aiConfig(), models, model: active?.model || "" });
    } catch (error) {
      setAISettingsMessage(`更新模型状态失败：${String(error)}`);
    }
  };
  const removeAIModel = async (modelName: string) => {
    const models = configuredAIModels().filter(model => model.model !== modelName);
    const active = models.find(model => model.enabled) || models[0];
    try {
      await persistAIProvider({ ...aiConfig(), models, model: active?.model || "" });
    } catch (error) {
      setAISettingsMessage(`删除模型失败：${String(error)}`);
    }
  };

  const selectAIProvider = (config: AIProviderConfig) => {
    setActiveAIProviderId(config.id);
    setAIConfig({ ...defaultAIProviderConfig(), ...config, custom_headers: config.custom_headers || {} });
    setAITestResult("");
    setAISettingsMessage("");
    setAIModelOptions([]);
    setAIModelPickerOpen(false);
    setAIExpandedModel(null);
    setAIApiKeyVisible(false);
    syncAIHeaderRows(config);
  };

  const addAIProvider = async (item: AIProviderTemplate) => {
    if (item.disabled) return;
    setShowAIProviderPicker(false);
    setAIProviderSearch("");
    const existing = aiProviders().find(config => config.provider === item.id);
    if (existing) { selectAIProvider(existing); return; }
    const previousConfig = aiConfig();
    const previousProviderId = activeAIProviderId();
    const draft: AIProviderConfig = {
      ...defaultAIProviderConfig(),
      enabled: true,
      provider: item.id,
      protocol: item.protocol,
      endpoint: item.endpoint,
      display_name: item.label,
      model: item.model || "",
    };
    setAIConfig(draft);
    setActiveAIProviderId(null);
    setAITestResult("");
    setAISettingsMessage("");
    setAIModelOptions([]);
    setAIModelPickerOpen(false);
    setAIExpandedModel(null);
    setAIHeaderRows([]);
    try {
      const saved = await api.aiSaveConfig(draft);
      setAIProviders(previous => [...previous, saved]);
      selectAIProvider(saved);
      feedback.success("供应商已添加");
    } catch (error) {
      setAIConfig(previousConfig);
      setActiveAIProviderId(previousProviderId);
      setAISettingsMessage(`添加供应商失败：${String(error)}`);
    }
  };

  const removeAIProvider = async (target: AIProviderConfig = aiConfig()) => {
    const config = target;
    if (!config.id) return;
    if (!await feedback.confirm("确定删除当前供应商吗？", "删除供应商")) return;
    setAISettingsMessage("");
    try {
      await api.aiDeleteConfig(config.id);
      const remaining = aiProviders().filter(item => item.id !== config.id);
      setAIProviders(remaining);
      if (activeAIProviderId() === config.id) {
        if (remaining[0]) selectAIProvider(remaining[0]);
        else {
          setActiveAIProviderId(null);
          setAIConfig(defaultAIProviderConfig());
        }
      }
      feedback.success("供应商已删除");
    } catch (error) {
      setAISettingsMessage(`删除供应商失败：${String(error)}`);
    }
  };

  const toggleAIProvider = async (config: AIProviderConfig, enabled: boolean) => {
    const next = { ...config, enabled };
    setAIProviders(previous => previous.map(item => item.id === config.id ? next : item));
    if (aiConfig().id === config.id) setAIConfig(next);
    try {
      const saved = await api.aiSaveConfig(next);
      setAIProviders(previous => previous.map(item => item.id === saved.id ? saved : item));
      if (aiConfig().id === saved.id) setAIConfig(saved);
    } catch (error) {
      setAIProviders(previous => previous.map(item => item.id === config.id ? config : item));
      if (aiConfig().id === config.id) setAIConfig(config);
      setAISettingsMessage(`更新供应商状态失败：${String(error)}`);
    }
  };

  const saveAIConfiguration = async () => {
    if (aiSaving()) return;
    setAISaving(true);
    setAISettingsMessage("");
    try {
      await persistAIProvider(effectiveAIConfig());
      setAISettingsMessage("供应商配置已加密保存");
    } catch (error) {
      setAISettingsMessage(`保存失败：${String(error)}`);
    } finally {
      setAISaving(false);
    }
  };

  const fetchAIModels = async () => {
    if (aiModelsLoading()) return;
    setAIModelsLoading(true);
    setAISettingsMessage("");
    try {
      const models = await api.aiListModels(aiConfig());
      setAIModelOptions(models);
      setAIModelPickerOpen(true);
      setAISettingsMessage(`已获取 ${models.length} 个可用模型`);
    } catch (error) {
      setAISettingsMessage(`获取模型列表失败：${String(error)}`);
    } finally {
      setAIModelsLoading(false);
    }
  };

  const testAIConfiguration = async () => {
    if (aiTesting()) return;
    setAITesting(true);
    setAITestResult("");
    try {
      const result = await api.aiTestConfig(effectiveAIConfig());
      setAITestResult(result || "连接成功");
    } catch (error) {
      setAITestResult(`测试失败：${String(error)}`);
    } finally {
      setAITesting(false);
    }
  };

  const exportSessionsFromSettings = async () => {
    const filePath = await save({
      title: "导出会话",
      defaultPath: `portnest-sessions-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON 文件", extensions: ["json"] }],
    });
    if (!filePath) return;
    setStorageBusy(true);
    setStorageMessage("");
    try {
      const json = await api.exportSessions(false, false);
      await writeTextFile(filePath, json);
      setStorageMessage(`会话已导出到：${filePath}`);
    } catch (error) {
      setStorageMessage(`导出失败：${String(error)}`);
    } finally {
      setStorageBusy(false);
    }
  };

  const importSessionsFromSettings = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setStorageBusy(true);
    setStorageMessage("");
    try {
      const result = await api.importSessions(await file.text());
      const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 个` : "";
      setStorageMessage(`已导入 ${result.connections} 个会话、${result.folders} 个文件夹${skipped}`);
    } catch (error) {
      setStorageMessage(`导入失败：${String(error)}`);
    } finally {
      input.value = "";
      setStorageBusy(false);
    }
  };

  const togglePin = async () => {
    if (!isTauriRuntime()) return;
    const next = !pinned();
    await getCurrentWindow().setAlwaysOnTop(next);
    setPinned(next);
  };
  const minimizeSettings = async () => {
    if (isTauriRuntime()) await getCurrentWindow().minimize();
  };
  const toggleMaximizeSettings = async () => {
    if (!isTauriRuntime()) return;
    const settingsWindow = getCurrentWindow();
    await settingsWindow.toggleMaximize();
    setMaximized(await settingsWindow.isMaximized());
  };

  const resetAppearanceSettings = () => {
    setThemeMode("system");
    const defaults: TerminalSettings = {
      copyOnSelect: true,
      rightClickAction: "paste",
      middleClickAction: "none",
      ctrlVPaste: true,
      fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      scrollback: 1000,
      highlightEnhancement: false,
      stripedBackground: false,
      commandHints: true,
      sshHistory: true,
      reconnectOnDisconnect: false,
      terminalBell: false,
      openFileManagerOnConnect: true,
    };
    setSettings(defaults);
    setTerminalSettings(defaults);
    const preferences = { mode: "follow" as const, lightTheme: "vscode_light", darkTheme: "vscode_dark", fixedTheme: "vscode_dark" };
    setThemePreferences(preferences);
    setTerminalThemePreferences(preferences);
    setCurrentTerminalTheme("vscode_dark");
    const nextBackground: TerminalBackgroundConfig = { style: "theme", solidColor: "#101827", imageFit: "cover", imageOpacity: 0.72, imageOverlay: 0.35, imageBlur: 0 };
    setBackground(nextBackground);
    setTerminalBackgroundConfig(nextBackground);
  };

  const updateBackground = (patch: Partial<TerminalBackgroundConfig>) => {
    const next = { ...background(), ...patch };
    setBackground(next);
    setTerminalBackgroundConfig(next);
  };

  const updateThemePreferences = (patch: Partial<ReturnType<typeof getTerminalThemePreferences>>) => {
    const next = { ...terminalThemePreferences(), ...patch };
    setThemePreferences(next);
    setTerminalThemePreferences(next);
    setCurrentTerminalTheme(next.mode === "fixed" ? next.fixedTheme : effectiveTheme() === "light" ? next.lightTheme : next.darkTheme);
  };
  const chooseTerminalTheme = (name: string) => {
    const preferences = terminalThemePreferences();
    if (preferences.mode === "fixed") updateThemePreferences({ fixedTheme: name });
    else if (effectiveTheme() === "light") updateThemePreferences({ lightTheme: name });
    else updateThemePreferences({ darkTheme: name });
  };
  const previewBackgroundStyle = () => getEffectiveTerminalBackgroundStyle(background());

  const chooseBackgroundImage = async (file?: File) => {
    if (!file) return;
    setImageError("");
    try {
      const imageAssetId = await saveTerminalBackgroundImage(file);
      updateBackground({ style: "image", imageAssetId });
    } catch (error) { setImageError(error instanceof Error ? error.message : "无法读取图片"); }
    if (imageInputRef) imageInputRef.value = "";
  };

  const handleCheckUpdate = async () => {
    if (checkingUpdate()) return;
    setCheckingUpdate(true);
    setUpdateStatus("正在检查...");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("已是最新版本");
        return;
      }
      setUpdateStatus(`正在下载 ${update.version}...`);
      await update.downloadAndInstall(event => {
        if (event.event === "Finished") setUpdateStatus("安装完成，正在重启...");
      });
      await relaunch();
    } catch (error) {
      console.error("Update failed:", error);
      setUpdateStatus("检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const updateSetting = <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => {
    const next = { ...terminalSettings(), [key]: value };
    setSettings(next);
    setTerminalSettings(next);
  };

  // Font size is committed only inside the supported range; the draft keeps
  // out-of-range typing visible until blur, then snaps back to the applied value.
  const updateFontSizeDraft = (raw: string) => {
    setFontSizeDraft(raw);
    const value = Number(raw);
    if (raw.trim() && isTerminalFontSizeValid(value)) updateSetting("fontSize", value);
  };
  const resetFontSizeDraft = () => setFontSizeDraft(String(terminalSettings().fontSize));

  const navItem = (id: Page, label: string, disabled = false) => (
    <button class={page() === id ? "active" : ""} disabled={disabled} onClick={() => !disabled && setPage(id)}>
      <span>{label}</span>
      <Show when={disabled}><small>暂不可用</small></Show>
    </button>
  );
  const startWindowDrag = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) void getCurrentWindow().startDragging();
  };

  const handleIsolatedWheel = (event: WheelEvent) => {
    const container = event.currentTarget as HTMLElement;
    const delta = event.deltaY;
    if (!delta) return;
    if (container.scrollHeight <= container.clientHeight + 1) {
      event.preventDefault();
      return;
    }
    const atTop = container.scrollTop <= 0 && delta < 0;
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1 && delta > 0;
    if (atTop || atBottom) event.preventDefault();
  };

  const aiProviderLabel = (provider: string) =>
    AI_PROVIDER_TEMPLATES.find(item => item.id === provider)?.label || provider || "自定义供应商";
  const aiProviderProtocolLabel = (protocol: string) =>
    protocol === "anthropic" ? "Anthropic Messages" : protocol === "ollama" ? "Ollama" : "OpenAI Chat";
  const aiProviderModelSummary = (config: AIProviderConfig) => {
    const models = (config.models || []).filter(model => model.model.trim());
    return `${models.length} 个模型 / ${models.filter(model => model.enabled).length} 个启用`;
  };

  return (
    <div class={`settings-workspace ${props.standalone ? "standalone" : ""}`}>
      <header class="settings-topbar" onMouseDown={startWindowDrag}>
        <div class="settings-brand">
          <BrandMark size={20} /><span>PortNest</span>
        </div>
        <strong>设置</strong>
        <div class="settings-window-actions">
          <button class={pinned() ? "active" : ""} onClick={() => void togglePin()} title={pinned() ? "取消置顶" : "窗口置顶"} aria-label="窗口置顶"><Icon name="pin" size={15} /></button>
          <button onClick={() => void minimizeSettings()} title="最小化" aria-label="最小化"><Icon name="minimize" size={15} /></button>
          <button onClick={() => void toggleMaximizeSettings()} title={maximized() ? "还原" : "最大化"} aria-label="最大化"><Icon name={maximized() ? "restore" : "maximize"} size={14} /></button>
          <button onClick={props.onClose} title="关闭设置" aria-label="关闭设置"><Icon name="close" size={15} /></button>
        </div>
      </header>

      <div class="settings-layout">
        <aside class="settings-sidebar">
          <h4>外观</h4>
          {navItem("appearance", "基础")}
          {navItem("terminal", "终端")}
          <h4>通用</h4>
          {navItem("general", "基础")}
          {navItem("ssh", "SSH / 终端")}
          {navItem("database", "数据库")}
          {navItem("cli", "CLI")}
          <h4>AI</h4>
          {navItem("aiModels", "模型配置")}
          {navItem("aiMcp", "MCP")}
          {navItem("aiSearch", "自定义搜索引擎")}
          <h4>账号</h4>
          {navItem("account", "账号")}
          <h4>快捷键</h4>
          {navItem("shortcutsBasic", "基础")}
          {navItem("shortcutsEditor", "编辑器")}
          {navItem("shortcutsSsh", "SSH / 终端")}
          {navItem("shortcutsDatabase", "数据库")}
          {navItem("shortcutsDocker", "Docker")}
          <h4>工具</h4>
          {navItem("templates", "命令模板")}
          <h4>储存仓库</h4>
          {navItem("storage", "储存仓库")}
          <h4>关于</h4>
          {navItem("version", "版本")}
        </aside>

        <main class={`settings-main ${page() === "aiModels" ? "ai-settings-main" : ""}`}>
          <Show when={page() === "appearance"}>
            <div class="settings-page">
              <div class="settings-page-heading"><h2>外观</h2><p>控制应用主题与终端配色方案。</p></div>
              <h3>主题</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span><b>主题风格</b><small>切换整套界面配色与表面质感</small></span>
                    <select value={themeSkin()} onChange={event => setThemeSkin(event.currentTarget.value as ThemeSkin)}>
                      <For each={themeSkins}>{skin => <option value={skin.id}>{skin.name}</option>}</For>
                    </select>
                  </label>
                  <label><span><b>主题模式</b><small>控制应用窗口、菜单和面板的明暗外观</small></span>
                    <select value={themeMode()} onChange={event => { setThemeMode(event.currentTarget.value as ThemeMode); setCurrentTerminalTheme(getTerminalTheme()); }}>
                      <option value="system">跟随系统</option><option value="light">明亮</option><option value="dark">暗黑</option>
                    </select>
                  </label>
                  <label><span><b>终端配色</b><small>选择当前终端的主题配色</small></span>
                    <select value={currentTerminalTheme()} onChange={event => chooseTerminalTheme(event.currentTarget.value)}>
                      <For each={Object.entries(terminalThemes)}>{([key, value]) => <option value={key}>{value.name}</option>}</For>
                    </select>
                  </label>
                </div>
              </div>
              <h3>终端配色方案</h3>
              <div class="terminal-theme-grid">
                <For each={Object.entries(terminalThemes)}>{([key, value]) =>
                  <button class={currentTerminalTheme() === key ? "active" : ""} onClick={() => chooseTerminalTheme(key)}>
                    <span class="theme-swatch" style={{ background: value.background, color: value.foreground }}><i style={{ background: value.red }} /><i style={{ background: value.green }} /><i style={{ background: value.blue }} /></span>
                    <span>{value.name}</span>
                  </button>
                }</For>
              </div>
            </div>
          </Show>

          <Show when={page() === "terminal"}>
            <div class="settings-page terminal-page-replica">
              <div class="settings-page-heading"><h2>终端</h2><p>调整终端显示、预览和文件列表布局。</p></div>

              <section class="settings-terminal-preview-shell">
                <div class={`terminal-settings-preview settings-terminal-preview terminal-background-${previewBackgroundStyle()}${terminalSettings().stripedBackground ? " terminal-striped" : ""}${terminalSettings().highlightEnhancement ? " terminal-highlight-enhanced" : ""}`} style={{
                  color: terminalThemes[currentTerminalTheme()]?.foreground,
                  "font-family": terminalSettings().fontFamily,
                  "font-size": `${terminalSettings().fontSize}px`,
                  "line-height": String(terminalSettings().lineHeight),
                  "letter-spacing": `${terminalSettings().letterSpacing}px`,
                  "--preview-row-height": `${terminalSettings().fontSize * terminalSettings().lineHeight}px`,
                  "--preview-theme-background": terminalThemes[currentTerminalTheme()]?.background,
                  "--preview-green": terminalThemes[currentTerminalTheme()]?.green,
                  "--preview-blue": terminalThemes[currentTerminalTheme()]?.blue,
                  "--preview-solid": background().solidColor,
                  "--preview-image": terminalBackgroundImageUrl() ? `url("${terminalBackgroundImageUrl()}")` : "none",
                  "--preview-image-size": background().imageFit === "fill" ? "100% 100%" : background().imageFit,
                  "--preview-opacity": String(background().imageOpacity),
                  "--preview-overlay": String(background().imageOverlay),
                  "--preview-blur": `${background().imageBlur}px`,
                }}>
                  <i class="terminal-preview-background" aria-hidden="true" />
                  <i class="terminal-preview-stripes" aria-hidden="true" />
                  <div><span>user@server</span>:<b>~/app$</b> ls -all</div>
                  <div>total 540</div>
                  <div>drwxr-xr-x 8 deploy deploy 4096 May 25 10:20 .</div>
                  <div>drwxr-xr-x 6 deploy deploy 4096 May 25 09:50 ..</div>
                  <div>-rw-r--r-- 1 deploy deploy 256 May 24 18:36 .env</div>
                  <div>drwxr-xr-x 4 deploy deploy 4096 May 25 10:10 dist</div>
                  <div><span>user@server</span>:<b>~/app$</b> <i class="terminal-preview-cursor" /></div>
                </div>
                <div class="settings-terminal-file-preview">
                  <div class="settings-file-preview-toolbar"><Icon name="back" size={12} /><Icon name="refresh" size={12} /><span>/srv/app</span><Icon name="search" size={12} /><Icon name="info" size={12} /></div>
                  <div class="settings-file-summary">共 5 个文件，2 个文件夹，514.3KB</div>
                  <div class="settings-file-preview-head"><span>名称</span><span>大小</span></div>
                  <div class="settings-file-preview-row"><span><Icon name="folder" size={12} /> ..</span><em>—</em></div>
                  <div class="settings-file-preview-row"><span><Icon name="folder" size={12} /> dist</span><em>0B</em></div>
                  <div class="settings-file-preview-row"><span><Icon name="folder" size={12} /> logs</span><em>0B</em></div>
                  <div class="settings-file-preview-row"><span><Icon name="file" size={12} /> deploy.sh</span><em>842B</em></div>
                  <div class="settings-file-preview-row active"><span><Icon name="file" size={12} /> app.log</span><em>512KB</em></div>
                  <div class="settings-file-preview-row"><span><Icon name="file" size={12} /> package.json</span><em>1.3KB</em></div>
                </div>
              </section>

              <h3>终端显示</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span><b>终端字体</b></span>
                    <select value={terminalSettings().fontFamily} onChange={event => updateSetting("fontFamily", event.currentTarget.value)}>
                      <option>JetBrains Mono, Cascadia Code, Consolas, monospace</option>
                      <option>Cascadia Code, Consolas, monospace</option><option>Consolas, monospace</option>
                    </select>
                  </label>
                  <label class={fontSizeDraftValid() ? undefined : "settings-row-invalid"}>
                    <span>
                      <b>终端字号</b>
                      <small>{fontSizeDraftValid() ? `可调范围 ${TERMINAL_FONT_SIZE_MIN}–${TERMINAL_FONT_SIZE_MAX} px` : `仅支持 ${TERMINAL_FONT_SIZE_MIN}–${TERMINAL_FONT_SIZE_MAX} px，超出的输入不会应用`}</small>
                    </span>
                    <input
                      type="number"
                      min={TERMINAL_FONT_SIZE_MIN}
                      max={TERMINAL_FONT_SIZE_MAX}
                      value={fontSizeDraft()}
                      aria-invalid={!fontSizeDraftValid()}
                      onInput={event => updateFontSizeDraft(event.currentTarget.value)}
                      onChange={resetFontSizeDraft}
                      onBlur={resetFontSizeDraft}
                    />
                  </label>
                  <label><span><b>终端行高</b></span><input type="number" min="1" max="2" step="0.1" value={terminalSettings().lineHeight} onInput={event => updateSetting("lineHeight", Number(event.currentTarget.value))} /></label>
                  <label><span><b>终端间距</b></span><input type="number" min="-2" max="8" value={terminalSettings().letterSpacing} onInput={event => updateSetting("letterSpacing", Number(event.currentTarget.value))} /></label>
                </div>
                <div class="settings-card">
                  <label><span><b>终端高亮增强</b><small>高亮命令与路径，不改变终端配色</small></span><Toggle checked={terminalSettings().highlightEnhancement} onChange={value => updateSetting("highlightEnhancement", value)} /></label>
                  <label><span><b>条纹背景</b><small>使用浅色水平条纹区分输出行</small></span><Toggle checked={terminalSettings().stripedBackground} onChange={value => updateSetting("stripedBackground", value)} /></label>
                  <label class="settings-row-unavailable"><span><b>WebGL 渲染</b><small>使用 GPU 提升终端渲染性能</small></span><DisabledToggle /></label>
                  <label><span><b>最大缓存行数</b></span><input type="number" min="100" max="100000" value={terminalSettings().scrollback} onChange={event => updateSetting("scrollback", Number(event.currentTarget.value))} /></label>
                </div>
              </div>
              <h3>文件列表显示</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span><b>文件列表布局</b></span>
                    <select value={uiStore.filesStacked() ? "stacked" : "side"} onChange={event => uiStore.setFilesStacked(event.currentTarget.value === "stacked")}>
                      <option value="side">左右布局</option><option value="stacked">上下布局</option>
                    </select>
                  </label>
                  <label class="settings-row-unavailable"><span><b>远程文件显示列</b></span><DisabledSelect value="名称, 大小" /></label>
                </div>
                <div class="settings-card">
                  <label class="settings-row-unavailable"><span><b>本地文件显示列</b></span><DisabledSelect value="名称, 修改时间, 类型, 大小" /></label>
                  <label><span><b>显示隐藏文件</b><small>在文件列表中显示以点开头的隐藏文件</small></span><Toggle checked={showHiddenFiles()} onChange={value => setShowHiddenFilesPreference(value)} /></label>
                </div>
              </div>
              <h3>终端背景</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span><b>背景风格</b></span>
                    <select value={background().style} onChange={event => updateBackground({ style: event.currentTarget.value as TerminalBackgroundStyle })}>
                      <For each={BACKGROUNDS}>{([key, label]) => <option value={key}>{label}</option>}</For>
                    </select>
                  </label>
                  <Show when={background().style === "solid"}><label><span><b>背景颜色</b></span><input type="color" value={background().solidColor} onInput={event => updateBackground({ solidColor: event.currentTarget.value })} /></label></Show>
                  <label class="settings-row-unavailable"><span><b>背景跟随主题</b></span><DisabledToggle /></label>
                </div>
                <div class="settings-card">
                  <Show when={background().style === "image"}>
                    <label><span><b>背景图片</b></span><span class="settings-image-actions"><button class="settings-inline-button" onClick={() => imageInputRef?.click()}>选择图片</button><button class="settings-inline-button danger" disabled={!background().imageAssetId} onClick={() => void clearTerminalBackgroundImage().then(() => updateBackground({ imageAssetId: undefined, style: "theme" }))}>清除</button></span></label>
                    <label><span><b>填充方式</b></span><select value={background().imageFit} onChange={event => updateBackground({ imageFit: event.currentTarget.value as TerminalBackgroundConfig["imageFit"] })}><option value="cover">覆盖</option><option value="contain">包含</option><option value="fill">拉伸</option></select></label>
                    <label><span><b>图片透明度</b><em>{Math.round(background().imageOpacity * 100)}%</em></span><input type="range" min="0.1" max="1" step="0.05" value={background().imageOpacity} onInput={event => updateBackground({ imageOpacity: Number(event.currentTarget.value) })} /></label>
                    <input ref={imageInputRef} class="settings-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseBackgroundImage(event.currentTarget.files?.[0])} />
                    <Show when={imageError()}><p class="settings-error">{imageError()}</p></Show>
                  </Show>
                  <label><span><b>深色遮罩</b><em>{Math.round(background().imageOverlay * 100)}%</em></span><input type="range" min="0" max="0.8" step="0.05" value={background().imageOverlay} onInput={event => updateBackground({ imageOverlay: Number(event.currentTarget.value) })} /></label>
                  <label><span><b>模糊度</b><em>{background().imageBlur}px</em></span><input type="range" min="0" max="16" step="1" value={background().imageBlur} onInput={event => updateBackground({ imageBlur: Number(event.currentTarget.value) })} /></label>
                    <p class="settings-note">更多图片背景配置暂不可用。</p>
                </div>
              </div>
            </div>
          </Show>

          <Show when={page() === "general"}>
            <div class="settings-page">
              <div class="settings-page-heading"><h2>基础</h2><p>控制应用基础行为、标签和内置编辑器。</p></div>
              <h3>基本</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label class="settings-row-unavailable"><span><b>中键关闭标签</b><small>使用鼠标中键快速关闭标签页</small></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>界面动画</b><small>启用窗口和菜单过渡效果</small></span><DisabledToggle /></label>
                  <label><span><b>关闭主窗口时</b><small>标题栏关闭按钮的行为</small></span><select value={uiStore.windowCloseAction()} onChange={event => uiStore.setWindowCloseAction(event.currentTarget.value as WindowCloseAction)}><option value="ask">每次询问</option><option value="close">退出应用</option><option value="fold">折叠到托盘</option></select></label>
                </div>
                <div class="settings-card">
                  <label class="settings-row-unavailable"><span><b>语言</b></span><DisabledSelect value="简体中文" /></label>
                  <label class="settings-row-unavailable"><span><b>更新通道</b></span><DisabledSelect value="稳定通道" /></label>
                  <label class="settings-row-unavailable"><span><b>会员标识</b></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>字体连字</b></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>滚轮缩放</b></span><DisabledToggle /></label>
                </div>
              </div>
              <h3>锁屏设置</h3>
              <div class="settings-grid">
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>启动时锁屏</b><small>登录账号后可用</small></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>自动锁屏</b></span><DisabledSelect value="关闭" /></label>
                </div>
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>锁屏密码</b><small>登录账号后可设置</small></span><DisabledSelect value="暂不可用" /></label>
                </div>
              </div>
              <h3>标签</h3>
              <div class="settings-grid">
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>关闭前确认</b><small>关闭 SSH / 终端标签时弹出确认</small></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>标签闪烁提醒</b><small>非当前标签有新活动时闪烁</small></span><DisabledToggle /></label>
                </div>
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>多行标签</b><small>标签过多时多行显示</small></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>自动缩短标签</b><small>空间不足时优先缩小标签</small></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>恢复上次标签</b><small>启动时恢复上次打开的标签</small></span><DisabledToggle /></label>
                </div>
              </div>
              <h3>编辑器</h3>
              <div class="settings-grid">
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>编辑器字体</b></span><DisabledSelect value="JetBrainsMono, NotoSansSC" /></label>
                  <label class="settings-row-unavailable"><span><b>编辑器字号</b></span><DisabledSelect value="14px" /></label>
                </div>
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>自动换行</b></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>Tab 键</b></span><DisabledSelect value="Tab 字符" /></label>
                </div>
              </div>
            </div>
          </Show>
          <Show when={page() === "database"}>
            <PlaceholderSettingsPage title="数据库" description="数据库表格、SQL 查询和 Redis 浏览相关设置。" sections={[
              { title: "数据库", groups: [
                [
                  { label: "表格字体", value: "JetBrainsMono, NotoSansSC" },
                  { label: "打开连接时自动展开", toggle: true },
                  { label: "数据库标签显示信息", value: "显示数据库 + 连接名称" },
                  { label: "表缓存", value: "连接时拉取一次表列表" },
                  { label: "固定主键列", toggle: true },
                  { label: "表数据自动计数", toggle: true },
                ],
                [
                  { label: "文本对齐", value: "自动" },
                  { label: "每页行数", value: "500" },
                  { label: "SQL 查询数量限制", value: "无限制" },
                  { label: "SQL 查询每页数量", value: "1,000" },
                  { label: "显示表注释", toggle: true },
                  { label: "危险 SQL 确认", toggle: true },
                ],
              ] },
              { title: "Redis", groups: [
                [
                  { label: "键列表上限", value: "10000" },
                  { label: "显示键值", toggle: true },
                ],
                [
                  { label: "分组分隔符", value: ":" },
                ],
              ] },
            ]} />
          </Show>
          <Show when={page() === "cli"}>
            <PlaceholderSettingsPage title="CLI" description="命令行工具和外部程序集成设置。" sections={[
              { title: "命令行", groups: [[
                { label: "默认 Shell", value: "PowerShell" },
                { label: "复用已有终端窗口", toggle: true },
                { label: "打开 CLI 时加载环境变量", toggle: true },
              ]] },
            ]} />
          </Show>

          <Show when={page() === "aiModels"}>
            <div class="settings-page ai-settings-page">
              <div class="settings-page-heading"><h2>模型配置</h2><p>添加模型供应商配置，聊天页可全局使用。只显示已经添加的供应商。</p></div>
              <div class="ai-config-layout">
                <aside class="ai-provider-panel">
                  <div class="ai-provider-panel-head">
                    <div><strong>供应商</strong><span>添加模型供应商配置，聊天页可全局使用。</span></div>
                    <button type="button" class="ai-provider-add-button" onClick={() => setShowAIProviderPicker(value => !value)}>＋ 添加</button>
                    <Show when={showAIProviderPicker()}>
                      <div class="ai-provider-picker-backdrop" onClick={() => setShowAIProviderPicker(false)}>
                        <div class="ai-provider-picker" onClick={event => event.stopPropagation()}>
                          <strong>添加供应商</strong>
                          <div class="ai-provider-picker-search">
                            <Icon name="search" size={13} />
                            <input autofocus value={aiProviderSearch()} placeholder="搜索供应商" onInput={event => setAIProviderSearch(event.currentTarget.value)} />
                          </div>
                          <div class="ai-provider-picker-list">
                            <For each={filteredAIProviderTemplates()}>{item => (
                              <button type="button" onClick={() => void addAIProvider(item)}>
                                <AIProviderIcon provider={item.id} size={19} />
                                <span><b>{item.label}</b><small>{aiProviderProtocolLabel(item.protocol)}</small></span>
                              </button>
                            )}</For>
                            <Show when={filteredAIProviderTemplates().length === 0}>
                              <div class="ai-provider-picker-empty">没有可添加的供应商</div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>
                  </div>
                  <Show when={aiProviders().length === 0}>
                    <div class="ai-provider-empty">
                      <strong>还没有供应商</strong>
                      <span>点击右上角添加按钮，选择供应商后创建配置。</span>
                    </div>
                  </Show>
                  <div class="ai-provider-list" onWheel={handleIsolatedWheel}>
                    <For each={aiProviders()}>{item => (
                      <div
                        class={`ai-provider-card ${activeAIProviderId() === item.id ? "active" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectAIProvider(item)}
                        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") selectAIProvider(item); }}
                      >
                        <AIProviderIcon provider={item.provider} size={19} />
                        <div class="ai-provider-copy">
                          <div class="ai-provider-title">
                            <strong>{item.display_name || aiProviderLabel(item.provider)}</strong>
                            <span onClick={event => event.stopPropagation()}><Toggle checked={item.enabled} onChange={value => void toggleAIProvider(item, value)} /></span>
                          </div>
                          <small>{aiProviderLabel(item.provider)}</small>
                          <code>{item.endpoint || "未填写 API Endpoint"}</code>
                          <span class="ai-provider-model-count">{aiProviderModelSummary(item)}</span>
                        </div>
                        <button type="button" class="ai-provider-delete" title="删除供应商" onClick={event => { event.stopPropagation(); void removeAIProvider(item); }}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    )}</For>
                  </div>
                </aside>
                <div class="ai-config-panel">
                  <Show when={activeAIProviderId()} fallback={
                    <div class="ai-config-empty">
                      <span class="ai-config-empty-icon"><Icon name="sparkles" size={22} /></span>
                      <h3>选择或新增供应商配置</h3>
                      <p>然后在这里维护凭据和模型。</p>
                    </div>
                  }>
                    <div class="ai-config-panel-heading">
                      <AIProviderIcon provider={aiConfig().provider} size={21} />
                      <div><strong>配置详情</strong><span>填写凭据、添加模型，并配置模型参数。</span></div>
                      <button type="button" class="settings-inline-button danger" onClick={() => void removeAIProvider(aiConfig())}>删除供应商</button>
                    </div>
                    <div class="ai-config-scroll" onWheel={handleIsolatedWheel}>
                    <Show when={aiConfigLoading()}><div class="settings-note">正在读取已保存的模型配置…</div></Show>
                    <div class="settings-card ai-config-card">
                      <label><span><b>名称</b></span><input value={aiConfig().display_name} placeholder="例如：DeepSeek 日常使用" onInput={event => patchAIConfig({ display_name: event.currentTarget.value })} /></label>
                      <label><span><b>API Endpoint</b></span><input value={aiConfig().endpoint} placeholder="https://api.deepseek.com" onInput={event => patchAIConfig({ endpoint: event.currentTarget.value })} /></label>
                      <label><span><b>API Key</b></span>
                        <div class="ai-secret-input-row">
                          <input type={aiApiKeyVisible() ? "text" : "password"} value={aiConfig().api_key} placeholder="sk-..." onInput={event => patchAIConfig({ api_key: event.currentTarget.value })} />
                          <button type="button" class="settings-inline-button" onClick={() => setAIApiKeyVisible(value => !value)}>{aiApiKeyVisible() ? "隐藏" : "显示"}</button>
                        </div>
                      </label>
                      <label><span><b>协议</b></span>
                        <select value={aiConfig().protocol} onChange={event => patchAIConfig({ protocol: event.currentTarget.value })}>
                          <option value="openai_chat">OpenAI Chat Completions</option>
                          <option value="anthropic">Anthropic Messages</option>
                          <option value="ollama">Ollama（OpenAI 兼容）</option>
                        </select>
                      </label>
                      <label><span><b>代理</b></span>
                        <select value={aiConfig().proxy_mode || "auto"} onChange={event => patchAIConfig({ proxy_mode: event.currentTarget.value })}>
                          <option value="auto">自动（优先使用系统代理）</option>
                          <option value="none">直连（不使用代理）</option>
                        </select>
                      </label>
                      <div class="ai-header-editor">
                        <div class="ai-header-editor-head">
                          <div><strong>自定义 Header</strong><small>覆盖同名请求头，应用于聊天、连接测试和模型列表请求。</small></div>
                          <button type="button" class="settings-inline-button" onClick={() => commitAIHeaderRows([...aiHeaderRows(), { key: "", value: "" }])}>＋ 添加 Header</button>
                        </div>
                        <For each={aiHeaderRows()}>{(row, index) => (
                          <div class="ai-header-row">
                            <input value={row.key} placeholder="Header 名称" onInput={event => {
                              const rows = aiHeaderRows().map((item, itemIndex) => itemIndex === index() ? { ...item, key: event.currentTarget.value } : item);
                              commitAIHeaderRows(rows);
                            }} />
                            <input value={row.value} placeholder="Header 值" onInput={event => {
                              const rows = aiHeaderRows().map((item, itemIndex) => itemIndex === index() ? { ...item, value: event.currentTarget.value } : item);
                              commitAIHeaderRows(rows);
                            }} />
                            <button type="button" class="ai-header-remove" title="删除 Header" onClick={() => commitAIHeaderRows(aiHeaderRows().filter((_, itemIndex) => itemIndex !== index()))}>
                              <Icon name="trash" size={12} />
                            </button>
                          </div>
                        )}</For>
                      </div>
                      <label><span><b>自定义 UA</b></span><input value={aiConfig().custom_user_agent || ""} placeholder="Go-http-client/1.1" onInput={event => patchAIConfig({ custom_user_agent: event.currentTarget.value })} /></label>
                      <label><span><b>备注</b></span><input value={aiConfig().remark || ""} placeholder="可选" onInput={event => patchAIConfig({ remark: event.currentTarget.value })} /></label>
                    </div>
                    <div class="settings-card ai-config-card ai-model-config-card">
                      <div class="ai-model-panel-head">
                        <div><strong>模型</strong><span>聊天页会使用这里启用的模型。</span></div>
                        <div class="ai-model-panel-actions">
                          <span class="ai-model-count-badge">{configuredAIModels().filter(model => model.model.trim()).length} 个 / {configuredAIModels().filter(model => model.enabled && model.model.trim()).length} 启用</span>
                          <button type="button" class="settings-inline-button" disabled={aiModelsLoading()} onClick={() => void fetchAIModels()}>{aiModelsLoading() ? "获取中…" : "获取可用模型"}</button>
                        </div>
                      </div>
                      <Show when={aiModelPickerOpen()}>
                        <div class="ai-model-available-list">
                          <div class="ai-model-available-head"><span>可用模型</span><button type="button" onClick={() => setAIModelPickerOpen(false)}>收起</button></div>
                          <Show when={aiModelsLoading()}><div class="ai-model-empty">正在获取模型列表…</div></Show>
                          <Show when={!aiModelsLoading() && availableAIModels().length === 0}><div class="ai-model-empty">没有可添加的模型</div></Show>
                          <For each={availableAIModels()}>{model => (
                            <button type="button" class="ai-model-available-row" onClick={() => void addAIModel(model)}>
                              <span>{model}</span><Icon name="plus" size={13} />
                            </button>
                          )}</For>
                        </div>
                      </Show>
                      <div class="ai-model-list">
                        <Show when={configuredAIModels().length === 0}>
                          <div class="ai-model-empty">暂无模型，请添加模型或手动输入模型 ID。</div>
                        </Show>
                        <For each={configuredAIModels()}>{model => (
                          <div class="ai-model-item">
                            <div class="ai-model-row">
                              <span class="ai-model-row-icon"><Icon name="sparkles" size={13} /></span>
                              <div class="ai-model-row-main"><strong>{model.model}</strong><small>{Math.round(model.context_window / 1000)}K 上下文 · {model.max_output} 输出 Token</small></div>
                              <button type="button" class="ai-model-configure" title="模型参数" aria-expanded={aiExpandedModel() === model.model} onClick={() => setAIExpandedModel(current => current === model.model ? null : model.model)}>
                                <Icon name={aiExpandedModel() === model.model ? "chevronUp" : "settings"} size={12} />
                              </button>
                              <span onClick={event => event.stopPropagation()}><Toggle checked={model.enabled} onChange={value => void toggleAIModel(model.model, value)} /></span>
                              <button type="button" class="ai-model-remove" title="删除模型" onClick={() => void removeAIModel(model.model)}><Icon name="trash" size={12} /></button>
                            </div>
                            <Show when={aiExpandedModel() === model.model}>
                              <div class="ai-model-advanced">
                                <div class="ai-model-advanced-grid">
                                  <label><span>上下文窗口</span><input type="number" min="1000" max="10000000" value={model.context_window} onInput={event => {
                                    const value = Number(event.currentTarget.value);
                                    if (Number.isFinite(value)) updateAIModelConfig(model.model, { context_window: Math.max(1, value) });
                                  }} /></label>
                                  <label><span>最大输出 Token</span><input type="number" min="1" max="1000000" value={model.max_output} onInput={event => {
                                    const value = Number(event.currentTarget.value);
                                    if (Number.isFinite(value)) updateAIModelConfig(model.model, { max_output: Math.max(1, value) });
                                  }} /></label>
                                  <label><span>温度</span><input type="number" min="0" max="2" step="0.1" value={model.temperature ?? ""} placeholder="默认" onInput={event => {
                                    const value = event.currentTarget.value === "" ? null : Number(event.currentTarget.value);
                                    updateAIModelConfig(model.model, { temperature: value !== null && Number.isFinite(value) ? value : null });
                                  }} /></label>
                                </div>
                                <div class="ai-model-capabilities">
                                  <span class="ai-model-capabilities-label">能力</span>
                                  <div class="ai-model-capability"><Toggle checked={model.supports_tool_calling !== false} onChange={value => updateAIModelConfig(model.model, { supports_tool_calling: value })} /><span>工具调用</span></div>
                                  <div class="ai-model-capability"><Toggle checked={Boolean(model.supports_image_input)} onChange={value => updateAIModelConfig(model.model, { supports_image_input: value })} /><span>图像输入</span></div>
                                  <div class="ai-model-capability"><Toggle checked={Boolean(model.supports_image_output)} onChange={value => updateAIModelConfig(model.model, { supports_image_output: value })} /><span>图像输出</span></div>
                                </div>
                              </div>
                            </Show>
                          </div>
                        )}</For>
                      </div>
                      <div class="ai-model-manual-row">
                        <input value={aiManualModel()} placeholder="或手动输入模型 ID" onInput={event => setAIManualModel(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && aiManualModel().trim()) void addAIModel(aiManualModel()).then(() => setAIManualModel("")); }} />
                        <button type="button" class="settings-inline-button" disabled={!aiManualModel().trim()} onClick={() => void addAIModel(aiManualModel()).then(() => setAIManualModel(""))}>添加</button>
                      </div>
                    </div>
                    <div class="ai-config-actions">
                      <button type="button" class="settings-inline-button" disabled={aiTesting() || aiSaving()} onClick={() => void testAIConfiguration()}>{aiTesting() ? "测试中…" : "测试连接"}</button>
                      <button type="button" class="ai-save-button" disabled={aiSaving() || aiTesting()} onClick={() => void saveAIConfiguration()}>{aiSaving() ? "保存中…" : "保存配置"}</button>
                    </div>
                    <Show when={aiTestResult()}><div class={`ai-test-result ${aiTestResult().startsWith("测试失败") ? "error" : "success"}`}>{aiTestResult()}</div></Show>
                    <Show when={aiSettingsMessage()}><div class="settings-note">{aiSettingsMessage()}</div></Show>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <Show when={page() === "aiMcp"}>
            <PlaceholderSettingsPage title="MCP" description="Model Context Protocol 服务连接设置。" sections={[
              { title: "MCP 服务", groups: [[
                { label: "启用 MCP", toggle: true },
                { label: "服务列表", value: "暂不可用" },
                { label: "自动重连", toggle: true },
              ]] },
            ]} />
          </Show>

          <Show when={page() === "aiSearch"}>
            <PlaceholderSettingsPage title="自定义搜索引擎" description="为 AI 助手配置外部搜索来源。" sections={[
              { title: "搜索引擎", groups: [[
                { label: "默认搜索引擎", value: "暂不可用" },
                { label: "搜索 API 地址", value: "暂不可用" },
                { label: "返回结果数量", value: "10" },
              ]] },
            ]} />
          </Show>

          <Show when={page() === "account"}>
            <PlaceholderSettingsPage title="账号" description="账号登录、会员和云端服务设置。" sections={[
              { title: "账号信息", groups: [[
                { label: "登录状态", value: "未登录" },
                { label: "账号邮箱", value: "暂不可用" },
                { label: "会员有效期", value: "暂不可用" },
              ]] },
            ]} />
          </Show>
          <Show when={page() === "shortcutsBasic"}>
            <PlaceholderSettingsPage title="快捷键 · 基础" description="应用全局操作快捷键。" readOnly note="以下为当前版本实际快捷键，暂不支持自定义。" sections={[
              { title: "全局快捷键", groups: [[
                { label: "快速切换", value: "Ctrl+K" },
                { label: "新建连接", value: "Ctrl+N" },
                { label: "关闭当前标签", value: "Ctrl+W", hint: "输入框内不触发" },
                { label: "恢复关闭的标签", value: "Ctrl+Shift+T" },
                { label: "切换会话", value: "Ctrl+Tab / Ctrl+Shift+Tab" },
                { label: "AI 助手", value: "Ctrl+Shift+A" },
                { label: "关闭窗口", value: "Alt+F4" },
              ]] },
            ]} />
          </Show>
          <Show when={page() === "shortcutsEditor"}>
            <PlaceholderSettingsPage title="快捷键 · 编辑器" description="SQL 与文本编辑器快捷键。" readOnly note="以下为当前版本实际快捷键，暂不支持自定义。" sections={[
              { title: "编辑器快捷键", groups: [[
                { label: "执行查询", value: "Ctrl+Enter" },
                { label: "保存远程文件", value: "Ctrl+S" },
                { label: "补全选择", value: "↑ / ↓" },
                { label: "插入补全", value: "Enter / Tab" },
                { label: "关闭补全", value: "Esc" },
              ]] },
            ]} />
          </Show>
          <Show when={page() === "shortcutsSsh"}>
            <PlaceholderSettingsPage title="快捷键 · SSH / 终端" description="终端会话中的快捷操作。" readOnly note="以下为当前版本实际快捷键，暂不支持自定义。" sections={[
              { title: "终端快捷键", groups: [[
                { label: "终端搜索", value: "Ctrl+F" },
                { label: "复制", value: "Ctrl+C", hint: "有选中文本时复制，否则发送中断" },
                { label: "粘贴", value: "Ctrl+V", hint: "受终端设置中的 Ctrl+V 粘贴开关控制" },
              ]] },
            ]} />
          </Show>
          <Show when={page() === "shortcutsDatabase"}>
            <PlaceholderSettingsPage title="快捷键 · 数据库" description="数据库工作区快捷操作。" readOnly note="以下为当前版本实际快捷键，暂不支持自定义。" sections={[
              { title: "数据库快捷键", groups: [[
                { label: "执行查询", value: "Ctrl+Enter" },
                { label: "补全选择", value: "↑ / ↓" },
                { label: "插入补全", value: "Enter / Tab" },
                { label: "关闭补全", value: "Esc" },
              ]] },
            ]} />
          </Show>
          <Show when={page() === "shortcutsDocker"}>
            <PlaceholderSettingsPage title="快捷键 · Docker" description="Docker 工作区快捷操作。" readOnly note="以下为当前版本实际快捷键，暂不支持自定义。" sections={[
              { title: "Docker 快捷键", groups: [[
                { label: "专属快捷键", value: "—", hint: "当前版本未提供 Docker 专属快捷键" },
              ]] },
            ]} />
          </Show>
          <Show when={page() === "storage"}>
            <div class="settings-page">
              <div class="settings-page-heading"><h2>储存仓库</h2><p>本地数据、备份恢复和资产同步设置。</p></div>
              <h3>资产同步</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label class="settings-row-unavailable"><span><b>本地数据</b><small>会清空本地连接和配置</small></span><DisabledSelect value="清理本地数据" /></label>
                  <label class="settings-row-unavailable"><span><b>备份 / 恢复</b><small>资产丢失时可尝试恢复</small></span><DisabledSelect value="恢复备份" /></label>
                  <label><span><b>导入 / 导出</b><small>导入会以新资产追加，不会覆盖现有连接</small></span>
                    <span class="settings-image-actions">
                      <input ref={importSessionsInput} class="settings-file-input" type="file" accept=".json,application/json" onChange={importSessionsFromSettings} />
                      <button class="settings-inline-button" disabled={storageBusy()} onClick={() => importSessionsInput?.click()}>导入</button>
                      <button class="settings-inline-button" disabled={storageBusy()} onClick={() => void exportSessionsFromSettings()}>导出</button>
                    </span>
                  </label>
                  <label class="settings-row-unavailable"><span><b>自动同步</b><small>新建资产后自动同步</small></span><DisabledToggle /></label>
                </div>
                <div class="settings-card settings-card-unavailable">
                  <label class="settings-row-unavailable"><span><b>同步源</b></span><DisabledSelect value="关闭" /></label>
                </div>
              </div>
              <Show when={storageMessage()}><p class="settings-note">{storageMessage()}</p></Show>
            </div>
          </Show>

          <Show when={page() === "ssh"}>
            <div class="settings-page">
              <div class="settings-page-heading"><h2>SSH / 终端</h2><p>管理终端交互、连接恢复和 SFTP 工作区行为。</p></div>
              <h3>终端交互</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <div class="settings-card-title"><strong>剪贴板</strong><span>控制复制和粘贴快捷操作</span></div>
                  <label><span><b>选中后自动复制</b><small>鼠标选中文本后立即写入剪贴板</small></span><Toggle checked={terminalSettings().copyOnSelect} onChange={value => updateSetting("copyOnSelect", value)} /></label>
                  <label><span><b>Ctrl+V 粘贴</b><small>在终端中使用系统粘贴快捷键</small></span><Toggle checked={terminalSettings().ctrlVPaste} onChange={value => updateSetting("ctrlVPaste", value)} /></label>
                </div>
                <div class="settings-card">
                  <div class="settings-card-title"><strong>鼠标操作</strong><span>设置终端内鼠标按键行为</span></div>
                  <label><span>鼠标中键执行</span>
                    <select value={terminalSettings().middleClickAction} onChange={event => updateSetting("middleClickAction", event.currentTarget.value as "paste" | "none")}>
                      <option value="none">不执行</option><option value="paste">粘贴</option>
                    </select>
                  </label>
                  <label><span>鼠标右键执行</span>
                    <select value={terminalSettings().rightClickAction} onChange={event => updateSetting("rightClickAction", event.currentTarget.value as "paste" | "none")}>
                      <option value="paste">粘贴</option><option value="none">不执行</option>
                    </select>
                  </label>
                </div>
              </div>

              <h3>连接与文件管理</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <div class="settings-card-title"><strong>SSH 会话</strong><span>连接异常中断后的处理方式</span></div>
                  <label><span><b>断开后自动重连</b><small>网络恢复后自动尝试重新建立会话</small></span><Toggle checked={terminalSettings().reconnectOnDisconnect} onChange={value => updateSetting("reconnectOnDisconnect", value)} /></label>
                </div>
                <div class="settings-card">
                  <div class="settings-card-title"><strong>SFTP 文件管理</strong><span>设置文件工作区的默认行为</span></div>
                  <label><span><b>连接后打开文件管理</b><small>SSH 会话建立后自动显示 SFTP 面板</small></span><Toggle checked={terminalSettings().openFileManagerOnConnect} onChange={value => updateSetting("openFileManagerOnConnect", value)} /></label>
                </div>
              </div>

              <h3>终端功能</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span><b>SSH/SFTP 路径联动</b><small>终端工作目录与文件管理器路径保持同步</small></span><Toggle checked={uiStore.pathLinked()} onChange={uiStore.setPathLinked} /></label>
                  <label><span><b>终端命令输入提示</b><small>输入命令时显示历史与补全建议</small></span><Toggle checked={terminalSettings().commandHints} onChange={value => updateSetting("commandHints", value)} /></label>
                  <label><span><b>SSH 历史命令</b><small>记录并复用历史输入命令</small></span><Toggle checked={terminalSettings().sshHistory} onChange={value => updateSetting("sshHistory", value)} /></label>
                </div>
                <div class="settings-card">
                  <label><span><b>终端声音</b><small>终端响铃时播放提示音</small></span><Toggle checked={terminalSettings().terminalBell} onChange={value => updateSetting("terminalBell", value)} /></label>
                  <label class="settings-row-unavailable"><span><b>清屏时保留屏幕内容</b><small>执行清屏后保留当前屏幕快照</small></span><DisabledToggle /></label>
                  <label class="settings-row-unavailable"><span><b>日志储存目录</b><small>指定终端会话日志保存位置</small></span><DisabledSelect value="不填写则关闭日志记录" /></label>
                </div>
              </div>

              <h3>SFTP</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label class="settings-row-unavailable"><span><b>默认编辑器</b></span><DisabledSelect value="内置编辑器" /></label>
                  <label class="settings-row-unavailable"><span><b>文件列表读取超时时间（秒）</b></span><DisabledSelect value="60" /></label>
                </div>
                <div class="settings-card">
                  <label class="settings-row-unavailable"><span><b>默认保存路径</b></span><DisabledSelect value="不填写则使用默认路径" /></label>
                  <label class="settings-row-unavailable"><span><b>双击打开文件逻辑</b></span><DisabledSelect value="自动判断编辑 / 打开" /></label>
                </div>
              </div>

              <h3>服务器概览</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <div class="settings-card-title"><strong>状态采集</strong><span>通过独立的 SSH Exec 通道采集只读指标</span></div>
                  <label><span><b>主机状态仪表盘</b><small>关闭后停用 SSH 主机状态的自动采集</small></span><Toggle checked={getOverviewSettings().enabled} onChange={value => setOverviewSettings({ enabled: value })} /></label>
                  <Show when={getOverviewSettings().enabled}>
                    <label><span>刷新频率</span>
                      <select value={String(getOverviewSettings().refreshIntervalSec)} onChange={event => setOverviewSettings({ refreshIntervalSec: Number(event.currentTarget.value) })}>
                        <For each={REFRESH_OPTIONS}>{option => (
                          <option value={String(option.value)}>{option.label}</option>
                        )}</For>
                      </select>
                    </label>
                  </Show>
                  <p class="settings-note">采集使用只读命令完成，不会写入终端会话；命令缺失的指标会自动跳过。关闭仪表盘后仍可在概览面板手动刷新。</p>
                </div>
              </div>
              <p class="settings-note settings-session-note">会话标签、顺序、固定状态和活动标签会自动保存；应用启动后以离线标签恢复，不会自动批量连接。</p>
            </div>
          </Show>

          <Show when={page() === "templates"}>
            <CommandTemplatesSettings />
          </Show>

          <Show when={page() === "version"}>
            <div class="settings-page version-settings-page">
              <div class="settings-page-heading"><h2>版本</h2><p>查看当前版本并获取 PortNest 的最新更新。</p></div>
              <section class="version-card">
                <div class="version-mark">P</div>
                <div class="version-summary">
                  <strong>PortNest</strong>
                  <span>当前版本 {appVersion()}</span>
                  <p>SSH、SFTP、数据库与本地终端工作区</p>
                </div>
                <button class="version-update-button" disabled={checkingUpdate()} onClick={handleCheckUpdate}>
                  <Icon name="refresh" size={16} />
                  {updateStatus()}
                </button>
              </section>
              <div class="version-details">
                <div><span>更新方式</span><strong>自动下载并安装</strong></div>
                <div><span>设置存储</span><strong>本地保存</strong></div>
              </div>
            </div>
          </Show>
        </main>
      </div>

      <footer class="settings-footer">
        <span>{page() === "aiModels" ? "模型配置需点击保存后生效" : "设置会自动保存并立即生效"}</span>
        <div class="settings-footer-actions">
          <button class="settings-footer-secondary" onClick={resetAppearanceSettings}>恢复默认设置</button>
          <button class="settings-footer-primary" onClick={props.onClose}>完成</button>
        </div>
      </footer>
      <TextContextMenu />
    </div>
  );
};
