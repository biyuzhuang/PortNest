import { Component, createSignal, For, Show, onMount, onCleanup, createEffect, on } from "solid-js";
import { api, FileInfo, ConnectionRecord } from "../utils/api";
import "./FileManager.css";

interface FileManagerProps {
  connection: ConnectionRecord;
  sessionKey?: string;
  sftpId?: string;
  onSftpOpened?: (id: string) => void;
  onClose?: () => void;
}

export const FileManager: Component<FileManagerProps> = (props) => {
  const [currentPath, setCurrentPath] = createSignal("/");
  const [files, setFiles] = createSignal<FileInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<FileInfo | null>(null);
  const [showNewFolderDialog, setShowNewFolderDialog] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; file: FileInfo } | null>(null);
  const [initialized, setInitialized] = createSignal(false);

  const getSftpId = () => props.sftpId;

  const loadDirectory = async (path: string) => {
    const id = getSftpId();
    if (!id) return;

    setLoading(true);
    setError(null);
    try {
      const entries = await api.listSftpDir(id, path);
      setFiles(entries.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
      setCurrentPath(path);
      setSelectedFile(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  createEffect(on(() => props.sftpId, (sftpId) => {
    console.log("[FileManager] sftpId changed:", sftpId, "session:", props.sessionKey);
    if (sftpId && !initialized()) {
      setInitialized(true);
      loadDirectory("/");
    }
  }));

  onMount(() => {
    console.log("[FileManager] Mounted, session:", props.sessionKey, "sftpId:", props.sftpId);
    if (props.sftpId) {
      setInitialized(true);
      loadDirectory("/");
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
    return new Date(timestamp * 1000).toLocaleString();
  };

  return (
    <div class="file-manager">
      <div class="file-manager-header">
        <div class="path-bar">
          <button class="nav-btn" onClick={navigateUp} title="返回上级目录">↑</button>
          <button class="nav-btn" onClick={() => navigateTo("/")} title="回到根目录">🏠</button>
          <input
            type="text"
            class="path-input"
            value={currentPath()}
            onKeyDown={(e) => e.key === "Enter" && navigateTo(e.currentTarget.value)}
            onBlur={(e) => navigateTo(e.currentTarget.value)}
          />
        </div>
        <div class="toolbar">
          <button class="toolbar-btn" onClick={() => setShowNewFolderDialog(true)} title="新建文件夹">📁+</button>
          <button class="toolbar-btn" onClick={handleUpload} title="上传文件">⬆</button>
        </div>
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
            <div class="file-row header">
              <div class="file-cell name">名称</div>
              <div class="file-cell size">大小</div>
              <div class="file-cell date">修改时间</div>
            </div>
            <div class="file-body">
              <For each={files()}>
                {(file) => (
                  <div
                    class={`file-row ${selectedFile()?.path === file.path ? "selected" : ""}`}
                    onClick={() => handleFileClick(file)}
                    onDblClick={() => handleFileDoubleClick(file)}
                    onContextMenu={(e) => handleContextMenu(e, file)}
                  >
                    <div class="file-cell name">
                      <span class="file-icon">{file.is_dir ? "📁" : file.is_link ? "🔗" : "📄"}</span>
                      <span class="file-name">{file.name}</span>
                    </div>
                    <div class="file-cell size">{file.is_dir ? "-" : formatSize(file.size)}</div>
                    <div class="file-cell date">{formatDate(file.modified)}</div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

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