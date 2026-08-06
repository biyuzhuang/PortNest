import { Component, createSignal, createMemo, For, Show, onMount, onCleanup, createEffect, on } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { api, FileInfo, ConnectionRecord } from "../utils/api";
import { uiStore } from "../stores/uiStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import { feedback } from "../stores/feedbackStore";
import { sessionStore } from "../stores/sessionStore";
import { pathLinkStore } from "../stores/pathLinkStore";
import { defaultHomePath } from "../utils/shellCwd";
import "./FileManager.css";

interface FileManagerProps {
  connection: ConnectionRecord;
  sessionKey?: string;
  sftpId?: string;
  onSftpOpened?: (id: string) => void;
  onClose?: () => void;
}

interface TransferProgressPayload {
  sftp_id: string;
  transfer_id: string;
  direction: string;
  file_name: string;
  transferred: number;
  total: number;
  status: string;
  error?: string | null;
}

interface TransferProgress {
  transferId: string;
  direction: "upload" | "download";
  fileName: string;
  transferred: number;
  total: number;
  status: "running" | "done" | "cancelled" | "error";
  error?: string;
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
  const [currentPath, setCurrentPath] = createSignal("");
  const [pathHistory, setPathHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(0);
  const [fileFilter, setFileFilter] = createSignal("");
  const [files, setFiles] = createSignal<FileInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<FileInfo | null>(null);
  const [showNewEntryDialog, setShowNewEntryDialog] = createSignal(false);
  const [newEntryMode, setNewEntryMode] = createSignal<"folder" | "file">("folder");
  const [newEntryName, setNewEntryName] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; file: FileInfo | null } | null>(null);
  const [showOptions, setShowOptions] = createSignal(false);
  const [showHidden, setShowHidden] = createSignal(storedOptions.showHidden === true);
  const [favoritePath, setFavoritePath] = createSignal(storedOptions.favoritePath === true);
  const [transfers, setTransfers] = createSignal<Record<string, TransferProgress>>({});
  const [pendingTransfers, setPendingTransfers] = createSignal<Array<{ localId: string; direction: "upload" | "download"; fileName: string }>>([]);
  const [probePending, setProbePending] = createSignal(false);
  const contextFile = createMemo(() => contextMenu()?.file ?? null);
  const linkedCwd = createMemo(() => props.sessionKey ? pathLinkStore.getCwd(props.sessionKey) : undefined);
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
  let unlistenProgress: (() => void) | undefined;
  const removeTimers = new Map<string, number>();
  let rootRef: HTMLDivElement | undefined;
  let contextMenuRef: HTMLDivElement | undefined;
  let lastFollowedCwd = "";
  let probeTimer: number | undefined;

  const getSftpId = () => props.sftpId;

  const homePath = () => defaultHomePath(props.connection.username);

  const persistOptions = () => localStorage.setItem("portnest-file-view-options", JSON.stringify({
    showHidden: showHidden(),
    pathLinked: uiStore.pathLinked(),
    favoritePath: favoritePath(),
    columns: columns(),
  }));

  const toggleColumn = (key: keyof ReturnType<typeof columns>) => {
    setColumns(previous => ({ ...previous, [key]: !previous[key] }));
    persistOptions();
  };

  const visibleFiles = createMemo(() => {
    const query = fileFilter().trim().toLowerCase();
    return files().filter(file => (showHidden() || !file.name.startsWith(".")) && (!query || file.name.toLowerCase().includes(query)));
  });
  const columnTemplate = createMemo(() => [
    columns().name && "minmax(175px, 1.35fr)",
    columns().modified && "125px",
    columns().type && "70px",
    columns().size && "80px",
    columns().permissions && "78px",
    columns().owner && "90px",
  ].filter(Boolean).join(" "));

  const computeInitialPath = () => {
    if (props.sessionKey && uiStore.pathLinked()) {
      const linked = pathLinkStore.getCwd(props.sessionKey);
      if (linked) return linked;
    }
    if (favoritePath()) {
      const favorite = localStorage.getItem(`portnest-favorite-path-${props.connection.id}`);
      if (favorite) return favorite;
    }
    return homePath();
  };

  const loadDirectory = async (path: string, recordHistory = true) => {
    const id = getSftpId();
    if (!id) return;

    const requestId = ++directoryRequestId;
    const cached = directoryCache.get(path);
    if (recordHistory && path !== currentPath()) {
      const next = pathHistory().slice(0, historyIndex() + 1);
      if (next[next.length - 1] !== path) next.push(path);
      setPathHistory(next);
      setHistoryIndex(next.length - 1);
    }
    setCurrentPath(path);
    setFileFilter("");
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
      if (directoryCache.size > 256) {
        const firstKey = directoryCache.keys().next().value;
        if (firstKey !== undefined) directoryCache.delete(firstKey);
      }
      if (requestId !== directoryRequestId) return;
      setFiles(sortedEntries);
      if (favoritePath()) localStorage.setItem(`portnest-favorite-path-${props.connection.id}`, path);
      setSelectedFile(null);
    } catch (e) {
      if (requestId === directoryRequestId && !cached) setError(String(e));
    } finally {
      if (requestId === directoryRequestId) setLoading(false);
    }
  };

  // SFTP 会话变更时（新连接/新标签）重置并加载对应初始路径
  createEffect(on(() => props.sftpId, (sftpId) => {
    console.log("[FileManager] sftpId changed:", sftpId, "session:", props.sessionKey);
    if (!sftpId) return;
    directoryCache.clear();
    const start = computeInitialPath();
    setCurrentPath(start);
    setPathHistory([start]);
    setHistoryIndex(0);
    setFiles([]);
    setFileFilter("");
    setSelectedFile(null);
    setError(null);
    void loadDirectory(start);
  }));

  // 终端 cwd 联动：cwd 变化必然触发跟随；lastFollowedCwd 守卫避免用户手动浏览被打回
  createEffect(() => {
    if (!uiStore.pathLinked() || !props.sessionKey) return;
    const cwd = pathLinkStore.cwdForSession(props.sessionKey);
    if (cwd) setProbePending(false);
    if (!cwd || cwd === lastFollowedCwd) return;
    if (cwd !== currentPath()) {
      lastFollowedCwd = cwd;
      console.info("[FileManager] 联动跟随:", { sessionKey: props.sessionKey, cwd, sftpId: getSftpId() });
      void loadDirectory(cwd, false);
    }
  });

  // 开启联动且尚无 cwd 时，向终端发送一次 PNCWD 探针校准初始路径
  createEffect(() => {
    if (!uiStore.pathLinked() || !props.sessionKey || !getSftpId()) return;
    if (!pathLinkStore.getCwd(props.sessionKey)) {
      sendProbe();
    }
  });

  onMount(() => {
    void (async () => {
      if (unlistenProgress) return;
      unlistenProgress = await listen<TransferProgressPayload>("sftp-transfer-progress", (event) => {
        const payload = event.payload;
        if (payload.sftp_id !== getSftpId()) return;
        const direction = payload.direction === "upload" ? "upload" : "download";
        // 乐观行与真实事件行合并：同方向同文件名视为同一传输
        const pending = pendingTransfers();
        const pendingIdx = pending.findIndex(item => item.direction === direction && item.fileName === payload.file_name);
        if (pendingIdx >= 0) {
          const matched = pending[pendingIdx];
          setPendingTransfers(prev => prev.filter(item => item.localId !== matched.localId));
          setTransfers(prev => {
            const next = { ...prev };
            delete next[matched.localId];
            return next;
          });
        }
        setTransfers(previous => ({
          ...previous,
          [payload.transfer_id]: {
            transferId: payload.transfer_id,
            direction,
            fileName: payload.file_name,
            transferred: payload.transferred,
            total: payload.total,
            status: (["running", "done", "cancelled", "error"].includes(payload.status) ? payload.status : "running") as TransferProgress["status"],
            error: payload.error ?? undefined,
          },
        }));
        if (payload.status !== "running") {
          const key = payload.transfer_id;
          const delay = payload.status === "done" ? 2500 : 6000;
          const existing = removeTimers.get(key);
          if (existing !== undefined) window.clearTimeout(existing);
          removeTimers.set(key, window.setTimeout(() => {
            removeTimers.delete(key);
            setTransfers(previous => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
          }, delay));
        }
      });
    })();
  });

  onCleanup(() => {
    unlistenProgress?.();
    for (const [, timer] of removeTimers) window.clearTimeout(timer);
    removeTimers.clear();
    if (probeTimer !== undefined) window.clearTimeout(probeTimer);
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

  const navigateHistory = (direction: -1 | 1) => {
    const nextIndex = historyIndex() + direction;
    const path = pathHistory()[nextIndex];
    if (!path) return;
    setHistoryIndex(nextIndex);
    void loadDirectory(path, false);
  };

  const refreshDirectory = () => {
    directoryCache.delete(currentPath());
    void loadDirectory(currentPath(), false);
  };

  const handleFileClick = (file: FileInfo) => {
    setSelectedFile(file);
  };

  const handleFileDoubleClick = (file: FileInfo) => {
    if (file.is_dir) {
      navigateTo(file.path);
    }
  };

  const openContextMenu = (e: MouseEvent, file: FileInfo | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  // 菜单只在文件管理界面内打开；菜单外的左键点击、Escape 或界面外的右键负责关闭。
  // 不使用全屏遮罩，避免在文件管理界面外右键时弹出本菜单或拦截其他区域的右键行为。
  createEffect(() => {
    if (!contextMenu()) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (contextMenuRef && target && contextMenuRef.contains(target)) return;
      setContextMenu(null);
    };
    const onDocumentContextMenu = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (contextMenuRef && target && contextMenuRef.contains(target)) return;
      // 文件管理界面内的右键已由自身处理器处理，不在此处关闭
      if (rootRef && target && rootRef.contains(target)) return;
      setContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("contextmenu", onDocumentContextMenu);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("contextmenu", onDocumentContextMenu);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  const handleDownload = async () => {
    const file = contextMenu()?.file;
    const id = getSftpId();
    if (!file || !id) {
      setContextMenu(null);
      return;
    }
    if (file.is_dir) {
      feedback.info("暂不支持下载文件夹");
      setContextMenu(null);
      return;
    }

    const localPath = await save({ defaultPath: file.name, title: `下载 ${file.name}` });
    if (!localPath) {
      setContextMenu(null);
      return;
    }
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingTransfers(prev => [...prev, { localId, direction: "download", fileName: file.name }]);
    setTransfers(prev => ({ ...prev, [localId]: { transferId: localId, direction: "download", fileName: file.name, transferred: 0, total: 0, status: "running" } }));
    try {
      await api.sftpDownload(id, file.path, localPath);
      feedback.success("下载完成: " + file.name);
      setError(null);
    } catch (e) {
      const message = String(e);
      if (!message.includes("取消")) setError("下载失败: " + message);
    } finally {
      cleanupOptimisticRow(localId);
    }
    setContextMenu(null);
  };

  const handleUpload = async () => {
    const id = getSftpId();
    if (!id) return;

    const localPath = await open({ multiple: false, directory: false, title: "选择要上传的文件" });
    if (!localPath) {
      setContextMenu(null);
      return;
    }
    const name = localPath.split(/[/\\]/).pop()!;
    const remotePath = currentPath() === "/" ? "/" + name : currentPath() + "/" + name;
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingTransfers(prev => [...prev, { localId, direction: "upload", fileName: name }]);
    setTransfers(prev => ({ ...prev, [localId]: { transferId: localId, direction: "upload", fileName: name, transferred: 0, total: 0, status: "running" } }));
    try {
      await api.sftpUpload(id, localPath, remotePath);
      feedback.success("上传完成: " + name);
      loadDirectory(currentPath());
    } catch (e) {
      const message = String(e);
      if (!message.includes("取消")) setError("上传失败: " + message);
    } finally {
      cleanupOptimisticRow(localId);
    }
    setContextMenu(null);
  };

  const openNewEntryDialog = (mode: "folder" | "file") => {
    setNewEntryMode(mode);
    setNewEntryName("");
    setShowNewEntryDialog(true);
    setContextMenu(null);
  };

  const handleNewEntry = async () => {
    const name = newEntryName().trim();
    const id = getSftpId();
    if (!name || !id) return;

    const path = currentPath() === "/" ? "/" + name : currentPath() + "/" + name;
    try {
      if (newEntryMode() === "folder") {
        await api.sftpCreateDir(id, path);
      } else {
        await api.sftpCreateFile(id, path);
      }
      setShowNewEntryDialog(false);
      setNewEntryName("");
      loadDirectory(currentPath());
      feedback.success(newEntryMode() === "folder" ? "文件夹创建成功" : "文件创建成功");
    } catch (e) {
      feedback.error("创建失败: " + e);
    }
  };

  const handleCopyPath = async () => {
    const file = contextMenu()?.file;
    const text = file ? file.path : currentPath();
    setContextMenu(null);
    try {
      await api.writeClipboardText(text);
      feedback.success("已复制路径: " + text);
    } catch (e) {
      feedback.error("复制失败: " + e);
    }
  };

  const handleDelete = async () => {
    const file = contextMenu()?.file;
    const id = getSftpId();
    if (!file || !id) return;

    if (await feedback.confirm(`确定删除${file.is_dir ? "目录" : "文件"}“${file.name}”吗？`, "删除远程文件")) {
      try {
        if (file.is_dir) {
          await api.sftpDeleteDir(id, file.path);
        } else {
          await api.sftpDeleteFile(id, file.path);
        }
        loadDirectory(currentPath());
      } catch (e) {
        feedback.error("删除失败: " + e);
      }
    }
    setContextMenu(null);
  };

  const sendProbe = () => {
    if (!props.sessionKey) return;
    setProbePending(true);
    if (probeTimer !== undefined) window.clearTimeout(probeTimer);
    probeTimer = window.setTimeout(() => setProbePending(false), 8000);
    void sessionStore.sendText(props.sessionKey, "\rprintf 'PNCWD=%s\\n' \"$PWD\"\r")
      .catch(() => setProbePending(false));
  };

  const handleReadTerminalPath = () => {
    sendProbe();
  };

  const cleanupOptimisticRow = (localId: string) => {
    const stillPending = pendingTransfers().some(item => item.localId === localId);
    if (!stillPending) return;
    setPendingTransfers(prev => prev.filter(item => item.localId !== localId));
    setTransfers(prev => {
      const next = { ...prev };
      delete next[localId];
      return next;
    });
  };

  const handleCancelTransfer = async (transferId: string) => {
    const id = getSftpId();
    if (!id) return;
    try {
      await api.cancelSftpTransfer(id, transferId);
    } catch (e) {
      console.warn("[FileManager] 取消传输失败:", e);
    }
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
    <div class="file-manager" ref={rootRef}>
      <div class="file-manager-header">
        <div class="path-bar">
          <button class="nav-btn" disabled={historyIndex() === 0} onClick={() => navigateHistory(-1)} title="返回">←</button>
          <button class="nav-btn" disabled={historyIndex() >= pathHistory().length - 1} onClick={() => navigateHistory(1)} title="前进">→</button>
          <button class="nav-btn" onClick={navigateUp} title="返回上级目录">↑</button>
          <button class="nav-btn" onClick={refreshDirectory} title="刷新">↻</button>
          <input
            type="text"
            class="path-input"
            value={currentPath()}
            onKeyDown={(e) => e.key === "Enter" && navigateTo(e.currentTarget.value)}
            onBlur={(e) => navigateTo(e.currentTarget.value)}
          />
          <Show when={uiStore.pathLinked() && props.sessionKey}>
            <span
              class={`path-link-badge ${probePending() ? "probing" : linkedCwd() ? "linked" : "idle"}`}
              title={probePending() ? "正在从终端读取当前路径…" : linkedCwd() ? "已与终端路径联动" : "路径联动已开启，等待首次定位"}
            >
              {probePending() ? "定位中" : linkedCwd() ? "联动中" : "待定位"}
            </span>
          </Show>
          <button class={`nav-btn ${showOptions() ? "active" : ""}`} title="更多操作" onClick={() => setShowOptions(!showOptions())}>⋮</button>
        </div>
      </div>
      <div class="file-manager-summary">
        <div class="file-manager-summary-actions">
          <Show when={uiStore.pathLinked() && props.sessionKey}>
            <button onClick={handleReadTerminalPath} title="从终端读取当前路径并同步">定位</button>
          </Show>
          <input class="file-filter-input" value={fileFilter()} placeholder="筛选当前目录" onInput={event => setFileFilter(event.currentTarget.value)} />
          <button onClick={() => openNewEntryDialog("folder")} title="新建文件夹">＋文件夹</button>
          <button onClick={handleUpload} title="上传文件">上传</button>
        </div>
        <div class="file-manager-summary-count">
          共 {files().length} 个文件，{files().filter(file => file.is_dir).length} 个文件夹，{formatSize(totalSize())}
        </div>
      </div>

      <div class="file-list" onContextMenu={(e) => openContextMenu(e, null)}>
        <Show when={loading()}>
          <div class="loading">加载中...</div>
        </Show>
        <Show when={error()}>
          <div class="error">{error()} <button onClick={refreshDirectory}>重试</button></div>
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
                  onContextMenu={(e) => openContextMenu(e, null)}
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
                    onContextMenu={(e) => openContextMenu(e, file)}
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

      <Show when={Object.keys(transfers()).length > 0}>
        <div class="transfer-strip">
          <For each={Object.values(transfers())}>
            {(transfer) => {
              const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : null;
              return (
                <div class={`transfer-row status-${transfer.status}`}>
                  <span class="transfer-icon">{transfer.direction === "upload" ? "↑" : "↓"}</span>
                  <div class="transfer-main">
                    <div class="transfer-info">
                      <span class="transfer-name" title={transfer.fileName}>{transfer.fileName}</span>
                      <span class="transfer-meta">
                        {transfer.status === "running"
                          ? `${formatSize(transfer.transferred)} / ${transfer.total > 0 ? formatSize(transfer.total) : "?"}${percent !== null ? ` · ${percent}%` : ""}`
                          : transfer.status === "done" ? "完成"
                          : transfer.status === "cancelled" ? "已取消"
                          : "失败"}
                      </span>
                    </div>
                    <div class="transfer-bar">
                      <div class="transfer-bar-fill" style={{ width: (percent ?? 0) + "%" }} />
                    </div>
                    <Show when={transfer.status === "error" && transfer.error}>
                      <div class="transfer-status">{transfer.error}</div>
                    </Show>
                  </div>
                  <Show when={transfer.status === "running"}>
                    <button class="transfer-cancel-btn" onClick={() => handleCancelTransfer(transfer.transferId)}>取消</button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={showOptions()}>
        <div class="file-options-menu" onClick={event => event.stopPropagation()}>
          <label><input type="checkbox" checked={uiStore.filesStacked()} onChange={event => uiStore.setFilesStacked(event.currentTarget.checked)} />上下布局</label>
          <label><input type="checkbox" checked={showHidden()} onChange={event => { setShowHidden(event.currentTarget.checked); persistOptions(); }} />显示隐藏文件</label>
          <label><input type="checkbox" checked={uiStore.pathLinked()} onChange={event => {
            uiStore.setPathLinked(event.currentTarget.checked);
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
          ref={contextMenuRef}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div class="context-menu-item" onClick={handleUpload}>上传到当前目录</div>
          <div
            class={`context-menu-item ${contextFile()?.is_dir ? "disabled" : ""}`}
            onClick={handleDownload}
            title={contextFile()?.is_dir ? "暂不支持下载文件夹" : undefined}
          >下载</div>
          <div class="context-menu-divider" />
          <div class="context-menu-item" onClick={() => openNewEntryDialog("folder")}>新建文件夹</div>
          <div class="context-menu-item" onClick={() => openNewEntryDialog("file")}>新建文件</div>
          <div class="context-menu-item" onClick={handleCopyPath}>复制路径</div>
          <div class="context-menu-item" onClick={() => { setContextMenu(null); refreshDirectory(); }}>刷新</div>
          <Show when={contextFile()}>
            <div class="context-menu-divider" />
            <div class="context-menu-item danger" onClick={handleDelete}>删除</div>
          </Show>
        </div>
      </Show>

      <Show when={showNewEntryDialog()}>
        <div class="modal-overlay">
          <div class="modal-content">
            <h3>{newEntryMode() === "folder" ? "新建文件夹" : "新建文件"}</h3>
            <div class="form-group">
              <input
                type="text"
                placeholder={newEntryMode() === "folder" ? "文件夹名称" : "文件名"}
                value={newEntryName()}
                onInput={(e) => setNewEntryName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNewEntry()}
              />
            </div>
            <div class="form-actions">
              <button class="btn-cancel" onClick={() => setShowNewEntryDialog(false)}>取消</button>
              <button class="btn-save" onClick={handleNewEntry}>创建</button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
