import { Component, createSignal, onMount, onCleanup, Show, For, createEffect, createMemo } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { RightPanel } from "./components/RightPanel";
import { ConnectionForm } from "./components/ConnectionForm";
import { TerminalView } from "./components/TerminalView";
import { AssetList } from "./components/AssetList";
import { SettingsModal } from "./components/SettingsModal";
import { SessionImportExport } from "./components/SessionImportExport";
import { SshKeyPicker } from "./components/SshKeyPicker";
import { CommandBroadcast } from "./components/CommandBroadcast";
import { TunnelPanel } from "./components/TunnelPanel";
import { FeedbackHost } from "./components/FeedbackHost";
import { connectionStore } from "./stores/connectionStore";
import { initTheme, getTerminalSettings } from "./stores/themeStore";
import { sessionStore, type SessionTab } from "./stores/sessionStore";
import { uiStore } from "./stores/uiStore";
import { feedback } from "./stores/feedbackStore";
import { api, localShellDisplayName, parseLocalProfile, ProtocolInfo, SshApiError, type ConnectionRecord, type ConnectionConfig, type TunnelRuntimeInfo } from "./utils/api";
import "./App.css";

type ContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
} | null;

const App: Component = () => {
  const isTauriRuntime = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const withAppWindow = (action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) => {
    if (isTauriRuntime()) {
      void action(getCurrentWindow());
    }
  };
  const [showForm, setShowForm] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showSessionTransfer, setShowSessionTransfer] = createSignal(false);
  const [showKeyManager, setShowKeyManager] = createSignal(false);
  const [showNewFolderDialog, setShowNewFolderDialog] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  const [newFolderParentId, setNewFolderParentId] = createSignal<string | null>(null);
  const [editingConnection, setEditingConnection] = createSignal<ConnectionConfig | null>(null);
  const [newConnectionDefaultFolderId, setNewConnectionDefaultFolderId] = createSignal<string | undefined>(undefined);
  const [protocols, setProtocols] = createSignal<ProtocolInfo[]>([]);
  const sessions = sessionStore.sessions;
  const setSessions = sessionStore.setSessions;
  const activeSessionId = sessionStore.activeSessionId;
  const setActiveSessionId = sessionStore.setActiveSessionId;
  const [assetListActive, setAssetListActive] = createSignal(false);
  const [rightPanelWidth, setRightPanelWidth] = createSignal(Number(localStorage.getItem("portnest-right-panel-width")) || 390);
  const [sidebarWidth, setSidebarWidth] = createSignal(Number(localStorage.getItem("portnest-sidebar-width")) || 292);
  const [tabContextMenu, setTabContextMenu] = createSignal<ContextMenuState>(null);
  const [showAppMenu, setShowAppMenu] = createSignal(false);
  const [showAbout, setShowAbout] = createSignal(false);
  const [showBroadcast, setShowBroadcast] = createSignal(false);
  const [showTunnels, setShowTunnels] = createSignal(false);
  const [tunnelConnection, setTunnelConnection] = createSignal<ConnectionRecord | null>(null);
  const [showQuickSwitcher, setShowQuickSwitcher] = createSignal(false);
  const [quickQuery, setQuickQuery] = createSignal("");
  const [tunnelRuntimes, setTunnelRuntimes] = createSignal<TunnelRuntimeInfo[]>([]);
  const reconnectTimers = new Map<string, number>();

  const activeSession = () => sessions().find(s => s.id === activeSessionId());
  const quickConnections = createMemo(() => {
    const query = quickQuery().trim().toLowerCase();
    return [...connectionStore.state.connections]
      .filter(connection => !query || `${connection.name} ${connection.host} ${connection.username || ""}`.toLowerCase().includes(query))
      .sort((a, b) => (b.last_connected_at || 0) - (a.last_connected_at || 0))
      .slice(0, 12);
  });
  const showRightPanel = () => {
    const session = activeSession();
    return !assetListActive() && session?.connection.protocol === "ssh";
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

    if (!isTauriRuntime()) {
      setProtocols([{ id: "ssh", name: "SSH" }, { id: "local", name: "本地终端" }]);
      sessionStore.hydrate([]);
      return;
    }

    // Load connections from database first
    await connectionStore.loadConnections();
    sessionStore.hydrate(connectionStore.state.connections);

    try {
      const supportedProtocols = await api.getProtocols();
      setProtocols(supportedProtocols.filter(protocol => protocol.id === "ssh" || protocol.id === "local"));
    } catch (e) {
      console.error("Failed to get protocols:", e);
    }

  });

  createEffect(() => {
    void sessions();
    void activeSessionId();
    sessionStore.persist();
  });

  const handleGlobalKeyDown = (event: KeyboardEvent) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault(); setQuickQuery(""); setShowQuickSwitcher(true); return;
    }
    if (showQuickSwitcher() && event.key === "Escape") { event.preventDefault(); setShowQuickSwitcher(false); return; }
    const element = event.target as HTMLElement | null;
    if (element?.matches("input, textarea, select, [contenteditable=true]")) return;
    if (modifier && event.key.toLowerCase() === "w" && activeSessionId()) {
      event.preventDefault(); void handleCloseSession(activeSessionId()!); return;
    }
    if (modifier && event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault(); sessionStore.restoreClosed(); setAssetListActive(false); return;
    }
    if (event.ctrlKey && event.key === "Tab" && sessions().length > 1) {
      event.preventDefault();
      const current = sessions().findIndex(session => session.id === activeSessionId());
      const direction = event.shiftKey ? -1 : 1;
      const next = (current + direction + sessions().length) % sessions().length;
      handleSwitchSession(sessions()[next].id);
    }
  };
  onMount(() => window.addEventListener("keydown", handleGlobalKeyDown));
  onCleanup(() => window.removeEventListener("keydown", handleGlobalKeyDown));

  onMount(() => {
    const keepTerminalUsable = () => {
      if (window.innerWidth < 960 && !uiStore.filesCollapsed()) uiStore.setFilesCollapsed(true);
    };
    keepTerminalUsable();
    window.addEventListener("resize", keepTerminalUsable);
    onCleanup(() => window.removeEventListener("resize", keepTerminalUsable));
  });

  onMount(() => {
    if (!isTauriRuntime()) return;
    const refreshTunnels = () => void api.listTunnels().then(setTunnelRuntimes).catch(error => console.error("[tunnels] refresh failed:", error));
    refreshTunnels();
    const timer = window.setInterval(refreshTunnels, 2000);
    onCleanup(() => window.clearInterval(timer));
  });

  const runningTunnelCount = (connectionId: string) => tunnelRuntimes().filter(runtime => runtime.connection_id === connectionId && runtime.status === "running").length;

  const chooseQuickConnection = (connection: ConnectionRecord) => {
    const existing = sessions().find(session => session.connection.id === connection.id);
    setShowQuickSwitcher(false);
    if (existing) handleSwitchSession(existing.id); else void handleConnect(connection);
  };

  const isBuiltinConnection = (connId: string) => connId.startsWith("builtin-");

  // 终端类会话（SSH 与本地终端）才能挂载 TerminalView；文件管理类能力仍按
  // 协议在各自组件内单独门控（如 showRightPanel 仅 SSH）。
  const isTerminalSession = (session: SessionTab) =>
    (session.connection.protocol === "ssh" || session.connection.protocol === "local")
    && session.viewMode === "terminal";

  const createSession = (conn: ConnectionRecord) => {
    const newSession = sessionStore.create(conn, "connecting");
    setAssetListActive(false);
    return newSession.id;
  };

  const openShellForSession = async (sessionId: string, conn: ConnectionRecord) => {
    const cols = 120;
    const rows = 30;

    console.log("[openShell] Opening shell for:", conn.name, conn.id);
    sessionStore.update(sessionId, { status: "connecting", error: undefined });
    const session = sessions().find(s => s.id === sessionId);
    const profile = session?.localProfile;
    const response = profile
      ? await api.openLocalShell(cols, rows, profile)
      : await api.openShell(conn.id, cols, rows);
    console.log("[openShell] Shell opened:", response.shell_id);

    if (!sessions().some(s => s.id === sessionId)) {
      console.log("[openShell] Session closed during openShell, disconnecting");
      await api.disconnectShell(response.shell_id);
      return;
    }

    const encodingOverride = sessions().find(session => session.id === sessionId)?.encodingOverride;
    const effectiveEncoding = encodingOverride
      ? await api.setShellEncoding(response.shell_id, encodingOverride)
      : response.encoding;

    setSessions(prev => prev.map(s =>
      s.id === sessionId ? {
        ...s,
        shellId: response.shell_id,
        status: "connected",
        error: undefined,
        reconnectAttempt: undefined,
        encoding: effectiveEncoding,
      } : s
    ));
  };

  // 一键打开默认本地终端（不创建连接记录，不参与资产树）
  const openQuickLocalTerminal = () => {
    const record: ConnectionRecord = {
      id: "local-quick",
      name: "本地终端",
      protocol: "local",
      host: "本机",
      port: 0,
      username: "",
      credential_id: "",
      sort_order: 0,
      created_at: Math.floor(Date.now() / 1000),
    };
    const session = sessionStore.create(record, "connecting", { transient: true, localProfile: {} });
    setAssetListActive(false);
    void openShellForSession(session.id, record).catch(error => {
      console.error("打开本地终端失败:", error);
      sessionStore.update(session.id, { status: "error", error: String(error), shellId: undefined });
    });
  };

  const handleConnect = async (conn: ConnectionRecord) => {
    console.log("[handleConnect] Starting connection:", conn.name, conn.id, "builtin:", isBuiltinConnection(conn.id));

    if (conn.protocol === "ssh") {
      const sessionId = createSession(conn);
      uiStore.setFilesCollapsed(!getTerminalSettings().openFileManagerOnConnect);
      console.log("[handleConnect] Created session:", sessionId);

      (async () => {
        try {
          await openShellForSession(sessionId, conn);
        } catch (e) {
          console.error("SSH connection failed:", e);
          sessionStore.update(sessionId, { status: "error", error: String(e), shellId: undefined });
        }
      })();
    } else if (conn.protocol === "local") {
      const sessionId = createSession(conn);
      console.log("[handleConnect] Created local terminal session:", sessionId);

      (async () => {
        try {
          await openShellForSession(sessionId, conn);
        } catch (e) {
          console.error("本地终端打开失败:", e);
          sessionStore.update(sessionId, { status: "error", error: String(e), shellId: undefined });
        }
      })();
    } else {
      feedback.info("当前版本专注于 SSH / SFTP，其他连接能力将在后续版本开放。");
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

    // The active SFTP channel is owned by RightPanel and shares this Shell's
    // SSH transport. RightPanel closes the channel when the active tab changes.

  };

  // P0-2: keep session tabs in sync with the connection store. If a connection
  // record is removed (e.g. user deletes it in Sidebar), any open session for
  // that connection becomes an orphan; close it and release its resources.
  // First run sees an empty sessions list and early-returns, so the optional
  // defer workaround mentioned in the task spec is not needed here.
  createEffect(() => {
    const validIds = new Set(connectionStore.state.connections.map(c => c.id));
    const current = sessions();
    const orphans = current.filter(s => !validIds.has(s.connection.id) && !s.transient);
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
    const closingIndex = currentSessions.findIndex(s => s.id === sessionId);
    const closingActive = activeSessionId() === sessionId;
    const newSessions = currentSessions.filter(s => s.id !== sessionId);

    if (session) {
      const timer = reconnectTimers.get(sessionId);
      if (timer !== undefined) window.clearTimeout(timer);
      reconnectTimers.delete(sessionId);
      await closeSessionResources(session, newSessions);
      sessionStore.pushClosed(session);
    }

    // 先切换活跃会话，再更新 sessions 列表，避免短暂的无活跃会话状态
    if (closingActive) {
      if (newSessions.length > 0) {
        const adjacentSession = newSessions[Math.min(Math.max(closingIndex, 0), newSessions.length - 1)];
        setActiveSessionId(adjacentSession.id);
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

  // P1-4: SSH reconnect — close the existing transport and reopen a fresh one.
  // Clearing shellId makes RightPanel discard the old SFTP channel as well.
  const handleReconnect = async (sessionId: string, automatic = false, attempt = 0) => {
    const session = sessions().find(s => s.id === sessionId);
    setTabContextMenu(null);
    if (!session || (session.connection.protocol !== "ssh" && session.connection.protocol !== "local")) return;
    const nextAttempt = automatic ? attempt + 1 : 0;
    sessionStore.update(sessionId, {
      status: automatic ? "reconnecting" : "connecting",
      reconnectAttempt: nextAttempt || undefined,
      error: undefined,
    });
    if (session.shellId) {
      try { await api.disconnectShell(session.shellId); } catch (e) { console.error("[handleReconnect] disconnectShell failed:", e); }
    }
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, shellId: undefined } : s));
    try {
      await openShellForSession(sessionId, session.connection);
    } catch (e) {
      console.error("[handleReconnect] openShell failed:", e);
      const message = String(e);
      sessionStore.update(sessionId, { status: "error", error: message, shellId: undefined });
      const retryable = e instanceof SshApiError ? e.retryable : !/认证|主机密钥|Authentication|host key/i.test(message);
      if (automatic && retryable && nextAttempt < 5 && sessions().some(item => item.id === sessionId)) {
        const delays = [1000, 2000, 5000, 10000, 15000];
        const timer = window.setTimeout(() => {
          reconnectTimers.delete(sessionId);
          void handleReconnect(sessionId, true, nextAttempt);
        }, delays[nextAttempt] ?? 15000);
        reconnectTimers.set(sessionId, timer);
        sessionStore.update(sessionId, { status: "reconnecting", reconnectAttempt: nextAttempt });
      }
    }
  };

  const handleSessionDisconnected = (sessionId: string, error?: unknown) => {
    const message = error ? String(error) : "远端连接已关闭";
    sessionStore.update(sessionId, { status: "disconnected", error: message, shellId: undefined });
    if (getTerminalSettings().reconnectOnDisconnect) {
      void handleReconnect(sessionId, true, 0);
    }
  };

  const handleSetEncoding = async (sessionId: string, encoding: string) => {
    const session = sessions().find(item => item.id === sessionId);
    if (!session?.shellId) return;
    try {
      const normalized = await api.setShellEncoding(session.shellId, encoding);
      sessionStore.update(sessionId, { encodingOverride: normalized });
    } catch (error) {
      sessionStore.update(sessionId, { error: String(error) });
    }
  };

  // P1-4: rename tab. P0-3 keeps displayName as the override slot, so writing
  // here takes effect on the tab label immediately.
  const handleRename = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    if (!session) return;
    const currentName = session.displayName || session.connection.name;
    const next = await feedback.prompt("输入新的标签名称", currentName, "重命名标签");
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
    const text = c.protocol === "local"
      ? `${c.name}（本地终端）`
      : `${c.host}:${c.port}${userPart}`;
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
  const handleCloseAll = () => {
    setTabContextMenu(null);
    const idsToClose = sessions().filter(s => !s.pinned).map(s => s.id);
    void closeSessions(idsToClose);
  };

  const handleSwitchSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setAssetListActive(false);
  };

  const handleDuplicateSession = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    if (!session || !session.connection?.id) return;

    const newSession = sessionStore.create(
      { ...session.connection },
      "connecting",
      { transient: session.transient, localProfile: session.localProfile },
    );
    const newSessionId = newSession.id;
    setAssetListActive(false);
    setTabContextMenu(null);

    if (session.connection.protocol === "ssh" || session.connection.protocol === "local") {
      void openShellForSession(newSessionId, session.connection).catch(error => {
        sessionStore.update(newSessionId, { status: "error", error: String(error), shellId: undefined });
      });
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

  const handleEdit = async (conn: ConnectionRecord) => {
    try {
      const config = await api.getConnectionConfig(conn.id);
      setEditingConnection(config);
      setShowForm(true);
    } catch (error) {
      console.error("Load connection credentials error:", error);
      feedback.error("读取会话凭据失败：" + error);
    }
  };

  const handleSave = async (config: ConnectionConfig, mode: "save" | "save-connect" = "save") => {
    try {
      const result = await api.saveConnection(config);
      await connectionStore.loadConnections();
      setShowForm(false);
      setEditingConnection(null);
      if (mode === "save-connect") {
        const connection = connectionStore.state.connections.find(item => item.id === result.id);
        if (connection) void handleConnect(connection);
      }
      feedback.success(mode === "save-connect" ? "连接已保存，正在连接" : "连接已保存");
    } catch (e) {
      console.error("Save connection error:", e);
      feedback.error("保存连接失败: " + e);
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingConnection(null);
  };

  const handleDelete = async (conn: ConnectionRecord) => {
    if (await feedback.confirm(`确定删除连接“${conn.name}”吗？`, "删除连接")) {
      try {
        await connectionStore.deleteConnection(conn.id);
      } catch (e) {
        console.error("Delete connection error:", e);
        feedback.error("删除连接失败: " + e);
      }
    }
  };

  const handleDeleteMany = async (connections: ConnectionRecord[]) => {
    if (connections.length === 0) return;
    if (!await feedback.confirm(`确定删除选中的 ${connections.length} 个连接吗？此操作不可撤销。`, "批量删除")) return;
    try {
      await Promise.all(connections.map(connection => api.deleteConnection(connection.id)));
      await connectionStore.loadConnections();
    } catch (e) {
      console.error("Batch delete connections error:", e);
      await connectionStore.loadConnections();
      feedback.error("批量删除未能全部完成，列表已刷新，请检查剩余连接。错误: " + e);
    }
  };

  const handleCopyConnection = (conn: ConnectionRecord) => {
    const newConn = conn.protocol === "local"
      ? { ...conn, id: undefined as unknown as string, name: conn.name + " (副本)", ...parseLocalProfile(conn.options) }
      : { ...conn, id: undefined as unknown as string, name: conn.name + " (副本)" };
    setEditingConnection(newConn as unknown as ConnectionConfig);
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
      feedback.error("创建文件夹失败: " + e);
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
      const appBody = document.querySelector<HTMLElement>(".app-body");
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const availableWidth = Math.max(320, (appBody?.clientWidth || window.innerWidth) - (sidebar?.offsetWidth || 0));
      const newWidth = Math.min(availableWidth, Math.max(320, startWidth + delta));
      setRightPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      localStorage.setItem("portnest-right-panel-width", String(rightPanelWidth()));
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

  const startSidebarResize = (event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth();
    const onMouseMove = (moveEvent: MouseEvent) => setSidebarWidth(Math.min(480, Math.max(220, startWidth + moveEvent.clientX - startX)));
    const onMouseUp = () => {
      localStorage.setItem("portnest-sidebar-width", String(sidebarWidth()));
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
                <div class="app-menu-item" onClick={() => { setShowSessionTransfer(true); setShowAppMenu(false); }}>
                  ⇄ 导入 / 导出会话
                </div>
                <div class="app-menu-item" onClick={() => { setShowKeyManager(true); setShowAppMenu(false); }}>
                  🔑 密钥管理器
                </div>
                <div class="app-menu-item" onClick={() => { setShowAbout(true); setShowAppMenu(false); }}>
                  ℹ️ 关于
                </div>
              </div>
              <div class="app-menu-overlay" onClick={() => setShowAppMenu(false)} />
            </Show>
          </div>
          <div class="titlebar-window-controls">
            <button class="titlebar-btn titlebar-btn-win" onClick={() => withAppWindow(appWindow => appWindow.minimize())} title="最小化">
              ─
            </button>
            <button class="titlebar-btn titlebar-btn-win" onClick={() => withAppWindow(appWindow => appWindow.toggleMaximize())} title="最大化">
              □
            </button>
            <button class="titlebar-btn titlebar-btn-win titlebar-btn-close" onClick={() => withAppWindow(appWindow => appWindow.close())} title="关闭">
              ✕
            </button>
          </div>
        </div>
      </div>
      <div class={`app-body ${uiStore.filesStacked() && activeSession() && !assetListActive() && !uiStore.filesCollapsed() ? "files-layout-stacked" : ""}`}>
        <Sidebar
          width={sidebarWidth()}
          onConnect={handleConnect}
          onEdit={handleEdit}
          onDelete={handleDelete}
        onOpenSettings={() => setShowSettings(true)}
        onNewConnection={handleNewConnection}
        onNewFolder={handleNewFolder}
        onCopyConnection={handleCopyConnection}
        onOpenLocalTerminal={openQuickLocalTerminal}
        onOpenTunnels={(connection) => { setTunnelConnection(connection); setShowTunnels(true); }}
      />
      <div class="sidebar-splitter" hidden={!uiStore.assetTreeVisible()} onMouseDown={startSidebarResize} />

      <Show when={sessions().length === 0}>
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

      <Show when={sessions().length > 0}>
        <main class="main-content with-tabs">
          <div class="session-tabs-bar">
            <div class="session-tabs">
              <button
                class={`session-list-tab ${assetListActive() ? "active" : ""}`}
                onClick={() => setAssetListActive(true)}
              >
                ☷ 列表⌄
              </button>
              <For each={sessions()}>
                {(session) => {
                  const isActive = () => activeSessionId() === session.id;
                  return (
                    <div
                      class={`session-tab ${isActive() ? "active" : ""} status-${session.status}`}
                      onClick={() => handleSwitchSession(session.id)}
                      onContextMenu={(e) => handleTabContextMenu(e, session.id)}
                    >
                      <Show when={session.pinned}>
                        <span class="session-tab-pin" title="已固定">📌</span>
                      </Show>
                      <span class="session-tab-terminal-icon">›_</span>
                      <span class={`session-tab-status status-${session.status}`} title={session.status} />
                      <span class="session-tab-name">{session.displayName || session.connection.name}</span>
                      <Show when={runningTunnelCount(session.connection.id) > 0}>
                        <span class="session-tab-tunnel" title={`${runningTunnelCount(session.connection.id)} 条隧道运行中`}>⇄{runningTunnelCount(session.connection.id)}</span>
                      </Show>
                      <Show when={(tabPosition().get(session.id)?.index ?? 0) > 1}>
                        <span class="session-tab-badge">{tabPosition().get(session.id)?.index}</span>
                      </Show>
                      <button
                        class="session-tab-close"
                        title={`关闭 ${session.displayName || session.connection.name}`}
                        aria-label={`关闭 ${session.displayName || session.connection.name}`}
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
              <Show when={["ssh", "local"].includes(tabContextMenuTarget()?.connection.protocol ?? "")}>
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
              <div class="tab-context-menu-item" onClick={() => handleCloseAll()}>
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

          <Show when={!assetListActive() && activeSession()}>{session => (
            <div class="session-action-bar">
              <div class="session-action-identity">
                <span class={`session-status-dot status-${session().status}`} />
                <strong>{session().status === "connected" ? "已连接" : session().status === "connecting" ? "连接中" : session().status === "reconnecting" ? `重连中 ${session().reconnectAttempt || ""}` : session().status === "restored" ? "离线恢复" : session().status === "error" ? "连接错误" : "已断开"}</strong>
                <span>{session().connection.protocol === "local"
                  ? `本机 · ${localShellDisplayName(parseLocalProfile(session().connection.options).shell_type)}`
                  : `${session().connection.username}@${session().connection.host}:${session().connection.port}`}</span>
              </div>
              <div class="session-action-controls">
                <label>编码<select value={session().encodingOverride || session().encoding || "UTF-8"} disabled={!session().shellId} onChange={event => void handleSetEncoding(session().id, event.currentTarget.value)}>
                  <option>UTF-8</option><option>GBK</option><option>GB2312</option><option>GB18030</option><option>Big5</option><option>Shift-JIS</option><option>EUC-KR</option><option>ISO-8859-1</option><option>Windows-1252</option><option>CP437</option>
                </select></label>
                <Show when={session().connection.protocol === "ssh"}>
                  <button onClick={() => { setTunnelConnection(session().connection); setShowTunnels(true); }}>⇄ 隧道 {runningTunnelCount(session().connection.id) || ""}</button>
                </Show>
                <button disabled={sessions().filter(item => item.status === "connected").length === 0} onClick={() => setShowBroadcast(true)}>⌁ 命令广播</button>
                <button onClick={() => void handleReconnect(session().id)}>↻ 重连</button>
              </div>
            </div>
          )}</Show>

          <Show when={assetListActive()}>
            <div class="session-asset-list">
              <AssetList
                onConnect={handleConnect}
                onEdit={handleEdit}
                onCopy={handleCopyConnection}
                onDelete={handleDelete}
                onDeleteMany={handleDeleteMany}
                onNewConnection={handleNewConnection}
                onNewFolder={() => handleNewFolder()}
              />
            </div>
          </Show>

          <div
            class="content-body"
            style={{
              position: "relative",
              flex: 1,
              overflow: "hidden",
              display: assetListActive() ? "none" : "block",
            }}
          >
            <For each={sessions()}>
              {(session) => {
                const sessionActive = createMemo(() => activeSessionId() === session.id);
                const sessionVisible = createMemo(() => sessionActive() && !assetListActive());
                return (
                  <div
                    class="session-content-wrapper"
                    style={{
                      display: sessionActive() ? "flex" : "none",
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%"
                    }}
                  >
                    {isTerminalSession(session) && (
                      <TerminalView
                        sessionKey={session.id}
                        connection={session.connection}
                        visible={sessionVisible}
                        shellId={session.shellId}
                        onDisconnected={(error) => handleSessionDisconnected(session.id, error)}
                      />
                    )}
                    <Show when={!session.shellId || session.status !== "connected"}>
                      <div class={`session-state-overlay state-${session.status}`}>
                        <span class={`session-state-icon status-${session.status}`}>{session.status === "connecting" || session.status === "reconnecting" ? "◌" : session.status === "error" ? "!" : "›_"}</span>
                        <h3>{session.status === "restored" ? "会话已从上次工作区恢复"
                          : session.status === "connecting" ? (session.connection.protocol === "local" ? "正在打开本地终端" : "正在建立 SSH 连接")
                          : session.status === "reconnecting" ? (session.connection.protocol === "local" ? "正在重新打开本地终端" : "正在重新连接")
                          : session.status === "error" ? (session.connection.protocol === "local" ? "本地终端打开失败" : "SSH 连接失败")
                          : (session.connection.protocol === "local" ? "本地终端已关闭" : "SSH 会话已断开")}</h3>
                        <Show when={session.error}><p>{session.error}</p></Show>
                        <div>
                          <button class="primary" disabled={session.status === "connecting" || session.status === "reconnecting"} onClick={() => void handleReconnect(session.id)}>{session.status === "restored" ? "连接" : "重试"}</button>
                          <button onClick={() => void handleEdit(session.connection)}>编辑连接</button>
                          <Show when={session.error}><button onClick={() => void navigator.clipboard.writeText(session.error || "").then(() => feedback.success("错误信息已复制"), error => feedback.error("复制失败：" + error))}>复制错误</button></Show>
                          <button onClick={() => void handleCloseSession(session.id)}>关闭标签</button>
                        </div>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </main>
        <Show when={showRightPanel()}>
          <div class="panel-splitter" onMouseDown={startResize} hidden={uiStore.filesCollapsed()} />
          <RightPanel connection={activeSession()?.connection} sessionId={activeSession()?.id} shellId={activeSession()?.shellId} style={{ width: `${rightPanelWidth()}px` }} />
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
          connection={editingConnection() || undefined}
          protocols={protocols()}
          onSave={handleSave}
          onCancel={handleCancel}
          defaultFolderId={newConnectionDefaultFolderId()}
        />
      </Show>

      <Show when={showSettings()}>
        <SettingsModal onClose={() => setShowSettings(false)} />
      </Show>
      <Show when={showSessionTransfer()}>
        <SessionImportExport onClose={() => setShowSessionTransfer(false)} />
      </Show>
      <Show when={showKeyManager()}>
        <SshKeyPicker onClose={() => setShowKeyManager(false)} onSelect={() => setShowKeyManager(false)} />
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
              版本 0.0.3 · 基于 Tauri 2.0 + SolidJS
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
      <Show when={showBroadcast()}>
        <CommandBroadcast sessions={sessions()} activeSessionId={activeSessionId()} onClose={() => setShowBroadcast(false)} />
      </Show>
      <Show when={showTunnels() && (tunnelConnection() || activeSession()?.connection)}>
        <TunnelPanel connection={(tunnelConnection() || activeSession()!.connection)!} onClose={() => { setShowTunnels(false); setTunnelConnection(null); }} />
      </Show>
      <Show when={showQuickSwitcher()}>
        <div class="quick-switcher-overlay" onClick={() => setShowQuickSwitcher(false)}>
          <div class="quick-switcher" onClick={event => event.stopPropagation()}>
            <input autofocus value={quickQuery()} placeholder="搜索连接、主机或用户…" onInput={event => setQuickQuery(event.currentTarget.value)} onKeyDown={event => {
              if (event.key === "Enter" && quickConnections()[0]) chooseQuickConnection(quickConnections()[0]);
            }} />
            <div class="quick-switcher-results">
              <For each={quickConnections()}>{connection => {
                const opened = () => sessions().find(session => session.connection.id === connection.id);
                return <button onClick={() => chooseQuickConnection(connection)}>
                  <span class={`session-status-dot status-${opened()?.status || "restored"}`} />
                  <span><strong>{connection.name}</strong><small>{connection.protocol === "local" ? "本机终端" : `${connection.username}@${connection.host}:${connection.port}`}</small></span>
                  <em>{opened() ? "切换标签" : "新建会话"}</em>
                </button>;
              }}</For>
            </div>
            <footer><kbd>Enter</kbd> 打开　<kbd>Esc</kbd> 关闭　<kbd>Ctrl K</kbd> 快速切换</footer>
          </div>
        </div>
      </Show>
      <FeedbackHost />
      </div>
    </div>
  );
};

export default App;
