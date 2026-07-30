import { Component, Show, createSignal } from "solid-js";
import { api } from "../utils/api";
import { connectionStore } from "../stores/connectionStore";

export const SessionImportExport: Component<{ onClose: () => void }> = (props) => {
  const [includePasswords, setIncludePasswords] = createSignal(false);
  const [includePrivateKeys, setIncludePrivateKeys] = createSignal(false);
  const [message, setMessage] = createSignal("");

  const exportJson = async () => {
    if ((includePasswords() || includePrivateKeys()) &&
        !confirm("导出的 JSON 将包含明文敏感信息，请妥善保管。是否继续？")) return;
    const json = await api.exportSessions(includePasswords(), includePrivateKeys());
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `portnest-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("会话已导出");
  };

  const importJson = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await api.importSessions(await file.text());
      await connectionStore.loadConnections();
      setMessage(`已导入 ${result.connections} 个会话、${result.folders} 个文件夹`);
    } catch (error) {
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
          <button type="button" class="primary-btn" onClick={() => void exportJson()}>导出 JSON</button>
        </section>
        <section>
          <h3>导入会话</h3>
          <label class="primary-btn file-action">选择 JSON 文件<input type="file" accept=".json,application/json" onChange={importJson} /></label>
        </section>
        <Show when={message()}><div class="session-transfer-message">{message()}</div></Show>
      </div>
    </div>
  );
};
