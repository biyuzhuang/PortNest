import { Component, createSignal, createMemo, For, Show, onMount, onCleanup, createEffect, on } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { api, FileInfo, ConnectionRecord, SftpConflictPolicy } from "../utils/api";
import { uiStore } from "../stores/uiStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import { feedback } from "../stores/feedbackStore";
import { sessionStore } from "../stores/sessionStore";
import { pathLinkStore } from "../stores/pathLinkStore";
import { defaultHomePath } from "../utils/shellCwd";
import { Icon } from "./Icon";
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
  actual_destination?: string | null;
}

interface TransferProgress {
  transferId: string;
  direction: "upload" | "download";
  fileName: string;
  transferred: number;
  total: number;
  status: "queued" | "running" | "cancelling" | "done" | "skipped" | "cancelled" | "error" | "interrupted";
  error?: string;
  persistent?: boolean;
}

type SortKey = "name" | "modified" | "type" | "size";
type SortDirection = "asc" | "desc";

const SORT_DEFAULT_DIRECTION: Record<SortKey, SortDirection> = {
  name: "asc",
  modified: "desc",
  type: "asc",
  size: "desc",
};

const isSortKey = (value: unknown): value is SortKey =>
  value === "name" || value === "modified" || value === "type" || value === "size";

const fileIconKind = (file: FileInfo): string => {
  if (file.is_dir) return "folder";
  if (file.is_link) return "link";
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(extension)) return "image";
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz"].includes(extension)) return "archive";
  if (["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(extension)) return "script";
  if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "cpp", "h", "css", "html", "vue"].includes(extension)) return "code";
  if (["yaml", "yml", "json", "toml", "ini", "conf", "cfg", "xml", "env"].includes(extension)) return "config";
  if (["txt", "md", "log", "csv"].includes(extension)) return "text";
  if (["sql", "db", "sqlite"].includes(extension)) return "database";
  if (["pem", "key", "pub", "crt", "cer"].includes(extension)) return "key";
  if (["exe", "bin", "run", "appimage"].includes(extension) || (!extension && file.permissions?.includes("x"))) return "executable";
  return "generic";
};

const fileTypeLabel = (file: FileInfo): string => file.is_dir
  ? "文件夹"
  : file.name.includes(".") ? file.name.split(".").pop() || "文件" : "文件";

const FileTypeIcon: Component<{ file: FileInfo; parent?: boolean }> = (props) => {
  const icon = () => props.parent ? "folder" : fileIconKind(props.file);
  return (
    <span class={`sftp-file-icon kind-${icon()}`}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <Show when={icon() === "folder"} fallback={
          <path d="M5 2.5h6l4 4v11H5z M11 2.5v4h4" />
        }>
          <path d="M2.5 5.5h6l1.7 2H17.5v9.5h-15z" />
        </Show>
      </svg>
    </span>
  );
};

const SortHeader: Component<{
  label: string;
  column: SortKey;
  activeColumn: SortKey;
  direction: SortDirection;
  onSort: (column: SortKey) => void;
}> = (props) => {
  const active = () => props.activeColumn === props.column;
  return (
    <button
      class={`file-sort ${active() ? "active" : ""}`}
      title={active()
        ? `${props.label}（${props.direction === "asc" ? "升序" : "降序"}），点击切换`
        : `按${props.label}排序`}
      aria-label={active()
        ? `${props.label}，当前${props.direction === "asc" ? "升序" : "降序"}，点击切换`
        : `按${props.label}排序`}
      onClick={() => props.onSort(props.column)}
    >
      <span>{props.label}</span>
      <span class="file-sort-icon">
        <Show when={active()} fallback={<Icon name="sort" size={10} class="file-sort-hint" />}>
          <Icon name={props.direction === "asc" ? "chevronUp" : "chevronDown"} size={11} />
        </Show>
      </span>
    </button>
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
  const [pathMode, setPathMode] = createSignal<"path" | "search">("path");
  const [sortKey, setSortKey] = createSignal<SortKey>(isSortKey(storedOptions.sortKey) ? storedOptions.sortKey : "name");
  const [sortDirection, setSortDirection] = createSignal<SortDirection>(
    storedOptions.sortDirection === "asc" || storedOptions.sortDirection === "desc"
      ? storedOptions.sortDirection
      : SORT_DEFAULT_DIRECTION[sortKey()],
  );
  const [files, setFiles] = createSignal<FileInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<FileInfo | null>(null);
  const [showNewEntryDialog, setShowNewEntryDialog] = createSignal(false);
  const [newEntryMode, setNewEntryMode] = createSignal<"folder" | "file">("folder");
  const [newEntryName, setNewEntryName] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; file: FileInfo | null } | null>(null);
  const [showOptions, setShowOptions] = createSignal(false);
  const [showTransferCenter, setShowTransferCenter] = createSignal(true);
  const [showHidden, setShowHidden] = createSignal(storedOptions.showHidden === true);
  const [transfers, setTransfers] = createSignal<Record<string, TransferProgress>>({});
  const [pendingTransfers, setPendingTransfers] = createSignal<Array<{ localId: string; direction: "upload" | "download"; fileName: string }>>([]);
  const [probePending, setProbePending] = createSignal(false);
  const [conflictPolicy, setConflictPolicy] = createSignal<SftpConflictPolicy>(storedOptions.conflictPolicy || "resume");
  const [verifyChecksum, setVerifyChecksum] = createSignal(storedOptions.verifyChecksum === true);
  const [maxConcurrent, setMaxConcurrent] = createSignal<number>(Math.min(8, Math.max(1, Number(storedOptions.maxConcurrent) || 2)));
  const [rateLimitKbps, setRateLimitKbps] = createSignal<number>(Math.max(0, Number(storedOptions.rateLimitKbps) || 0));
  const [showPermissionDialog, setShowPermissionDialog] = createSignal(false);
  const [permissionMode, setPermissionMode] = createSignal("0644");
  const [ownerUid, setOwnerUid] = createSignal("");
  const [ownerGid, setOwnerGid] = createSignal("");
  const [editorFile, setEditorFile] = createSignal<FileInfo | null>(null);
  const [editorContent, setEditorContent] = createSignal("");
  const [editorOriginal, setEditorOriginal] = createSignal("");
  const [editorChecksum, setEditorChecksum] = createSignal("");
  const [editorLoading, setEditorLoading] = createSignal(false);
  const [editorSaving, setEditorSaving] = createSignal(false);
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
  let rootRef: HTMLDivElement | undefined;
  let contextMenuRef: HTMLDivElement | undefined;
  let pathInputRef: HTMLInputElement | undefined;
  let lastFollowedCwd = "";
  let probeTimer: number | undefined;

  const getSftpId = () => props.sftpId;

  const homePath = () => defaultHomePath(props.connection.username);

  const persistOptions = () => localStorage.setItem("portnest-file-view-options", JSON.stringify({
    showHidden: showHidden(),
    pathLinked: uiStore.pathLinked(),
    conflictPolicy: conflictPolicy(),
    verifyChecksum: verifyChecksum(),
    maxConcurrent: maxConcurrent(),
    rateLimitKbps: rateLimitKbps(),
    columns: columns(),
    sortKey: sortKey(),
    sortDirection: sortDirection(),
  }));

  const applyQueueConfig = async () => {
    persistOptions();
    try {
      await api.configureSftpTransferQueue(maxConcurrent(), Math.round(rateLimitKbps() * 1024));
    } catch (cause) {
      console.warn("[FileManager] 更新传输队列设置失败:", cause);
    }
  };

  const toggleColumn = (key: keyof ReturnType<typeof columns>) => {
    setColumns(previous => ({ ...previous, [key]: !previous[key] }));
    persistOptions();
  };

  const compareFiles = (a: FileInfo, b: FileInfo) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let result: number;
    switch (sortKey()) {
      case "modified":
        result = (a.modified ?? 0) - (b.modified ?? 0);
        break;
      case "type":
        result = fileTypeLabel(a).localeCompare(fileTypeLabel(b), "zh-CN");
        break;
      case "size":
        result = (a.is_dir ? 0 : a.size) - (b.is_dir ? 0 : b.size);
        break;
      default:
        result = a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
    }
    return sortDirection() === "asc" ? result : -result;
  };

  const visibleFiles = createMemo(() => {
    const query = fileFilter().trim().toLowerCase();
    return files()
      .filter(file => (showHidden() || !file.name.startsWith(".")) && (!query || file.name.toLowerCase().includes(query)))
      .sort(compareFiles);
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey() === key) {
      setSortDirection(previous => previous === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDirection(SORT_DEFAULT_DIRECTION[key]);
    }
    persistOptions();
  };

  const columnTemplate = createMemo(() => {
    const tracks = [
      columns().name && "var(--file-name-track)",
      columns().modified && "max-content",
      columns().type && "max-content",
      columns().size && "max-content",
      columns().permissions && "max-content",
      columns().owner && "max-content",
    ].filter((track): track is string => Boolean(track));
    if (!columns().name) tracks.push("minmax(0, 1fr)");
    return tracks.join(" ");
  });

  const computeInitialPath = () => {
    if (props.sessionKey && uiStore.pathLinked()) {
      const linked = pathLinkStore.getCwd(props.sessionKey);
      if (linked) return linked;
    }
    return homePath();
  };

  const loadTransferHistory = async () => {
    try {
      const records = await api.listSftpTransfers(props.connection.id);
      const mapped: Record<string, TransferProgress> = {};
      for (const record of records) {
        mapped[record.id] = {
          transferId: record.id,
          direction: record.direction.startsWith("upload") ? "upload" : "download",
          fileName: record.file_name,
          transferred: record.transferred,
          total: record.total,
          status: record.status,
          error: record.error ?? undefined,
          persistent: true,
        };
      }
      setTransfers(previous => ({ ...mapped, ...Object.fromEntries(Object.entries(previous).filter(([, item]) => item.status === "running")) }));
    } catch (cause) {
      console.warn("[FileManager] 读取传输历史失败:", cause);
    }
  };

  const loadDirectory = async (path: string, recordHistory = true) => {
    const id = getSftpId();
    if (!id) return;

    const requestId = ++directoryRequestId;
    const cached = directoryCache.get(path);
    if (path !== currentPath()) setPathMode("path");
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
    void applyQueueConfig();
    void loadTransferHistory();
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
            status: (["running", "done", "skipped", "cancelled", "error", "interrupted"].includes(payload.status) ? payload.status : "running") as TransferProgress["status"],
            error: payload.error ?? undefined,
            persistent: true,
          },
        }));
        if (payload.status !== "running") {
          void loadTransferHistory();
        }
      });
    })();
  });

  onCleanup(() => {
    unlistenProgress?.();
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
    if (file) setSelectedFile(file);
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
    const selectedPath = file.is_dir
      ? await open({ multiple: false, directory: true, title: `选择“${file.name}”的保存位置` })
      : await save({ defaultPath: file.name, title: `下载 ${file.name}` });
    const localPath = typeof selectedPath === "string"
      ? (file.is_dir ? `${selectedPath}${selectedPath.includes("\\") ? "\\" : "/"}${file.name}` : selectedPath)
      : null;
    if (!localPath) {
      setContextMenu(null);
      return;
    }
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingTransfers(prev => [...prev, { localId, direction: "download", fileName: file.name }]);
    setTransfers(prev => ({ ...prev, [localId]: { transferId: localId, direction: "download", fileName: file.name, transferred: 0, total: 0, status: "running" } }));
    try {
      const transferOptions = {
        conflict_policy: conflictPolicy(),
        verify_checksum: verifyChecksum(),
      };
      const result = file.is_dir
        ? await api.sftpDownloadDirectory(id, file.path, localPath, transferOptions)
        : await api.sftpDownload(id, file.path, localPath, transferOptions);
      feedback.success(result.status === "skipped" ? `已跳过同名文件: ${file.name}` : `下载完成: ${result.actual_destination}`);
      setError(null);
      await loadTransferHistory();
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

    const selected = await open({ multiple: true, directory: false, title: "选择要上传的文件（可多选）" });
    const localPaths = typeof selected === "string" ? [selected] : selected || [];
    if (localPaths.length === 0) {
      setContextMenu(null);
      return;
    }
    let completed = 0;
    let skipped = 0;
    let failed = 0;
    await Promise.all(localPaths.map(async (localPath, index) => {
      const name = localPath.split(/[/\\]/).pop()!;
      const remotePath = currentPath() === "/" ? "/" + name : currentPath() + "/" + name;
      const localId = `local-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
      setPendingTransfers(previous => [...previous, { localId, direction: "upload", fileName: name }]);
      setTransfers(previous => ({ ...previous, [localId]: { transferId: localId, direction: "upload", fileName: name, transferred: 0, total: 0, status: "running" } }));
      try {
        const result = await api.sftpUpload(id, localPath, remotePath, {
          conflict_policy: conflictPolicy(),
          verify_checksum: verifyChecksum(),
        });
        if (result.status === "skipped") skipped += 1;
        else completed += 1;
      } catch (cause) {
        failed += 1;
        const message = String(cause);
        if (!message.includes("取消")) setError(`上传 ${name} 失败: ${message}`);
      } finally {
        cleanupOptimisticRow(localId);
      }
    }));
    await loadTransferHistory();
    loadDirectory(currentPath());
    feedback.info(`批量上传完成：成功 ${completed}，跳过 ${skipped}，失败 ${failed}`);
    setContextMenu(null);
  };

  const handleUploadDirectory = async () => {
    const id = getSftpId();
    if (!id) return;
    const selected = await open({ multiple: false, directory: true, title: "选择要上传的目录" });
    const localPath = typeof selected === "string" ? selected : null;
    if (!localPath) { setContextMenu(null); return; }
    const name = localPath.split(/[/\\]/).filter(Boolean).pop() || "upload";
    const remotePath = currentPath() === "/" ? `/${name}` : `${currentPath()}/${name}`;
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingTransfers(previous => [...previous, { localId, direction: "upload", fileName: name }]);
    setTransfers(previous => ({ ...previous, [localId]: { transferId: localId, direction: "upload", fileName: name, transferred: 0, total: 0, status: "running" } }));
    try {
      const result = await api.sftpUploadDirectory(id, localPath, remotePath, {
        conflict_policy: conflictPolicy(),
        verify_checksum: verifyChecksum(),
      });
      feedback.success(result.status === "skipped" ? `已跳过同名目录: ${name}` : `目录上传完成: ${result.actual_destination}`);
      await loadTransferHistory();
      refreshDirectory();
    } catch (cause) {
      const message = String(cause);
      if (!message.includes("取消")) setError("目录上传失败: " + message);
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

  const handleRetryTransfer = async (transferId: string) => {
    const id = getSftpId();
    if (!id) return;
    try {
      await api.retrySftpTransfer(id, transferId);
      feedback.success("传输已完成");
      await loadTransferHistory();
      refreshDirectory();
    } catch (cause) {
      feedback.error("重试失败: " + cause);
      await loadTransferHistory();
    }
  };

  const handleClearTransferHistory = async () => {
    try {
      await api.clearSftpTransferHistory(props.connection.id);
      await loadTransferHistory();
    } catch (cause) {
      feedback.error("清理传输记录失败: " + cause);
    }
  };

  const openPermissionEditor = () => {
    const file = contextFile();
    if (!file) return;
    const symbolic = file.permissions || "";
    let mode = 0;
    if (symbolic.length >= 10) {
      const triplets = [symbolic.slice(1, 4), symbolic.slice(4, 7), symbolic.slice(7, 10)];
      mode = Number(triplets.map(value => (value[0] === "r" ? 4 : 0) + (value[1] === "w" ? 2 : 0) + (value[2] === "x" ? 1 : 0)).join(""));
    }
    setPermissionMode(String(mode || (file.is_dir ? 755 : 644)).padStart(4, "0"));
    setOwnerUid(file.uid === null || file.uid === undefined ? "" : String(file.uid));
    setOwnerGid(file.gid === null || file.gid === undefined ? "" : String(file.gid));
    setShowPermissionDialog(true);
    setContextMenu(null);
  };

  const handleSetPermissions = async () => {
    const id = getSftpId();
    const file = selectedFile();
    if (!id || !file || !/^[0-7]{3,4}$/.test(permissionMode())) {
      feedback.error("请输入 3 或 4 位八进制权限，例如 0644 或 0755");
      return;
    }
    try {
      await api.sftpSetPermissions(id, file.path, Number.parseInt(permissionMode(), 8));
      const uid = ownerUid() === "" ? undefined : Number.parseInt(ownerUid(), 10);
      const gid = ownerGid() === "" ? undefined : Number.parseInt(ownerGid(), 10);
      if (uid !== file.uid || gid !== file.gid) {
        await api.sftpSetOwner(id, file.path, uid, gid);
      }
      setShowPermissionDialog(false);
      feedback.success(`已更新 ${file.name} 的属性`);
      refreshDirectory();
    } catch (cause) {
      feedback.error("修改权限失败: " + cause);
    }
  };

  const openRemoteEditor = async () => {
    const id = getSftpId();
    const file = contextFile();
    setContextMenu(null);
    if (!id || !file || file.is_dir) return;
    setEditorFile(file);
    setEditorContent("");
    setEditorOriginal("");
    setEditorChecksum("");
    setEditorLoading(true);
    try {
      const result = await api.sftpReadTextFile(id, file.path);
      setEditorContent(result.content);
      setEditorOriginal(result.content);
      setEditorChecksum(result.checksum);
    } catch (cause) {
      setEditorFile(null);
      feedback.error("打开远程文件失败: " + cause);
    } finally {
      setEditorLoading(false);
    }
  };

  const closeRemoteEditor = async () => {
    if (editorContent() !== editorOriginal() && !await feedback.confirm("远程文件尚未保存，确定放弃修改吗？", "关闭编辑器")) return;
    setEditorFile(null);
  };

  const saveRemoteEditor = async () => {
    const id = getSftpId();
    const file = editorFile();
    if (!id || !file || editorSaving()) return;
    setEditorSaving(true);
    try {
      const checksum = await api.sftpWriteTextFile(id, file.path, editorContent(), editorChecksum());
      setEditorChecksum(checksum);
      setEditorOriginal(editorContent());
      feedback.success(`已保存 ${file.name}`);
      refreshDirectory();
    } catch (cause) {
      feedback.error("保存远程文件失败: " + cause);
    } finally {
      setEditorSaving(false);
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

  const totalSize = () => files().filter(file => !file.is_dir).reduce((sum, file) => sum + file.size, 0);
  const summaryText = () => {
    const folderCount = files().filter(file => file.is_dir).length;
    return `共 ${files().length - folderCount} 个文件，${folderCount} 个文件夹，${formatSize(totalSize())}`;
  };

  return (
    <div class="file-manager" ref={rootRef}>
      <div class="file-manager-header">
        <div class="path-bar">
          <button class="nav-btn" disabled={historyIndex() === 0} onClick={() => navigateHistory(-1)} title="返回"><Icon name="arrowLeft" size={15} /></button>
          <button class="nav-btn" disabled={historyIndex() >= pathHistory().length - 1} onClick={() => navigateHistory(1)} title="前进"><Icon name="arrowRight" size={15} /></button>
          <button class="nav-btn" onClick={navigateUp} title="返回上级目录"><Icon name="arrowUp" size={15} /></button>
          <button class="nav-btn" onClick={refreshDirectory} title="刷新"><Icon name="refresh" size={15} /></button>
          <div class={`path-field ${pathMode() === "search" ? "searching" : ""}`}>
            <input
              ref={pathInputRef}
              type="text"
              class="path-input"
              value={pathMode() === "path" ? currentPath() : fileFilter()}
              placeholder={pathMode() === "path" ? "输入路径并回车" : "搜索当前目录"}
              aria-label={pathMode() === "path" ? "目录路径" : "搜索当前目录"}
              onInput={(e) => { if (pathMode() === "search") setFileFilter(e.currentTarget.value); }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && pathMode() === "search") {
                  setPathMode("path");
                  setFileFilter("");
                  e.currentTarget.blur();
                  return;
                }
                if (e.key === "Enter" && pathMode() === "path") navigateTo(e.currentTarget.value);
              }}
              onBlur={(e) => { if (pathMode() === "path") navigateTo(e.currentTarget.value); }}
            />
            <button
              class="path-mode-btn"
              title={pathMode() === "path" ? "搜索当前目录" : "返回路径输入"}
              aria-label={pathMode() === "path" ? "搜索当前目录" : "返回路径输入"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (pathMode() === "path") {
                  setPathMode("search");
                } else {
                  setPathMode("path");
                  setFileFilter("");
                }
                pathInputRef?.focus();
              }}
            >
              <Icon name={pathMode() === "path" ? "search" : "folder"} size={13} />
            </button>
          </div>
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
        <div class="file-manager-summary-count" title={summaryText()}>
          {summaryText()}
        </div>
        <button
          class={`file-manager-transfer-toggle ${showTransferCenter() ? "active" : ""}`}
          onClick={() => setShowTransferCenter(value => !value)}
          title={showTransferCenter() ? "隐藏传输中心" : "显示传输中心"}
        >
          <Icon name="transfer" size={12} />
          <span>传输 {Object.values(transfers()).filter(item => item.status === "running").length || ""}</span>
        </button>
      </div>

      <div class="file-list" onContextMenu={(e) => openContextMenu(e, null)}>
        <Show when={loading()}>
          <div class="loading">加载中...</div>
        </Show>
        <Show when={error()}>
          <div class="error">{error()} <button onClick={refreshDirectory}>重试</button></div>
        </Show>
        <Show when={!loading() && !error()}>
          <div class="file-table" style={{ "grid-template-columns": columnTemplate() }}>
            <div class="file-row header">
              <Show when={columns().name}><div class="file-cell name"><SortHeader label="名称" column="name" activeColumn={sortKey()} direction={sortDirection()} onSort={toggleSort} /></div></Show>
              <Show when={columns().modified}><div class="file-cell date"><SortHeader label="修改时间" column="modified" activeColumn={sortKey()} direction={sortDirection()} onSort={toggleSort} /></div></Show>
              <Show when={columns().type}><div class="file-cell type"><SortHeader label="类型" column="type" activeColumn={sortKey()} direction={sortDirection()} onSort={toggleSort} /></div></Show>
              <Show when={columns().size}><div class="file-cell size"><SortHeader label="大小" column="size" activeColumn={sortKey()} direction={sortDirection()} onSort={toggleSort} /></div></Show>
              <Show when={columns().permissions}><div class="file-cell permissions">权限</div></Show>
              <Show when={columns().owner}><div class="file-cell owner">用户/组</div></Show>
            </div>
            <div class="file-body">
              <Show when={currentPath() !== "/"}>
                <div
                  class="file-row parent-row"
                  title="双击返回上级目录"
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
                    onClick={() => handleFileClick(file)}
                    onDblClick={() => handleFileDoubleClick(file)}
                    onContextMenu={(e) => openContextMenu(e, file)}
                  >
                    <Show when={columns().name}><div class="file-cell name">
                      <FileTypeIcon file={file} />
                      <span class="file-name" title={file.name}>{file.name}</span>
                    </div></Show>
                    <Show when={columns().modified}><div class="file-cell date">{formatDate(file.modified)}</div></Show>
                    <Show when={columns().type}><div class="file-cell type">{fileTypeLabel(file)}</div></Show>
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

      <Show when={showTransferCenter() && Object.keys(transfers()).length > 0}>
        <div class="transfer-strip">
          <div class="transfer-strip-header">
            <strong>传输中心</strong>
            <span>{Object.keys(transfers()).length} 条记录</span>
            <button onClick={handleClearTransferHistory}>清理已完成</button>
          </div>
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
                          : transfer.status === "skipped" ? "已跳过"
                          : transfer.status === "cancelled" ? "已取消"
                          : transfer.status === "interrupted" ? "已中断"
                          : "失败"}
                      </span>
                    </div>
                    <div class="transfer-bar">
                      <div class="transfer-bar-fill" style={{ width: (percent ?? 0) + "%" }} />
                    </div>
                    <Show when={(["error", "cancelled", "interrupted"].includes(transfer.status)) && transfer.error}>
                      <div class="transfer-status">{transfer.error}</div>
                    </Show>
                  </div>
                  <Show when={transfer.status === "running"}>
                    <button class="transfer-cancel-btn" onClick={() => handleCancelTransfer(transfer.transferId)}>取消</button>
                  </Show>
                  <Show when={["error", "cancelled", "interrupted"].includes(transfer.status)}>
                    <button class="transfer-retry-btn" onClick={() => handleRetryTransfer(transfer.transferId)}>续传</button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={showOptions()}>
        <div class="file-options-menu" onClick={event => event.stopPropagation()}>
          <div class="file-options-group" role="group" aria-label="视图">
            <div class="file-options-caption">视图</div>
            <label class="file-options-check">
              <input type="checkbox" checked={uiStore.filesStacked()} onChange={event => uiStore.setFilesStacked(event.currentTarget.checked)} />
              <span>上下布局</span>
            </label>
            <label class="file-options-check">
              <input type="checkbox" checked={showHidden()} onChange={event => { setShowHidden(event.currentTarget.checked); persistOptions(); }} />
              <span>显示隐藏文件</span>
            </label>
            <label class="file-options-check">
              <input type="checkbox" checked={uiStore.pathLinked()} onChange={event => {
                uiStore.setPathLinked(event.currentTarget.checked);
                persistOptions();
              }} />
              <span>路径联动</span>
            </label>
          </div>
          <div class="file-options-divider" />
          <div class="file-options-group" role="group" aria-label="传输策略">
            <div class="file-options-caption">传输策略</div>
            <label class="file-options-field">
              <span class="file-options-label">同名文件</span>
              <select class="file-options-select file-options-policy" value={conflictPolicy()} onChange={event => { setConflictPolicy(event.currentTarget.value as SftpConflictPolicy); persistOptions(); }}>
                <option value="resume">断点续传</option>
                <option value="rename">自动重命名</option>
                <option value="overwrite">覆盖</option>
                <option value="skip">跳过</option>
              </select>
            </label>
            <label class="file-options-check">
              <input type="checkbox" checked={verifyChecksum()} onChange={event => { setVerifyChecksum(event.currentTarget.checked); persistOptions(); }} />
              <span>SHA-256 校验</span>
            </label>
            <label class="file-options-field">
              <span class="file-options-label">并发任务</span>
              <select class="file-options-select file-options-concurrency" value={maxConcurrent()} onChange={event => { setMaxConcurrent(Number(event.currentTarget.value)); void applyQueueConfig(); }}>
                <option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option>
                <option value="6">6</option><option value="8">8</option>
              </select>
            </label>
            <label class="file-options-field">
              <span class="file-options-label">单任务限速</span>
              <span class="file-options-number-control">
                <input class="file-options-number" type="number" min="0" step="128" value={rateLimitKbps()} onChange={event => { setRateLimitKbps(Math.max(0, Number(event.currentTarget.value) || 0)); void applyQueueConfig(); }} />
                <span class="file-options-unit">KB/s</span>
              </span>
            </label>
          </div>
          <div class="file-options-divider" />
          <div class="file-options-group" role="group" aria-label="远程显示列">
            <div class="file-options-caption">远程显示列</div>
            <div class="file-options-columns">
              <label class="file-options-check"><input type="checkbox" checked={columns().name} onChange={() => toggleColumn("name")} /><span>名称</span></label>
              <label class="file-options-check"><input type="checkbox" checked={columns().modified} onChange={() => toggleColumn("modified")} /><span>修改时间</span></label>
              <label class="file-options-check"><input type="checkbox" checked={columns().type} onChange={() => toggleColumn("type")} /><span>类型</span></label>
              <label class="file-options-check"><input type="checkbox" checked={columns().size} onChange={() => toggleColumn("size")} /><span>大小</span></label>
              <label class="file-options-check"><input type="checkbox" checked={columns().permissions} onChange={() => toggleColumn("permissions")} /><span>权限</span></label>
              <label class="file-options-check"><input type="checkbox" checked={columns().owner} onChange={() => toggleColumn("owner")} /><span>用户/组</span></label>
            </div>
          </div>
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
          <div class="context-menu-item" onClick={handleUpload}><span class="context-menu-icon"><Icon name="export" size={13} /></span><span>上传到当前目录</span></div>
          <div class="context-menu-item" onClick={handleUploadDirectory}><span class="context-menu-icon"><Icon name="export" size={13} /></span><span>上传目录到当前位置</span></div>
          <div class="context-menu-item" onClick={handleDownload}><span class="context-menu-icon"><Icon name="import" size={13} /></span><span>{contextFile()?.is_dir ? "下载目录" : "下载"}</span></div>
          <div class="context-menu-divider" />
          <div class="context-menu-item" onClick={() => openNewEntryDialog("folder")}><span class="context-menu-icon"><Icon name="folder" size={13} /></span><span>新建文件夹</span></div>
          <div class="context-menu-item" onClick={() => openNewEntryDialog("file")}><span class="context-menu-icon"><Icon name="plus" size={13} /></span><span>新建文件</span></div>
          <div class="context-menu-item" onClick={handleCopyPath}><span class="context-menu-icon"><Icon name="copy" size={13} /></span><span>复制路径</span></div>
          <div class="context-menu-item" onClick={() => { setContextMenu(null); refreshDirectory(); }}><span class="context-menu-icon"><Icon name="refresh" size={13} /></span><span>刷新</span></div>
          <Show when={contextFile()}>
            <div class="context-menu-divider" />
            <Show when={!contextFile()?.is_dir}><div class="context-menu-item" onClick={openRemoteEditor}><span class="context-menu-icon"><Icon name="edit" size={13} /></span><span>编辑文本…</span></div></Show>
            <div class="context-menu-item" onClick={openPermissionEditor}><span class="context-menu-icon"><Icon name="info" size={13} /></span><span>文件属性…</span></div>
            <div class="context-menu-item danger" onClick={handleDelete}><span class="context-menu-icon"><Icon name="trash" size={13} /></span><span>删除</span></div>
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

      <Show when={showPermissionDialog()}>
        <div class="modal-overlay">
          <div class="modal-content permission-dialog">
            <h3>文件属性</h3>
            <p>{selectedFile()?.name}</p>
            <div class="form-group">
              <label>八进制权限</label>
              <input
                type="text"
                inputmode="numeric"
                maxlength="4"
                placeholder="0644"
                value={permissionMode()}
                onInput={event => setPermissionMode(event.currentTarget.value.replace(/[^0-7]/g, ""))}
                onKeyDown={event => event.key === "Enter" && void handleSetPermissions()}
              />
              <small>常用：0644 普通文件，0755 可执行文件或目录</small>
            </div>
            <div class="permission-owner-grid">
              <div class="form-group">
                <label>所有者 UID</label>
                <input type="text" inputmode="numeric" placeholder="保持未知" value={ownerUid()} onInput={event => setOwnerUid(event.currentTarget.value.replace(/\D/g, ""))} />
              </div>
              <div class="form-group">
                <label>所属组 GID</label>
                <input type="text" inputmode="numeric" placeholder="保持未知" value={ownerGid()} onInput={event => setOwnerGid(event.currentTarget.value.replace(/\D/g, ""))} />
              </div>
            </div>
            <div class="form-actions">
              <button class="btn-cancel" onClick={() => setShowPermissionDialog(false)}>取消</button>
              <button class="btn-save" onClick={handleSetPermissions}>应用</button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={editorFile()}>
        <div class="modal-overlay remote-editor-overlay">
          <div class="remote-editor-dialog">
            <header>
              <div><strong>{editorFile()?.name}</strong><small>{editorFile()?.path}</small></div>
              <button onClick={() => void closeRemoteEditor()} aria-label="关闭编辑器"><Icon name="close" size={15} /></button>
            </header>
            <Show when={editorLoading()} fallback={
              <textarea
                value={editorContent()}
                spellcheck={false}
                onInput={event => setEditorContent(event.currentTarget.value)}
                onKeyDown={event => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void saveRemoteEditor();
                  }
                }}
              />
            }><div class="remote-editor-loading">正在读取远程文件…</div></Show>
            <footer>
              <span>{new TextEncoder().encode(editorContent()).length} 字节 · UTF-8 · Ctrl+S 保存</span>
              <button class="btn-cancel" onClick={() => void closeRemoteEditor()}>关闭</button>
              <button class="btn-save" disabled={editorSaving() || editorLoading() || editorContent() === editorOriginal()} onClick={saveRemoteEditor}>
                {editorSaving() ? "保存中…" : "保存"}
              </button>
            </footer>
          </div>
        </div>
      </Show>
    </div>
  );
};
