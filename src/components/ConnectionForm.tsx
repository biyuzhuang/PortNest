import { Component, For, Show, createSignal } from "solid-js";
import { api, type ConnectionConfig } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";
import { SshKeyPicker } from "./SshKeyPicker";

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  protocols: Array<{ id: string; name: string }>;
  onSave: (config: ConnectionConfig) => void;
  onCancel: () => void;
  defaultFolderId?: string;
}

type TabType = "general" | "tunnel" | "proxy" | "environment" | "automation" | "advanced";

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#32b4d4", "#2589e8", "#9b51e0", "#8e8e93"];
const ENCODINGS = ["UTF-8", "GBK", "GB2312", "Latin-1", "ISO-8859-1", "CP437"];

export const ConnectionForm: Component<ConnectionFormProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<TabType>("general");
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [name, setName] = createSignal(props.connection?.name || "");
  const [host, setHost] = createSignal(props.connection?.host || "");
  const [port, setPort] = createSignal(props.connection?.port || 22);
  const [username, setUsername] = createSignal(props.connection?.username || "root");
  const [authType, setAuthType] = createSignal(props.connection?.auth_type || "password");
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
    auth_type: authType(),
    password: authType() === "password" ? password() : undefined,
    private_key: authType() === "key" || authType() === "key_with_passphrase" ? privateKey() : undefined,
    key_id: authType() === "key" || authType() === "key_with_passphrase" ? keyId() || undefined : undefined,
    passphrase: authType() === "key_with_passphrase" ? passphrase() : undefined,
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
  });

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
    if (isValid()) props.onSave(buildConfig());
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
                ["general", "常规"], ["tunnel", "隧道"], ["proxy", "代理"],
                ["environment", "环境变量"], ["automation", "自动化"], ["advanced", "高级"],
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
                  <small>name is a required field</small>
                </label>

                <label class={`ssh-field ${!host().trim() ? "invalid" : ""}`}>
                  <span>主机</span>
                  <input value={host()} onInput={event => setHost(event.currentTarget.value)} />
                  <small>host is a required field</small>
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
                  {authButton("key_with_passphrase", "私钥+密码")}
                  {authButton("credential", "凭据", true)}
                  {authButton("template", "模板机私钥", true)}
                  {authButton("agent", "SSH Agent")}
                  {authButton("none", "不验证")}
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

                <Show when={authType() === "key" || authType() === "key_with_passphrase"}>
                  <div class="ssh-field ssh-key-field">
                    <span>私钥</span>
                    <button type="button" class="ssh-key-select" onClick={() => setShowKeyPicker(true)}>
                      {keyName() || (keyId() ? "已选择密钥" : "点击选择或上传密钥")}
                    </button>
                  </div>
                  <Show when={authType() === "key_with_passphrase"}>
                    <label class="ssh-field">
                      <span>私钥密码</span>
                      <input type="password" value={passphrase()} onInput={event => setPassphrase(event.currentTarget.value)} />
                    </label>
                  </Show>
                </Show>

                <label class="ssh-field ssh-remark-field">
                  <span>备注</span>
                  <textarea value={remark()} onInput={event => setRemark(event.currentTarget.value)} />
                </label>
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

            <Show when={activeTab() === "tunnel" || activeTab() === "environment" || activeTab() === "automation"}>
              <div class="ssh-tab-empty">此配置将在后续版本中提供</div>
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
            <button type="submit" class="ssh-save-button" disabled={!isValid()}>保存</button>
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
