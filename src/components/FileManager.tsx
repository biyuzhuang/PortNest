import { Component, createSignal, createMemo, For, Show, onMount, onCleanup, createEffect, on } from "solid-js";
import { api, FileInfo, ConnectionRecord } from "../utils/api";
import { uiStore } from "../stores/uiStore";
import "./FileManager.css";

interface FileManagerProps {
  connection: ConnectionRecord;
  sessionKey?: string;
  sftpId?: string;
  onSftpOpened?: (id: string) => void;
  onClose?: () => void;
}

const fileIconKind = (file: FileInfo) => {
  if (file.is_dir) return { kind: "folder", label: "" };
  if (file.is_link) return { kind: "link", label: "↗" };
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(extension)) return { kind: "image", label: "IMG" };
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz"].includes(extension)) return { kind: "archive", label: "ZIP" };
  if (["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(extension)) return { kind: "script", label: "SH" };
  if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "cpp", "h", "css", "html", "vue"].includes(extension)) return { kind: "code", label: "<>" };
  if (["yaml", "yml", "json", "toml", "ini", "conf", "cfg", "xml", "env"].includes(extension)) return { kind: "config", label: "CFG" };
  if (["txt", "md", "log", "csv"].includes(extension)) return { kind: "text", label: "TXT" };
  if (["sql", "db", "sqlite"].includes(extension)) return { kind: "database", label: "DB" };
  if (["pem", "key", "pub", "crt", "cer"].includes(extension)) return { kind: "key", label: "KEY" };
  if (["exe", "bin", "run", "appimage"].includes(extension) || (!extension && file.permissions?.includes("x"))) {
    return { kind: "executable", label: "EXE" };
  }
  return { kind: "generic", label: "FILE" };
};

const FileTypeIcon: Component<{ file: FileInfo; parent?: boolean }> = (props) => {
  const icon = () => props.parent ? { kind: "folder", label: "" } : fileIconKind(props.file);
  return (
    <span class={`sftp-file-icon kind-${icon().kind}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <Show when={icon().kind === "folder"} fallback={
          <path d="M5 2.5h6l4 4v11H5z M11 2.5v4h4" />
        }>
          <path d="M2.5 5.5h6l1.7 2H17.5v9.5h-15z" />
        </Show>
      </svg>
      <Show when={icon().kind !== "folder"}><small>{icon().label}</small></Show>
    </span>
  );
};

export const FileManager: Component<FileManagerProps> = (props) => {
  const storedOptions = (() => {
    try { return JSON.parse(localStorage.getItem("portnest-file-view-options") || "{}"); }
    catch { return {}; }
  })();
  const defaultPath = props.connection.username === "root"
    ? "/root"
    : props.connection.username ? `/home/${props.connection.username}` : "/";
  const initialPath = storedOptions.pathLinked
    ? localStorage.getItem("portnest-linked-sftp-path") || defaultPath
    : storedOptions.favoritePath
      ? localStorage.getItem(`portnest-favorite-path-${props.connection.id}`) || defaultPath
      : defaultPath;
  const [currentPath, setCurrentPath] = createSignal(initialPath);
  const [files, setFiles] = createSignal<FileInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<FileInfo | null>(null);
  const [showNewFolderDialog, setShowNewFolderDialog] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; file: FileInfo } | null>(null);
  const [initialized, setInitialized] = createSignal(false);
  const [showOptions, setShowOptions] = createSignal(false);
  const [showHidden, setShowHidden] = createSignal(storedOptions.showHidden === true);
  const [pathLinked, setPathLinked] = createSignal(storedOptions.pathLinked === true);
  const [favoritePath, setFavoritePath] = createSignal(storedOptions.favoritePath === true);
  const [columns, setColumns] = createSignal({
    name: storedOptions.columns?.name !== false,
    modified: storedOptions.columns?.modified !== false,
    type: storedOptions.columns?.type !== false,
    size: storedOptions.columns?.size !== false,
    permissions: storedOptions.columns?.permissions === true,
    owner: storedOptions.columns?.owner === true,
  });
  const directoryCache = new Map<string, FileInfo[]>();
  let directoryRequestId = 0;

  const getSftpId = () => props.sftpId;

  const persistOptions = () => localStorage.setItem("portnest-file-view-options", JSON.stringify({
    showHidden: showHidden(),
    pathLinked: pathLinked(),
    favoritePath: favoritePath(),
    columns: columns(),
  }));

  const toggleColumn = (key: keyof ReturnType<typeof columns>) => {
    setColumns(previous => ({ ...previous, [key]: !previous[key] }));
    persistOptions();
  };

  const visibleFiles = createMemo(() => showHidden() ? files() : files().filter(file => !file.name.startsWith(".")));
  const columnTemplate = createMemo(() => [
    columns().name && "minmax(175px, 1.35fr)",
    columns().modified && "125px",
    columns().type && "70px",
    columns().size && "80px",
    columns().permissions && "78px",
    columns().owner && "90px",
  ].filter(Boolean).join(" "));

  const loadDirectory = async (path: string) => {
    const id = getSftpId();
    if (!id) return;

    const requestId = ++directoryRequestId;
    const cached = directoryCache.get(path);
    setCurrentPath(path);
    setSelectedFile(null);
    if (cached) {
      setFiles(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const entries = await api.listSftpDir(id, path);
      const sortedEntries = entries.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      directoryCache.set(path, sortedEntries);
      if (requestId !== directoryRequestId) return;
      setFiles(sortedEntries);
      if (pathLinked()) localStorage.setItem("portnest-linked-sftp-path", path);
      if (favoritePath()) localStorage.setItem(`portnest-favorite-path-${props.connection.id}`, path);
      setSelectedFile(null);
    } catch (e) {
      if (requestId === directoryRequestId && !cached) setError(String(e));
    } finally {
      if (requestId === directoryRequestId) setLoading(false);
    }
  };

  createEffect(on(() => props.sftpId, (sftpId) => {
    console.log("[FileManager] sftpId changed:", sftpId, "session:", props.sessionKey);
    if (sftpId && !initialized()) {
      setInitialized(true);
      loadDirectory(initialPath);
    }
  }));

  onMount(() => {
    console.log("[FileManager] Mounted, session:", props.sessionKey, "sftpId:", props.sftpId);
    if (props.sftpId) {
      setInitialized(true);
      loadDirectory(initialPath);
    }
  });

  onCleanup(async () => {
    console.log("[FileManager] Cleanup, session:", props.sessionKey);
  });

  const navigateTo = (path: string) => {
    loadDirectory(path);
  };

  const navigateUp = () => {
    const path = currentPath();
    if (path === "/") return;
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    loadDirectory(parent);
  };

  const handleFileClick = (file: FileInfo) => {
    setSelectedFile(file);
  };

  const handleFileDoubleClick = (file: FileInfo) => {
    if (file.is_dir) {
      navigateTo(file.path);
    }
  };

  const handleContextMenu = (e: MouseEvent, file: FileInfo) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  const handleDownload = async () => {
    const file = contextMenu()?.file;
    const id = getSftpId();
    if (!file || !id) return;

    const localPath = prompt("保存到本地路径:", file.name);
    if (localPath) {
      try {
        await api.sftpDownload(id, file.path, localPath);
        alert("下载完成");
      } catch (e) {
        alert("下载失败: " + e);
      }
    }
    setContextMenu(null);
  };

  const handleUpload = async () => {
    const id = getSftpId();
    if (!id) return;

    const localPath = prompt("请输入本地文件路径:");
    if (localPath) {
      const remotePath = currentPath() === "/" ? "/" + localPath.split(/[/\\]/).pop()! : currentPath() + "/" + localPath.split(/[/\\]/).pop()!;
      try {
        await api.sftpUpload(id, localPath, remotePath);
        alert("上传完成");
        loadDirectory(currentPath());
      } catch (e) {
        alert("上传失败: " + e);
      }
    }
    setContextMenu(null);
  };

  const handleNewFolder = async () => {
    const name = newFolderName();
    const id = getSftpId();
    if (!name || !id) return;

    try {
      await api.sftpCreateDir(id, currentPath() + "/" + name);
      setShowNewFolderDialog(false);
      setNewFolderName("");
      loadDirectory(currentPath());
    } catch (e) {
      alert("创建失败: " + e);
    }
  };

  const handleDelete = async () => {
    const file = contextMenu()?.file;
    const id = getSftpId();
    if (!file || !id) return;

    if (confirm(`确定删除 ${file.is_dir ? "目录" : "文件"} "${file.name}" 吗？`)) {
      try {
        if (file.is_dir) {
          await api.sftpDeleteDir(id, file.path);
        } else {
          await api.sftpDeleteFile(id, file.path);
        }
        loadDirectory(currentPath());
      } catch (e) {
        alert("删除失败: " + e);
      }
    }
    setContextMenu(null);
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  };

  const formatDate = (timestamp: number | null): string => {
    if (!timestamp) return "-";
    return new Date(timestamp * 1000).toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(/\//g, "-");
  };

  const fileType = (file: FileInfo) => file.is_dir
    ? "文件夹"
    : file.name.includes(".") ? file.name.split(".").pop() || "文件" : "文件";
  const totalSize = () => files().filter(file => !file.is_dir).reduce((sum, file) => sum + file.size, 0);

  return (
    <div class="file-manager">
      <div class="file-manager-header">
        <div class="path-bar">
          <button class="nav-btn" onClick={navigateUp} title="返回上级目录">‹</button>
          <button class="nav-btn" onClick={() => navigateTo(currentPath())} title="刷新">↻</button>
          <input
            type="text"
            class="path-input"
            value={currentPath()}
            onKeyDown={(e) => e.key === "Enter" && navigateTo(e.currentTarget.value)}
            onBlur={(e) => navigateTo(e.currentTarget.value)}
          />
          <button class="nav-btn" title="搜索">⌕</button>
          <button class="nav-btn" title="历史记录">◷</button>
          <button class={`nav-btn ${showOptions() ? "active" : ""}`} title="更多操作" onClick={() => setShowOptions(!showOptions())}>⋮</button>
        </div>
      </div>
      <div class="file-manager-summary">
        共 {files().length} 个文件，{files().filter(file => file.is_dir).length} 个文件夹，{formatSize(totalSize())}
        <span>
          <button onClick={() => setShowNewFolderDialog(true)} title="新建文件夹">＋文件夹</button>
          <button onClick={handleUpload} title="上传文件">上传</button>
        </span>
      </div>

      <div class="file-list">
        <Show when={loading()}>
          <div class="loading">加载中...</div>
        </Show>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
        <Show when={!loading() && !error()}>
          <div class="file-table">
            <div class="file-row header" style={{ "grid-template-columns": columnTemplate() }}>
              <Show when={columns().name}><div class="file-cell name">名称</div></Show>
              <Show when={columns().modified}><div class="file-cell date">修改时间</div></Show>
              <Show when={columns().type}><div class="file-cell type">类型</div></Show>
              <Show when={columns().size}><div class="file-cell size">大小</div></Show>
              <Show when={columns().permissions}><div class="file-cell permissions">权限</div></Show>
              <Show when={columns().owner}><div class="file-cell owner">用户/组</div></Show>
            </div>
            <div class="file-body">
              <Show when={currentPath() !== "/"}>
                <div
                  class="file-row parent-row"
                  style={{ "grid-template-columns": columnTemplate() }}
                  onDblClick={navigateUp}
                >
                  <Show when={columns().name}><div class="file-cell name">
                    <FileTypeIcon file={{ name: "..", path: "", size: 0, is_dir: true, is_link: false, modified: null }} parent />
                    <span class="file-name">..</span>
                  </div></Show>
                  <Show when={columns().modified}><div class="file-cell date">-</div></Show>
                  <Show when={columns().type}><div class="file-cell type">文件夹</div></Show>
                  <Show when={columns().size}><div class="file-cell size">-</div></Show>
                  <Show when={columns().permissions}><div class="file-cell permissions">-</div></Show>
                  <Show when={columns().owner}><div class="file-cell owner">-/-</div></Show>
                </div>
              </Show>
              <For each={visibleFiles()}>
                {(file) => (
                  <div
                    class={`file-row ${selectedFile()?.path === file.path ? "selected" : ""}`}
                    style={{ "grid-template-columns": columnTemplate() }}
                    onClick={() => handleFileClick(file)}
                    onDblClick={() => handleFileDoubleClick(file)}
                    onContextMenu={(e) => handleContextMenu(e, file)}
                  >
                    <Show when={columns().name}><div class="file-cell name">
                      <FileTypeIcon file={file} />
                      <span class="file-name">{file.name}</span>
                    </div></Show>
                    <Show when={columns().modified}><div class="file-cell date">{formatDate(file.modified)}</div></Show>
                    <Show when={columns().type}><div class="file-cell type">{fileType(file)}</div></Show>
                    <Show when={columns().size}><div class="file-cell size">{file.is_dir ? "-" : formatSize(file.size)}</div></Show>
                    <Show when={columns().permissions}><div class="file-cell permissions">{file.permissions || "-"}</div></Show>
                    <Show when={columns().owner}><div class="file-cell owner">{file.owner_group || "-"}</div></Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      <Show when={showOptions()}>
        <div class="file-options-menu" onClick={event => event.stopPropagation()}>
          <label><input type="checkbox" checked={uiStore.filesStacked()} onChange={event => uiStore.setFilesStacked(event.currentTarget.checked)} />上下布局</label>
          <label><input type="checkbox" checked={showHidden()} onChange={event => { setShowHidden(event.currentTarget.checked); persistOptions(); }} />显示隐藏文件</label>
          <label><input type="checkbox" checked={pathLinked()} onChange={event => {
            setPathLinked(event.currentTarget.checked);
            if (event.currentTarget.checked) localStorage.setItem("portnest-linked-sftp-path", currentPath());
            persistOptions();
          }} />路径联动</label>
          <label><input type="checkbox" checked={favoritePath()} onChange={event => {
            setFavoritePath(event.currentTarget.checked);
            if (event.currentTarget.checked) localStorage.setItem(`portnest-favorite-path-${props.connection.id}`, currentPath());
            persistOptions();
          }} />收藏路径</label>
          <div class="file-options-divider" />
          <div class="file-options-caption">远程显示列</div>
          <label><input type="checkbox" checked={columns().name} onChange={() => toggleColumn("name")} />名称</label>
          <label><input type="checkbox" checked={columns().modified} onChange={() => toggleColumn("modified")} />修改时间</label>
          <label><input type="checkbox" checked={columns().type} onChange={() => toggleColumn("type")} />类型</label>
          <label><input type="checkbox" checked={columns().size} onChange={() => toggleColumn("size")} />大小</label>
          <label><input type="checkbox" checked={columns().permissions} onChange={() => toggleColumn("permissions")} />权限</label>
          <label><input type="checkbox" checked={columns().owner} onChange={() => toggleColumn("owner")} />用户/组</label>
        </div>
        <div class="file-options-overlay" onClick={() => setShowOptions(false)} />
      </Show>

      <Show when={contextMenu()}>
        <div
          class="context-menu"
          style={{ left: contextMenu()!.x + "px", top: contextMenu()!.y + "px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="context-menu-item" onClick={handleDownload}>下载</div>
          <div class="context-menu-divider" />
          <div class="context-menu-item danger" onClick={handleDelete}>删除</div>
        </div>
        <div class="context-menu-overlay" onClick={() => setContextMenu(null)} />
      </Show>

      <Show when={showNewFolderDialog()}>
        <div class="modal-overlay">
          <div class="modal-content">
            <h3>新建文件夹</h3>
            <div class="form-group">
              <input
                type="text"
                placeholder="文件夹名称"
                value={newFolderName()}
                onInput={(e) => setNewFolderName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNewFolder()}
              />
            </div>
            <div class="form-actions">
              <button class="btn-cancel" onClick={() => setShowNewFolderDialog(false)}>取消</button>
              <button class="btn-save" onClick={handleNewFolder}>创建</button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
