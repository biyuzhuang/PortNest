import { Component, createSignal, onMount, Show, For, createEffect, on, createMemo } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { RightPanel } from "./components/RightPanel";
import { ConnectionForm } from "./components/ConnectionForm";
import { TerminalView } from "./components/TerminalView";
import { AssetList } from "./components/AssetList";
import { SettingsModal } from "./components/SettingsModal";
import { connectionStore, ConnectionRecord, ConnectionConfig } from "./stores/connectionStore";
import { initTheme } from "./stores/themeStore";
import { uiStore } from "./stores/uiStore";
import { api, ProtocolInfo } from "./utils/api";
import "./App.css";

type ViewMode = "terminal";

type SessionTab = {
  id: string;
  connection: ConnectionRecord;
  viewMode: ViewMode;
  activeTab: "query" | "structure" | "security" | "monitor" | "ai";
  displayName?: string;
  shellId?: string;
  sftpId?: string;
  pinned?: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
} | null;

const App: Component = () => {
  const appWindow = getCurrentWindow();
  const [showForm, setShowForm] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showNewFolderDialog, setShowNewFolderDialog] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  const [newFolderParentId, setNewFolderParentId] = createSignal<string | null>(null);
  const [editingConnection, setEditingConnection] = createSignal<ConnectionRecord | null>(null);
  const [newConnectionDefaultFolderId, setNewConnectionDefaultFolderId] = createSignal<string | undefined>(undefined);
  const [protocols, setProtocols] = createSignal<ProtocolInfo[]>([]);
  const [sessions, setSessions] = createSignal<SessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = createSignal(280);
  const [tabContextMenu, setTabContextMenu] = createSignal<ContextMenuState>(null);
  const [showAppMenu, setShowAppMenu] = createSignal(false);
  const [showAbout, setShowAbout] = createSignal(false);

  const activeSession = () => sessions().find(s => s.id === activeSessionId());
  const showRightPanel = () => {
    const session = activeSession();
    return session?.connection.protocol === "ssh";
  };

  // P0-3: derive the 1-based position of a session among its siblings for the
  // same connection, and the total sibling count. The badge is shown only when
  // total > 1. Closing a middle tab re-numbers the remaining ones in insertion
  // order, so the badge never collides with a freshly created tab.
  const tabPosition = createMemo(() => {
    const totalByConn = new Map<string, number>();
    for (const s of sessions()) {
      totalByConn.set(s.connection.id, (totalByConn.get(s.connection.id) ?? 0) + 1);
    }
    const result = new Map<string, { index: number; total: number }>();
    const seen = new Map<string, number>();
    for (const s of sessions()) {
      const idx = (seen.get(s.connection.id) ?? 0) + 1;
      seen.set(s.connection.id, idx);
      result.set(s.id, { index: idx, total: totalByConn.get(s.connection.id) ?? 1 });
    }
    return result;
  });

  // P1-4: resolve the session the right-click menu currently targets, so the menu
  // JSX can check protocol / pinned without re-deriving it inline.
  const tabContextMenuTarget = createMemo(() => {
    const m = tabContextMenu();
    if (!m) return undefined;
    return sessions().find(s => s.id === m.sessionId);
  });

  onMount(async () => {
    initTheme();

    // Load connections from database first
    await connectionStore.loadConnections();

    try {
      const supportedProtocols = await api.getProtocols();
      setProtocols(supportedProtocols.filter(protocol => protocol.id === "ssh"));
    } catch (e) {
      console.error("Failed to get protocols:", e);
    }

  });

  const isBuiltinConnection = (connId: string) => connId.startsWith("builtin-");

  const createSession = (conn: ConnectionRecord, viewMode: ViewMode = "terminal") => {
    const sessionId = `${conn.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newSession: SessionTab = {
      id: sessionId,
      connection: conn,
      viewMode,
      activeTab: "query",
    };
    setSessions(prev => [...prev, newSession]);
    setActiveSessionId(sessionId);
    return sessionId;
  };

  const openShellForSession = async (sessionId: string, conn: ConnectionRecord) => {
    const cols = 120;
    const rows = 30;

    console.log("[openShell] Opening shell for:", conn.name, conn.id);
    const response = await api.openShell(conn.id, cols, rows);
    console.log("[openShell] Shell opened:", response.shell_id);

    if (!sessions().some(s => s.id === sessionId)) {
      console.log("[openShell] Session closed during openShell, disconnecting");
      await api.disconnectShell(response.shell_id);
      return;
    }

    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, shellId: response.shell_id } : s
    ));
  };

  const handleConnect = async (conn: ConnectionRecord) => {
    console.log("[handleConnect] Starting connection:", conn.name, conn.id, "builtin:", isBuiltinConnection(conn.id));

    if (conn.protocol === "ssh") {
      const sessionId = createSession(conn, "terminal");
      console.log("[handleConnect] Created session:", sessionId);

      (async () => {
        try {
          await openShellForSession(sessionId, conn);
        } catch (e) {
          console.error("SSH connection failed:", e);
          const currentSessions = sessions();
          if (currentSessions.some(s => s.id === sessionId)) {
            const newSessions = currentSessions.filter(s => s.id !== sessionId);
            setSessions(newSessions);
            if (activeSessionId() === sessionId) {
              setActiveSessionId(newSessions.length > 0 ? newSessions[newSessions.length - 1].id : null);
            }
          }
          alert("SSH 连接失败: " + e);
        }
      })();
    } else {
      alert("当前版本专注于 SSH / SFTP，其他连接能力将在后续版本开放。");
    }
  };

  // Release any remote resources owned by session before it is dropped from state.
  // Called from handleCloseSession. remainingSessions is the post-close snapshot so we
  // can decide whether this session was the last tab of a given connection (relevant for
  // docker, which uses a single per-connection session).
  const closeSessionResources = async (session: SessionTab, _remainingSessions: SessionTab[]) => {
    if (session.shellId) {
      try {
        await api.disconnectShell(session.shellId);
      } catch (e) {
        console.error("[closeSessionResources] disconnectShell failed:", session.id, e);
      }
    }

    // SFTP is currently connection-scoped and owned by RightPanel (its onCleanup closes
    // the sftp channel when no SSH session is active). The sftpId field is reserved for
    // the future per-session ownership refactor (see P2-9). No action here for now.

  };

  // P0-2: keep session tabs in sync with the connection store. If a connection
  // record is removed (e.g. user deletes it in Sidebar), any open session for
  // that connection becomes an orphan; close it and release its resources.
  // First run sees an empty sessions list and early-returns, so the optional
  // defer workaround mentioned in the task spec is not needed here.
  createEffect(() => {
    const validIds = new Set(connectionStore.state.connections.map(c => c.id));
    const current = sessions();
    const orphans = current.filter(s => !validIds.has(s.connection.id));
    if (orphans.length === 0) return;

    const remaining = current.filter(s => validIds.has(s.connection.id));
    const closingActive = orphans.some(s => s.id === activeSessionId());

    void (async () => {
      try {
        for (const s of orphans) {
          await closeSessionResources(s, remaining);
        }
        setSessions(remaining);
        if (closingActive) {
          setActiveSessionId(remaining[0]?.id ?? null);
        }
      } catch (e) {
        console.error("[orphanCleanup] failed:", e);
      }
    })();
  });

  const handleCloseSession = async (sessionId: string) => {
    console.log("[App] handleCloseSession:", sessionId);

    const currentSessions = sessions();
    const session = currentSessions.find(s => s.id === sessionId);
    const closingActive = activeSessionId() === sessionId;
    const newSessions = currentSessions.filter(s => s.id !== sessionId);

    if (session) {
      await closeSessionResources(session, newSessions);
    }

    // 先切换活跃会话，再更新 sessions 列表，避免短暂的无活跃会话状态
    if (closingActive) {
      if (newSessions.length > 0) {
        const lastSession = newSessions[newSessions.length - 1];
        setActiveSessionId(lastSession.id);
      } else {
        setActiveSessionId(null);
      }
    }

    setSessions(newSessions);
  };

  // P1-4: batched close helper used by the "close others / right / all" actions.
  // Releases resources for each id, then commits the remaining set in a single
  // setSessions call to avoid intermediate flicker. Falls back active to the first
  // remaining tab (or null) if the active tab was among the closed ones.
  const closeSessions = async (idsToClose: string[]) => {
    if (idsToClose.length === 0) return;
    const current = sessions();
    const idSet = new Set(idsToClose);
    const remaining = current.filter(s => !idSet.has(s.id));
    for (const id of idsToClose) {
      const s = current.find(x => x.id === id);
      if (s) await closeSessionResources(s, remaining);
    }
    setSessions(remaining);
    if (!remaining.some(s => s.id === activeSessionId())) {
      setActiveSessionId(remaining[0]?.id ?? null);
    }
  };

  // P1-4: SSH reconnect — close the existing shell and reopen a fresh one.
  // SFTP is owned by RightPanel on a separate SSH session, so it stays open and
  // does not need to be re-handled here.
  const handleReconnect = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    setTabContextMenu(null);
    if (!session || session.connection.protocol !== "ssh") return;
    if (session.shellId) {
      try { await api.disconnectShell(session.shellId); } catch (e) { console.error("[handleReconnect] disconnectShell failed:", e); }
    }
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, shellId: undefined } : s));
    try {
      await openShellForSession(sessionId, session.connection);
    } catch (e) {
      console.error("[handleReconnect] openShell failed:", e);
    }
  };

  // P1-4: rename tab. P0-3 keeps displayName as the override slot, so writing
  // here takes effect on the tab label immediately.
  const handleRename = (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    if (!session) return;
    const currentName = session.displayName || session.connection.name;
    const next = window.prompt("重命名标签", currentName);
    setTabContextMenu(null);
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === currentName) return;
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, displayName: trimmed || undefined } : s));
  };

  // P1-4: copy "host:port (username)" to clipboard.
  const handleCopyConnectionInfo = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    setTabContextMenu(null);
    if (!session) return;
    const c = session.connection;
    const userPart = c.username ? ` (${c.username})` : "";
    const text = `${c.host}:${c.port}${userPart}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error("[handleCopyConnectionInfo] clipboard write failed:", e);
    }
  };

  // P1-4: pin / unpin a tab. Pinned tabs survive "close others" and "close all".
  const handleTogglePin = (sessionId: string) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, pinned: !s.pinned } : s));
    setTabContextMenu(null);
  };

  // P1-4: close every non-pinned tab except the target (which is preserved even
  // if it is not pinned, since it is the tab the user right-clicked on).
  const handleCloseOthers = (sessionId: string) => {
    setTabContextMenu(null);
    const idsToClose = sessions()
      .filter(s => s.id !== sessionId && !s.pinned)
      .map(s => s.id);
    void closeSessions(idsToClose);
  };

  // P1-4: close every tab strictly to the right of the target, including pinned
  // ones — per the spec, "close right" affects fixed tabs as well.
  const handleCloseRight = (sessionId: string) => {
    setTabContextMenu(null);
    const current = sessions();
    const idx = current.findIndex(s => s.id === sessionId);
    if (idx < 0) return;
    const idsToClose = current.slice(idx + 1).map(s => s.id);
    void closeSessions(idsToClose);
  };

  // P1-4: close every non-pinned tab. Pinned tabs (including the right-clicked
  // one if it happens to be pinned) stay open.
  const handleCloseAll = (sessionId: string) => {
    setTabContextMenu(null);
    const idsToClose = sessions().filter(s => !s.pinned).map(s => s.id);
    void closeSessions(idsToClose);
  };

  const handleSwitchSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
  };

  const handleDuplicateSession = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    if (!session || !session.connection?.id) return;

    const newSessionId = `${session.connection.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newSession: SessionTab = {
      id: newSessionId,
      connection: { ...session.connection },
      viewMode: session.viewMode,
      activeTab: session.activeTab,
    };
    setSessions(prev => [...prev, newSession]);
    setActiveSessionId(newSessionId);
    setTabContextMenu(null);

    if (session.connection.protocol === "ssh") {
      openShellForSession(newSessionId, session.connection);
    }
  };

  const handleTabContextMenu = (e: MouseEvent, sessionId: string) => {
    e.preventDefault();
    // P1-4: clamp menu origin to viewport so the menu never overflows the right
    // or bottom edge. 200x280 are the expected menu footprint for the new items.
    const menuW = 200;
    const menuH = 280;
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth - menuW));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight - menuH));
    setTabContextMenu({ x, y, sessionId });
  };

  const handleBack = () => {
    const currentId = activeSessionId();
    if (currentId) {
      handleCloseSession(currentId);
    }
  };

  const handleNewConnection = (folderId?: string) => {
    setNewConnectionDefaultFolderId(folderId);
    setEditingConnection(null);
    setShowForm(true);
  };

  const handleEdit = (conn: ConnectionRecord) => {
    setEditingConnection(conn);
    setShowForm(true);
  };

  const handleSave = async (config: ConnectionConfig) => {
    try {
      await api.saveConnection(config);
      await connectionStore.loadConnections();
      setShowForm(false);
      setEditingConnection(null);
    } catch (e) {
      console.error("Save connection error:", e);
      alert("保存连接失败: " + e);
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingConnection(null);
  };

  const handleDelete = async (conn: ConnectionRecord) => {
    if (confirm(`确定删除连接 "${conn.name}" 吗？`)) {
      try {
        await connectionStore.deleteConnection(conn.id);
      } catch (e) {
        console.error("Delete connection error:", e);
        alert("删除连接失败: " + e);
      }
    }
  };

  const handleDeleteMany = async (connections: ConnectionRecord[]) => {
    if (connections.length === 0) return;
    if (!confirm(`确定删除选中的 ${connections.length} 个连接吗？此操作不可撤销。`)) return;
    try {
      await Promise.all(connections.map(connection => api.deleteConnection(connection.id)));
      await connectionStore.loadConnections();
    } catch (e) {
      console.error("Batch delete connections error:", e);
      await connectionStore.loadConnections();
      alert("批量删除未能全部完成，列表已刷新，请检查剩余连接。错误: " + e);
    }
  };

  const handleCopyConnection = (conn: ConnectionRecord) => {
    const newConn = {
      ...conn,
      id: undefined as unknown as string,
      name: conn.name + " (副本)",
    };
    setEditingConnection(newConn as ConnectionRecord);
    setShowForm(true);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName().trim();
    if (!name) return;
    try {
      await connectionStore.addFolder(name, newFolderParentId());
      setShowNewFolderDialog(false);
      setNewFolderName("");
      setNewFolderParentId(null);
    } catch (e) {
      console.error("Create folder error:", e);
      alert("创建文件夹失败: " + e);
    }
  };

  const handleNewFolder = (parentId?: string) => {
    setNewFolderParentId(parentId ?? null);
    setNewFolderName("");
    setShowNewFolderDialog(true);
  };

  const startResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPanelWidth();

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const newWidth = Math.min(450, Math.max(200, startWidth + delta));
      setRightPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div class="app-container">
      <div class="app-titlebar">
        <span class="titlebar-title" data-tauri-drag-region><b>P</b> PortNest</span>
        <div class="titlebar-spacer" data-tauri-drag-region />
        <div class="titlebar-workspace-status">
          <span class="status-dot online" /> SSH / SFTP 工作区
        </div>
        <div class="titlebar-controls">
          <div class="app-menu-container">
            <button class="titlebar-btn" onClick={() => setShowAppMenu(!showAppMenu())}>
              ⋮
            </button>
            <Show when={showAppMenu()}>
              <div class="app-menu-dropdown">
                <Show when={activeSession()}>
                  <div class="app-menu-item" onClick={() => { handleBack(); setShowAppMenu(false); }}>
                    ← 关闭当前标签
                  </div>
                </Show>
                <div class="app-menu-item" onClick={() => { setShowSettings(true); setShowAppMenu(false); }}>
                  ⚙️ 设置
                </div>
                <div class="app-menu-item" onClick={() => { setShowAbout(true); setShowAppMenu(false); }}>
                  ℹ️ 关于
                </div>
              </div>
              <div class="app-menu-overlay" onClick={() => setShowAppMenu(false)} />
            </Show>
          </div>
          <div class="titlebar-window-controls">
            <button class="titlebar-btn titlebar-btn-win" onClick={() => appWindow.minimize()} title="最小化">
              ─
            </button>
            <button class="titlebar-btn titlebar-btn-win" onClick={() => appWindow.toggleMaximize()} title="最大化">
              □
            </button>
            <button class="titlebar-btn titlebar-btn-win titlebar-btn-close" onClick={() => appWindow.close()} title="关闭">
              ✕
            </button>
          </div>
        </div>
      </div>
      <div class="app-body">
        <Sidebar
          onConnect={handleConnect}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onOpenAI={() => alert("AI 运维助手已列入后续计划。")}
        onOpenSettings={() => setShowSettings(true)}
        onNewConnection={handleNewConnection}
        onNewFolder={handleNewFolder}
        onCopyConnection={handleCopyConnection}
      />

      <Show when={!activeSession()}>
        <main class="main-content">
          <AssetList
            onConnect={handleConnect}
            onEdit={handleEdit}
            onCopy={handleCopyConnection}
            onDelete={handleDelete}
            onDeleteMany={handleDeleteMany}
            onNewConnection={handleNewConnection}
            onNewFolder={() => handleNewFolder()}
          />
        </main>
      </Show>

      <Show when={activeSession()}>
        <main class="main-content with-tabs">
          <div class="session-tabs-bar">
            <div class="session-tabs">
              <For each={sessions()}>
                {(session) => {
                  const isActive = () => activeSessionId() === session.id;
                  return (
                    <div
                      class={`session-tab ${isActive() ? "active" : ""}`}
                      onClick={() => handleSwitchSession(session.id)}
                      onContextMenu={(e) => handleTabContextMenu(e, session.id)}
                    >
                      <Show when={session.pinned}>
                        <span class="session-tab-pin" title="已固定">📌</span>
                      </Show>
                      <span class="session-tab-name">{session.displayName || session.connection.name}</span>
                      <Show when={(tabPosition().get(session.id)?.index ?? 0) > 1}>
                        <span class="session-tab-badge">{tabPosition().get(session.id)?.index}</span>
                      </Show>
                      <span class="session-tab-protocol">{session.connection.protocol.toUpperCase()}</span>
                      <button
                        class="session-tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCloseSession(session.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          <Show when={tabContextMenu()}>
            <div
              class="tab-context-menu"
              style={{ left: tabContextMenu()!.x + "px", top: tabContextMenu()!.y + "px" }}
            >
              <Show when={tabContextMenuTarget()?.connection.protocol === "ssh"}>
                <div class="tab-context-menu-item" onClick={() => handleReconnect(tabContextMenu()!.sessionId)}>
                  断开重连
                </div>
                <div class="tab-context-menu-divider" />
              </Show>
              <div class="tab-context-menu-item" onClick={() => handleRename(tabContextMenu()!.sessionId)}>
                重命名
              </div>
              <div class="tab-context-menu-item" onClick={() => handleCopyConnectionInfo(tabContextMenu()!.sessionId)}>
                复制连接信息
              </div>
              <div class="tab-context-menu-item" onClick={() => handleDuplicateSession(tabContextMenu()!.sessionId)}>
                复制标签页
              </div>
              <div class="tab-context-menu-divider" />
              <div class="tab-context-menu-item" onClick={() => handleCloseOthers(tabContextMenu()!.sessionId)}>
                关闭其他
              </div>
              <div class="tab-context-menu-item" onClick={() => handleCloseRight(tabContextMenu()!.sessionId)}>
                关闭右侧
              </div>
              <div class="tab-context-menu-item" onClick={() => handleCloseAll(tabContextMenu()!.sessionId)}>
                关闭全部
              </div>
              <div class="tab-context-menu-divider" />
              <div class="tab-context-menu-item" onClick={() => handleTogglePin(tabContextMenu()!.sessionId)}>
                {tabContextMenuTarget()?.pinned ? "取消固定" : "固定标签"}
              </div>
              <div class="tab-context-menu-divider" />
              <div class="tab-context-menu-item" onClick={() => {
                handleCloseSession(tabContextMenu()!.sessionId);
                setTabContextMenu(null);
              }}>
                关闭标签页
              </div>
            </div>
            <div class="tab-context-menu-overlay" onClick={() => setTabContextMenu(null)} />
          </Show>

          <div class="content-body" style={{ position: "relative", flex: 1, overflow: "hidden" }}>
            <For each={sessions()}>
              {(session) => {
                const sessionActive = createMemo(() => activeSessionId() === session.id);
                return (
                  <div
                    key={session.id}
                    class="session-content-wrapper"
                    style={{
                      display: sessionActive() ? "flex" : "none",
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%"
                    }}
                  >
                    {session.connection.protocol === "ssh" && session.viewMode === "terminal" && (
                      <TerminalView
                        sessionKey={session.id}
                        connection={session.connection}
                        visible={sessionActive}
                        shellId={session.shellId}
                      />
                    )}
                  </div>
                );
              }}
            </For>
          </div>
        </main>
        <Show when={showRightPanel()}>
          <div class="panel-splitter" onMouseDown={startResize} hidden={uiStore.filesCollapsed()} />
          <RightPanel connection={activeSession()?.connection} shellId={activeSession()?.shellId} style={{ width: `${rightPanelWidth()}px` }} />
          <Show when={uiStore.filesCollapsed()}>
            <button
              class="right-panel-expand-tab"
              onClick={() => uiStore.setFilesCollapsed(false)}
              title="展开文件面板"
              aria-label="展开文件面板"
            >
              <span class="right-panel-expand-tab-icon">📂</span>
              <span class="right-panel-expand-tab-arrow">‹</span>
            </button>
          </Show>
        </Show>
      </Show>

      <Show when={showForm()}>
        <ConnectionForm
          connection={editingConnection() as unknown as ConnectionConfig}
          protocols={protocols()}
          onSave={handleSave}
          onCancel={handleCancel}
          defaultFolderId={newConnectionDefaultFolderId()}
        />
      </Show>

      <Show when={showSettings()}>
        <SettingsModal onClose={() => setShowSettings(false)} />
      </Show>

      <Show when={showNewFolderDialog()}>
        <div class="modal-overlay" onClick={() => setShowNewFolderDialog(false)}>
          <div class="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>{newFolderParentId() ? "新建子文件夹" : "新建文件夹"}</h3>
            <Show when={newFolderParentId()}>
              <p class="folder-parent-hint">
                创建到：{connectionStore.state.folders.find(folder => folder.id === newFolderParentId())?.name}
              </p>
            </Show>
            <div class="form-group">
              <input
                type="text"
                placeholder="文件夹名称"
                value={newFolderName()}
                onInput={(e) => setNewFolderName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
              />
            </div>
            <div class="form-actions">
              <button class="btn-cancel" onClick={() => setShowNewFolderDialog(false)}>取消</button>
              <button class="btn-save" onClick={handleCreateFolder}>创建</button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={showAbout()}>
        <div class="modal-overlay" onClick={() => setShowAbout(false)}>
          <div class="modal-content" onClick={(e) => e.stopPropagation()} style={{ "max-width": "360px" }}>
            <h2>PortNest</h2>
            <p style={{ color: "var(--text-secondary)", "margin-bottom": "12px" }}>安全、专注的 SSH / SFTP 工作区</p>
            <p style={{ color: "var(--text-muted)", "font-size": "13px", "margin-bottom": "8px" }}>
              版本 0.1.0 · 基于 Tauri 2.0 + SolidJS
            </p>
            <p style={{ color: "var(--text-muted)", "font-size": "13px" }}>
              当前专注 SSH · SFTP，数据库与容器能力将在后续版本开放
            </p>
            <div class="form-actions" style={{ "margin-top": "20px" }}>
              <button class="btn-save" onClick={() => setShowAbout(false)}>关闭</button>
            </div>
          </div>
        </div>
      </Show>
      </div>
    </div>
  );
};

export default App;
