import { Component, For, Show, createSignal, onMount } from "solid-js";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { api, type SessionImportResult } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";
import { feedback } from "../stores/feedbackStore";
import { Icon } from "./Icon";

export const SessionImportExport: Component<{ onClose: () => void }> = (props) => {
  const isTauriRuntime = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const [activeTab, setActiveTab] = createSignal<"export" | "import">("export");
  const [includePasswords, setIncludePasswords] = createSignal(false);
  const [includePrivateKeys, setIncludePrivateKeys] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [importingJson, setImportingJson] = createSignal(false);
  const [importingXshell, setImportingXshell] = createSignal(false);
  const [xshellDir, setXshellDir] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [messageKind, setMessageKind] = createSignal<"success" | "error">("success");
  const [messageDetails, setMessageDetails] = createSignal<string[]>([]);
  let jsonInput: HTMLInputElement | undefined;

  onMount(() => {
    if (!isTauriRuntime()) return;
    void api.detectXshellSessionsDir()
      .then(directory => {
        if (directory) setXshellDir(directory);
      })
      .catch(() => undefined);
  });

  const clearMessage = () => {
    setMessage("");
    setMessageDetails([]);
  };

  const switchTab = (tab: "export" | "import") => {
    if (activeTab() === tab) return;
    clearMessage();
    setActiveTab(tab);
  };

  const showError = (prefix: string, error: unknown) => {
    setMessageKind("error");
    setMessage(`${prefix}：${String(error)}`);
    setMessageDetails([]);
  };

  const applyImportResult = (result: SessionImportResult, source: string) => {
    const summary = [
      `${result.connections} 个会话`,
      `${result.folders} 个文件夹`,
    ];
    if (result.skipped > 0) summary.push(`跳过 ${result.skipped} 个`);
    setMessageKind(result.connections > 0 ? "success" : "error");
    setMessage(`${source} 导入完成：${summary.join("，")}`);

    const details: string[] = [];
    if (result.password_required > 0) {
      details.push(`${result.password_required} 个会话未导入密码，请编辑连接后重新输入。`);
    }
    if (result.private_key_required > 0) {
      details.push(`${result.private_key_required} 个会话缺少私钥，请按需重新绑定 PortNest 私钥。`);
    }
    details.push(...result.warnings);
    setMessageDetails(details);
  };

  const exportJson = async () => {
    if ((includePasswords() || includePrivateKeys()) &&
        !await feedback.confirm("导出的 JSON 将包含明文敏感信息，请妥善保管。是否继续？", "导出敏感信息")) return;

    const defaultFileName = `portnest-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    const filePath = await save({
      title: "选择会话导出位置",
      defaultPath: defaultFileName,
      filters: [{ name: "JSON 文件", extensions: ["json"] }],
    });
    if (!filePath) return;

    setExporting(true);
    clearMessage();
    try {
      const json = await api.exportSessions(includePasswords(), includePrivateKeys());
      await writeTextFile(filePath, json);
      setMessageKind("success");
      setMessage(`会话已导出到：${filePath}`);
    } catch (error) {
      showError("导出失败", error);
    } finally {
      setExporting(false);
    }
  };

  const importJson = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      showError("导入失败", "请选择 PortNest 导出的 JSON 文件");
      input.value = "";
      return;
    }

    setImportingJson(true);
    clearMessage();
    try {
      const result = await api.importSessions(await file.text());
      await connectionStore.loadConnections();
      applyImportResult(result, "PortNest JSON");
    } catch (error) {
      showError("导入失败", error);
    } finally {
      setImportingJson(false);
      input.value = "";
    }
  };

  const importXshell = async () => {
    if (!isTauriRuntime()) {
      showError("导入失败", "Xshell 目录导入仅支持 PortNest 桌面应用");
      return;
    }

    let selected: string | string[] | null;
    try {
      selected = await open({
        title: "选择 Xshell 会话目录",
        directory: true,
        multiple: false,
        defaultPath: xshellDir() || undefined,
      });
    } catch (error) {
      showError("打开目录选择器失败", error);
      return;
    }

    const sessionDir = Array.isArray(selected) ? selected[0] : selected;
    if (!sessionDir) return;

    setImportingXshell(true);
    clearMessage();
    try {
      const result = await api.importXshellSessions(sessionDir);
      setXshellDir(sessionDir);
      await connectionStore.loadConnections();
      applyImportResult(result, "Xshell");
    } catch (error) {
      showError("Xshell 导入失败", error);
    } finally {
      setImportingXshell(false);
    }
  };

  return (
    <div class="modal-overlay session-transfer-overlay" onClick={props.onClose}>
      <div class="session-transfer-modal" onClick={event => event.stopPropagation()}>
        <header class="session-transfer-header">
          <div class="session-transfer-heading">
            <span class="session-transfer-hero-icon"><Icon name="transfer" size={21} /></span>
            <div>
              <h2>会话迁移中心</h2>
              <p>在 PortNest 与其他 SSH 客户端之间安全迁移连接与文件夹。</p>
            </div>
          </div>
          <button type="button" onClick={props.onClose} aria-label="关闭"><Icon name="close" size={14} /></button>
        </header>

        <div class="session-transfer-tabbar" role="tablist" aria-label="会话导入导出">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab() === "export"}
            class={`session-transfer-tab ${activeTab() === "export" ? "active" : ""}`}
            onClick={() => switchTab("export")}
          >
            <span class="session-transfer-tab-icon"><Icon name="export" size={15} /></span>
            <span><b>导出会话</b><small>生成 JSON 备份</small></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab() === "import"}
            class={`session-transfer-tab ${activeTab() === "import" ? "active" : ""}`}
            onClick={() => switchTab("import")}
          >
            <span class="session-transfer-tab-icon"><Icon name="import" size={15} /></span>
            <span><b>导入会话</b><small>恢复备份或迁移 Xshell</small></span>
          </button>
        </div>

        <div class="session-transfer-body">
          <Show when={activeTab() === "export"}>
            <div class="session-export-panel">
              <div class="session-export-hero">
                <div class="session-export-hero-copy">
                  <span class="session-export-kicker"><Icon name="file" size={13} /> PortNest JSON</span>
                  <h3>导出完整会话备份</h3>
                  <p>将连接、文件夹和凭据打包为一个可再次导入的 JSON 文件。</p>
                </div>
                <span class="session-export-art"><Icon name="export" size={28} /></span>
              </div>

              <div class="session-transfer-checks">
                <label class="session-transfer-check password">
                  <span class="session-transfer-check-icon"><Icon name="lock" size={16} /></span>
                  <span class="session-transfer-check-copy">
                    <b>包含会话密码和私钥密码</b>
                    <small>导出的 JSON 会包含明文密码，仅用于可信设备之间迁移。</small>
                  </span>
                  <input type="checkbox" checked={includePasswords()} onChange={event => setIncludePasswords(event.currentTarget.checked)} />
                  <span class="session-transfer-switch" aria-hidden="true" />
                </label>
                <label class="session-transfer-check private-key">
                  <span class="session-transfer-check-icon"><Icon name="key" size={16} /></span>
                  <span class="session-transfer-check-copy">
                    <b>包含私钥</b>
                    <small>私钥内容会写入 JSON 文件，请妥善保管导出文件。</small>
                  </span>
                  <input type="checkbox" checked={includePrivateKeys()} onChange={event => setIncludePrivateKeys(event.currentTarget.checked)} />
                  <span class="session-transfer-switch" aria-hidden="true" />
                </label>
              </div>

              <div class="session-transfer-export-footer">
                <p><Icon name="info" size={13} /> 默认不包含敏感信息，建议只在可信设备间迁移时开启。</p>
                <button type="button" class="session-transfer-primary" disabled={exporting()} onClick={() => void exportJson()}>
                  <Icon name="export" size={15} />
                  {exporting() ? "正在导出…" : "选择位置并导出"}
                </button>
              </div>
            </div>
          </Show>

          <Show when={activeTab() === "import"}>
            <div class="session-import-panel">
              <div class="session-import-panel-heading">
                <div>
                  <h3>选择会话来源</h3>
                  <p>当前支持 PortNest 官方备份和 Xshell 会话目录。</p>
                </div>
                <span class="session-import-source-count">2 个来源</span>
              </div>

              <div class="session-import-grid">
                <article class="session-import-card json">
                  <div class="session-import-card-heading">
                    <span class="session-import-badge"><Icon name="file" size={19} /></span>
                    <div>
                      <h4>PortNest JSON <span class="session-import-chip official">官方备份</span></h4>
                      <p>恢复由 PortNest 导出的会话备份，保留文件夹层级和连接配置。</p>
                    </div>
                  </div>
                  <div class="session-import-points">
                    <span><Icon name="check" size={12} /> 文件夹结构</span>
                    <span><Icon name="check" size={12} /> 连接与凭据</span>
                  </div>
                  <button type="button" class="session-import-action json" disabled={importingJson()} onClick={() => jsonInput?.click()}>
                    <Icon name="import" size={15} />
                    {importingJson() ? "正在导入…" : "选择 JSON 文件"}
                  </button>
                  <input ref={jsonInput} class="session-import-file" type="file" accept=".json,application/json" onChange={importJson} />
                </article>

                <article class="session-import-card xshell">
                  <div class="session-import-card-heading">
                    <span class="session-import-badge"><Icon name="terminal" size={19} /></span>
                    <div>
                      <h4>Xshell <span class="session-import-chip third-party">第三方</span></h4>
                      <p>选择 Xshell 的 Sessions 目录，保留文件夹层级并导入 SSH 连接。</p>
                    </div>
                  </div>
                  <div class="session-import-points">
                    <span><Icon name="check" size={12} /> 自动识别目录</span>
                    <span><Icon name="check" size={12} /> 保留文件夹层级</span>
                  </div>
                  <Show when={xshellDir()}>
                    <div class="session-import-detected" title={xshellDir()}>
                      <i />
                      <span>已检测到：{xshellDir()}</span>
                    </div>
                  </Show>
                  <p class="session-import-note"><Icon name="info" size={12} /> Xshell 加密密码和 NSSSH 私钥不会直接导入，完成后需重新输入或绑定。</p>
                  <Show when={!isTauriRuntime()}>
                    <p class="session-import-note"><Icon name="info" size={12} /> 目录导入仅在 PortNest 桌面应用中可用。</p>
                  </Show>
                  <button type="button" class="session-import-action xshell" disabled={importingXshell() || !isTauriRuntime()} onClick={() => void importXshell()}>
                    <Icon name="terminal" size={15} />
                    {importingXshell() ? "正在导入…" : "选择 Xshell 目录"}
                  </button>
                </article>
              </div>
            </div>
          </Show>

          <Show when={message()}>
            <div class={`session-transfer-message ${messageKind()}`}>
              <span class="session-transfer-message-icon">
                <Icon name={messageKind() === "success" ? "check" : "info"} size={16} />
              </span>
              <div class="session-transfer-message-copy">
                <div class="session-transfer-message-title">{message()}</div>
                <Show when={messageDetails().length > 0}>
                  <ul>
                    <For each={messageDetails()}>{detail => <li>{detail}</li>}</For>
                  </ul>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <footer class="session-transfer-footnote">
          <span><Icon name="lock" size={12} /> 会话数据仅在本机处理，不会上传服务器</span>
          <span>PortNest JSON · Xshell 7</span>
        </footer>
      </div>
    </div>
  );
};
