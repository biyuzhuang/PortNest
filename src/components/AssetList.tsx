import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import {
  connectionStore,
  countFolderConnections,
  sortAssetsByTreeOrder,
} from "../stores/connectionStore";
import { api, type ConnectionRecord } from "../utils/api";
import { matchesAssetFilter, uiStore } from "../stores/uiStore";

interface AssetListProps {
  onConnect: (connection: ConnectionRecord) => void;
  onEdit: (connection: ConnectionRecord) => void;
  onCopy: (connection: ConnectionRecord) => void;
  onDelete: (connection: ConnectionRecord) => void;
  onDeleteMany: (connections: ConnectionRecord[]) => void;
  onNewConnection: (folderId?: string) => void;
  onNewFolder: () => void;
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
    all: "SSH 资产",
    terminal: "SSH 终端",
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
    const width = 200;
    const height = 320;
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

  const closeMenus = () => {
    setContextMenu(null);
    setConnectionMenu(null);
  };

  const clearSelectionFromBlankArea = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    setSelectedIds(new Set<string>());
    setSelectionAnchorId(null);
  };

  return (
    <section class="asset-workspace" onContextMenu={openContextMenu} onClick={closeMenus}>
      <div class="asset-view-tabs">
        <button class="asset-view-tab active"><span>☷</span> 列表 <span class="asset-chevron">⌄</span></button>
      </div>

      <div class="asset-toolbar">
        <div class="asset-toolbar-title">
          <span class="asset-list-icon">☷</span>
          <Show when={currentFolder()} fallback={filterTitle()}>
            <button class="asset-breadcrumb" onClick={() => setFolderId(null)}>资产列表</button>
            <span class="asset-breadcrumb-separator">/</span>
            <span>{currentFolder()?.name}</span>
          </Show>
        </div>
        <div class="asset-selection">已选择 <strong>{selectedConnections().length}</strong> 个连接</div>
        <div class="asset-toolbar-actions">
          <label class="asset-search">
            <span>⌕</span>
            <input
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
              placeholder="名称、IP、User  (Ctrl+F)"
            />
          </label>
          <button title="刷新当前列表延迟" onClick={refreshVisibleLatencies}>↻</button>
          <button
            class={showPing() ? "active" : ""}
            title={showPing() ? "隐藏 Ping 延迟" : "显示 Ping 延迟"}
            onClick={togglePingVisibility}
          >
            ◉
          </button>
          <button title="新建文件夹" onClick={props.onNewFolder}>▱+</button>
          <button title="新建 SSH 连接" onClick={() => props.onNewConnection(folderId() ?? undefined)}>＋</button>
        </div>
      </div>

      <div class="asset-table" onClick={clearSelectionFromBlankArea}>
        <div class="asset-row asset-table-head">
          <div>名称 <span>⌃</span></div>
          <div>延迟</div>
          <div>Host</div>
          <div>User</div>
          <div>创建时间</div>
          <div>最近连接</div>
          <div>备注</div>
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
              <div class="asset-name-cell"><span class="asset-folder-icon">■</span>{folder.name}</div>
              <div>—</div><div>—</div><div>—</div><div>—</div><div>—</div>
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
              onClick={(event) => selectConnection(event, connection)}
              onDblClick={() => props.onConnect(connection)}
              onContextMenu={(event) => openConnectionMenu(event, connection)}
            >
              <div class="asset-name-cell"><span class="asset-terminal-icon">›_</span>{connection.name}</div>
              <div>{renderLatency(connection)}</div>
              <div class="asset-mono">{connection.host}:{connection.port}</div>
              <div class="asset-mono">{connection.username || "—"}</div>
              <div>{formatTime(connection.created_at)}</div>
              <div>{formatTime(connection.last_connected_at)}</div>
              <div class="asset-muted">{connection.tags || "—"}</div>
            </div>
          )}
        </For>

        <Show when={visibleFolders().length === 0 && visibleConnections().length === 0}>
          <div class="asset-empty">
            <span>›_</span>
            <strong>{query() ? "没有匹配的连接" : "这里还没有 SSH 连接"}</strong>
            <button onClick={() => props.onNewConnection(folderId() ?? undefined)}>新建连接</button>
          </div>
        </Show>
      </div>

      <div class="asset-footer">
        <span>{visibleFolders().length} 个文件夹</span>
        <span>{visibleConnections().length} 个连接</span>
        <span>双击连接以打开终端</span>
      </div>

      <Show when={contextMenu()}>
        <div
          class="asset-context-menu"
          style={{ left: `${contextMenu()!.x}px`, top: `${contextMenu()!.y}px` }}
          onClick={event => event.stopPropagation()}
        >
          <button onClick={() => {
            props.onNewConnection(folderId() ?? undefined);
            setContextMenu(null);
          }}>
            <span class="asset-context-icon">＋</span>
            <span><strong>新建 SSH 连接</strong><small>添加远程服务器</small></span>
          </button>
          <button onClick={() => {
            props.onNewFolder();
            setContextMenu(null);
          }}>
            <span class="asset-context-icon folder">▰</span>
            <span><strong>新建文件夹</strong><small>整理连接资产</small></span>
          </button>
          <div class="asset-context-divider" />
          <button onClick={() => {
            void connectionStore.loadConnections();
            setContextMenu(null);
          }}>
            <span class="asset-context-icon">↻</span>
            <span><strong>刷新列表</strong></span>
          </button>
          <Show when={folderId()}>
            <button onClick={() => {
              setFolderId(null);
              setContextMenu(null);
            }}>
              <span class="asset-context-icon">←</span>
              <span><strong>返回资产列表</strong></span>
            </button>
          </Show>
        </div>
        <div class="asset-context-overlay" onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
        }} />
      </Show>

      <Show when={connectionMenu()}>
        <div
          class="asset-context-menu asset-connection-menu"
          style={{ left: `${connectionMenu()!.x}px`, top: `${connectionMenu()!.y}px` }}
          onClick={event => event.stopPropagation()}
        >
          <Show when={selectedConnections().length > 1} fallback={
            <>
              <div class="asset-context-caption">
                <strong>{connectionMenu()!.connection.name}</strong>
                <span>{connectionMenu()!.connection.username}@{connectionMenu()!.connection.host}:{connectionMenu()!.connection.port}</span>
              </div>
              <div class="asset-context-divider" />
              <button onClick={() => {
                props.onConnect(connectionMenu()!.connection);
                closeMenus();
              }}>
                <span class="asset-context-icon">›_</span>
                <span><strong>打开终端</strong><small>建立新的 SSH 会话</small></span>
              </button>
              <button onClick={() => {
                props.onEdit(connectionMenu()!.connection);
                closeMenus();
              }}>
                <span class="asset-context-icon">✎</span>
                <span><strong>编辑连接</strong></span>
              </button>
              <button onClick={() => {
                const connection = connectionMenu()!.connection;
                void navigator.clipboard.writeText(
                  `${connection.username || ""}@${connection.host}:${connection.port}`
                );
                closeMenus();
              }}>
                <span class="asset-context-icon">⧉</span>
                <span><strong>复制连接信息</strong></span>
              </button>
              <button onClick={() => {
                props.onCopy(connectionMenu()!.connection);
                closeMenus();
              }}>
                <span class="asset-context-icon">⎘</span>
                <span><strong>复制连接</strong><small>创建一份连接副本</small></span>
              </button>
              <div class="asset-context-divider" />
              <button class="danger" onClick={() => {
                props.onDelete(connectionMenu()!.connection);
                closeMenus();
              }}>
                <span class="asset-context-icon danger">×</span>
                <span><strong>删除连接</strong></span>
              </button>
            </>
          }>
            <div class="asset-context-caption">
              <strong>已选择 {selectedConnections().length} 个连接</strong>
              <span>批量操作将应用于当前选中的连接</span>
            </div>
            <div class="asset-context-divider" />
            <button class="danger" onClick={() => {
              props.onDeleteMany(selectedConnections());
              closeMenus();
            }}>
              <span class="asset-context-icon danger">×</span>
              <span><strong>删除所选连接</strong><small>此操作不可撤销</small></span>
            </button>
          </Show>
        </div>
        <div class="asset-context-overlay" onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
        }} />
      </Show>
    </section>
  );
};
