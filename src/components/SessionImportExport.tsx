import { Component, Show, createSignal } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { api } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";
import { feedback } from "../stores/feedbackStore";

export const SessionImportExport: Component<{ onClose: () => void }> = (props) => {
  const [includePasswords, setIncludePasswords] = createSignal(false);
  const [includePrivateKeys, setIncludePrivateKeys] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [messageKind, setMessageKind] = createSignal<"success" | "error">("success");

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
    setMessage("");
    try {
      const json = await api.exportSessions(includePasswords(), includePrivateKeys());
      await writeTextFile(filePath, json);
      setMessageKind("success");
      setMessage(`会话已导出到：${filePath}`);
    } catch (error) {
      setMessageKind("error");
      setMessage(`导出失败：${String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const importJson = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await api.importSessions(await file.text());
      await connectionStore.loadConnections();
      setMessageKind("success");
      setMessage(`已导入 ${result.connections} 个会话、${result.folders} 个文件夹`);
    } catch (error) {
      setMessageKind("error");
      setMessage(`导入失败：${String(error)}`);
    } finally {
      input.value = "";
    }
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="session-transfer-modal" onClick={event => event.stopPropagation()}>
        <header><h2>导入 / 导出会话</h2><button type="button" onClick={props.onClose}>×</button></header>
        <section>
          <h3>导出会话</h3>
          <label><input type="checkbox" checked={includePasswords()} onChange={event => setIncludePasswords(event.currentTarget.checked)} /> 包含会话密码和私钥密码</label>
          <label><input type="checkbox" checked={includePrivateKeys()} onChange={event => setIncludePrivateKeys(event.currentTarget.checked)} /> 包含私钥</label>
          <p>敏感信息被选中后会以明文写入 JSON，仅用于可信设备间迁移。</p>
          <button type="button" class="primary-btn" disabled={exporting()} onClick={() => void exportJson()}>
            {exporting() ? "正在导出…" : "选择位置并导出 JSON"}
          </button>
        </section>
        <section>
          <h3>导入会话</h3>
          <label class="primary-btn file-action">选择 JSON 文件<input type="file" accept=".json,application/json" onChange={importJson} /></label>
        </section>
        <Show when={message()}><div class={`session-transfer-message ${messageKind()}`}>{message()}</div></Show>
      </div>
    </div>
  );
};
