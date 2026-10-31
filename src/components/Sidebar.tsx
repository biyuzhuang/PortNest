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
import { ProtocolIcon } from "./ProtocolIcon";
import { Icon } from "./Icon";
import { AssetContextMenu, type AssetMenuAction, type AssetMenuHeaderAction } from "./AssetContextMenu";
import { api } from "../utils/api";

interface SidebarProps {
  width?: number;
  onConnect: (conn: ConnectionRecord) => void;
  onEdit: (conn: ConnectionRecord) => void;
  onDelete: (conn: ConnectionRecord) => void;
  onOpenSettings?: () => void;
  onOpenAI?: () => void;
  onOpenTransfer?: () => void;
  onNewConnection?: (folderId?: string, protocol?: string) => void;
  onNewFolder?: (parentId?: string) => void;
  onCopyConnection?: (conn: ConnectionRecord) => void;
  onOpenLocalTerminal?: () => void;
  onOpenTunnels?: (conn: ConnectionRecord) => void;
  selectedId?: string;
  aiOpen?: boolean;
  onCloseAI?: () => void;
}

export const Sidebar: Component<SidebarProps> = (props) => {
  const { state } = connectionStore;
  const [expandedFolders, setExpandedFolders] = createSignal<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);
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

  const newConnectionActions = (targetFolderId?: string | null): AssetMenuAction[] => [
    { label: "SSH 连接", icon: "terminal", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "ssh") },
    { label: "本地终端", icon: "terminal", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "local") },
    { label: "MySQL", icon: "database", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "mysql") },
    { label: "PostgreSQL", icon: "database", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "postgresql") },
    { label: "瀚高数据库", icon: "database", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "highgo") },
  ];

  const databaseConnectionActions = (targetFolderId?: string | null): AssetMenuAction[] => [
    { label: "MySQL", icon: "database", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "mysql") },
    { label: "PostgreSQL", icon: "database", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "postgresql") },
    { label: "瀚高数据库", icon: "database", onSelect: () => props.onNewConnection?.(targetFolderId ?? undefined, "highgo") },
  ];

  const moreActions = (): AssetMenuAction[] => [
    { label: "通过文本批量导入 SSH", icon: "terminal", disabled: true },
    { label: "ssh-copy-id", icon: "key", disabled: true },
    { label: "批量创建 Docker 连接", icon: "docker", disabled: true, separatorBefore: true },
    { label: "Ping", icon: "refresh", onSelect: () => void connectionStore.loadConnections() },
    { label: "导入", icon: "import", onSelect: () => props.onOpenTransfer?.(), separatorBefore: true },
    { label: "导出", icon: "export", onSelect: () => props.onOpenTransfer?.() },
  ];

  const copyConnectionInfo = (connection: ConnectionRecord) => {
    const text = connection.protocol === "local"
      ? `${connection.name}（本地终端）`
      : `${connection.username || ""}@${connection.host}:${connection.port}`;
    void navigator.clipboard.writeText(text);
  };

  const renameConnection = async (connection: ConnectionRecord) => {
    const name = await feedback.prompt("请输入新的连接名称", connection.name, "重命名连接");
    if (!name?.trim() || name.trim() === connection.name) return;
    try {
      const config = await api.getConnectionConfig(connection.id);
      await connectionStore.saveConnection({ ...config, name: name.trim() });
    } catch (error) {
      feedback.error("重命名连接失败：" + error);
    }
  };

  const connectionHeaderActions = (connection: ConnectionRecord): AssetMenuHeaderAction[] => [
    { label: "复制连接信息", icon: "copy", onSelect: () => copyConnectionInfo(connection) },
    { label: "剪切", icon: "scissors", disabled: true },
    { label: "创建副本", icon: "copyPlus", onSelect: () => props.onCopyConnection?.(connection) },
  ];

  const connectionMenuItems = (connection: ConnectionRecord): AssetMenuAction[] => [
    { label: "打开", icon: "play", onSelect: () => props.onConnect(connection) },
    { label: "刷新", icon: "refresh", onSelect: () => void connectionStore.loadConnections() },
    { label: "新标签页打开", icon: "plus", onSelect: () => props.onConnect(connection) },
    { label: "新窗口打开", icon: "copyPlus", disabled: true },
    { label: "同屏打开", icon: "view", disabled: true },
    { label: "新建目录", icon: "folder", separatorBefore: true, onSelect: () => props.onNewFolder?.(connection.folder_id ?? undefined) },
    { label: "新建连接", icon: "link", children: newConnectionActions(connection.folder_id) },
    { label: "新建数据库连接", icon: "database", children: databaseConnectionActions(connection.folder_id) },
    { label: "克隆", icon: "copyPlus", onSelect: () => props.onCopyConnection?.(connection) },
    { label: "编辑", icon: "edit", onSelect: () => props.onEdit(connection) },
    { label: "删除", icon: "trash", danger: true, onSelect: () => props.onDelete(connection) },
    { label: "重命名", icon: "edit", onSelect: () => void renameConnection(connection) },
    { label: "更多", icon: "chevronDown", children: moreActions() },
  ];

  const folderMenuItems = (): AssetMenuAction[] => {
    const folder = contextMenuFolder();
    return [
      { label: "新建目录", icon: "folder", onSelect: () => props.onNewFolder?.(folder?.id) },
      { label: "新建连接", icon: "link", children: newConnectionActions(folder?.id) },
      { label: "新建数据库连接", icon: "database", children: databaseConnectionActions(folder?.id) },
      { label: "删除", icon: "trash", danger: true, disabled: !folder, separatorBefore: true, onSelect: () => { if (!folder) return; void (async () => { if (await feedback.confirm("确定要删除此文件夹吗？", "删除文件夹")) await connectionStore.deleteFolder(folder.id); })(); } },
      { label: "重命名", icon: "edit", disabled: !folder, onSelect: () => { if (!folder) return; void (async () => { const nextName = await feedback.prompt("请输入新的文件夹名称", folder.name, "重命名文件夹"); if (nextName?.trim() && nextName.trim() !== folder.name) await connectionStore.renameFolder(folder.id, nextName.trim()); })(); } },
      { label: "复制", icon: "copy", disabled: true },
      { label: "剪切", icon: "scissors", disabled: true },
      { label: "粘贴", icon: "copyPlus", disabled: true },
      { label: "刷新", icon: "refresh", separatorBefore: true, onSelect: () => void connectionStore.loadConnections() },
      { label: "更多", icon: "chevronDown", children: moreActions() },
    ];
  };

  const handleSidebarContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowContextMenu(false);
    setContextMenuFolder(null);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowFolderMenu(true);
  };

  // 整个窗口任意位置点击都应能关闭这两个右键菜单（仅在点击落在菜单外部时关闭）。
  // 菜单自身的 onClick={e => e.stopPropagation()} 已能阻止菜单项点击冒泡；这里只兜底：
  // 若 mousedown 落在 .context-menu 之外，则关闭菜单。
  onMount(() => {
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".context-menu, .asset-context-menu")) return;
      setShowContextMenu(false);
      setShowFolderMenu(false);
    };
    document.addEventListener("mousedown", handleDocMouseDown);
    onCleanup(() => document.removeEventListener("mousedown", handleDocMouseDown));
  });

  return (
    <div class={`sidebar ${uiStore.assetTreeVisible() ? "" : "tree-collapsed"}`} style={`--asset-sidebar-width:${props.width || 286}px`} onClick={() => { setShowContextMenu(false); setShowFolderMenu(false); }}>
      <nav class="module-rail" aria-label="功能导航">
        <div class="module-rail-primary">
          <button
            class={`module-rail-btn ${!props.aiOpen && uiStore.assetTreeVisible() ? "active" : ""}`}
            title={props.aiOpen || !uiStore.assetTreeVisible() ? "显示资产树" : "收起资产树"}
            aria-pressed={uiStore.assetTreeVisible()}
            onClick={() => {
              if (props.aiOpen) {
                props.onCloseAI?.();
                uiStore.setAssetTreeVisible(true);
                return;
              }
              uiStore.toggleAssetTree();
            }}
          >
            <span><Icon name="assets" /></span><small>资产树</small>
          </button>

          <div class="module-rail-divider" role="separator" aria-orientation="horizontal" />

          <div class="module-rail-filters" role="group" aria-label="资产筛选">
            <button
              class={`module-rail-btn ${uiStore.assetFilter() === "all" ? "active" : ""}`}
              title="显示全部资产"
              aria-pressed={uiStore.assetFilter() === "all"}
              onClick={() => { props.onCloseAI?.(); selectAssetFilter("all"); }}
            >
              <span><Icon name="list" /></span><small>全部</small>
            </button>
            <button
              class={`module-rail-btn ${uiStore.assetFilter() === "terminal" ? "active" : ""}`}
              title="只看终端资产"
              aria-pressed={uiStore.assetFilter() === "terminal"}
              onClick={() => { props.onCloseAI?.(); selectAssetFilter("terminal"); }}
            >
              <span><Icon name="terminal" /></span><small>终端</small>
            </button>
            <button
              class={`module-rail-btn ${uiStore.assetFilter() === "database" ? "active" : ""}`}
              title="只看数据库资产"
              aria-pressed={uiStore.assetFilter() === "database"}
              onClick={() => { props.onCloseAI?.(); selectAssetFilter("database"); }}
            >
              <span><Icon name="database" /></span><small>数据库</small>
            </button>
          </div>
        </div>
        <div class="module-rail-bottom">
          <button class={`module-rail-btn ${props.aiOpen ? "active" : ""}`} title="PortNest AI（Ctrl+Shift+A）" aria-pressed={!!props.aiOpen} onClick={() => props.onOpenAI?.()}>
            <span><Icon name="sparkles" /></span><small>AI</small>
          </button>
          <button class="module-rail-btn" title="设置" onClick={() => { props.onCloseAI?.(); props.onOpenSettings?.(); }}>
            <span><Icon name="settings" /></span><small>设置</small>
          </button>
        </div>
      </nav>

      <div class="asset-sidebar">
      <div class="sidebar-header">
        <strong>资产列表</strong>
        <div class="sidebar-header-actions">
          <button title="搜索" onClick={() => { setSearchOpen(true); window.setTimeout(() => document.querySelector<HTMLInputElement>(".search-input")?.focus(), 0); }}><Icon name="search" /></button>
          <button title="新建连接" onClick={() => props.onNewConnection?.()}><Icon name="plus" /></button>
          <button title="新建文件夹" onClick={() => props.onNewFolder?.()}><Icon name="folder" /></button>
          <button title="打开默认本地终端" onClick={() => props.onOpenLocalTerminal?.()}><Icon name="terminal" /></button>
          <button title="刷新" onClick={() => void connectionStore.loadConnections()}><Icon name="refresh" /></button>
        </div>
      </div>

      <Show when={searchOpen()}>
        <div class="sidebar-search">
          <div class="search-wrapper">
            <span class="search-icon"><Icon name="search" /></span>
            <input
              type="text"
              placeholder="搜索连接..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={event => { if (event.key === "Escape") { setSearchQuery(""); setSearchOpen(false); } }}
              class="search-input field-flush"
            />
          </div>
        </div>
      </Show>

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
                      <Icon name={expandedFolders().has(folder.id) ? "folderOpen" : "folder"} size={15} />
                    </span>
                    <span class="folder-name">{folder.name}</span>
                    <span class="folder-count">
                      {folderConnectionCount(folder.id)}
                    </span>
                    <span class={`folder-toggle ${expandedFolders().has(folder.id) ? "expanded" : ""}`}>
                      <Icon name="chevronRight" size={14} />
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
        <AssetContextMenu
          x={contextMenuPos().x}
          y={contextMenuPos().y}
          headerActions={connectionHeaderActions(contextMenuConn()!)}
          items={connectionMenuItems(contextMenuConn()!)}
          onClose={() => setShowContextMenu(false)}
        />
      </Show>

      <Show when={showFolderMenu()}>
        <AssetContextMenu
          x={contextMenuPos().x}
          y={contextMenuPos().y}
          items={folderMenuItems()}
          onClose={() => setShowFolderMenu(false)}
        />
      </Show>

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

  const connectionSummary = props.conn.protocol === "local"
    ? props.conn.name
    : `${props.conn.username ? `${props.conn.username}@` : ""}${props.conn.host}:${props.conn.port}`;

  return (
    <div
      class={`connection-item ${props.selected ? "selected" : ""} ${props.builtin ? "builtin" : ""} ${props.dragging ? "dragging" : ""}`}
      classList={{ "has-color": Boolean(props.conn.color) }}
      style={props.conn.color ? { "--connection-color": props.conn.color } : undefined}
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
      <span class={`conn-icon protocol-${props.conn.protocol}`}>
        <ProtocolIcon kind={props.conn.protocol} />
      </span>
      <span class="conn-name" title={`${props.conn.name}\n${connectionSummary}`}>{props.conn.name}</span>
    </div>
  );
};
