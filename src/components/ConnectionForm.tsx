import { Component, For, Show, createSignal, onMount } from "solid-js";
import { api, type ConnectionConfig, type TunnelRule, type TunnelType } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";
import { SshKeyPicker } from "./SshKeyPicker";

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  protocols: Array<{ id: string; name: string }>;
  onSave: (config: ConnectionConfig, mode?: "save" | "save-connect") => void;
  onCancel: () => void;
  defaultFolderId?: string;
}

type TabType = "general" | "tunnel" | "proxy" | "advanced";

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#32b4d4", "#2589e8", "#9b51e0", "#8e8e93"];
const ENCODINGS = ["UTF-8", "GBK", "GB2312", "GB18030", "Big5", "Shift-JIS", "EUC-KR", "ISO-8859-1", "Windows-1252", "CP437"];

export const ConnectionForm: Component<ConnectionFormProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<TabType>("general");
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [name, setName] = createSignal(props.connection?.name || "");
  const [host, setHost] = createSignal(props.connection?.host || "");
  const [port, setPort] = createSignal(props.connection?.port || 22);
  const [username, setUsername] = createSignal(props.connection?.username || "root");
  const [authType, setAuthType] = createSignal(props.connection?.auth_type === "key_with_passphrase" ? "key" : props.connection?.auth_type || "password");
  const [password, setPassword] = createSignal(props.connection?.password || "");
  const [privateKey, setPrivateKey] = createSignal(props.connection?.private_key || "");
  const [keyId, setKeyId] = createSignal(props.connection?.key_id || "");
  const [keyName, setKeyName] = createSignal("");
  const [showKeyPicker, setShowKeyPicker] = createSignal(false);
  const [passphrase, setPassphrase] = createSignal(props.connection?.passphrase || "");
  const [color, setColor] = createSignal(props.connection?.color || "");
  const [remark, setRemark] = createSignal(props.connection?.tags || "");
  const [showPassword, setShowPassword] = createSignal(false);
  const [proxyType, setProxyType] = createSignal(props.connection?.proxy_type || "");
  const [proxyHost, setProxyHost] = createSignal(props.connection?.proxy_host || "");
  const [proxyPort, setProxyPort] = createSignal(props.connection?.proxy_port || 1080);
  const [proxyUsername, setProxyUsername] = createSignal(props.connection?.proxy_username || "");
  const [proxyPassword, setProxyPassword] = createSignal(props.connection?.proxy_password || "");
  const [encoding, setEncoding] = createSignal(props.connection?.encoding || "UTF-8");
  const [timeout, setTimeout] = createSignal((props.connection?.timeout_ms || 30000) / 1000);
  const [folderId, setFolderId] = createSignal(props.connection?.folder_id || props.defaultFolderId || "");
  const [tunnelRules, setTunnelRules] = createSignal<TunnelRule[]>(props.connection?.tunnel_rules || []);

  onMount(() => {
    if (!keyId()) return;
    void api.getSshKeys().then(keys => {
      const selected = keys.find(key => key.id === keyId());
      if (selected) setKeyName(selected.name);
    });
  });

  const isValid = () => {
    if (!name().trim() || !host().trim()) return false;
    if (authType() === "password" && !password() && !props.connection?.id) return false;
    if ((authType() === "key" || authType() === "key_with_passphrase") &&
        !keyId() && !privateKey() && !props.connection?.id) return false;
    return true;
  };

  const buildConfig = (): ConnectionConfig => ({
    id: props.connection?.id || "",
    name: name().trim(),
    protocol: "ssh",
    host: host().trim(),
    port: port(),
    username: username().trim(),
    auth_type: authType() === "key" && passphrase() ? "key_with_passphrase" : authType(),
    password: authType() === "password" ? password() : undefined,
    private_key: authType() === "key" || authType() === "key_with_passphrase" ? privateKey() : undefined,
    key_id: authType() === "key" || authType() === "key_with_passphrase" ? keyId() || undefined : undefined,
    passphrase: authType() === "key" ? passphrase() || undefined : undefined,
    color: color(),
    tags: remark(),
    folder_id: folderId() || undefined,
    proxy_type: proxyType() || undefined,
    proxy_host: proxyHost() || undefined,
    proxy_port: proxyPort() || undefined,
    proxy_username: proxyUsername() || undefined,
    proxy_password: proxyPassword() || undefined,
    encoding: encoding(),
    timeout_ms: timeout() * 1000,
    tunnel_rules: tunnelRules(),
  });

  const addTunnelRule = () => {
    const id = crypto.randomUUID?.() || `tunnel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTunnelRules(previous => [...previous, {
      id,
      name: `隧道 ${previous.length + 1}`,
      tunnel_type: "local",
      enabled: true,
      auto_start: false,
      bind_host: "127.0.0.1",
      bind_port: 8080 + previous.length,
      target_host: "127.0.0.1",
      target_port: 80,
      allow_public_bind: false,
    }]);
  };

  const updateTunnelRule = (id: string, patch: Partial<TunnelRule>) => {
    setTunnelRules(previous => previous.map(rule => rule.id === id ? { ...rule, ...patch } : rule));
  };

  const removeTunnelRule = (id: string) => setTunnelRules(previous => previous.filter(rule => rule.id !== id));

  const duplicateTunnelRule = (rule: TunnelRule) => {
    const id = crypto.randomUUID?.() || `tunnel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTunnelRules(previous => [...previous, { ...rule, id, name: `${rule.name} 副本`, auto_start: false }]);
  };

  const moveTunnelRule = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= tunnelRules().length) return;
    setTunnelRules(previous => {
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleTest = async () => {
    if (!isValid()) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(`success:${await api.testConnection(buildConfig())}`);
    } catch (error) {
      setTestResult(`error:${String(error)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (event: Event) => {
    event.preventDefault();
    if (isValid()) props.onSave(buildConfig(), "save");
  };

  const authButton = (value: string, label: string, disabled = false) => (
    <button
      type="button"
      class={`ssh-auth-pill ${authType() === value ? "active" : ""}`}
      disabled={disabled}
      onClick={() => !disabled && setAuthType(value)}
    >
      {label}
    </button>
  );

  return (
    <div class="modal-overlay ssh-config-overlay" onClick={props.onCancel}>
      <div class="ssh-config-modal" onClick={event => event.stopPropagation()}>
        <header class="ssh-config-header">
          <h2>SSH配置编辑</h2>
          <button type="button" class="ssh-config-close" onClick={props.onCancel} aria-label="关闭">×</button>
        </header>

        <form class="ssh-config-form" onSubmit={handleSubmit}>
          <div class="ssh-config-card">
            <nav class="ssh-config-tabs">
              {([
                ["general", "常规"], ["tunnel", "隧道"], ["proxy", "代理"], ["advanced", "高级"],
              ] as Array<[TabType, string]>).map(([id, label]) => (
                <button type="button" class={activeTab() === id ? "active" : ""} onClick={() => setActiveTab(id)}>{label}</button>
              ))}
            </nav>

            <Show when={activeTab() === "general"}>
              <div class="ssh-general-grid">
                <div class="ssh-field ssh-color-field">
                  <label>颜色标签</label>
                  <div class="ssh-color-palette">
                    <For each={COLORS}>{item => (
                      <button
                        type="button"
                        aria-label={`选择颜色 ${item}`}
                        class={color() === item ? "active" : ""}
                        style={{ background: item }}
                        onClick={() => setColor(item)}
                      />
                    )}</For>
                    <button type="button" class="ssh-color-clear" onClick={() => setColor("")}>×</button>
                  </div>
                </div>

                <label class="ssh-field">
                  <span>环境</span>
                  <select value={folderId()} onChange={event => setFolderId(event.currentTarget.value)}>
                    <option value="">无</option>
                    <For each={connectionStore.state.folders}>{folder => (
                      <option value={folder.id}>{folder.name}</option>
                    )}</For>
                  </select>
                </label>

                <label class={`ssh-field ${!name().trim() ? "invalid" : ""}`}>
                  <span>名称</span>
                  <input autofocus value={name()} onInput={event => setName(event.currentTarget.value)} />
                  <small>名称不能为空</small>
                </label>

                <label class={`ssh-field ${!host().trim() ? "invalid" : ""}`}>
                  <span>主机</span>
                  <input value={host()} onInput={event => setHost(event.currentTarget.value)} />
                  <small>主机不能为空</small>
                </label>

                <label class="ssh-field">
                  <span>用户</span>
                  <input value={username()} onInput={event => setUsername(event.currentTarget.value)} />
                </label>

                <label class="ssh-field">
                  <span>端口</span>
                  <input type="number" min="1" max="65535" value={port()} onInput={event => setPort(Number(event.currentTarget.value))} />
                </label>

                <div class="ssh-auth-options">
                  {authButton("password", "密码")}
                  {authButton("key", "私钥")}
                  {authButton("agent", "SSH Agent")}
                </div>

                <Show when={authType() === "password"}>
                  <label class="ssh-field">
                    <span>密码</span>
                    <div class="ssh-secret-input">
                      <input type={showPassword() ? "text" : "password"} value={password()} onInput={event => setPassword(event.currentTarget.value)} />
                      <button type="button" onClick={() => setShowPassword(!showPassword())}>{showPassword() ? "◉" : "⊙"}</button>
                    </div>
                  </label>
                </Show>

                <Show when={authType() === "key"}>
                  <div class="ssh-field ssh-key-field">
                    <span>私钥</span>
                    <div class="ssh-key-actions">
                      <button type="button" class="ssh-key-select" onClick={() => setShowKeyPicker(true)}>
                        <span>{keyName() || (keyId() ? "已选择密钥" : "请选择私钥")}</span>
                        <span class="ssh-key-settings-icon">⚙</span>
                      </button>
                    </div>
                  </div>
                  <label class="ssh-field">
                    <span>私钥密码</span>
                    <input type="password" value={passphrase()} onInput={event => setPassphrase(event.currentTarget.value)} />
                  </label>
                </Show>

                <label class="ssh-field ssh-remark-field">
                  <span>备注</span>
                  <textarea value={remark()} onInput={event => setRemark(event.currentTarget.value)} />
                </label>
              </div>
            </Show>

            <Show when={activeTab() === "tunnel"}>
              <div class="ssh-tunnel-panel">
                <div class="ssh-tunnel-toolbar">
                  <div><strong>SSH 隧道</strong><small>本地、远程和动态 SOCKS5 转发</small></div>
                  <button type="button" class="ssh-tunnel-add" onClick={addTunnelRule}>＋ 添加规则</button>
                </div>
                <Show when={tunnelRules().length === 0}>
                  <div class="ssh-tunnel-empty">尚未配置隧道。保存连接后也可从连接右键菜单启动。</div>
                </Show>
                <For each={tunnelRules()}>{(rule, index) => {
                  const publicBind = () => ["0.0.0.0", "::", "[::]"].includes(rule.bind_host);
                  return (
                    <section class="ssh-tunnel-rule">
                      <header>
                        <input class="ssh-tunnel-name" value={rule.name} onInput={event => updateTunnelRule(rule.id, { name: event.currentTarget.value })} />
                        <label><input type="checkbox" checked={rule.enabled} onChange={event => updateTunnelRule(rule.id, { enabled: event.currentTarget.checked })} />启用</label>
                        <label><input type="checkbox" checked={rule.auto_start} onChange={event => updateTunnelRule(rule.id, { auto_start: event.currentTarget.checked })} />连接后启动</label>
                        <div class="ssh-tunnel-rule-actions">
                          <button type="button" title="上移" disabled={index() === 0} onClick={() => moveTunnelRule(index(), -1)}>↑</button>
                          <button type="button" title="下移" disabled={index() === tunnelRules().length - 1} onClick={() => moveTunnelRule(index(), 1)}>↓</button>
                          <button type="button" title="复制" onClick={() => duplicateTunnelRule(rule)}>⧉</button>
                          <button type="button" class="danger" title="删除" onClick={() => removeTunnelRule(rule.id)}>×</button>
                        </div>
                      </header>
                      <div class="ssh-tunnel-grid">
                        <label><span>类型</span><select value={rule.tunnel_type} onChange={event => {
                          const tunnel_type = event.currentTarget.value as TunnelType;
                          updateTunnelRule(rule.id, tunnel_type === "dynamic"
                            ? { tunnel_type, target_host: undefined, target_port: undefined }
                            : { tunnel_type, target_host: rule.target_host || "127.0.0.1", target_port: rule.target_port || 80 });
                        }}><option value="local">本地转发</option><option value="remote">远程转发</option><option value="dynamic">动态 SOCKS5</option></select></label>
                        <label><span>{rule.tunnel_type === "remote" ? "远端监听地址" : "本机监听地址"}</span><input value={rule.bind_host} onInput={event => updateTunnelRule(rule.id, { bind_host: event.currentTarget.value, allow_public_bind: false })} /></label>
                        <label><span>监听端口</span><input type="number" min="1" max="65535" value={rule.bind_port} onInput={event => updateTunnelRule(rule.id, { bind_port: Number(event.currentTarget.value) })} /></label>
                        <Show when={rule.tunnel_type !== "dynamic"}>
                          <label><span>{rule.tunnel_type === "remote" ? "本机目标主机" : "远端目标主机"}</span><input value={rule.target_host || ""} onInput={event => updateTunnelRule(rule.id, { target_host: event.currentTarget.value })} /></label>
                          <label><span>目标端口</span><input type="number" min="1" max="65535" value={rule.target_port || 0} onInput={event => updateTunnelRule(rule.id, { target_port: Number(event.currentTarget.value) })} /></label>
                        </Show>
                      </div>
                      <Show when={publicBind()}>
                        <label class="ssh-tunnel-warning"><input type="checkbox" checked={rule.allow_public_bind === true} onChange={event => updateTunnelRule(rule.id, { allow_public_bind: event.currentTarget.checked })} />
                          允许其他设备访问此监听端口；我了解这可能暴露本地服务
                        </label>
                      </Show>
                    </section>
                  );
                }}</For>
              </div>
            </Show>

            <Show when={activeTab() === "proxy"}>
              <div class="ssh-tab-panel">
                <label class="ssh-field"><span>代理类型</span>
                  <select value={proxyType()} onChange={event => setProxyType(event.currentTarget.value)}>
                    <option value="">不使用代理</option><option value="socks5">SOCKS5</option><option value="http">HTTP CONNECT</option>
                  </select>
                </label>
                <Show when={proxyType()}>
                  <label class="ssh-field"><span>代理主机</span><input value={proxyHost()} onInput={event => setProxyHost(event.currentTarget.value)} /></label>
                  <label class="ssh-field"><span>代理端口</span><input type="number" value={proxyPort()} onInput={event => setProxyPort(Number(event.currentTarget.value))} /></label>
                  <label class="ssh-field"><span>代理用户</span><input value={proxyUsername()} onInput={event => setProxyUsername(event.currentTarget.value)} /></label>
                  <label class="ssh-field"><span>代理密码</span><input type="password" value={proxyPassword()} onInput={event => setProxyPassword(event.currentTarget.value)} /></label>
                </Show>
              </div>
            </Show>

            <Show when={activeTab() === "advanced"}>
              <div class="ssh-tab-panel">
                <label class="ssh-field"><span>终端编码</span>
                  <select value={encoding()} onChange={event => setEncoding(event.currentTarget.value)}>
                    <For each={ENCODINGS}>{item => <option value={item}>{item}</option>}</For>
                  </select>
                </label>
                <label class="ssh-field"><span>连接超时（秒）</span><input type="number" min="5" max="120" value={timeout()} onInput={event => setTimeout(Number(event.currentTarget.value))} /></label>
              </div>
            </Show>

          </div>

          <Show when={testResult()}>
            <div class={`ssh-test-result ${testResult()!.startsWith("success:") ? "success" : "error"}`}>
              {testResult()!.replace(/^(success|error):/, "")}
            </div>
          </Show>

          <footer class="ssh-config-actions">
            <button type="button" class="ssh-test-button" disabled={!isValid() || testing()} onClick={handleTest}>
              {testing() ? "测试中..." : "测试连接"}
            </button>
            <button type="submit" class="ssh-save-secondary" disabled={!isValid()}>保存</button>
            <button type="button" class="ssh-save-button" disabled={!isValid()} onClick={() => props.onSave(buildConfig(), "save-connect")}>保存并连接</button>
          </footer>
        </form>
      </div>
      <Show when={showKeyPicker()}>
        <SshKeyPicker selectedId={keyId()} onClose={() => setShowKeyPicker(false)} onSelect={key => {
          setKeyId(key.id);
          setKeyName(key.name);
          setPrivateKey("");
          setShowKeyPicker(false);
        }} />
      </Show>
    </div>
  );
};
