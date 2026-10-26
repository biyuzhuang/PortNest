import { Component, For, Index, Show, createSignal, onMount } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, isDatabaseProtocol, isPostgresCompatibleProtocol, type ConnectionConfig, type TunnelRule, type TunnelType } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";
import { SshKeyPicker } from "./SshKeyPicker";
import { Icon } from "./Icon";
import { ProtocolIcon } from "./ProtocolIcon";
import { SelectMenu } from "./SelectMenu";

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  protocols: Array<{ id: string; name: string }>;
  onSave: (config: ConnectionConfig, mode?: "save" | "save-connect") => Promise<void>;
  onCancel: () => void;
  defaultFolderId?: string;
  defaultProtocol?: string;
}

type TabType = "general" | "tunnel" | "proxy" | "advanced";

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#32b4d4", "#2589e8", "#9b51e0", "#8e8e93"];
const ENCODINGS = ["UTF-8", "GBK", "GB2312", "GB18030", "Big5", "Shift-JIS", "EUC-KR", "ISO-8859-1", "Windows-1252", "CP437"];
const LOCAL_ENCODINGS = ["auto", ...ENCODINGS];
const DEFAULT_DATABASE_PORT: Record<string, number> = { mysql: 3306, postgresql: 5432, highgo: 5432 };
const databasePort = (protocol?: string) => DEFAULT_DATABASE_PORT[protocol || ""] || 22;
const protocolLabel = (protocol: string) => protocol === "highgo" ? "HighGo 瀚高数据库" : protocol === "postgresql" ? "PostgreSQL" : protocol === "mysql" ? "MySQL" : protocol === "local" ? "本地终端" : "SSH";

export const ConnectionForm: Component<ConnectionFormProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<TabType>("general");
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [protocol, setProtocol] = createSignal(props.connection?.protocol || props.defaultProtocol || "ssh");
  const [shellType, setShellType] = createSignal(props.connection?.shell_type || "powershell");
  const [cwd, setCwd] = createSignal(props.connection?.cwd || "");
  const [customCommand, setCustomCommand] = createSignal(props.connection?.custom_command || "");
  const [name, setName] = createSignal(props.connection?.name || "");
  const [host, setHost] = createSignal(props.connection?.host || "");
  const [port, setPort] = createSignal(props.connection?.port || databasePort(props.connection?.protocol || props.defaultProtocol));
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
  const [proxyType, setProxyType] = createSignal<ConnectionConfig["proxy_type"] | "">(props.connection?.proxy_type || "");
  const [proxyHost, setProxyHost] = createSignal(props.connection?.proxy_host || "");
  const [proxyPort, setProxyPort] = createSignal(props.connection?.proxy_port || 1080);
  const [proxyUsername, setProxyUsername] = createSignal(props.connection?.proxy_username || "");
  const [proxyPassword, setProxyPassword] = createSignal(props.connection?.proxy_password || "");
  const [jumpConnectionId, setJumpConnectionId] = createSignal(props.connection?.jump_connection_id || "");
  const [encoding, setEncoding] = createSignal(props.connection?.encoding || "UTF-8");
  const [timeout, setTimeout] = createSignal((props.connection?.timeout_ms || 30000) / 1000);
  const [database, setDatabase] = createSignal(props.connection?.database || "");
  const [sslMode, setSslMode] = createSignal(props.connection?.ssl_mode || (isPostgresCompatibleProtocol(props.connection?.protocol || props.defaultProtocol) ? "prefer" : "disabled"));
  const [folderId, setFolderId] = createSignal(props.connection?.folder_id || props.defaultFolderId || "");
  const [tunnelRules, setTunnelRules] = createSignal<TunnelRule[]>(props.connection?.tunnel_rules || []);

  const isDatabase = () => isDatabaseProtocol(protocol());
  const [touched, setTouched] = createSignal<Set<string>>(new Set());
  const markTouched = (field: string) => setTouched(previous => {
    if (previous.has(field)) return previous;
    const next = new Set(previous);
    next.add(field);
    return next;
  });
  const fieldInvalid = (field: string, invalid: boolean) => touched().has(field) && invalid;
  const protocolIconKind = () => protocol() === "local" ? "local" : isDatabase() ? "database" : "ssh";
  const protocolDescription = (id: string) => id === "local"
    ? "本机终端"
    : id === "mysql"
      ? "关系型数据库"
      : id === "postgresql"
        ? "关系型数据库"
        : id === "highgo"
          ? "瀚高 PostgreSQL 兼容数据库"
          : "远程终端与文件传输";
  const modalTitle = () => props.connection?.id
    ? `编辑 ${protocolLabel(protocol())} 连接`
    : `新建 ${protocolLabel(protocol())} 连接`;
  const modalSubtitle = () => protocol() === "local"
    ? "配置本机终端类型和工作目录"
    : isDatabase()
      ? "配置数据库地址、认证信息和 SSL 连接选项"
      : "配置远程主机、身份认证、代理和隧道";
  const validationHint = () => !name().trim()
    ? "请填写连接名称"
    : protocol() !== "local" && !host().trim()
      ? "请填写主机地址"
      : isDatabase() && !username().trim()
        ? `请填写 ${protocolLabel(protocol())} 用户名`
        : protocol() === "ssh" && authType() === "password" && !password() && !props.connection?.id
          ? "请填写 SSH 密码"
          : "请检查连接配置";

  const selectProtocol = (next: string) => {
    setProtocol(next);
    setTouched(new Set<string>());
    if (next === "local") {
      if (activeTab() === "tunnel" || activeTab() === "proxy") setActiveTab("general");
      if (encoding() === "UTF-8") setEncoding("auto");
      setPort(0);
      return;
    }
    if (isDatabaseProtocol(next)) {
      if (activeTab() === "tunnel" || activeTab() === "proxy") setActiveTab("general");
      setAuthType("password");
      setPort(databasePort(next));
      setSslMode(isPostgresCompatibleProtocol(next) ? "prefer" : "disabled");
      return;
    }
    if (encoding() === "auto") setEncoding("UTF-8");
    setPort(22);
  };
  const visibleTabs = (): Array<[TabType, string]> => protocol() === "local" || isDatabase()
    ? [["general", "常规"], ["advanced", "高级"]]
    : [["general", "常规"], ["tunnel", "隧道"], ["proxy", "代理"], ["advanced", "高级"]];

  onMount(() => {
    if (!keyId()) return;
    void api.getSshKeys().then(keys => {
      const selected = keys.find(key => key.id === keyId());
      if (selected) setKeyName(selected.name);
    });
  });

  const isValid = () => {
    if (!name().trim()) return false;
    if (protocol() === "local") {
      return shellType() !== "custom" || customCommand().trim().length > 0;
    }
    if (!host().trim()) return false;
    if (isDatabase()) return Boolean(username().trim()) && port() > 0 && port() <= 65535;
    if (authType() === "password" && !password() && !props.connection?.id) return false;
    if ((authType() === "key" || authType() === "key_with_passphrase") &&
        !keyId() && !privateKey() && !props.connection?.id) return false;
    if (proxyType() === "ssh_jump" && !jumpConnectionId()) return false;
    if ((proxyType() === "socks5" || proxyType() === "http") && (!proxyHost().trim() || proxyPort() < 1 || proxyPort() > 65535)) return false;
    return true;
  };

  const buildConfig = (): ConnectionConfig => {
    const base = {
      id: props.connection?.id || "",
      name: name().trim(),
      color: color(),
      tags: remark(),
      folder_id: folderId() || undefined,
      encoding: encoding(),
      timeout_ms: timeout() * 1000,
    };
    if (protocol() === "local") {
      return {
        ...base,
        protocol: "local",
        host: "本机",
        port: 0,
        username: "",
        auth_type: "none",
        shell_type: shellType(),
        cwd: cwd() || undefined,
        custom_command: shellType() === "custom" ? customCommand() || undefined : undefined,
      };
    }
    return {
      ...base,
      protocol: protocol(),
      host: host().trim(),
      port: port(),
      username: username().trim(),
      auth_type: isDatabase() ? "password" : authType() === "key" && passphrase() ? "key_with_passphrase" : authType(),
      password: authType() === "password" ? password() : undefined,
      private_key: authType() === "key" || authType() === "key_with_passphrase" ? privateKey() : undefined,
      key_id: authType() === "key" || authType() === "key_with_passphrase" ? keyId() || undefined : undefined,
      passphrase: authType() === "key" ? passphrase() || undefined : undefined,
      proxy_type: proxyType() || undefined,
      proxy_host: proxyHost() || undefined,
      proxy_port: proxyPort() || undefined,
      proxy_username: proxyUsername() || undefined,
      proxy_password: proxyPassword() || undefined,
      jump_connection_id: proxyType() === "ssh_jump" ? jumpConnectionId() || undefined : undefined,
      tunnel_rules: tunnelRules(),
      database: isDatabase() ? database().trim() || undefined : undefined,
      ssl_mode: isDatabase() ? sslMode() : undefined,
    };
  };

  const pickDirectory = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择本地终端工作路径",
        defaultPath: cwd() || undefined,
      });
      if (typeof selected === "string") setCwd(selected);
    } catch (error) {
      console.error("选择目录失败:", error);
    }
  };

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
      if (protocol() === "ssh") {
        const result = await api.testSshRoute(buildConfig());
        setTestResult(`${result.success ? "success" : "error"}:${result.route} · 阶段 ${result.stage} · ${result.message}${result.suggestion ? `；建议：${result.suggestion}` : ""}`);
      } else {
        setTestResult(`success:${await api.testConnection(buildConfig())}`);
      }
    } catch (error) {
      setTestResult(`error:${String(error)}`);
    } finally {
      setTesting(false);
    }
  };

  const submit = async (mode: "save" | "save-connect") => {
    if (!isValid() || saving()) return;
    setSaving(true); setSaveError(null);
    try { await props.onSave(buildConfig(), mode); }
    catch (error) { setSaveError(String(error)); }
    finally { setSaving(false); }
  };

  const handleSubmit = (event: Event) => {
    event.preventDefault();
    void submit("save");
  };

  const authButton = (value: string, label: string, disabled = false) => (
    <button
      type="button"
      class={`ssh-auth-pill ${authType() === value ? "active" : ""}`}
      disabled={disabled}
      onClick={() => !disabled && setAuthType(value)}
    >
      <Icon name={value === "key" ? "key" : value === "agent" ? "settings" : "terminal"} size={14} />
      <span>{label}</span>
    </button>
  );

  return (
    <div class="modal-overlay ssh-config-overlay" onClick={props.onCancel}>
      <div class="ssh-config-modal connect-modal-v2" onClick={event => event.stopPropagation()}>
        <header class="connect-modal-header">
          <div class="connect-modal-heading">
            <span class={`connect-modal-protocol-icon protocol-${protocol()}`}>
              <ProtocolIcon kind={protocolIconKind()} />
            </span>
            <div>
              <span class="connect-modal-kicker">{props.connection?.id ? "连接设置" : "创建新资产"}</span>
              <h2>{modalTitle()}</h2>
              <p>{modalSubtitle()}</p>
            </div>
          </div>
          <button type="button" class="ssh-config-close" onClick={props.onCancel} aria-label="关闭">
            <Icon name="close" size={17} />
          </button>
        </header>

        <form class="ssh-config-form" onSubmit={handleSubmit}>
          <div class="connect-modal-body">
            <aside class="connect-protocol-rail">
              <div class="connect-rail-heading">
                <span>连接类型</span>
                <small>选择协议后配置对应参数</small>
              </div>
              <div class="connect-protocol-list">
                <For each={props.protocols.filter(item => ["ssh", "local", "mysql", "postgresql", "highgo"].includes(item.id))}>{item => (
                  <button
                    type="button"
                    class={`connect-protocol-card ${protocol() === item.id ? "active" : ""}`}
                    onClick={() => selectProtocol(item.id)}
                  >
                    <span class={`connect-protocol-card-icon protocol-${item.id}`}>
                      <ProtocolIcon kind={item.id === "local" ? "local" : isDatabaseProtocol(item.id) ? "database" : "ssh"} />
                    </span>
                    <span class="connect-protocol-card-copy">
                      <strong>{item.name}</strong>
                      <small>{protocolDescription(item.id)}</small>
                    </span>
                    <span class="connect-protocol-check"><Icon name={protocol() === item.id ? "check" : "chevronRight"} size={13} /></span>
                  </button>
                )}</For>
              </div>
              <div class="connect-rail-tip">
                <Icon name="info" size={14} />
                <span>保存后可从资产列表双击打开，也可以直接保存并连接。</span>
              </div>
            </aside>
            <main class="connect-form-main">
              <div class="ssh-config-card connect-form-card">
                <nav class="ssh-config-tabs">
              <For each={visibleTabs()}>{([id, label]) => (
                <button type="button" class={activeTab() === id ? "active" : ""} onClick={() => setActiveTab(id)}>
                  <Icon name={id === "general" ? "edit" : id === "tunnel" ? "transfer" : id === "proxy" ? "assets" : "settings"} size={14} />
                  <span>{label}</span>
                </button>
              )}</For>
            </nav>

            <Show when={activeTab() === "general"}>
              <div class="connect-form-scroll-content">
                <section class="connect-form-section">
                  <header class="connect-form-section-head">
                    <span class="connect-form-section-icon"><Icon name="edit" size={15} /></span>
                    <div><h3>基本信息</h3><p>设置连接名称、所属环境和识别色</p></div>
                  </header>
                  <div class="connect-form-grid">
                    <label class={`ssh-field ${fieldInvalid("name", !name().trim()) ? "invalid" : ""}`}>
                      <span>连接名称<span class="required-mark">*</span></span>
                      <input autofocus value={name()} placeholder="例如：生产环境 Web 服务器" onInput={event => setName(event.currentTarget.value)} onBlur={() => markTouched("name")} />
                      <small>请填写连接名称</small>
                    </label>

                    <label class="ssh-field">
                      <span>所属环境</span>
                      <SelectMenu
                        value={folderId()}
                        onChange={setFolderId}
                        ariaLabel="所属环境"
                        options={[{ value: "", label: "根目录", description: "不放入任何文件夹" }, ...connectionStore.state.folders.map(folder => ({ value: folder.id, label: folder.name }))]}
                      />
                    </label>

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
                        <button type="button" class="ssh-color-clear" aria-label="清除颜色标签" title="清除颜色标签" onClick={() => setColor("")}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </div>

                    <label class="ssh-field connect-field-full">
                      <span>备注</span>
                      <textarea class="connect-remark-input" value={remark()} placeholder="记录这台主机的用途、负责人或其他说明" onInput={event => setRemark(event.currentTarget.value)} />
                    </label>
                  </div>
                </section>

                <Show when={protocol() === "local"}>
                  <section class="connect-form-section">
                    <header class="connect-form-section-head">
                      <span class="connect-form-section-icon local"><Icon name="terminal" size={15} /></span>
                      <div><h3>本地终端</h3><p>选择 Shell、启动命令和工作目录</p></div>
                    </header>
                    <div class="connect-form-grid">
                      <label class="ssh-field">
                        <span>终端类型</span>
                        <SelectMenu
                          value={shellType()}
                          onChange={setShellType}
                          ariaLabel="终端类型"
                          options={[
                            { value: "powershell", label: "PowerShell 5.1", description: "Windows 内置 PowerShell" },
                            { value: "powershell7", label: "PowerShell 7 (pwsh)", description: "跨平台 PowerShell" },
                            { value: "cmd", label: "命令提示符 (cmd)", description: "Windows 传统命令行" },
                            { value: "bash", label: "Git Bash", description: "Git for Windows 终端" },
                            { value: "wsl", label: "WSL", description: "Windows Subsystem for Linux" },
                            { value: "custom", label: "自定义命令", description: "手动指定可执行文件参数" },
                          ]}
                        />
                      </label>
                      <Show when={shellType() === "custom"}>
                        <label class={`ssh-field ${fieldInvalid("customCommand", !customCommand().trim()) ? "invalid" : ""}`}>
                          <span>自定义命令<span class="required-mark">*</span></span>
                          <input
                            value={customCommand()}
                            placeholder='例如 "C:\Program Files\Git\bin\bash.exe" --login'
                            onInput={event => setCustomCommand(event.currentTarget.value)}
                            onBlur={() => markTouched("customCommand")}
                          />
                          <small>自定义命令不能为空</small>
                        </label>
                      </Show>
                      <label class="ssh-field connect-field-full">
                        <span>工作路径</span>
                        <div class="connect-input-action">
                          <input value={cwd()} placeholder="默认：用户主目录" onInput={event => setCwd(event.currentTarget.value)} />
                          <button type="button" title="选择目录" onClick={() => void pickDirectory()}><Icon name="folder" size={14} />浏览</button>
                        </div>
                      </label>
                    </div>
                  </section>
                </Show>

                <Show when={protocol() !== "local"}>
                  <section class="connect-form-section">
                    <header class="connect-form-section-head">
                      <span class="connect-form-section-icon connection"><Icon name="terminal" size={15} /></span>
                      <div><h3>连接信息</h3><p>{isDatabase() ? "填写数据库服务器地址和默认数据库" : "填写远程主机地址和登录用户"}</p></div>
                    </header>
                    <div class="connect-form-grid">
                      <label class={`ssh-field ${fieldInvalid("host", !host().trim()) ? "invalid" : ""}`}>
                        <span>主机地址<span class="required-mark">*</span></span>
                        <input value={host()} placeholder={isDatabase() ? "例如：db.example.com" : "例如：192.168.1.10"} onInput={event => setHost(event.currentTarget.value)} onBlur={() => markTouched("host")} />
                        <small>请填写主机地址</small>
                      </label>

                      <label class="ssh-field">
                        <span>端口</span>
                        <input type="number" min="1" max="65535" value={port()} onInput={event => setPort(Number(event.currentTarget.value))} />
                      </label>

                      <label class={`ssh-field ${fieldInvalid("username", isDatabase() && !username().trim()) ? "invalid" : ""}`}>
                        <span>用户名{isDatabase() && <span class="required-mark">*</span>}</span>
                        <input value={username()} placeholder={isDatabase() ? "数据库用户名" : "SSH 登录用户"} onInput={event => setUsername(event.currentTarget.value)} onBlur={() => markTouched("username")} />
                        <small>请填写用户名</small>
                      </label>

                      <Show when={isDatabase()}>
                        <label class="ssh-field">
                          <span>默认数据库</span>
                          <input value={database()} placeholder={isPostgresCompatibleProtocol(protocol()) ? "可留空，默认使用用户名同名数据库" : "可留空，连接后选择"} onInput={event => setDatabase(event.currentTarget.value)} />
                        </label>
                      </Show>
                    </div>
                  </section>

                  <section class="connect-form-section">
                    <header class="connect-form-section-head">
                      <span class="connect-form-section-icon security"><Icon name="key" size={15} /></span>
                      <div><h3>认证与安全</h3><p>{isDatabase() ? "填写数据库密码；凭据会保存在本地加密存储中" : "选择认证方式并填写对应凭据"}</p></div>
                    </header>
                    <div class="connect-form-grid">
                      <Show when={protocol() === "ssh"}>
                        <div class="ssh-field connect-field-full">
                          <span>认证方式</span>
                          <div class="ssh-auth-options connect-auth-options">
                            {authButton("password", "密码")}
                            {authButton("key", "私钥")}
                            {authButton("agent", "SSH Agent")}
                          </div>
                        </div>
                      </Show>

                      <Show when={authType() === "password"}>
                        <label class={`ssh-field connect-field-full ${fieldInvalid("password", protocol() === "ssh" && authType() === "password" && !password() && !props.connection?.id) ? "invalid" : ""}`}>
                          <span>密码{protocol() === "ssh" && <span class="required-mark">*</span>}</span>
                          <div class="ssh-secret-input connect-password-input">
                            <input
                              type={showPassword() ? "text" : "password"}
                              value={password()}
                              placeholder={isDatabase() ? "输入数据库密码" : "输入 SSH 密码"}
                              onInput={event => setPassword(event.currentTarget.value)}
                              onBlur={() => markTouched("password")}
                            />
                            <button type="button" aria-label={showPassword() ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword(!showPassword())}>
                              <Icon name={showPassword() ? "eyeOff" : "eye"} size={15} />
                            </button>
                          </div>
                          <small>请填写 SSH 密码</small>
                        </label>
                      </Show>

                      <Show when={protocol() === "ssh" && authType() === "key"}>
                        <div class="ssh-field connect-field-full ssh-key-field">
                          <span>私钥<span class="required-mark">*</span></span>
                          <button type="button" class="ssh-key-select connect-key-select" onClick={() => setShowKeyPicker(true)}>
                            <span class="connect-key-select-copy">
                              <Icon name="key" size={15} />
                              <span>{keyName() || (keyId() ? "已选择密钥" : "请选择私钥")}</span>
                            </span>
                            <Icon name="settings" size={15} />
                          </button>
                        </div>
                        <label class="ssh-field connect-field-full">
                          <span>私钥密码</span>
                          <input type="password" value={passphrase()} placeholder="如果私钥有口令，请填写" onInput={event => setPassphrase(event.currentTarget.value)} />
                        </label>
                      </Show>
                    </div>
                  </section>
                </Show>
              </div>
            </Show>

            <Show when={activeTab() === "tunnel"}>
              <div class="ssh-tunnel-panel">
                <div class="ssh-tunnel-toolbar">
                  <div><strong>SSH 隧道</strong><small>本地、远程和动态 SOCKS5 转发</small></div>
                  <button type="button" class="ssh-tunnel-add" onClick={addTunnelRule}><Icon name="plus" size={14} /> 添加规则</button>
                </div>
                <Show when={tunnelRules().length === 0}>
                  <div class="ssh-tunnel-empty">尚未配置隧道。保存连接后也可从连接右键菜单启动。</div>
                </Show>
                <Index each={tunnelRules()}>{(rule, index) => {
                  const publicBind = () => ["0.0.0.0", "::", "[::]"].includes(rule().bind_host);
                  return (
                    <section class="ssh-tunnel-rule">
                      <header>
                        <input class="ssh-tunnel-name" value={rule().name} onInput={event => updateTunnelRule(rule().id, { name: event.currentTarget.value })} />
                        <label><input type="checkbox" checked={rule().enabled} onChange={event => updateTunnelRule(rule().id, { enabled: event.currentTarget.checked })} />启用</label>
                        <label><input type="checkbox" checked={rule().auto_start} onChange={event => updateTunnelRule(rule().id, { auto_start: event.currentTarget.checked })} />连接后启动</label>
                        <div class="ssh-tunnel-rule-actions">
                          <button type="button" title="上移" disabled={index === 0} onClick={() => moveTunnelRule(index, -1)}><Icon name="chevronUp" size={14} /></button>
                          <button type="button" title="下移" disabled={index === tunnelRules().length - 1} onClick={() => moveTunnelRule(index, 1)}><Icon name="chevronDown" size={14} /></button>
                          <button type="button" title="复制" onClick={() => duplicateTunnelRule(rule())}><Icon name="copy" size={14} /></button>
                          <button type="button" class="danger" title="删除" onClick={() => removeTunnelRule(rule().id)}><Icon name="close" size={14} /></button>
                        </div>
                      </header>
                      <div class="ssh-tunnel-grid">
                        <label><span>类型</span><SelectMenu
                          value={rule().tunnel_type}
                          ariaLabel="隧道类型"
                          options={[
                            { value: "local", label: "本地转发", description: "本机端口转发到远端服务" },
                            { value: "remote", label: "远程转发", description: "远端端口转发到本机服务" },
                            { value: "dynamic", label: "动态 SOCKS5", description: "通过 SSH 建立 SOCKS 代理" },
                          ]}
                          onChange={value => {
                            const tunnel_type = value as TunnelType;
                            updateTunnelRule(rule().id, tunnel_type === "dynamic"
                              ? { tunnel_type, target_host: undefined, target_port: undefined }
                              : { tunnel_type, target_host: rule().target_host || "127.0.0.1", target_port: rule().target_port || 80 });
                          }}
                        /></label>
                        <label><span>{rule().tunnel_type === "remote" ? "远端监听地址" : "本机监听地址"}</span><input value={rule().bind_host} onInput={event => updateTunnelRule(rule().id, { bind_host: event.currentTarget.value, allow_public_bind: false })} /></label>
                        <label><span>监听端口</span><input type="number" min="1" max="65535" value={rule().bind_port} onInput={event => updateTunnelRule(rule().id, { bind_port: Number(event.currentTarget.value) })} /></label>
                        <Show when={rule().tunnel_type !== "dynamic"}>
                          <label><span>{rule().tunnel_type === "remote" ? "本机目标主机" : "远端目标主机"}</span><input value={rule().target_host || ""} onInput={event => updateTunnelRule(rule().id, { target_host: event.currentTarget.value })} /></label>
                          <label><span>目标端口</span><input type="number" min="1" max="65535" value={rule().target_port || 0} onInput={event => updateTunnelRule(rule().id, { target_port: Number(event.currentTarget.value) })} /></label>
                        </Show>
                      </div>
                      <Show when={publicBind()}>
                        <label class="ssh-tunnel-warning"><input type="checkbox" checked={rule().allow_public_bind === true} onChange={event => updateTunnelRule(rule().id, { allow_public_bind: event.currentTarget.checked })} />
                          允许其他设备访问此监听端口；我了解这可能暴露本地服务
                        </label>
                      </Show>
                    </section>
                  );
                }}</Index>
              </div>
            </Show>

            <Show when={activeTab() === "proxy"}>
              <div class="ssh-tab-panel">
                <label class="ssh-field"><span>代理类型</span>
                  <SelectMenu
                    value={proxyType() || ""}
                    ariaLabel="代理类型"
                    options={[
                      { value: "", label: "不使用代理", description: "直接连接目标主机" },
                      { value: "socks5", label: "SOCKS5", description: "通过 SOCKS5 代理连接" },
                      { value: "http", label: "HTTP CONNECT", description: "通过 HTTP 隧道代理连接" },
                      { value: "ssh_jump", label: "SSH 跳板机", description: "通过已保存的 SSH 资产跳转" },
                    ]}
                    onChange={value => setProxyType(value as ConnectionConfig["proxy_type"] | "")}
                  />
                </label>
                <Show when={proxyType() === "ssh_jump"}>
                  <label class="ssh-field"><span>跳板资产</span>
                    <SelectMenu
                      value={jumpConnectionId()}
                      ariaLabel="跳板资产"
                      placeholder="请选择已保存的 SSH 连接"
                      options={connectionStore.state.connections
                        .filter(connection => connection.protocol === "ssh" && connection.id !== props.connection?.id)
                        .map(connection => ({ value: connection.id, label: connection.name, description: `${connection.host}:${connection.port}` }))}
                      onChange={setJumpConnectionId}
                    />
                  </label>
                  <p class="ssh-proxy-note">先连接并校验跳板机，再通过 SSH direct-tcpip 通道连接目标；仅支持单级跳板。</p>
                </Show>
                <Show when={proxyType() === "socks5" || proxyType() === "http"}>
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
                  <SelectMenu
                    value={encoding()}
                    ariaLabel="终端编码"
                    options={(protocol() === "local" ? LOCAL_ENCODINGS : ENCODINGS).map(item => ({
                      value: item,
                      label: item === "auto" ? "自动（UTF-8，推荐）" : item,
                    }))}
                    onChange={setEncoding}
                  />
                </label>
                <Show when={protocol() !== "local"}>
                  <label class="ssh-field"><span>连接超时（秒）</span><input type="number" min="5" max="120" value={timeout()} onInput={event => setTimeout(Number(event.currentTarget.value))} /></label>
                </Show>
                <Show when={isDatabase()}>
                  <label class="ssh-field"><span>SSL 模式</span>
                    <SelectMenu
                      value={sslMode()}
                      ariaLabel="SSL 模式"
                      options={[
                        { value: "disabled", label: "禁用", description: "仅使用普通连接" },
                        { value: "prefer", label: "优先使用 SSL", description: "服务器支持时自动加密" },
                        { value: "required", label: "要求 SSL（校验证书和主机名）", description: "严格校验证书与主机名" },
                        { value: "skip_verify", label: "要求 SSL（跳过证书校验）", description: "加密连接但不校验证书" },
                      ]}
                      onChange={setSslMode}
                    />
                  </label>
                </Show>
              </div>
            </Show>

              </div>
            </main>
          </div>

          <footer class="connect-modal-footer">
            <div class="connect-modal-feedback">
              <button type="button" class="connect-test-button" disabled={!isValid() || testing() || saving()} onClick={handleTest}>
                <Icon name={testing() ? "refresh" : "play"} size={14} class={testing() ? "spin" : ""} />
                {testing() ? "正在测试…" : proxyType() ? "测试代理链路" : "测试连接"}
              </button>
              <Show when={testResult()}>
                <div class={`connect-status-pill ${testResult()!.startsWith("success:") ? "success" : "error"}`}>
                  <Icon name={testResult()!.startsWith("success:") ? "check" : "info"} size={13} />
                  <span>{testResult()!.replace(/^(success|error):/, "")}</span>
                </div>
              </Show>
              <Show when={saveError()}>
                <div class="connect-status-pill error"><Icon name="info" size={13} /><span>保存失败：{saveError()}</span></div>
              </Show>
              <Show when={!isValid() && touched().size > 0}>
                <div class="connect-validation-hint"><Icon name="info" size={13} /><span>{validationHint()}</span></div>
              </Show>
            </div>
            <div class="connect-modal-actions">
              <button type="button" class="connect-cancel-button" onClick={props.onCancel}>取消</button>
              <button type="submit" class="connect-save-button secondary" disabled={!isValid() || saving()}>{saving() ? "保存中…" : "保存"}</button>
              <button type="button" class="connect-save-button primary" disabled={!isValid() || saving()} onClick={() => void submit("save-connect")}>{saving() ? "处理中…" : "保存并连接"}</button>
            </div>
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
