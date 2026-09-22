import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { templateStore } from "../stores/templateStore";
import { sessionStore, type SessionTab } from "../stores/sessionStore";
import "./CommandBroadcast.css";

interface Props { sessions: SessionTab[]; activeSessionId: string | null; onClose: () => void; }

export const CommandBroadcast: Component<Props> = (props) => {
  const [section, setSection] = createSignal<"broadcast" | "template">("broadcast");
  const [targetsOpen, setTargetsOpen] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [command, setCommand] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [summary, setSummary] = createSignal<{ sent: number; failed: Array<{ name: string; error: string }>; skipped: number } | null>(null);

  const [templateQuery, setTemplateQuery] = createSignal("");
  const [selectedTemplateId, setSelectedTemplateId] = createSignal<string | null>(null);
  const [templateName, setTemplateName] = createSignal("");
  const [templateContent, setTemplateContent] = createSignal("");
  const [templateSaved, setTemplateSaved] = createSignal(false);

  void templateStore.refresh();

  const connected = () => props.sessions.filter(session => session.status === "connected" && session.shellId);
  const selectedNames = () => connected().filter(session => selectedIds().has(session.id)).map(session => session.displayName || session.connection.name);
  const targetLabel = () => selectedNames().length === 0 ? "目标会话" : selectedNames().length === 1 ? selectedNames()[0] : `已选 ${selectedNames().length} 个会话`;

  createEffect(() => {
    const activeId = props.activeSessionId;
    if (activeId && props.sessions.some(session => session.id === activeId && session.status === "connected" && session.shellId)
      && !selectedIds().has(activeId)) {
      setSelectedIds(previous => new Set([...previous, activeId]));
    }
  });

  const sendBroadcast = async () => {
    if (!command().trim() || sending()) return;
    const normalized = command().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const payload = `${normalized.replace(/\n/g, "\r")}${normalized.endsWith("\n") ? "" : "\r"}`;
    setSending(true); setSummary(null);
    const selected = props.sessions.filter(session => selectedIds().has(session.id));
    const writable = selected.filter(session => session.status === "connected" && session.shellId);
    const results = await Promise.allSettled(writable.map(session => sessionStore.sendText(session.id, payload)));
    const failed = results.flatMap((result, index) => result.status === "rejected" ? [{ name: writable[index].displayName || writable[index].connection.name, error: String(result.reason) }] : []);
    setSummary({ sent: writable.length - failed.length, failed, skipped: selected.length - writable.length });
    if (!failed.length) setCommand("");
    setSending(false);
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
  const toggleTarget = (id: string) => setSelectedIds(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });

  // 点击面板其他位置时自动收起目标会话菜单（菜单自身内部的点击不关闭）。
  createEffect(() => {
    if (!targetsOpen()) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".composer-targets")) return;
      setTargetsOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    onCleanup(() => window.removeEventListener("mousedown", handlePointerDown, true));
  });
  const selectAllTargets = () => setSelectedIds(new Set<string>(connected().map(session => session.id)));
  const clearTargets = () => setSelectedIds(new Set<string>());

  return <div class="command-composer" role="dialog" aria-label="命令广播撰写窗格">
    <button class="command-composer-close" onClick={props.onClose} aria-label="关闭命令广播">×</button>
    <div class="command-composer-layout">
      <nav class="command-composer-rail" aria-label="撰写功能">
        <button class={section() === "broadcast" ? "active" : ""} onClick={() => setSection("broadcast")}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4h4l5 4V6l-5 4H3z" fill="currentColor" stroke="none" /><path d="M15.5 9.2a4 4 0 0 1 0 5.6" /><path d="M18 7a7.2 7.2 0 0 1 0 10" /></svg></span>
          <span>命令广播</span>
        </button>
        <button class={section() === "template" ? "active" : ""} onClick={() => setSection("template")}>
          <span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z" /><path d="M9.5 11h6M9.5 14.5h6M9.5 8h3" /></svg></span>
          <span>命令模板</span>
        </button>
      </nav>
      <main class="command-composer-main">
        <Show when={section() === "broadcast"}>
          <section class="composer-section">
            <div class="composer-targets">
              <button class="target-picker" onClick={() => setTargetsOpen(value => !value)} aria-expanded={targetsOpen()}>
                <span>{targetLabel()}</span><span class="target-picker-arrow">⌄</span>
              </button>
              <Show when={targetsOpen()}>
                <div class="composer-session-menu">
                  <div class="composer-session-list">
                    <For each={props.sessions}>{session => <label class={session.status !== "connected" || !session.shellId ? "disabled" : ""}><input type="checkbox" checked={selectedIds().has(session.id)} disabled={session.status !== "connected" || !session.shellId} onChange={() => toggleTarget(session.id)} /><span class={`session-status-dot status-${session.status}`} /><span><strong>{session.displayName || session.connection.name}</strong><small>{session.connection.username}@{session.connection.host}:{session.connection.port}</small></span></label>}</For>
                    <Show when={!props.sessions.length}><p class="composer-session-empty">暂无已打开的终端会话</p></Show>
                  </div>
                  <div class="composer-session-actions"><button onClick={selectAllTargets}>全选</button><button onClick={clearTargets}>清空</button></div>
                </div>
              </Show>
            </div>
            <label class="composer-field"><span>命令内容</span><textarea value={command()} autofocus rows={5} placeholder="输入要发送到一个或多个终端的命令" onInput={event => { setCommand(event.currentTarget.value); setSummary(null); }} onKeyDown={event => { if (event.key === "Enter" && event.ctrlKey) void sendBroadcast(); }} /></label>
            <div class="composer-actions"><button class="primary" disabled={sending() || !selectedIds().size || !command().trim()} onClick={() => void sendBroadcast()}>{sending() ? "发送中…" : `发送到 ${selectedIds().size} 个会话`}</button></div>
            <Show when={summary()}>{result => <div class={`broadcast-summary ${result().failed.length ? "has-error" : ""}`}>已发送 {result().sent}，失败 {result().failed.length}，跳过 {result().skipped}<For each={result().failed}>{failure => <p>{failure.name}：{failure.error}</p>}</For></div>}</Show>
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
