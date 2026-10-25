import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { templateStore } from "../stores/templateStore";
import { sessionStore, type SessionTab } from "../stores/sessionStore";
import { Icon } from "./Icon";
import "./CommandBroadcast.css";

interface Props { sessions: SessionTab[]; activeSessionId: string | null; onClose: () => void; height?: number; }

type SendMode = "current" | "all";

export const CommandBroadcast: Component<Props> = (props) => {
  const [section, setSection] = createSignal<"broadcast" | "template">("broadcast");
  const [mode, setMode] = createSignal<SendMode>("current");
  const [command, setCommand] = createSignal("");
  const [sending, setSending] = createSignal(false);

  // 仅本次程序运行期间记录撰写栏发送过的命令（不持久化）。
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  let draftBeforeHistory = "";

  const [templateQuery, setTemplateQuery] = createSignal("");
  const [selectedTemplateId, setSelectedTemplateId] = createSignal<string | null>(null);
  const [templateName, setTemplateName] = createSignal("");
  const [templateContent, setTemplateContent] = createSignal("");
  const [templateSaved, setTemplateSaved] = createSignal(false);

  void templateStore.refresh();

  const connected = () => props.sessions.filter(session => session.status === "connected" && session.shellId);
  const activeSession = () => connected().find(session => session.id === props.activeSessionId);
  const targets = () => mode() === "all" ? connected() : (activeSession() ? [activeSession()!] : []);
  const canSend = () => !sending() && !!command().trim() && targets().length > 0;
  const modeLabel = () => mode() === "all" ? "全部会话" : "当前会话";

  const sendBroadcast = async () => {
    if (!canSend()) return;
    const normalized = command().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const payload = `${normalized.replace(/\n/g, "\r")}${normalized.endsWith("\n") ? "" : "\r"}`;
    setSending(true);
    const writable = targets();
    const results = await Promise.allSettled(writable.map(session => sessionStore.sendText(session.id, payload)));
    const failed = results.filter(result => result.status === "rejected").length;
    setSending(false);
    if (failed === 0) {
      const sent = command();
      setHistory(previous => previous[previous.length - 1] === sent ? previous : [...previous, sent]);
      setHistoryIndex(-1);
      setCommand("");
    }
  };

  const olderCommand = () => {
    const list = history();
    if (!list.length) return;
    const index = historyIndex();
    if (index === -1) draftBeforeHistory = command();
    const next = index === -1 ? list.length - 1 : Math.max(0, index - 1);
    setHistoryIndex(next);
    setCommand(list[next]);
  };

  const newerCommand = () => {
    const list = history();
    const index = historyIndex();
    if (index === -1) return;
    const next = index + 1;
    if (next >= list.length) {
      setHistoryIndex(-1);
      setCommand(draftBeforeHistory);
    } else {
      setHistoryIndex(next);
      setCommand(list[next]);
    }
  };

  const templates = templateStore.templates;
  const filteredTemplates = createMemo(() => {
    const query = templateQuery().trim().toLowerCase();
    const list = [...templates()].sort((a, b) => Number(a.created_at === 0) - Number(b.created_at === 0));
    if (!query) return list;
    return list.filter(item => `${item.name} ${item.content}`.toLowerCase().includes(query.toLowerCase()));
  });
  const selectedTemplate = createMemo(() => templates().find(item => item.id === selectedTemplateId()));

  const selectTemplate = (item: { id: string; name: string; content: string }) => {
    setSelectedTemplateId(item.id); setTemplateName(item.name); setTemplateContent(item.content); setTemplateSaved(true);
  };
  /** 新建：在列表中新增一条可命名、可保存的空白条目并进入编辑，不覆盖任何现有记录。 */
  const newTemplate = () => {
    const draft = templateStore.addDraft();
    setSelectedTemplateId(draft.id); setTemplateName(draft.name); setTemplateContent(""); setTemplateSaved(false);
  };
  const saveTemplate = async () => {
    const current = selectedTemplate();
    if (!current || !templateName().trim() || !templateContent().trim()) return;
    const saved = await templateStore.save({
      id: current.id.startsWith("draft-") ? undefined : current.id,
      name: templateName().trim(),
      content: templateContent(),
    });
    if (current.id.startsWith("draft-")) setSelectedTemplateId(saved.id);
    setTemplateSaved(true);
  };
  const deleteTemplate = async () => {
    const current = selectedTemplate();
    if (!current) return;
    if (current.id.startsWith("draft-")) templateStore.discardDraft(current.id);
    else await templateStore.remove(current.id);
    setSelectedTemplateId(null); setTemplateName(""); setTemplateContent("");
  };
  const copyTemplateToBroadcast = () => {
    if (!templateContent().trim()) return;
    setCommand(templateContent());
    setSection("broadcast");
  };

  return <div class="command-composer" role="dialog" aria-label="命令撰写栏" style={{ height: `${props.height ?? 320}px` }}>
    <div class="command-composer-layout">
      <nav class="command-composer-rail" aria-label="撰写栏设置">
        <button class={section() === "broadcast" ? "active" : ""} title="命令广播" aria-label="命令广播" onClick={() => setSection("broadcast")}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4h4l5 4V6l-5 4H3z" fill="currentColor" stroke="none" /><path d="M15.5 9.2a4 4 0 0 1 0 5.6" /><path d="M18 7a7.2 7.2 0 0 1 0 10" /></svg></span>
        </button>
        <button class={section() === "template" ? "active" : ""} title="命令模板" aria-label="命令模板" onClick={() => setSection("template")}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z" /><path d="M9.5 11h6M9.5 14.5h6M9.5 8h3" /></svg></span>
        </button>
        <span class="rail-divider" />
        <button class={mode() === "current" ? "active" : ""} title="发送到当前会话" aria-label="发送到当前会话" aria-pressed={mode() === "current"} onClick={() => setMode("current")}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="9" rx="1.5" /><path d="M7 20h6M10 13v7" /></svg></span>
        </button>
        <button class={mode() === "all" ? "active" : ""} title="发送到全部会话" aria-label="发送到全部会话" aria-pressed={mode() === "all"} onClick={() => setMode("all")}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="9" height="7" rx="1.2" /><rect x="13" y="5" width="9" height="7" rx="1.2" /><path d="M4.5 16h5M7 12v4M14.5 16h5M17 12v4" /></svg></span>
        </button>
        <span class="rail-divider" />
        <button title="上一条命令" aria-label="上一条命令" disabled={!history().length} onClick={olderCommand}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg></span>
        </button>
        <button title="下一条命令" aria-label="下一条命令" disabled={!history().length} onClick={newerCommand}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7" /></svg></span>
        </button>
        <span class="rail-spacer" />
        <button class="command-composer-close" title="关闭撰写栏" aria-label="关闭撰写栏" onClick={props.onClose}><Icon name="close" size={14} /></button>
      </nav>
      <main class="command-composer-main">
        <Show when={section() === "broadcast"}>
          <section class="composer-section">
            <div class="composer-field">
              <div class="composer-field-header">
                <span class="composer-mode-label" title={`当前模式：发送到${modeLabel()}`}>
                  <span class="mode-dot" aria-hidden="true" />
                  发送到{modeLabel()}{mode() === "all" ? `（${targets().length}）` : ""}
                </span>
                <button class="primary composer-send" disabled={!canSend()} onClick={() => void sendBroadcast()}>{sending() ? "发送中…" : "发送"}</button>
              </div>
              <textarea value={command()} autofocus rows={5} placeholder="输入要发送的命令" onInput={event => { setCommand(event.currentTarget.value); setHistoryIndex(-1); }} onKeyDown={event => { if (event.key === "Enter" && event.ctrlKey) void sendBroadcast(); }} />
            </div>
          </section>
        </Show>
        <Show when={section() === "template"}>
          <section class="composer-section template-section">
            <div class="template-list">
              <input placeholder="搜索命令模板" value={templateQuery()} onInput={event => setTemplateQuery(event.currentTarget.value)} />
              <button class="template-new" onClick={newTemplate}>＋ 新建模板</button>
              <div class="template-items"><For each={filteredTemplates()}>{item => <button class={selectedTemplateId() === item.id ? "active" : ""} onClick={() => selectTemplate(item)}><strong>{item.name}</strong><small>{item.content.split("\n")[0] || "（空）"}</small></button>}</For></div>
            </div>
            <div class="template-editor">
              <div class="template-toolbar"><input value={templateName()} placeholder="模板名称" onInput={event => { setTemplateName(event.currentTarget.value); setTemplateSaved(false); }} /></div>
              <textarea value={templateContent()} placeholder="输入命令内容" onInput={event => { setTemplateContent(event.currentTarget.value); setTemplateSaved(false); }} />
              <div class="composer-actions">
                <button disabled={!selectedTemplateId()} onClick={() => void deleteTemplate()}>删除</button>
                <button disabled={!selectedTemplateId() || templateSaved() || !templateName().trim() || !templateContent().trim()} onClick={() => void saveTemplate()}>{selectedTemplate()?.id.startsWith("draft-") ? "保存并加入模板列表" : "保存"}</button>
                <button class="primary" disabled={!templateContent().trim()} onClick={copyTemplateToBroadcast}>复制到命令广播</button>
              </div>
            </div>
          </section>
        </Show>
      </main>
    </div>
  </div>;
};
