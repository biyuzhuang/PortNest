import { Component, For, Show, createMemo, createSignal, onMount } from "solid-js";
import { api, type SshKeyRecord } from "../utils/api";
import { feedback } from "../stores/feedbackStore";
import "./SshKeyPicker.css";

interface Props {
  selectedId?: string;
  onSelect: (key: SshKeyRecord) => void;
  onClose: () => void;
}

type SortField = "name" | "file_name" | "key_type" | "updated_at";
type ImportMode = "import" | "generate";

const CloseIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10m0-10L5 15" /></svg>
);

const EyeIcon = (props: { hidden?: boolean }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M2.2 10s2.8-4 7.8-4 7.8 4 7.8 4-2.8 4-7.8 4-7.8-4-7.8-4Z" />
    <circle cx="10" cy="10" r="2" />
    <Show when={props.hidden}><path d="M3 3l14 14" /></Show>
  </svg>
);

const detectKeyType = (value: string) => {
  if (/BEGIN RSA PRIVATE KEY/.test(value)) return "ssh-rsa";
  if (/BEGIN EC PRIVATE KEY/.test(value)) return "ecdsa";
  if (/BEGIN DSA PRIVATE KEY/.test(value)) return "ssh-dss";
  if (/BEGIN OPENSSH PRIVATE KEY/.test(value)) return "OpenSSH";
  if (/BEGIN PRIVATE KEY/.test(value)) return "PKCS#8";
  return "";
};

const formatDate = (seconds: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(seconds * 1000)).replace(/\//g, "-");

export const SshKeyPicker: Component<Props> = (props) => {
  let fileInput!: HTMLInputElement;
  const [keys, setKeys] = createSignal<SshKeyRecord[]>([]);
  const [selectedId, setSelectedId] = createSignal(props.selectedId || "");
  const [error, setError] = createSignal("");
  const [showImport, setShowImport] = createSignal(false);
  const [mode, setMode] = createSignal<ImportMode>("import");
  const [name, setName] = createSignal("");
  const [fileName, setFileName] = createSignal("");
  const [privateKey, setPrivateKey] = createSignal("");
  const [passphrase, setPassphrase] = createSignal("");
  const [showPassphrase, setShowPassphrase] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [sortField, setSortField] = createSignal<SortField>("name");
  const [sortAsc, setSortAsc] = createSignal(true);

  const load = async () => setKeys(await api.getSshKeys());
  onMount(() => void load().catch(cause => setError(String(cause))));

  const sortedKeys = createMemo(() => [...keys()].sort((a, b) => {
    const field = sortField();
    const left = a[field];
    const right = b[field];
    const result = typeof left === "number" ? left - Number(right) : String(left).localeCompare(String(right), "zh-CN");
    return sortAsc() ? result : -result;
  }));

  const changeSort = (field: SortField) => {
    if (sortField() === field) setSortAsc(!sortAsc());
    else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const readFile = async (file?: File) => {
    if (!file) return;
    try {
      const text = await file.text();
      setFileName(file.name);
      setPrivateKey(text);
      if (!name().trim()) setName(file.name.replace(/\.[^.]+$/, ""));
      setError("");
    } catch (cause) {
      setError(`读取私钥文件失败：${String(cause)}`);
    }
  };

  const openImport = () => {
    setMode("import");
    setName("");
    setFileName("");
    setPrivateKey("");
    setPassphrase("");
    setError("");
    setShowImport(true);
  };

  const generateKey = () => {
    setMode("generate");
    setName("");
    setFileName("id_ed25519");
    setPrivateKey("");
    setPassphrase("");
    setError("当前版本暂不支持在应用内生成密钥，请先使用 ssh-keygen 生成后再导入。");
    setShowImport(true);
  };

  const save = async () => {
    const keyName = name().trim();
    const material = privateKey().trim();
    if (!keyName || !material) return;
    if (!detectKeyType(material)) {
      setError("无法识别私钥格式，请选择 OpenSSH、RSA、ECDSA、DSA 或 PKCS#8 私钥。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const key = await api.saveSshKey(keyName, fileName() || keyName, material);
      await load();
      setSelectedId(key.id);
      setShowImport(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId() || !await feedback.confirm("确定删除所选私钥吗？使用该私钥的会话可能无法继续连接。", "删除私钥")) return;
    try {
      await api.deleteSshKey(selectedId());
      setSelectedId("");
      await load();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const choose = () => {
    const key = keys().find(item => item.id === selectedId());
    if (key) props.onSelect(key);
  };

  return (
    <div class="modal-overlay key-picker-overlay" onClick={props.onClose}>
      <section class="key-picker-modal" role="dialog" aria-modal="true" aria-labelledby="key-picker-title" onClick={event => event.stopPropagation()}>
        <header class="key-dialog-header">
          <div>
            <h2 id="key-picker-title">请选择私钥</h2>
            <p>双击或者回车选择私钥</p>
          </div>
          <button type="button" class="key-dialog-close" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button>
        </header>

        <div class="key-picker-body">
          <div class="key-picker-table" role="grid" aria-label="私钥列表">
            <div class="key-picker-row key-picker-head" role="row">
              <For each={[
                ["name", "名称"], ["file_name", "文件名"], ["key_type", "类型"], ["updated_at", "更新时间"],
              ] as Array<[SortField, string]>}>{([field, label]) => (
                <button type="button" onClick={() => changeSort(field)}>
                  <span>{label}</span>
                  <span class={`sort-mark ${sortField() === field ? "active" : ""}`}>
                    {sortField() === field && !sortAsc() ? "⌄" : "⌃"}
                  </span>
                </button>
              )}</For>
            </div>
            <For each={sortedKeys()}>{key => (
              <div
                class={`key-picker-row ${selectedId() === key.id ? "selected" : ""}`}
                role="row"
                tabindex="0"
                onClick={() => setSelectedId(key.id)}
                onDblClick={() => props.onSelect(key)}
                onKeyDown={event => event.key === "Enter" && props.onSelect(key)}
              >
                <span>{key.name}</span>
                <span>{key.file_name}</span>
                <span>{key.key_type}</span>
                <span>{formatDate(key.updated_at)}</span>
              </div>
            )}</For>
            <Show when={!keys().length}>
              <div class="key-picker-empty">还没有保存的私钥，请点击“新建”导入</div>
            </Show>
          </div>
          <Show when={error() && !showImport()}><div class="key-picker-error">{error()}</div></Show>
        </div>

        <footer class="key-picker-footer">
          <button type="button" class="text-action danger" disabled={!selectedId()} onClick={() => void remove()}>删除</button>
          <span />
          <button type="button" class="text-action cancel" onClick={props.onClose}>取消</button>
          <button type="button" class="text-action create" onClick={openImport}>新建</button>
          <button type="button" class="text-action choose" disabled={!selectedId()} onClick={choose}>选择</button>
        </footer>
      </section>

      <Show when={showImport()}>
        <div class="modal-overlay key-import-overlay" onClick={event => { event.stopPropagation(); setShowImport(false); }}>
          <section class="key-import-modal" role="dialog" aria-modal="true" aria-labelledby="key-import-title" onClick={event => event.stopPropagation()}>
            <header class="key-dialog-header">
              <div>
                <h2 id="key-import-title">{mode() === "import" ? "导入私钥" : "生成新的私钥"}</h2>
                <p>{mode() === "import" ? "可直接将私钥文件拖拽进此区域" : "创建一对新的 SSH 密钥"}</p>
              </div>
              <button type="button" class="key-dialog-close" onClick={() => setShowImport(false)} aria-label="关闭"><CloseIcon /></button>
            </header>

            <div class="key-import-card">
              <label class={`key-import-field ${!name().trim() ? "invalid" : ""}`}>
                <span>名称</span>
                <input autofocus value={name()} onInput={event => setName(event.currentTarget.value)} />
                <small>name is a required field</small>
              </label>

              <div class="key-import-field">
                <span>私钥文件</span>
                <input ref={fileInput} class="key-picker-file-input" type="file" onChange={event => void readFile(event.currentTarget.files?.[0])} />
                <button
                  type="button"
                  class={`key-file-drop ${dragging() ? "dragging" : ""}`}
                  onClick={() => fileInput.click()}
                  onDragOver={event => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={event => {
                    event.preventDefault();
                    setDragging(false);
                    void readFile(event.dataTransfer?.files[0]);
                  }}
                >
                  <span>{fileName() || "选择私钥文件，自动填充私钥"}</span>
                  <span class="key-file-icon">⌾</span>
                </button>
              </div>

              <label class={`key-import-field ${!privateKey().trim() ? "invalid" : ""}`}>
                <span>私钥内容</span>
                <textarea value={privateKey()} onInput={event => setPrivateKey(event.currentTarget.value)} spellcheck={false} />
                <small>privateKey is a required field</small>
              </label>

              <label class="key-import-field">
                <span>私钥密码</span>
                <div class="key-passphrase-input">
                  <input type={showPassphrase() ? "text" : "password"} value={passphrase()} onInput={event => setPassphrase(event.currentTarget.value)} />
                  <button type="button" onClick={() => setShowPassphrase(!showPassphrase())} aria-label="显示或隐藏密码">
                    <EyeIcon hidden={!showPassphrase()} />
                  </button>
                </div>
              </label>
              <Show when={error()}><div class="key-picker-error">{error()}</div></Show>
            </div>

            <footer class="key-import-footer">
              <div>
                <button type="button" class="import-secondary" onClick={openImport}>导入本机私钥</button>
                <button type="button" class="generate-action" onClick={generateKey}>生成新的</button>
                <button type="button" disabled>复制公钥</button>
                <button type="button" disabled>下载</button>
              </div>
              <div>
                <button type="button" class="cancel" onClick={() => setShowImport(false)}>取消</button>
                <button type="button" class="save" disabled={!name().trim() || !privateKey().trim() || saving()} onClick={() => void save()}>
                  {saving() ? "保存中…" : "保存"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      </Show>
    </div>
  );
};
