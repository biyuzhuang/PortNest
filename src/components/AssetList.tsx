import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import {
  connectionStore,
  countFolderConnections,
  sortAssetsByTreeOrder,
} from "../stores/connectionStore";
import { api, isDatabaseProtocol, type ConnectionRecord } from "../utils/api";
import { matchesAssetFilter, uiStore } from "../stores/uiStore";
import { feedback } from "../stores/feedbackStore";
import { ProtocolIcon } from "./ProtocolIcon";
import { Icon } from "./Icon";
import { AssetContextMenu, type AssetMenuAction, type AssetMenuHeaderAction } from "./AssetContextMenu";

interface AssetListProps {
  onConnect: (connection: ConnectionRecord) => void;
  onEdit: (connection: ConnectionRecord) => void;
  onCopy: (connection: ConnectionRecord) => void;
  onDelete: (connection: ConnectionRecord) => void;
  onDeleteMany: (connections: ConnectionRecord[]) => void;
  onNewConnection: (folderId?: string, protocol?: string) => void;
  onNewFolder: () => void;
  onOpenTransfer?: () => void;
}

const PING_VISIBILITY_KEY = "portnest-asset-ping-visible";

const getStoredPingVisibility = () => {
  try {
    return localStorage.getItem(PING_VISIBILITY_KEY) !== "false";
  } catch {
    return true;
  }
};

export const AssetList: Component<AssetListProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const folderId = uiStore.selectedAssetFolderId;
  const setFolderId = uiStore.setSelectedAssetFolderId;
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = createSignal<string | null>(null);
  const [showPing, setShowPing] = createSignal(getStoredPingVisibility());
  const [pingStates, setPingStates] = createSignal<Record<string, {
    status: "testing" | "online" | "offline";
    latency?: number;
  }>>({});
  const testedConnections = new Set<string>();
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [connectionMenu, setConnectionMenu] = createSignal<{
    x: number;
    y: number;
    connection: ConnectionRecord;
  } | null>(null);

  const currentFolder = createMemo(() =>
    connectionStore.state.folders.find(folder => folder.id === folderId())
  );

  const visibleFolders = createMemo(() => {
    if (query().trim()) return [];
    return sortAssetsByTreeOrder(
      connectionStore.state.folders.filter(folder => folder.parentId === folderId())
    );
  });

  const visibleConnections = createMemo(() => {
    const normalized = query().trim().toLowerCase();
    return sortAssetsByTreeOrder(connectionStore.state.connections.filter(connection => {
      if (!matchesAssetFilter(connection.protocol)) return false;
      if (normalized) {
        return connection.name.toLowerCase().includes(normalized)
          || connection.host.toLowerCase().includes(normalized)
          || (connection.username ?? "").toLowerCase().includes(normalized);
      }
      return (connection.folder_id ?? null) === folderId();
    }));
  });

  const folderConnectionCount = (targetFolderId: string) =>
    countFolderConnections(
      targetFolderId,
      connectionStore.state.connections,
      connectionStore.state.folders,
      connection => matchesAssetFilter(connection.protocol),
    );

  const filterTitle = createMemo(() => ({
    all: "资产列表",
    terminal: "终端资产",
    database: "数据库资产",
  })[uiStore.assetFilter()]);

  createEffect(() => {
    uiStore.assetFilter();
    folderId();
    setSelectedIds(new Set<string>());
    setSelectionAnchorId(null);
  });

  const selectedConnections = createMemo(() => {
    const ids = selectedIds();
    return visibleConnections().filter(connection => ids.has(connection.id));
  });

  const selectConnection = (event: MouseEvent, connection: ConnectionRecord) => {
    const connections = visibleConnections();
    const id = connection.id;
    if (event.shiftKey && selectionAnchorId()) {
      const anchorIndex = connections.findIndex(item => item.id === selectionAnchorId());
      const currentIndex = connections.findIndex(item => item.id === id);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const next = event.ctrlKey || event.metaKey ? new Set(selectedIds()) : new Set<string>();
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        for (let index = start; index <= end; index += 1) next.add(connections[index].id);
        setSelectedIds(next);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedIds());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
    } else {
      setSelectedIds(new Set([id]));
    }
    setSelectionAnchorId(id);
  };

  const testConnectionLatency = async (connection: ConnectionRecord, force = false) => {
    if (connection.protocol === "local") return;
    if (!force && testedConnections.has(connection.id)) return;
    testedConnections.add(connection.id);
    setPingStates(previous => ({
      ...previous,
      [connection.id]: { status: "testing" },
    }));
    try {
      const result = await api.pingHost(connection.host, connection.port);
      setPingStates(previous => ({
        ...previous,
        [connection.id]: result.reachable
          ? { status: "online", latency: result.latency_ms ?? 0 }
          : { status: "offline" },
      }));
    } catch {
      setPingStates(previous => ({
        ...previous,
        [connection.id]: { status: "offline" },
      }));
    }
  };

  const refreshVisibleLatencies = () => {
    for (const connection of visibleConnections()) {
      void testConnectionLatency(connection, true);
    }
  };

  const togglePingVisibility = () => {
    const next = !showPing();
    setShowPing(next);
    try {
      localStorage.setItem(PING_VISIBILITY_KEY, String(next));
    } catch {
      // WebView 隐私模式下存储可能不可用，保持当前会话状态即可。
    }
  };

  createEffect(() => {
    for (const connection of visibleConnections()) {
      void testConnectionLatency(connection);
    }
  });

  const renderLatency = (connection: ConnectionRecord) => {
    if (connection.protocol === "local") {
      return <span class="asset-muted">本机</span>;
    }
    if (!showPing()) return <span class="asset-muted">已隐藏</span>;
    const state = pingStates()[connection.id];
    if (!state || state.status === "testing") {
      return <span class="asset-latency testing">测试中…</span>;
    }
    if (state.status === "offline") {
      return <span class="asset-latency offline">Timeout</span>;
    }
    return <span class="asset-latency online">{state.latency}ms</span>;
  };

  const protocolSkin = (protocol: string) =>
    protocol === "local" ? "local" : isDatabaseProtocol(protocol) ? "database" : "terminal";

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return "—";
    return new Date(timestamp * 1000).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/\//g, "-");
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

  const newConnectionActions = (): AssetMenuAction[] => [
    { label: "SSH 连接", icon: "terminal", onSelect: () => props.onNewConnection(folderId() ?? undefined, "ssh") },
    { label: "本地终端", icon: "terminal", onSelect: () => props.onNewConnection(folderId() ?? undefined, "local") },
    { label: "MySQL", icon: "database", onSelect: () => props.onNewConnection(folderId() ?? undefined, "mysql") },
    { label: "PostgreSQL", icon: "database", onSelect: () => props.onNewConnection(folderId() ?? undefined, "postgresql") },
    { label: "瀚高数据库", icon: "database", onSelect: () => props.onNewConnection(folderId() ?? undefined, "highgo") },
  ];

  const databaseConnectionActions = (): AssetMenuAction[] => [
    { label: "MySQL", icon: "database", onSelect: () => props.onNewConnection(folderId() ?? undefined, "mysql") },
    { label: "PostgreSQL", icon: "database", onSelect: () => props.onNewConnection(folderId() ?? undefined, "postgresql") },
    { label: "瀚高数据库", icon: "database", onSelect: () => props.onNewConnection(folderId() ?? undefined, "highgo") },
  ];

  const moreActions = (): AssetMenuAction[] => [
    { label: "通过文本批量导入 SSH", icon: "terminal", disabled: true },
    { label: "ssh-copy-id", icon: "key", disabled: true },
    { label: "批量创建 Docker 连接", icon: "docker", disabled: true, separatorBefore: true },
    { label: "Ping", icon: "refresh", onSelect: refreshVisibleLatencies },
    { label: "导入", icon: "import", onSelect: () => props.onOpenTransfer?.(), separatorBefore: true },
    { label: "导出", icon: "export", onSelect: () => props.onOpenTransfer?.() },
  ];

  const copyConnectionText = (connection: ConnectionRecord) => {
    const text = connection.protocol === "local"
      ? `${connection.name}（本地终端）`
      : `${connection.username || ""}@${connection.host}:${connection.port}`;
    void navigator.clipboard.writeText(text);
  };

  const connectionHeaderActions = (connection: ConnectionRecord): AssetMenuHeaderAction[] => [
    { label: "复制连接信息", icon: "copy", onSelect: () => copyConnectionText(connection) },
    { label: "剪切", icon: "scissors", disabled: true },
    { label: "创建副本", icon: "copyPlus", onSelect: () => props.onCopy(connection) },
  ];

  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    setConnectionMenu(null);
    const width = 190;
    const height = 152;
    setContextMenu({
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6)),
    });
  };

  const openConnectionMenu = (event: MouseEvent, connection: ConnectionRecord) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 286;
    const height = 430;
    if (!selectedIds().has(connection.id)) {
      setSelectedIds(new Set([connection.id]));
      setSelectionAnchorId(connection.id);
    }
    setContextMenu(null);
    setConnectionMenu({
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6)),
      connection,
    });
  };

  const openMoreMenu = (event: MouseEvent) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setConnectionMenu(null);
    setContextMenu(null);
    setMoreMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const refreshAssets = () => {
    void connectionStore.loadConnections();
    refreshVisibleLatencies();
  };

  const closeMenus = () => {
    setContextMenu(null);
    setConnectionMenu(null);
    setMoreMenu(null);
  };

  const clearSelectionFromBlankArea = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    setSelectedIds(new Set<string>());
    setSelectionAnchorId(null);
  };

  return (
    <section class="asset-workspace" onContextMenu={openContextMenu} onClick={closeMenus}>
      <div class="asset-toolbar">
        <div class="asset-toolbar-title">
          <span class="asset-list-icon"><Icon name="list" size={16} /></span>
          <Show when={currentFolder()} fallback={<span class="asset-toolbar-heading">{filterTitle()}</span>}>
            <button class="asset-breadcrumb" onClick={() => setFolderId(null)}>资产列表</button>
            <span class="asset-breadcrumb-separator">/</span>
            <span class="asset-toolbar-heading">{currentFolder()?.name}</span>
          </Show>
        </div>
        <span class="asset-toolbar-meta">{visibleFolders().length} 个文件夹 · {visibleConnections().length} 个连接</span>
        <div class="asset-selection" classList={{ "is-empty": selectedConnections().length === 0 }}>已选择 <strong>{selectedConnections().length}</strong> 个连接</div>
        <div class="asset-toolbar-actions">
          <label class="asset-search">
            <Icon name="search" size={15} />
            <input
              class="field-flush"
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
              placeholder="名称, IP, User (Ctrl+F)"
            />
          </label>
          <button class="asset-icon-button" title="回到资产列表根目录" aria-label="回到资产列表根目录" onClick={() => { setFolderId(null); setQuery(""); }}>
            <Icon name="home" size={16} />
          </button>
          <button class="asset-icon-button" title="刷新连接列表" aria-label="刷新连接列表" onClick={refreshAssets}>
            <Icon name="refresh" size={16} />
          </button>
          <button class="asset-icon-button asset-ping-toggle" title="测试当前列表延迟" aria-label="测试当前列表延迟" onClick={refreshVisibleLatencies}>
            <span class="asset-ping-icon"><i /></span>
          </button>
          <button class="asset-icon-button asset-primary" title="新建连接" aria-label="新建连接" onClick={() => props.onNewConnection(folderId() ?? undefined)}>
            <Icon name="plus" size={16} />
          </button>
          <button class="asset-icon-button asset-folder-add" title="新建文件夹" aria-label="新建文件夹" onClick={props.onNewFolder}>
            <Icon name="folder" size={16} />
            <i>+</i>
          </button>
          <button
            class={`asset-icon-button ${showPing() ? "active" : ""}`}
            title={showPing() ? "隐藏 Ping 延迟" : "显示 Ping 延迟"}
            aria-label={showPing() ? "隐藏 Ping 延迟" : "显示 Ping 延迟"}
            onClick={togglePingVisibility}
          >
            <Icon name={showPing() ? "eye" : "eyeOff"} size={16} />
          </button>
          <button class="asset-icon-button" title="更多操作" aria-label="更多操作" onClick={openMoreMenu}>
            <Icon name="chevronDown" size={16} />
          </button>
        </div>
      </div>

      <div class="asset-table" onClick={clearSelectionFromBlankArea}>
        <div class="asset-row asset-table-head">
          <div>名称 <span class="asset-sort-indicator"><Icon name="chevronUp" size={11} /></span></div>
          <div>延迟</div>
          <div>Host</div>
          <div>User</div>
          <div>创建时间</div>
          <div>最近连接</div>
        </div>

        <For each={visibleFolders()}>
          {(folder) => (
            <div
              class="asset-row asset-folder-row"
              onDblClick={() => {
                setFolderId(folder.id);
                setSelectedIds(new Set<string>());
                setSelectionAnchorId(null);
              }}
            >
              <div class="asset-name-cell"><span class="asset-folder-icon"><Icon name="folder" size={15} /></span>{folder.name}</div>
              <div>—</div><div>—</div><div>—</div><div>—</div>
              <div>
                {folderConnectionCount(folder.id)} 个连接
              </div>
            </div>
          )}
        </For>

        <For each={visibleConnections()}>
          {(connection) => (
            <div
              class={`asset-row asset-connection-row ${selectedIds().has(connection.id) ? "selected" : ""}`}
              classList={{ "has-color": Boolean(connection.color) }}
              style={connection.color ? { "--connection-color": connection.color } : undefined}
              onClick={(event) => selectConnection(event, connection)}
              onDblClick={() => props.onConnect(connection)}
              onContextMenu={(event) => openConnectionMenu(event, connection)}
            >
              <div class="asset-name-cell"><span class={`asset-terminal-icon protocol-${protocolSkin(connection.protocol)}`}><ProtocolIcon kind={isDatabaseProtocol(connection.protocol) ? "database" : "terminal"} /></span>{connection.name}</div>
              <div>{renderLatency(connection)}</div>
              <div class="asset-mono asset-host-cell"><Icon name="copy" size={11} /><span>{connection.protocol === "local" ? "本机" : `${connection.host}:${connection.port}`}</span></div>
              <div class="asset-mono">{connection.protocol === "local" ? "—" : (connection.username || "—")}</div>
              <div class="asset-time-cell">{formatTime(connection.created_at)}</div>
              <div class="asset-time-cell">{formatTime(connection.last_connected_at)}</div>
            </div>
          )}
        </For>

        <Show when={visibleFolders().length === 0 && visibleConnections().length === 0}>
          <div class="asset-empty">
            <span><ProtocolIcon kind={uiStore.assetFilter() === "database" ? "database" : "terminal"} /></span>
            <strong>{query() ? "没有匹配的连接" : "这里还没有连接"}</strong>
            <p class="asset-empty-hint">
              {query() ? "换个关键词试试，或清空搜索查看全部资产" : "新建一个连接，或从其他工具导入现有配置"}
            </p>
            <button onClick={() => props.onNewConnection(folderId() ?? undefined)}>新建连接</button>
          </div>
        </Show>
      </div>

      <Show when={contextMenu()}>
        <AssetContextMenu
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          items={[
            { label: "新建目录", icon: "folder", onSelect: props.onNewFolder },
            { label: "新建连接", icon: "link", children: newConnectionActions() },
            { label: "新建数据库连接", icon: "database", children: databaseConnectionActions() },
            { label: "删除", icon: "trash", disabled: true, separatorBefore: true },
            { label: "重命名", icon: "edit", disabled: true },
            { label: "复制", icon: "copy", disabled: true },
            { label: "剪切", icon: "scissors", disabled: true },
            { label: "粘贴", icon: "copyPlus", disabled: true },
            { label: "刷新", icon: "refresh", separatorBefore: true, onSelect: () => { void connectionStore.loadConnections(); refreshVisibleLatencies(); } },
            { label: "更多", icon: "chevronDown", children: moreActions() },
          ]}
          onClose={() => setContextMenu(null)}
        />
      </Show>

      <Show when={moreMenu()}>
        <AssetContextMenu
          x={moreMenu()!.x}
          y={moreMenu()!.y}
          items={moreActions()}
          onClose={() => setMoreMenu(null)}
        />
      </Show>

      <Show when={connectionMenu()}>
        <Show
          when={selectedConnections().length > 1}
          fallback={
            <AssetContextMenu
              x={connectionMenu()!.x}
              y={connectionMenu()!.y}
              headerActions={connectionHeaderActions(connectionMenu()!.connection)}
              items={[
                { label: "打开", icon: "play", shortcut: "Enter", onSelect: () => props.onConnect(connectionMenu()!.connection) },
                { label: "刷新", icon: "refresh", shortcut: "F5", onSelect: () => { void connectionStore.loadConnections(); void testConnectionLatency(connectionMenu()!.connection, true); } },
                { label: "新标签页打开", icon: "plus", shortcut: "Alt+N", onSelect: () => props.onConnect(connectionMenu()!.connection) },
                { label: "新窗口打开", icon: "copyPlus", shortcut: "Ctrl+Shift+N", disabled: true },
                { label: "同屏打开", icon: "view", disabled: true },
                { label: "新建目录", icon: "folder", separatorBefore: true, onSelect: props.onNewFolder },
                { label: "新建连接", icon: "link", children: newConnectionActions() },
                { label: "新建数据库连接", icon: "database", children: databaseConnectionActions() },
                { label: "克隆", icon: "copyPlus", onSelect: () => props.onCopy(connectionMenu()!.connection) },
                { label: "编辑", icon: "edit", onSelect: () => props.onEdit(connectionMenu()!.connection) },
                { label: "删除", icon: "trash", shortcut: "Backspace", danger: true, onSelect: () => props.onDelete(connectionMenu()!.connection) },
                { label: "重命名", icon: "edit", shortcut: "F2", onSelect: () => void renameConnection(connectionMenu()!.connection) },
                { label: "更多", icon: "chevronDown", children: moreActions() },
              ]}
              onClose={closeMenus}
            />
          }
        >
          <AssetContextMenu
            x={connectionMenu()!.x}
            y={connectionMenu()!.y}
            headerActions={[
              { label: "复制", icon: "copy", disabled: true },
              { label: "剪切", icon: "scissors", disabled: true },
              { label: "删除", icon: "trash", onSelect: () => props.onDeleteMany(selectedConnections()) },
            ]}
            items={[
              { label: `删除所选连接（${selectedConnections().length}）`, icon: "trash", danger: true, onSelect: () => props.onDeleteMany(selectedConnections()) },
              { label: "复制所选连接", icon: "copyPlus", disabled: true },
              { label: "剪切所选连接", icon: "scissors", disabled: true },
              { label: "导出所选连接", icon: "export", onSelect: () => props.onOpenTransfer?.(), separatorBefore: true },
            ]}
            onClose={closeMenus}
          />
        </Show>
      </Show>
    </section>
  );
};
