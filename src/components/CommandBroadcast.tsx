import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { sessionStore, type SessionTab } from "../stores/sessionStore";
import "./CommandBroadcast.css";

interface CommandBroadcastProps {
  sessions: SessionTab[];
  activeSessionId: string | null;
  onClose: () => void;
}

export const CommandBroadcast: Component<CommandBroadcastProps> = (props) => {
  let initialized = false;
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set<string>());
  const [command, setCommand] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [summary, setSummary] = createSignal<{ sent: number; failed: Array<{ name: string; error: string }>; skipped: number } | null>(null);

  const connected = createMemo(() => props.sessions.filter(session => session.status === "connected" && session.shellId));

  createEffect(() => {
    if (initialized) return;
    const active = connected().find(session => session.id === props.activeSessionId);
    if (active) {
      setSelectedIds(new Set<string>([active.id]));
      initialized = true;
    } else if (props.sessions.length > 0) {
      initialized = true;
    }
  });

  const toggle = (sessionId: string) => setSelectedIds(previous => {
    const next = new Set<string>(previous);
    if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
    return next;
  });

  const send = async () => {
    if (!command().trim() || sending()) return;
    const normalized = command().replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r");
    const payload = normalized.endsWith("\r") ? normalized : `${normalized}\r`;
    setSending(true);
    setSummary(null);
    const selected = props.sessions.filter(session => selectedIds().has(session.id));
    const writable = selected.filter(session => session.status === "connected" && session.shellId);
    const results = await Promise.allSettled(writable.map(session => sessionStore.sendText(session.id, payload)));
    const failed = results.flatMap((result, index) => result.status === "rejected"
      ? [{ name: writable[index].displayName || writable[index].connection.name, error: String(result.reason) }]
      : []);
    setSummary({ sent: writable.length - failed.length, failed, skipped: selected.length - writable.length });
    if (failed.length === 0) setCommand("");
    setSending(false);
  };

  return (
    <div class="workspace-drawer-overlay" onClick={props.onClose}>
      <aside class="workspace-drawer broadcast-drawer" onClick={event => event.stopPropagation()}>
        <header class="workspace-drawer-header">
          <div><h3>命令广播</h3><p>向选中的已连接终端发送单行或多行命令</p></div>
          <button onClick={props.onClose} aria-label="关闭命令广播">×</button>
        </header>
        <div class="broadcast-select-actions">
          <span>目标会话 <strong>{selectedIds().size}</strong></span>
          <button onClick={() => setSelectedIds(new Set<string>(connected().map(session => session.id)))}>全选已连接</button>
          <button onClick={() => setSelectedIds(new Set<string>())}>取消全选</button>
        </div>
        <div class="broadcast-session-list">
          <For each={props.sessions}>{session => (
            <label class={`broadcast-session-row ${session.status !== "connected" ? "disabled" : ""}`}>
              <input type="checkbox" checked={selectedIds().has(session.id)} disabled={session.status !== "connected" || !session.shellId} onChange={() => toggle(session.id)} />
              <span class={`session-status-dot status-${session.status}`} />
              <span class="broadcast-session-main"><strong>{session.displayName || session.connection.name}</strong><small>{session.connection.username}@{session.connection.host}:{session.connection.port}</small></span>
              <code>{session.encodingOverride || session.encoding || "UTF-8"}</code>
            </label>
          )}</For>
        </div>
        <div class="broadcast-command-box">
          <label>命令内容 <span>Enter 换行，Ctrl+Enter 发送</span></label>
          <textarea value={command()} autofocus rows={6} placeholder={"例如：\ncd /opt/app\ngit pull\nnpm run build"} onInput={event => { setCommand(event.currentTarget.value); setSummary(null); }} onKeyDown={event => {
            if (event.key === "Enter" && event.ctrlKey) void send();
          }} />
          <button class="broadcast-send" disabled={sending() || selectedIds().size === 0 || !command().trim()} onClick={() => void send()}>
            {sending() ? "发送中…" : `发送到 ${selectedIds().size} 个会话`} <kbd>Ctrl+Enter</kbd>
          </button>
        </div>
        <Show when={summary()}>{result => (
          <div class={`broadcast-summary ${result().failed.length ? "has-error" : ""}`}>
            已发送 {result().sent}，失败 {result().failed.length}，跳过 {result().skipped}
            <For each={result().failed}>{failure => <p><strong>{failure.name}</strong>：{failure.error}</p>}</For>
          </div>
        )}</Show>
      </aside>
    </div>
  );
};
