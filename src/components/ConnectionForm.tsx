import { Component, createSignal, For, Show } from "solid-js";
import type { ConnectionConfig, FolderRecord } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  protocols: Array<{ id: string; name: string }>;
  onSave: (config: ConnectionConfig) => void;
  onCancel: () => void;
  defaultFolderId?: string;
}

type TabType = "general" | "proxy" | "advanced" | "folder";

const ENCODINGS = [
  { value: "UTF-8", label: "UTF-8 (默认)" },
  { value: "GBK", label: "GBK (中文)" },
  { value: "GB2312", label: "GB2312 (中文)" },
  { value: "Latin-1", label: "Latin-1" },
  { value: "ISO-8859-1", label: "ISO-8859-1" },
  { value: "CP437", label: "CP437 ( DOS)" },
];

export const ConnectionForm: Component<ConnectionFormProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<TabType>("general");
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<string | null>(null);

  // General tab
  const [name, setName] = createSignal(props.connection?.name || "");
  const [protocol, setProtocol] = createSignal(props.connection?.protocol || "ssh");
  const [host, setHost] = createSignal(props.connection?.host || "");
  const [port, setPort] = createSignal(props.connection?.port || 22);
  const [username, setUsername] = createSignal(props.connection?.username || "");
  const [authType, setAuthType] = createSignal(props.connection?.auth_type || "password");
  const [password, setPassword] = createSignal(props.connection?.password || "");
  const [privateKey, setPrivateKey] = createSignal(props.connection?.private_key || "");
  const [passphrase, setPassphrase] = createSignal(props.connection?.passphrase || "");
  const [color, setColor] = createSignal(props.connection?.color || "");
  const [showPassword, setShowPassword] = createSignal(false);
  const [showPrivateKey, setShowPrivateKey] = createSignal(false);

  // Proxy tab
  const [proxyType, setProxyType] = createSignal(props.connection?.proxy_type || "");
  const [proxyHost, setProxyHost] = createSignal(props.connection?.proxy_host || "");
  const [proxyPort, setProxyPort] = createSignal(props.connection?.proxy_port || 1080);
  const [proxyUsername, setProxyUsername] = createSignal(props.connection?.proxy_username || "");
  const [proxyPassword, setProxyPassword] = createSignal(props.connection?.proxy_password || "");

  // Advanced tab
  const [encoding, setEncoding] = createSignal(props.connection?.encoding || "UTF-8");
  const [timeout, setTimeout] = createSignal(30);

  // Folder tab
  const [folderId, setFolderId] = createSignal(props.connection?.folder_id || props.defaultFolderId || "");

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { api } = await import("../utils/api");
      const config = buildConfig();
      const result = await api.testConnection(config);
      setTestResult("success:" + result);
    } catch (e) {
      setTestResult("error:" + String(e));
    } finally {
      setTesting(false);
    }
  };

  const buildConfig = (): ConnectionConfig => {
    return {
      id: props.connection?.id || "",
      name: name(),
      protocol: protocol(),
      host: host(),
      port: port(),
      username: username(),
      auth_type: authType(),
      password: authType() === "password" ? password() : undefined,
      private_key: (authType() === "key" || authType() === "key_with_passphrase") ? privateKey() : undefined,
      passphrase: authType() === "key_with_passphrase" ? passphrase() : undefined,
      color: color(),
      folder_id: folderId() || undefined,
      proxy_type: proxyType() || undefined,
      proxy_host: proxyHost() || undefined,
      proxy_port: proxyPort() || undefined,
      proxy_username: proxyUsername() || undefined,
      proxy_password: proxyPassword() || undefined,
      encoding: encoding(),
    };
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    props.onSave(buildConfig());
  };

  const tabClasses = (tab: TabType) => {
    return `tab-btn ${activeTab() === tab ? "active" : ""}`;
  };

  return (
    <div class="modal-overlay" onClick={props.onCancel}>
      <div class="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>{props.connection?.id ? "编辑连接" : "新建连接"}</h2>

        <div class="content-tabs">
          <button class={tabClasses("general")} onClick={() => setActiveTab("general")}>常规</button>
          <button class={tabClasses("proxy")} onClick={() => setActiveTab("proxy")}>代理</button>
          <button class={tabClasses("advanced")} onClick={() => setActiveTab("advanced")}>高级</button>
          <button class={tabClasses("folder")} onClick={() => setActiveTab("folder")}>文件夹</button>
        </div>

        <form onSubmit={handleSubmit} style={{ "margin-top": "20px" }}>
          <Show when={activeTab() === "general"}>
            <div class="form-group">
              <label>名称</label>
              <input type="text" value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
            </div>

            <div class="form-group">
              <label>协议</label>
              <select value={protocol()} onChange={(e) => setProtocol(e.currentTarget.value)}>
                <For each={props.protocols}>
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
            </div>

            <div class="form-row">
              <div class="form-group flex-1">
                <label>主机</label>
                <input type="text" value={host()} onInput={(e) => setHost(e.currentTarget.value)} required />
              </div>
              <div class="form-group">
                <label>端口</label>
                <input type="number" value={port()} onInput={(e) => setPort(parseInt(e.currentTarget.value))} required />
              </div>
            </div>

            <div class="form-group">
              <label>用户名</label>
              <input type="text" value={username()} onInput={(e) => setUsername(e.currentTarget.value)} required />
            </div>

            <div class="form-group">
              <label>认证方式</label>
              <select value={authType()} onChange={(e) => setAuthType(e.currentTarget.value)}>
                <option value="password">密码</option>
                <option value="key">私钥</option>
                <option value="key_with_passphrase">私钥 + 密码</option>
                <option value="agent">Agent (ssh-agent)</option>
              </select>
            </div>

            <Show when={authType() === "password"}>
              <div class="form-group">
                <label>密码</label>
                <div class="password-input-wrapper">
                  <input
                    type={showPassword() ? "text" : "password"}
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                  <button type="button" class="btn-show-password" onClick={() => setShowPassword(!showPassword())}>
                    {showPassword() ? "隐藏" : "显示"}
                  </button>
                </div>
              </div>
            </Show>

            <Show when={authType() === "key" || authType() === "key_with_passphrase"}>
              <div class="form-group">
                <label>私钥</label>
                <div class="password-input-wrapper">
                  <textarea
                    value={privateKey()}
                    onInput={(e) => setPrivateKey(e.currentTarget.value)}
                    rows={5}
                    style={{ "font-family": "monospace" }}
                  />
                  <button type="button" class="btn-show-password" onClick={() => setShowPrivateKey(!showPrivateKey())}>
                    {showPrivateKey() ? "隐藏" : "显示"}
                  </button>
                </div>
              </div>
            </Show>

            <Show when={authType() === "key_with_passphrase"}>
              <div class="form-group">
                <label>私钥密码</label>
                <input type="password" value={passphrase()} onInput={(e) => setPassphrase(e.currentTarget.value)} />
              </div>
            </Show>

            <div class="form-group">
              <label>颜色</label>
              <input type="color" value={color() || "#3b82f6"} onInput={(e) => setColor(e.currentTarget.value)} />
            </div>
          </Show>

          <Show when={activeTab() === "proxy"}>
            <div class="form-group">
              <label>代理类型</label>
              <select value={proxyType()} onChange={(e) => setProxyType(e.currentTarget.value)}>
                <option value="">不使用代理</option>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP CONNECT</option>
              </select>
            </div>

            <Show when={proxyType()}>
              <div class="form-row">
                <div class="form-group flex-1">
                  <label>代理主机</label>
                  <input type="text" value={proxyHost()} onInput={(e) => setProxyHost(e.currentTarget.value)} />
                </div>
                <div class="form-group">
                  <label>代理端口</label>
                  <input type="number" value={proxyPort()} onInput={(e) => setProxyPort(parseInt(e.currentTarget.value))} />
                </div>
              </div>

              <div class="form-group">
                <label>代理用户名 (可选)</label>
                <input type="text" value={proxyUsername()} onInput={(e) => setProxyUsername(e.currentTarget.value)} />
              </div>

              <div class="form-group">
                <label>代理密码 (可选)</label>
                <input type="password" value={proxyPassword()} onInput={(e) => setProxyPassword(e.currentTarget.value)} />
              </div>
            </Show>
          </Show>

          <Show when={activeTab() === "advanced"}>
            <div class="form-group">
              <label>终端编码</label>
              <select value={encoding()} onChange={(e) => setEncoding(e.currentTarget.value)}>
                <For each={ENCODINGS}>
                  {(enc) => <option value={enc.value}>{enc.label}</option>}
                </For>
              </select>
            </div>

            <div class="form-group">
              <label>连接超时 (秒)</label>
              <input type="number" value={timeout()} onInput={(e) => setTimeout(parseInt(e.currentTarget.value))} min={5} max={120} />
            </div>
          </Show>

          <Show when={activeTab() === "folder"}>
            <div class="form-group">
              <label>所属文件夹</label>
              <select value={folderId()} onChange={(e) => setFolderId(e.currentTarget.value)}>
                <option value="">无 (根目录)</option>
                <For each={connectionStore.state.folders}>
                  {(folder) => <option value={folder.id}>{folder.name}</option>}
                </For>
              </select>
            </div>
          </Show>

          <Show when={testResult()}>
            <div class={`test-result ${testResult()!.startsWith("success") ? "success" : "error"}`}>
              {testResult()!.replace(/^(success|error):/, "")}
            </div>
          </Show>

          <div class="form-actions">
            <button type="button" class="btn-cancel" onClick={props.onCancel}>取消</button>
            <button type="button" class="btn-test" onClick={handleTest} disabled={testing()}>
              {testing() ? "测试中..." : "测试连接"}
            </button>
            <button type="submit" class="btn-save">保存</button>
          </div>
        </form>
      </div>
    </div>
  );
};