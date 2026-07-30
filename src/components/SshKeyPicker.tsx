import { Component, For, Show, createSignal, onMount } from "solid-js";
import { api, type SshKeyRecord } from "../utils/api";

interface Props {
  selectedId?: string;
  onSelect: (key: SshKeyRecord) => void;
  onClose: () => void;
}

export const SshKeyPicker: Component<Props> = (props) => {
  let fileInput!: HTMLInputElement;
  const [keys, setKeys] = createSignal<SshKeyRecord[]>([]);
  const [selectedId, setSelectedId] = createSignal(props.selectedId || "");
  const [error, setError] = createSignal("");
  const [pendingFile, setPendingFile] = createSignal<File | null>(null);
  const [pendingName, setPendingName] = createSignal("");
  const load = async () => setKeys(await api.getSshKeys());
  onMount(() => void load().catch(error => setError(String(error))));

  const upload = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setPendingName(file.name.replace(/\.[^.]+$/, ""));
    input.value = "";
  };

  const confirmUpload = async () => {
    const file = pendingFile();
    const name = pendingName().trim();
    if (!file || !name) return;
    try {
      const key = await api.saveSshKey(name, file.name, await file.text());
      await load();
      setSelectedId(key.id);
      setPendingFile(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const remove = async () => {
    if (!selectedId() || !confirm("确定删除所选密钥吗？已保存的会话仍保留其加密副本。")) return;
    await api.deleteSshKey(selectedId());
    setSelectedId("");
    await load();
  };

  const choose = () => {
    const key = keys().find(item => item.id === selectedId());
    if (key) props.onSelect(key);
  };

  return (
    <div class="modal-overlay key-picker-overlay" onClick={props.onClose}>
      <div class="key-picker-modal" onClick={event => event.stopPropagation()}>
        <header>
          <div><h2>请选择私钥</h2><p>双击或者回车选择私钥</p></div>
          <button type="button" onClick={props.onClose}>×</button>
        </header>
        <div class="key-picker-table">
          <div class="key-picker-row key-picker-head">
            <span>名称</span><span>文件名</span><span>类型</span><span>更新时间</span>
          </div>
          <For each={keys()}>{key => (
            <div class={`key-picker-row ${selectedId() === key.id ? "selected" : ""}`} tabindex="0"
              onClick={() => setSelectedId(key.id)} onDblClick={() => props.onSelect(key)}
              onKeyDown={event => event.key === "Enter" && props.onSelect(key)}>
              <span>{key.name}</span><span>{key.file_name}</span><span>{key.key_type}</span>
              <span>{new Date(key.updated_at * 1000).toLocaleString()}</span>
            </div>
          )}</For>
          <Show when={!keys().length}><div class="key-picker-empty">还没有保存的密钥，请点击“新建”上传</div></Show>
        </div>
        <Show when={error()}><div class="key-picker-error">{error()}</div></Show>
        <footer>
          <button type="button" class="danger" disabled={!selectedId()} onClick={() => void remove()}>删除</button>
          <span />
          <button type="button" onClick={props.onClose}>取消</button>
          <input ref={fileInput} class="key-picker-file-input" type="file" onChange={upload} />
          <button type="button" class="key-picker-upload" onClick={() => fileInput.click()}>新建上传</button>
          <button type="button" disabled={!selectedId()} onClick={choose}>选择</button>
        </footer>
      </div>
      <Show when={pendingFile()}>
        <div class="modal-overlay key-name-overlay" onClick={event => { event.stopPropagation(); setPendingFile(null); }}>
          <div class="key-name-modal" onClick={event => event.stopPropagation()}>
            <header><h3>新建私钥</h3><button type="button" onClick={() => setPendingFile(null)}>×</button></header>
            <label>
              <span>密钥名称</span>
              <input autofocus value={pendingName()} onInput={event => setPendingName(event.currentTarget.value)}
                onKeyDown={event => event.key === "Enter" && void confirmUpload()} />
            </label>
            <div class="key-name-file">文件：{pendingFile()!.name}</div>
            <footer>
              <button type="button" onClick={() => setPendingFile(null)}>取消</button>
              <button type="button" class="primary-btn" disabled={!pendingName().trim()} onClick={() => void confirmUpload()}>保存</button>
            </footer>
          </div>
        </div>
      </Show>
    </div>
  );
};
