import { Component, createSignal, For, Show, createMemo } from "solid-js";
import { connectionStore, ConnectionFolder, ConnectionRecord } from "../stores/connectionStore";

interface SidebarProps {
  onConnect: (conn: ConnectionRecord) => void;
  onOpenAI: (conn: ConnectionRecord) => void;
  onEdit: (conn: ConnectionRecord) => void;
  onDelete: (conn: ConnectionRecord) => void;
  onOpenFiles?: (conn: ConnectionRecord) => void;
  onOpenSettings?: () => void;
  onNewConnection?: () => void;
  onNewFolder?: () => void;
  onCopyConnection?: (conn: ConnectionRecord) => void;
  selectedId?: string;
}

export const Sidebar: Component<SidebarProps> = (props) => {
  const { state } = connectionStore;
  const [expandedFolders, setExpandedFolders] = createSignal<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = createSignal("");
  const [contextMenuConn, setContextMenuConn] = createSignal<ConnectionRecord | null>(null);
  const [showContextMenu, setShowContextMenu] = createSignal(false);
  const [dragOverFolderId, setDragOverFolderId] = createSignal<string | null>(null);
  const [contextMenuFolder, setContextMenuFolder] = createSignal<ConnectionFolder | null>(null);
  const [showFolderMenu, setShowFolderMenu] = createSignal(false);

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const filteredConnections = createMemo(() => {
    const query = searchQuery().toLowerCase();
    if (!query) return state.connections;
    return state.connections.filter(
      (c) => c.name.toLowerCase().includes(query) || c.host.toLowerCase().includes(query)
    );
  });

  const getProtocolIcon = (protocol: string) => {
    switch (protocol) {
      case "ssh": return "🖥";
      case "rdp": return "⊟";
      case "sftp": return "📂";
      case "mysql": return "🗄";
      case "postgresql": return "🐘";
      default: return "●";
    }
  };

  const getProtocolColor = (protocol: string) => {
    switch (protocol) {
      case "ssh": return "#4ade80";
      case "rdp": return "#60a5fa";
      case "sftp": return "#fbbf24";
      case "mysql": return "#f472b6";
      case "postgresql": return "#3b82f6";
      default: return "#9ca3af";
    }
  };

  const handleContextMenu = (e: MouseEvent, conn: ConnectionRecord) => {
    e.preventDefault();
    setContextMenuConn(conn);
    setShowContextMenu(true);
  };

  const handleFolderContextMenu = (e: MouseEvent, folder: ConnectionFolder) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuFolder(folder);
    setShowFolderMenu(true);
  };

  const handleSidebarContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuFolder(null);
    setShowFolderMenu(true);
  };

  return (
    <div class="sidebar" onClick={() => { setShowContextMenu(false); setShowFolderMenu(false); }}>
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span class="logo-icon">⚡</span>
          <span class="logo-text">PortNest</span>
        </div>
      </div>

      <div class="sidebar-search">
        <div class="search-wrapper">
          <span class="search-icon">🔍</span>
          <input
            type="text"
            placeholder="搜索连接..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            class="search-input"
          />
        </div>
      </div>

      <div class="sidebar-actions">
        <button class="action-btn" title="新建连接" onClick={() => props.onNewConnection?.()}>
          <span>+</span>
        </button>
        <button class="action-btn" title="新建文件夹" onClick={() => props.onNewFolder?.()}>
          <span>📁</span>
        </button>
        <button class="action-btn" title="设置" onClick={() => props.onOpenSettings?.()}>
          <span>⚙️</span>
        </button>
      </div>

      <div class="sidebar-nav" onContextMenu={handleSidebarContextMenu}>
        <div class="nav-section">
          <div class="nav-section-title">
            <span>连接列表</span>
            <span class="conn-count">{state.connections.length}</span>
          </div>

          <Show when={!searchQuery() && state.folders.length > 0}>
            <For each={state.folders}>
              {(folder) => (
                <div class="folder-item">
                  <div
                    class={`folder-header ${dragOverFolderId() === folder.id ? "drag-over" : ""}`}
                    onClick={() => toggleFolder(folder.id)}
                    onContextMenu={(e) => handleFolderContextMenu(e, folder)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverFolderId(folder.id);
                    }}
                    onDragLeave={() => setDragOverFolderId(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const connId = e.dataTransfer?.getData("connectionId");
                      if (connId) {
                        connectionStore.moveConnectionToFolder(connId, folder.id);
                        setDragOverFolderId(null);
                      }
                    }}
                  >
                    <span class="folder-icon">
                      {expandedFolders().has(folder.id) ? "📂" : "📁"}
                    </span>
                    <span class="folder-name">{folder.name}</span>
                    <span class="folder-toggle">
                      {expandedFolders().has(folder.id) ? "▼" : "▶"}
                    </span>
                  </div>
                  <Show when={expandedFolders().has(folder.id)}>
                    <div class="folder-children">
                      <For each={state.connections.filter(c => c.folder_id === folder.id)}>
                        {(conn) => (
                          <ConnectionItem
                            conn={conn}
                            selected={props.selectedId === conn.id}
                            onConnect={props.onConnect}
                            onContextMenu={handleContextMenu}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <div class="connection-list">
            <For each={filteredConnections()}>
              {(conn) => (
                <ConnectionItem
                  conn={conn}
                  selected={props.selectedId === conn.id}
                  onConnect={props.onConnect}
                  onContextMenu={handleContextMenu}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      <Show when={showContextMenu() && contextMenuConn()}>
        <div
          class="context-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="context-menu-item" onClick={() => { props.onConnect(contextMenuConn()!); setShowContextMenu(false); }}>
            连接
          </div>
          <Show when={contextMenuConn()?.protocol === "ssh"}>
            <div class="context-menu-item" onClick={() => { props.onOpenFiles?.(contextMenuConn()!); setShowContextMenu(false); }}>
              📂 文件管理
            </div>
          </Show>
          <div class="context-menu-item" onClick={() => { props.onOpenAI(contextMenuConn()!); setShowContextMenu(false); }}>
            AI 诊断
          </div>
          <div class="context-menu-divider" />
          <div class="context-menu-item" onClick={() => { props.onEdit(contextMenuConn()!); setShowContextMenu(false); }}>
            编辑
          </div>
          <div class="context-menu-item" onClick={() => { props.onCopyConnection?.(contextMenuConn()!); setShowContextMenu(false); }}>
            复制
          </div>
          <div class="context-menu-item danger" onClick={() => { props.onDelete(contextMenuConn()!); setShowContextMenu(false); }}>
            删除
          </div>
        </div>
      </Show>

      <Show when={showFolderMenu()}>
        <div
          class="context-menu"
          style={{ left: "150px", top: "200px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <Show when={contextMenuFolder()}>
            <div class="context-menu-item" onClick={() => {
              props.onNewConnection?.(contextMenuFolder()!.id);
              setShowFolderMenu(false);
            }}>
              📁 在此文件夹中新建连接
            </div>
            <div class="context-menu-divider" />
            <div class="context-menu-item danger" onClick={() => {
              if (confirm(`确定要删除文件夹 "${contextMenuFolder()!.name}" 吗？`)) {
                connectionStore.deleteFolder(contextMenuFolder()!.id);
              }
              setShowFolderMenu(false);
            }}>
              删除文件夹
            </div>
          </Show>
          <Show when={!contextMenuFolder()}>
            <div class="context-menu-item" onClick={() => {
              props.onNewConnection?.();
              setShowFolderMenu(false);
            }}>
              ➕ 新建连接
            </div>
          </Show>
        </div>
      </Show>

      <div class="sidebar-footer">
        <div class="status-bar">
          <span class="status-item">
            <span class="status-dot online" />
            就绪
          </span>
        </div>
      </div>
    </div>
  );
};

interface ConnectionItemProps {
  conn: ConnectionRecord;
  selected: boolean;
  onConnect: (conn: ConnectionRecord) => void;
  onContextMenu: (e: MouseEvent, conn: ConnectionRecord) => void;
  builtin?: boolean;
}

const ConnectionItem: Component<ConnectionItemProps> = (props) => {
  const getProtocolIcon = (protocol: string) => {
    switch (protocol) {
      case "ssh": return "🖥";
      case "rdp": return "⊟";
      case "sftp": return "📂";
      case "mysql": return "🗄";
      case "postgresql": return "🐘";
      default: return "●";
    }
  };

  const getProtocolColor = (protocol: string) => {
    switch (protocol) {
      case "ssh": return "#4ade80";
      case "rdp": return "#60a5fa";
      case "sftp": return "#fbbf24";
      case "mysql": return "#f472b6";
      case "postgresql": return "#3b82f6";
      default: return "#9ca3af";
    }
  };

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData("connectionId", props.conn.id);
  };

  return (
    <div
      class={`connection-item ${props.selected ? "selected" : ""} ${props.builtin ? "builtin" : ""}`}
      draggable={true}
      onDblClick={() => props.onConnect(props.conn)}
      onContextMenu={(e) => props.onContextMenu(e, props.conn)}
    >
      <span class="conn-icon" style={{ color: getProtocolColor(props.conn.protocol) }}>
        {getProtocolIcon(props.conn.protocol)}
      </span>
      <div class="conn-details">
        <span class="conn-name">{props.conn.name}</span>
        <span class="conn-host">{props.conn.host}:{props.conn.port}</span>
      </div>
      <span class="protocol-badge" style={{ "background-color": getProtocolColor(props.conn.protocol) + "20", color: getProtocolColor(props.conn.protocol) }}>
        {props.conn.protocol.toUpperCase()}
      </span>
    </div>
  );
};