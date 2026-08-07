import { Component, createSignal, For, Show, createMemo, onMount, onCleanup } from "solid-js";
import {
  connectionStore,
  ConnectionFolder,
  ConnectionRecord,
  countFolderConnections,
  sortAssetsByTreeOrder,
} from "../stores/connectionStore";
import { matchesAssetFilter, uiStore, type AssetFilter } from "../stores/uiStore";
import { feedback } from "../stores/feedbackStore";
import { localShellDisplayName, parseLocalProfile } from "../utils/api";

interface SidebarProps {
  width?: number;
  onConnect: (conn: ConnectionRecord) => void;
  onEdit: (conn: ConnectionRecord) => void;
  onDelete: (conn: ConnectionRecord) => void;
  onOpenSettings?: () => void;
  onNewConnection?: (folderId?: string) => void;
  onNewFolder?: (parentId?: string) => void;
  onCopyConnection?: (conn: ConnectionRecord) => void;
  onOpenLocalTerminal?: () => void;
  onOpenTunnels?: (conn: ConnectionRecord) => void;
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
  const [draggingConnectionId, setDraggingConnectionId] = createSignal<string | null>(null);
  const [draggingFolderId, setDraggingFolderId] = createSignal<string | null>(null);
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

  const handleDragStarted = (connectionId: string) => {
    setDraggingConnectionId(connectionId);
    setShowContextMenu(false);
    setShowFolderMenu(false);
  };

  const handleDragEnded = () => {
    setDraggingConnectionId(null);
    setDraggingFolderId(null);
    setDragOverFolderId(null);
    setDragOverRoot(false);
  };

  type DragAsset = { kind: "connection" | "folder"; id: string };

  const getDraggedAsset = (event: DragEvent): DragAsset | null => {
    const connectionId = event.dataTransfer?.getData("application/x-portnest-connection");
    if (connectionId) return { kind: "connection", id: connectionId };
    const folderId = event.dataTransfer?.getData("application/x-portnest-folder");
    if (folderId) return { kind: "folder", id: folderId };
    const fallback = event.dataTransfer?.getData("text/plain") || "";
    if (fallback.startsWith("folder:")) return { kind: "folder", id: fallback.slice(7) };
    if (fallback.startsWith("connection:")) return { kind: "connection", id: fallback.slice(11) };
    if (draggingFolderId()) return { kind: "folder", id: draggingFolderId()! };
    if (draggingConnectionId()) return { kind: "connection", id: draggingConnectionId()! };
    return null;
  };

  const sortedConnections = (folderId: string | null) =>
    sortAssetsByTreeOrder(
      state.connections.filter(connection => (connection.folder_id ?? null) === folderId)
    );

  const sortedFolders = (parentId: string | null) =>
    sortAssetsByTreeOrder(
      state.folders.filter(folder => folder.parentId === parentId)
    );

  const persistConnectionMove = (
    connectionId: string,
    folderId: string | null,
    targetId?: string,
    after = false,
  ) => {
    const dragged = state.connections.find(connection => connection.id === connectionId);
    if (!dragged) return;
    const siblings = sortedConnections(folderId).filter(connection => connection.id !== connectionId);
    let index = targetId ? siblings.findIndex(connection => connection.id === targetId) : siblings.length;
    if (index < 0) index = siblings.length;
    if (after && targetId) index += 1;
    siblings.splice(index, 0, { ...dragged, folder_id: folderId ?? undefined });
    const updates = new Map(siblings.map((connection, order) => [
      connection.id,
      { ...connection, folder_id: folderId ?? undefined, sort_order: order },
    ]));
    const next = state.connections.map(connection => updates.get(connection.id) ?? connection);
    void connectionStore.saveAssetOrder(next, [...state.folders]).catch(error =>
      console.error("[Sidebar] 保存会话排序失败:", error)
    );
  };

  const folderContains = (folderId: string, possibleChildId: string) => {
    let current = state.folders.find(folder => folder.id === possibleChildId);
    while (current) {
      if (current.parentId === folderId) return true;
      current = current.parentId
        ? state.folders.find(folder => folder.id === current!.parentId)
        : undefined;
    }
    return false;
  };

  const persistFolderMove = (
    folderId: string,
    parentId: string | null,
    targetId?: string,
    after = false,
  ) => {
    if (folderId === parentId || (parentId && folderContains(folderId, parentId))) return;
    const dragged = state.folders.find(folder => folder.id === folderId);
    if (!dragged) return;
    const siblings = sortedFolders(parentId).filter(folder => folder.id !== folderId);
    let index = targetId ? siblings.findIndex(folder => folder.id === targetId) : siblings.length;
    if (index < 0) index = siblings.length;
    if (after && targetId) index += 1;
    siblings.splice(index, 0, { ...dragged, parentId });
    const updates = new Map(siblings.map((folder, order) => [
      folder.id,
      { ...folder, parentId, sort_order: order },
    ]));
    const next = state.folders.map(folder => updates.get(folder.id) ?? folder);
    void connectionStore.saveAssetOrder([...state.connections], next).catch(error =>
      console.error("[Sidebar] 保存文件夹排序失败:", error)
    );
  };

  const handleFolderDragOver = (event: DragEvent, folderId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDragOverRoot(false);
    setDragOverFolderId(folderId);
  };

  const handleRootDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDragOverFolderId(null);
    setDragOverRoot(true);
  };

  const handleDrop = (event: DragEvent, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const asset = getDraggedAsset(event);
    handleDragEnded();
    if (!asset) return;
    if (asset.kind === "connection") {
      persistConnectionMove(asset.id, folderId);
    } else {
      persistFolderMove(asset.id, folderId);
    }
  };

  const handleFolderDrop = (event: DragEvent, folder: ConnectionFolder) => {
    event.preventDefault();
    event.stopPropagation();
    const asset = getDraggedAsset(event);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
    handleDragEnded();
    if (!asset) return;
    if (asset.kind === "connection") {
      persistConnectionMove(asset.id, folder.id);
      setExpandedFolders(previous => new Set(previous).add(folder.id));
      return;
    }
    if (ratio < 0.3) {
      persistFolderMove(asset.id, folder.parentId, folder.id, false);
    } else if (ratio > 0.7) {
      persistFolderMove(asset.id, folder.parentId, folder.id, true);
    } else {
      persistFolderMove(asset.id, folder.id);
      setExpandedFolders(previous => new Set(previous).add(folder.id));
    }
  };

  const handleConnectionDrop = (event: DragEvent, target: ConnectionRecord) => {
    event.preventDefault();
    event.stopPropagation();
    const asset = getDraggedAsset(event);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    handleDragEnded();
    if (!asset || asset.kind !== "connection" || asset.id === target.id) return;
    persistConnectionMove(asset.id, target.folder_id ?? null, target.id, after);
  };

  const handleDropZoneLeave = (event: DragEvent, folderId: string | null) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && (event.currentTarget as HTMLElement).contains(nextTarget)) return;
    if (folderId === null) {
      setDragOverRoot(false);
    } else if (dragOverFolderId() === folderId) {
      setDragOverFolderId(null);
    }
  };

  const filteredConnections = createMemo(() => {
    const query = searchQuery().toLowerCase();
    // 根目录区块只显示不在任何文件夹里的连接；已经在文件夹里的连接由
    // 对应 folder 的子列表渲染，否则同一条连接会同时出现在根目录和文件夹里，
    // 看上去像"移动后存在两份"。搜索时仍全表搜，便于按名字找到文件夹里的连接。
    if (!query) return sortedConnections(null).filter(c => matchesAssetFilter(c.protocol));
    return [...state.connections].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).filter(
      (c) => matchesAssetFilter(c.protocol) &&
        (c.name.toLowerCase().includes(query) || c.host.toLowerCase().includes(query))
    );
  });

  const visibleFolderNodes = createMemo(() => {
    const result: Array<{ folder: ConnectionFolder; depth: number }> = [];
    const appendChildren = (parentId: string | null, depth: number) => {
      for (const folder of sortedFolders(parentId)) {
        result.push({ folder, depth });
        if (expandedFolders().has(folder.id)) appendChildren(folder.id, depth + 1);
      }
    };
    appendChildren(null, 0);
    return result;
  });

  const displayedConnectionCount = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const validFolderIds = new Set(state.folders.map(folder => folder.id));
    return state.connections.filter(connection => {
      if (!matchesAssetFilter(connection.protocol)) return false;
      if (connection.folder_id && !validFolderIds.has(connection.folder_id)) return false;
      if (!query) return true;
      return connection.name.toLowerCase().includes(query)
        || connection.host.toLowerCase().includes(query);
    }).length;
  });

  const folderConnectionCount = (folderId: string) =>
    countFolderConnections(
      folderId,
      state.connections,
      state.folders,
      connection => matchesAssetFilter(connection.protocol),
    );

  const selectAssetFilter = (filter: AssetFilter) => {
    uiStore.setAssetFilter(filter);
    uiStore.setAssetTreeVisible(true);
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
    <div class={`sidebar ${uiStore.assetTreeVisible() ? "" : "tree-collapsed"}`} style={`--asset-sidebar-width:${props.width || 292}px`} onClick={() => { setShowContextMenu(false); setShowFolderMenu(false); }}>
      <nav class="module-rail" aria-label="功能导航">
        <button class="module-rail-brand" title="PortNest">P</button>
        <div class="module-rail-primary">
          <button
            class={`module-rail-btn ${uiStore.assetTreeVisible() ? "active" : ""}`}
            title={uiStore.assetTreeVisible() ? "隐藏资产树" : "显示资产树"}
            onClick={() => uiStore.toggleAssetTree()}
          >
            <span>▣</span><small>资产树</small>
          </button>
          <button class={`module-rail-btn ${uiStore.assetFilter() === "all" ? "active" : ""}`} title="显示全部" onClick={() => selectAssetFilter("all")}>
            <span>☷</span><small>全部</small>
          </button>
          <button class={`module-rail-btn ${uiStore.assetFilter() === "terminal" ? "active" : ""}`} title="只显示终端" onClick={() => selectAssetFilter("terminal")}>
            <span>›_</span><small>终端</small>
          </button>
        </div>
        <div class="module-rail-bottom">
          <button class="module-rail-btn" title="设置" onClick={() => props.onOpenSettings?.()}>
            <span>⚙</span><small>设置</small>
          </button>
        </div>
      </nav>

      <div class="asset-sidebar">
      <div class="sidebar-header">
        <strong>资产列表</strong>
        <div class="sidebar-header-actions">
          <button title="搜索" onClick={() => document.querySelector<HTMLInputElement>(".search-input")?.focus()}>⌕</button>
          <button title="新建连接" onClick={() => props.onNewConnection?.()}>＋</button>
          <button title="新建文件夹" onClick={() => props.onNewFolder?.()}>▰</button>
          <button title="刷新" onClick={() => void connectionStore.loadConnections()}>↻</button>
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
        <button class="action-btn" title="打开默认本地终端" onClick={() => props.onOpenLocalTerminal?.()}>
          <span>▣</span>
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
            <span class="conn-count">{displayedConnectionCount()}</span>
          </div>

          <Show when={!searchQuery() && state.folders.length > 0}>
            <For each={visibleFolderNodes()}>
              {(node) => {
                const folder = node.folder;
                return (
                <div class="folder-item">
                  <div
                    class={`folder-header ${dragOverFolderId() === folder.id ? "drag-over" : ""} ${uiStore.selectedAssetFolderId() === folder.id ? "selected" : ""}`}
                    draggable={true}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer?.setData("application/x-portnest-folder", folder.id);
                      event.dataTransfer?.setData("text/plain", `folder:${folder.id}`);
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                      setDraggingFolderId(folder.id);
                    }}
                    onDragEnd={handleDragEnded}
                    onClick={() => {
                      uiStore.setSelectedAssetFolderId(folder.id);
                      toggleFolder(folder.id);
                    }}
                    onContextMenu={(e) => handleFolderContextMenu(e, folder)}
                    onDragEnter={(event) => handleFolderDragOver(event, folder.id)}
                    onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                    onDragLeave={(event) => handleDropZoneLeave(event, folder.id)}
                    onDrop={(event) => handleFolderDrop(event, folder)}
                    style={{ "margin-left": `${node.depth * 13}px` }}
                  >
                    <span class="folder-icon">
                      {expandedFolders().has(folder.id) ? "📂" : "📁"}
                    </span>
                    <span class="folder-name">{folder.name}</span>
                    <span class="folder-count">
                      {folderConnectionCount(folder.id)}
                    </span>
                    <span class="folder-toggle">
                      {expandedFolders().has(folder.id) ? "▼" : "▶"}
                    </span>
                  </div>
                  <Show when={expandedFolders().has(folder.id)}>
                    <div
                      class={`folder-children ${dragOverFolderId() === folder.id ? "drag-over" : ""}`}
                      onDragEnter={(event) => handleFolderDragOver(event, folder.id)}
                      onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                      onDragLeave={(event) => handleDropZoneLeave(event, folder.id)}
                      onDrop={(event) => handleDrop(event, folder.id)}
                    >
                      <For each={sortedConnections(folder.id).filter(c => matchesAssetFilter(c.protocol))}>
                        {(conn) => (
                          <ConnectionItem
                            conn={conn}
                            selected={props.selectedId === conn.id}
                            onConnect={props.onConnect}
                            onContextMenu={handleContextMenu}
                            dragging={draggingConnectionId() === conn.id}
                            onDragStarted={handleDragStarted}
                            onDragEnded={handleDragEnded}
                            onDropAsset={handleConnectionDrop}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                );
              }}
            </For>
          </Show>

          <div
            class={`connection-list ${dragOverRoot() ? "drag-over" : ""}`}
            onDragEnter={handleRootDragOver}
            onDragOver={handleRootDragOver}
            onDragLeave={(event) => handleDropZoneLeave(event, null)}
            onDrop={(event) => handleDrop(event, null)}
          >
            <Show when={state.connections.find(connection => connection.id === draggingConnectionId())?.folder_id}>
              <div class="root-drop-hint">拖到这里移出文件夹</div>
            </Show>
            <For each={filteredConnections()}>
              {(conn) => (
                <ConnectionItem
                  conn={conn}
                  selected={props.selectedId === conn.id}
                  onConnect={props.onConnect}
                  onContextMenu={handleContextMenu}
                  dragging={draggingConnectionId() === conn.id}
                  onDragStarted={handleDragStarted}
                  onDragEnded={handleDragEnded}
                  onDropAsset={handleConnectionDrop}
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
          <Show when={contextMenuConn()?.protocol === "ssh"}>
            <div class="context-menu-item" onClick={() => { props.onOpenTunnels?.(contextMenuConn()!); setShowContextMenu(false); }}>
              SSH 隧道
            </div>
          </Show>
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
            <div class="context-menu-item" onClick={() => {
              props.onNewFolder?.(contextMenuFolder()!.id);
              setShowFolderMenu(false);
            }}>
              📂 新建子文件夹
            </div>
            <div class="context-menu-divider" />
            <div class="context-menu-item" onClick={() => { void (async () => {
              const folder = contextMenuFolder()!;
              const nextName = await feedback.prompt("请输入新的文件夹名称", folder.name, "重命名文件夹");
              if (nextName?.trim() && nextName.trim() !== folder.name) {
                await connectionStore.renameFolder(folder.id, nextName.trim());
              }
              setShowFolderMenu(false);
            })(); }}>
              ✎ 重命名文件夹
            </div>
            <div class="context-menu-item danger" onClick={() => { void (async () => {
              const folder = contextMenuFolder()!;
              if (await feedback.confirm(`确定要删除文件夹“${folder.name}”吗？`, "删除文件夹")) {
                await connectionStore.deleteFolder(folder.id);
              }
              setShowFolderMenu(false);
            })(); }}>
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
            <div class="context-menu-item" onClick={() => {
              props.onNewFolder?.();
              setShowFolderMenu(false);
            }}>
              📁 新建文件夹
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
    </div>
  );
};

interface ConnectionItemProps {
  conn: ConnectionRecord;
  selected: boolean;
  onConnect: (conn: ConnectionRecord) => void;
  onContextMenu: (e: MouseEvent, conn: ConnectionRecord) => void;
  dragging: boolean;
  onDragStarted: (connectionId: string) => void;
  onDragEnded: () => void;
  onDropAsset: (event: DragEvent, connection: ConnectionRecord) => void;
  builtin?: boolean;
}

const ConnectionItem: Component<ConnectionItemProps> = (props) => {
  const getProtocolIcon = (protocol: string) => {
    switch (protocol) {
      case "ssh": return "🖥";
      case "local": return "▣";
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
      case "local": return "#22d3ee";
      case "rdp": return "#60a5fa";
      case "sftp": return "#fbbf24";
      case "mysql": return "#f472b6";
      case "postgresql": return "#3b82f6";
      default: return "#9ca3af";
    }
  };

  const handleDragStart = (e: DragEvent) => {
    if (e.dataTransfer) {
      // 同时写 connectionId 和 text/plain 两种 MIME，
      // 避免部分浏览器/WKWebView 只接受 text/plain 导致 dropEffect 失效。
      // effectAllowed 设为 all 以兼容更多场景。
      e.dataTransfer.setData("application/x-portnest-connection", props.conn.id);
      e.dataTransfer.setData("text/plain", `connection:${props.conn.id}`);
      e.dataTransfer.effectAllowed = "all";
    }
    props.onDragStarted(props.conn.id);
  };

  const handleDragEnd = () => {
    props.onDragEnded();
  };

  return (
    <div
      class={`connection-item ${props.selected ? "selected" : ""} ${props.builtin ? "builtin" : ""} ${props.dragging ? "dragging" : ""}`}
      draggable={true}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => props.onDropAsset(event, props.conn)}
      onDblClick={() => props.onConnect(props.conn)}
      onContextMenu={(e) => props.onContextMenu(e, props.conn)}
    >
      <span class="conn-icon" style={{ color: getProtocolColor(props.conn.protocol) }}>
        {getProtocolIcon(props.conn.protocol)}
      </span>
      <div class="conn-details">
        <span class="conn-name">{props.conn.name}</span>
        <span class="conn-host">
          {props.conn.protocol === "local"
            ? `本机 · ${localShellDisplayName(parseLocalProfile(props.conn.options).shell_type)}`
            : `${props.conn.host}:${props.conn.port}`}
        </span>
      </div>
      <span class="protocol-badge" style={{ "background-color": getProtocolColor(props.conn.protocol) + "20", color: getProtocolColor(props.conn.protocol) }}>
        {props.conn.protocol.toUpperCase()}
      </span>
    </div>
  );
};
