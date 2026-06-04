import { Component, createSignal, For, Show, createMemo, onMount, onCleanup } from "solid-js";
import { connectionStore, ConnectionFolder, ConnectionRecord } from "../stores/connectionStore";

interface SidebarProps {
  onConnect: (conn: ConnectionRecord) => void;
  onOpenAI: (conn: ConnectionRecord) => void;
  onEdit: (conn: ConnectionRecord) => void;
  onDelete: (conn: ConnectionRecord) => void;
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
const [dragOverRoot, setDragOverRoot] = createSignal(false);
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

  const [contextMenuPos, setContextMenuPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleContextMenu = (e: MouseEvent, conn: ConnectionRecord) => {
    e.preventDefault();
    e.stopPropagation();
    // 关闭 folder/背景 的右键菜单，避免与连接菜单同时出现（"新建连接"等不应该在会话上出现）
    setShowFolderMenu(false);
    setContextMenuConn(conn);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  const handleFolderContextMenu = (e: MouseEvent, folder: ConnectionFolder) => {
    e.preventDefault();
    e.stopPropagation();
    setShowContextMenu(false);
    setContextMenuFolder(folder);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowFolderMenu(true);
  };

  const handleSidebarContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowContextMenu(false);
    setContextMenuFolder(null);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowFolderMenu(true);
  };

  // 命令式地把一个 fixed 定位的菜单调整到不超出视口。
  // 溢出时把菜单的【左下角】贴近鼠标位置（contextMenuPos），
  // 让菜单向【右上】展开——鼠标正好压在菜单最底部那一项（"移动此会话"），
  // 用户不用移动鼠标就能看到所有菜单项。如果贴近鼠标后仍会超出顶/右边缘，
  // 再做最后夹取。
  const clampMenuToViewport = (el: HTMLElement, margin = 4) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const winH = window.innerHeight;
    const winW = window.innerWidth;
    const overflowsBottom = rect.bottom > winH;
    const overflowsRight = rect.right > winW;
    if (!overflowsBottom && !overflowsRight) return;

    // 菜单的左下角贴近鼠标位置。
    const pos = contextMenuPos();
    // menuLeft = mouseX
    // menuTop  = mouseY - menuHeight  (即 menuBottom = mouseY)
    let newLeft = pos.x;
    let newTop = pos.y - rect.height;

    // 防止菜单超出上边缘：菜单高度 > mouseY 时上提。
    if (newTop < margin) {
      newTop = margin;
    }
    // 防止菜单超出右边缘：菜单向右延伸到 mouseX + menuWidth，
    // 如果超出视口右边，把 left 夹到合适位置。
    if (newLeft + rect.width > winW - margin) {
      newLeft = Math.max(margin, winW - rect.width - margin);
    }
    // 防止菜单超出左边缘（兜底）。
    if (newLeft < margin) {
      newLeft = margin;
    }

    el.style.left = newLeft + "px";
    el.style.top = newTop + "px";
    el.style.right = "auto";
  };

  // 共用的右键菜单挂载回调：
  // 1. 立即把 element 定位到 cursor 位置（覆盖响应式 style 绑定），并先隐藏避免闪屏；
  // 2. 用 requestAnimationFrame 等到下一帧布局稳定后，调用 clampMenuToViewport 调整位置；
  // 3. 调整完成后显示菜单。
  const attachContextMenuRef = (el: HTMLElement) => {
    if (!el) return;
    const pos = contextMenuPos();
    el.style.position = "fixed";
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
    el.style.visibility = "hidden";
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      clampMenuToViewport(el);
      el.style.visibility = "visible";
    });
  };

  // 整个窗口任意位置点击都应能关闭这两个右键菜单（仅在点击落在菜单外部时关闭）。
  // 菜单自身的 onClick={e => e.stopPropagation()} 已能阻止菜单项点击冒泡；这里只兜底：
  // 若 mousedown 落在 .context-menu 之外，则关闭菜单。
  onMount(() => {
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".context-menu")) return;
      setShowContextMenu(false);
      setShowFolderMenu(false);
    };
    document.addEventListener("mousedown", handleDocMouseDown);
    onCleanup(() => document.removeEventListener("mousedown", handleDocMouseDown));
  });

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
                      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                      setDragOverFolderId(folder.id);
                    }}
                    onDragLeave={() => setDragOverFolderId(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const connId = e.dataTransfer?.getData("connectionId");
                      if (connId) {
                        connectionStore.moveConnectionToFolder(connId, folder.id);
                      }
                      setDragOverFolderId(null);
                      setDragOverRoot(false);
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
                    <div
                      class="folder-children"
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                        setDragOverFolderId(folder.id);
                      }}
                      onDragLeave={(e) => {
                        // 只有真正离开整个 folder 才清空（鼠标移到 folder-children 内
                        // 的子连接上时不该清）。用 relatedTarget 判断是否还在 folder 范围内。
                        const folderEl = e.currentTarget.closest(".folder-item");
                        if (folderEl && !folderEl.contains(e.relatedTarget as Node | null)) {
                          setDragOverFolderId(null);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const connId = e.dataTransfer?.getData("connectionId");
                        if (connId) {
                          connectionStore.moveConnectionToFolder(connId, folder.id);
                        }
                        setDragOverFolderId(null);
                        setDragOverRoot(false);
                      }}
                    >
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

          <div
            class={`connection-list ${dragOverRoot() ? "drag-over" : ""}`}
            onDragOver={(e) => {
              // 始终接收 drop；用 data 校验在 onDrop 里做。
              // 之前用 types.includes() 做条件判定在 DOMStringList 环境下会失效，导致
              // 光标变 "红圈带斜杠"。
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              if (!dragOverRoot()) setDragOverRoot(true);
            }}
            onDragLeave={() => setDragOverRoot(false)}
            onDrop={(e) => {
              e.preventDefault();
              const connId = e.dataTransfer?.getData("connectionId");
              if (connId) {
                connectionStore.moveConnectionToFolder(connId, null);
              }
              setDragOverRoot(false);
            }}
          >
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
          ref={attachContextMenuRef}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="context-menu-item" onClick={() => { props.onConnect(contextMenuConn()!); setShowContextMenu(false); }}>
            连接
          </div>
          <div class="context-menu-item" onClick={() => { props.onOpenAI(contextMenuConn()!); setShowContextMenu(false); }}>
            AI 诊断
          </div>
          <div class="context-menu-item has-submenu">
            <span>移动此会话</span>
            <span class="submenu-arrow">›</span>
            <div
              class="context-submenu"
              ref={(el) => {
                if (!el) return;
                // 子菜单初始是 display: none，ref 首次执行时尺寸是 0。
                // 用 ResizeObserver 在子菜单变为可见（hover）时重新计算位置，
                // 避免子菜单溢出屏幕。observer 在元素卸载时会被 GC。
                const clampSubmenu = () => {
                  const rect = el.getBoundingClientRect();
                  if (rect.width === 0 || rect.height === 0) return;
                  const winH = window.innerHeight;
                  const winW = window.innerWidth;
                  const parent = el.parentElement as HTMLElement | null;
                  // 默认右侧展开；如果右侧溢出，翻转到父项的左侧。
                  if (rect.right > winW) {
                    el.style.left = "auto";
                    el.style.right = "100%";
                  }
                  // 底部溢出：在父项范围内向上夹取。
                  if (rect.bottom > winH && parent) {
                    const parentRect = parent.getBoundingClientRect();
                    const overflow = rect.bottom - winH;
                    const newTop = -4 - overflow;
                    el.style.top = Math.min(-4, Math.max(-(rect.height - parentRect.height), newTop)) + "px";
                  }
                  if (rect.top < 0) {
                    el.style.top = "-4px";
                  }
                };
                clampSubmenu();
                const observer = new ResizeObserver(() => clampSubmenu());
                observer.observe(el);
              }}
            >
              <div
                class={`context-menu-item ${!contextMenuConn()!.folder_id ? "is-current" : ""}`}
                onClick={() => {
                  connectionStore.moveConnectionToFolder(contextMenuConn()!.id, null);
                  setShowContextMenu(false);
                }}
              >
                根目录
              </div>
              <Show when={state.folders.length > 0}>
                <div class="context-menu-divider" />
              </Show>
              <For each={state.folders}>
                {(folder) => (
                  <div
                    class={`context-menu-item ${contextMenuConn()!.folder_id === folder.id ? "is-current" : ""}`}
                    onClick={() => {
                      connectionStore.moveConnectionToFolder(contextMenuConn()!.id, folder.id);
                      setShowContextMenu(false);
                    }}
                  >
                    {folder.name}
                  </div>
                )}
              </For>
              <Show when={state.folders.length === 0}>
                <div class="context-menu-item disabled">（暂无文件夹可移入）</div>
              </Show>
            </div>
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
          ref={attachContextMenuRef}
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
    if (e.dataTransfer) {
      e.dataTransfer.setData("connectionId", props.conn.id);
      e.dataTransfer.effectAllowed = "move";
    }
  };

  const handleDragEnd = (_e: DragEvent) => {
    // 拖拽结束：通知父组件清理 drag-over 高亮。
    // 这里只做局部兜底（父组件的 onDragLeave/onDrop 也会清）。
  };

  return (
    <div
      class={`connection-item ${props.selected ? "selected" : ""} ${props.builtin ? "builtin" : ""}`}
      attr:draggable="true"
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
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