import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { api, type ConnectionRecord, type TunnelRule, type TunnelRuntimeInfo } from "../utils/api";

interface TunnelPanelProps {
  connection: ConnectionRecord;
  onClose: () => void;
}

const parseRules = (connection: ConnectionRecord): TunnelRule[] => {
  try { return JSON.parse(connection.options || "{}").tunnel_rules || []; }
  catch { return []; }
};

export const TunnelPanel: Component<TunnelPanelProps> = (props) => {
  const [runtimes, setRuntimes] = createSignal<TunnelRuntimeInfo[]>([]);
  const [busyRuleId, setBusyRuleId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal<string | null>(null);
  const rules = createMemo(() => parseRules(props.connection));
  let refreshTimer: number | undefined;

  const refresh = async () => {
    try { setRuntimes(await api.listTunnels(props.connection.id)); }
    catch (reason) { setError(String(reason)); }
  };
  onMount(() => { void refresh(); refreshTimer = window.setInterval(() => void refresh(), 1500); });
  onCleanup(() => { if (refreshTimer !== undefined) clearInterval(refreshTimer); });

  const runtimeFor = (ruleId: string) => runtimes().find(runtime => runtime.rule_id === ruleId && runtime.status !== "stopped");
  const start = async (rule: TunnelRule) => {
    setBusyRuleId(rule.id); setError(null); setMessage(null);
    try { await api.startTunnel(props.connection.id, rule.id); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusyRuleId(null); }
  };
  const stop = async (runtime: TunnelRuntimeInfo) => {
    setBusyRuleId(runtime.rule_id); setError(null); setMessage(null);
    try { await api.stopTunnel(runtime.id); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusyRuleId(null); }
  };
  const startAll = async () => {
    setBusyRuleId("all"); setError(null); setMessage(null);
    const pending = rules().filter(rule => rule.enabled && !runtimeFor(rule.id));
    const results = await Promise.allSettled(pending.map(rule => api.startTunnel(props.connection.id, rule.id)));
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) setError(`${failed.length} 条隧道启动失败：${String((failed[0] as PromiseRejectedResult).reason)}`);
    else setMessage(`已启动 ${pending.length} 条隧道`);
    await refresh(); setBusyRuleId(null);
  };
  const stopAll = async () => {
    setBusyRuleId("all"); setError(null); setMessage(null);
    try { await api.stopAllTunnels(props.connection.id); setMessage("已停止全部隧道"); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusyRuleId(null); }
  };
  const test = async (rule: TunnelRule) => {
    setBusyRuleId(rule.id); setError(null); setMessage(null);
    try {
      const runtime = await api.startTunnel(props.connection.id, rule.id);
      await new Promise(resolve => window.setTimeout(resolve, 500));
      await api.stopTunnel(runtime.id);
      setMessage(`${rule.name || "隧道"}测试成功，监听端口已释放`);
      await refresh();
    } catch (reason) { setError(`测试失败：${String(reason)}`); }
    finally { setBusyRuleId(null); }
  };

  return (
    <div class="workspace-drawer-overlay" onClick={props.onClose}>
      <aside class="workspace-drawer tunnel-drawer" onClick={event => event.stopPropagation()}>
        <header class="workspace-drawer-header"><div><h3>SSH 隧道</h3><p>{props.connection.name}</p></div><button onClick={props.onClose}>×</button></header>
        <div class="tunnel-panel-actions"><span>运行中 <strong>{runtimes().filter(item => item.status === "running").length}</strong></span><button disabled={busyRuleId() !== null || rules().every(rule => !rule.enabled || Boolean(runtimeFor(rule.id)))} onClick={() => void startAll()}>全部启动</button><button disabled={busyRuleId() !== null || runtimes().length === 0} onClick={() => void stopAll()}>全部停止</button></div>
        <Show when={error()}><div class="drawer-error">{error()}</div></Show>
        <Show when={message()}><div class="drawer-message">{message()}</div></Show>
        <Show when={rules().length > 0} fallback={<div class="drawer-empty">此连接尚未配置隧道，请先编辑连接。</div>}>
          <div class="tunnel-runtime-list">
            <For each={rules()}>{rule => {
              const runtime = () => runtimeFor(rule.id);
              const target = () => rule.tunnel_type === "dynamic" ? "SOCKS5 动态目标" : `${rule.target_host}:${rule.target_port}`;
              return <article class="tunnel-runtime-row">
                <span class={`session-status-dot status-${runtime()?.status || "stopped"}`} />
                <div><strong>{rule.name}</strong><small>{rule.tunnel_type.toUpperCase()} · {rule.bind_host}:{rule.bind_port} → {target()}</small><Show when={runtime()?.error}><em>{runtime()!.error}</em></Show></div>
                <span class="tunnel-connections">{runtime()?.active_connections || 0} 连接</span>
                <Show when={runtime()} fallback={<span class="tunnel-row-actions"><button disabled={!rule.enabled || busyRuleId() !== null} onClick={() => void test(rule)}>测试</button><button disabled={!rule.enabled || busyRuleId() !== null} onClick={() => void start(rule)}>启动</button></span>}>
                  {current => current().status === "error"
                    ? <button disabled={busyRuleId() !== null} onClick={() => void start(rule)}>重试</button>
                    : <button class="danger" disabled={busyRuleId() === rule.id} onClick={() => void stop(current())}>停止</button>}
                </Show>
              </article>;
            }}</For>
          </div>
        </Show>
      </aside>
    </div>
  );
};
