import { Component, createSignal, onMount, onCleanup, Show, For, createEffect, createMemo } from "solid-js";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import packageInfo from "../package.json";
import { Sidebar } from "./components/Sidebar";
import { RightPanel } from "./components/RightPanel";
import { ServerOverview } from "./components/ServerOverview";
import { readTerminalSelection, readTerminalTranscript, refitTerminal } from "./components/TerminalView";
import { getOverviewSettings } from "./stores/dashboardStore";
import { ConnectionForm } from "./components/ConnectionForm";
import { TerminalView } from "./components/TerminalView";
import { AssetList } from "./components/AssetList";
import { SessionImportExport } from "./components/SessionImportExport";
import { SshKeyPicker } from "./components/SshKeyPicker";
import { CommandBroadcast } from "./components/CommandBroadcast";
import { TunnelPanel } from "./components/TunnelPanel";
import { FeedbackHost } from "./components/FeedbackHost";
import { TextContextMenu } from "./components/TextContextMenu";
import { AIAssistant, type AssistantMode } from "./components/AIAssistant";
import { DatabaseWorkspace } from "./components/DatabaseWorkspace";
import { ProtocolIcon } from "./components/ProtocolIcon";
import { Icon } from "./components/Icon";
import { openSettingsWindow } from "./utils/settingsWindow";
import { connectionStore } from "./stores/connectionStore";
import { initTheme, getTerminalSettings } from "./stores/themeStore";
import { sessionStore, type SessionTab } from "./stores/sessionStore";
import { uiStore } from "./stores/uiStore";
import { aiContextStore } from "./stores/aiContextStore";
import { feedback } from "./stores/feedbackStore";
import { api, isDatabaseProtocol, localShellDisplayName, parseLocalProfile, ProtocolInfo, SshApiError, type ConnectionRecord, type ConnectionConfig, type TunnelRuntimeInfo } from "./utils/api";
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
  const [showSessionTransfer, setShowSessionTransfer] = createSignal(false);
  const [showKeyManager, setShowKeyManager] = createSignal(false);
  const [showNewFolderDialog, setShowNewFolderDialog] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  const [newFolderParentId, setNewFolderParentId] = createSignal<string | null>(null);
  const [newFolderTouched, setNewFolderTouched] = createSignal(false);
  const [editingConnection, setEditingConnection] = createSignal<ConnectionConfig | null>(null);
  const [newConnectionDefaultFolderId, setNewConnectionDefaultFolderId] = createSignal<string | undefined>(undefined);
  const [newConnectionDefaultProtocol, setNewConnectionDefaultProtocol] = createSignal<string>("ssh");
  const [protocols, setProtocols] = createSignal<ProtocolInfo[]>([]);
  const sessions = sessionStore.sessions;
  const setSessions = sessionStore.setSessions;
  const activeSessionId = sessionStore.activeSessionId;
  const setActiveSessionId = sessionStore.setActiveSessionId;
  const [assetListActive, setAssetListActive] = createSignal(false);
  const [rightPanelWidth, setRightPanelWidth] = createSignal(Number(localStorage.getItem("portnest-right-panel-width")) || 390);
  const [sidebarWidth, setSidebarWidth] = createSignal(Number(localStorage.getItem("portnest-sidebar-width")) || 286);
  const [tabContextMenu, setTabContextMenu] = createSignal<ContextMenuState>(null);
  const [showAppMenu, setShowAppMenu] = createSignal(false);
  const [showAbout, setShowAbout] = createSignal(false);
  const [showAIAssistant, setShowAIAssistant] = createSignal(false);
  const [aiAssistantMode, setAiAssistantMode] = createSignal<AssistantMode>("general");
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [saveCloseChoice, setSaveCloseChoice] = createSignal(false);
  const [isWindowMaximized, setIsWindowMaximized] = createSignal(false);
  const [appVersion, setAppVersion] = createSignal(packageInfo.version);
  const [showCommandComposer, setShowCommandComposer] = createSignal(false);
  const [composerHeight, setComposerHeight] = createSignal(Number(localStorage.getItem("portnest-composer-height")) || 320);

  // 拖动撰写窗格上缘分界条调整窗格高度；外窗口尺寸不变，终端区自动让出空间（内部滚动）。
  const startComposerResize = (event: MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = composerHeight();
    document.body.style.userSelect = "none";
    const onMove = (move: MouseEvent) => {
      setComposerHeight(Math.max(140, Math.min(600, startHeight - (move.clientY - startY))));
    };
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      document.body.style.userSelect = "";
      localStorage.setItem("portnest-composer-height", String(composerHeight()));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  const [showTunnels, setShowTunnels] = createSignal(false);
  const [tunnelConnection, setTunnelConnection] = createSignal<ConnectionRecord | null>(null);
  const [showQuickSwitcher, setShowQuickSwitcher] = createSignal(false);
  const [quickQuery, setQuickQuery] = createSignal("");
  const [tunnelRuntimes, setTunnelRuntimes] = createSignal<TunnelRuntimeInfo[]>([]);
  const reconnectTimers = new Map<string, number>();
  let allowWindowClose = false;
  let unlistenWindowClose: (() => void) | undefined;

  const closeActionStorageKey = "portnest-window-close-action";
  const rememberedCloseAction = (): "close" | "fold" | null => {
    const action = localStorage.getItem(closeActionStorageKey);
    return action === "close" || action === "fold" ? action : null;
  };
  const openCloseConfirm = () => {
    setSaveCloseChoice(rememberedCloseAction() !== null);
    setShowCloseConfirm(true);
  };
  const saveClosePreference = (action: "close" | "fold") => {
    if (saveCloseChoice()) localStorage.setItem(closeActionStorageKey, action);
    else localStorage.removeItem(closeActionStorageKey);
  };
  const confirmWindowClose = async (remember = true) => {
    if (remember) saveClosePreference("close");
    allowWindowClose = true;
    setShowCloseConfirm(false);
    if (isTauriRuntime()) {
      unlistenWindowClose?.();
      unlistenWindowClose = undefined;
      try {
        await invoke("quit_app");
      } catch (error) {
        console.error("[window] unable to quit application", error);
        await getCurrentWindow().destroy().catch(destroyError => {
          console.error("[window] unable to destroy main window", destroyError);
        });
      }
      return;
    }
    window.close();
  };
  const foldWindow = async (remember = true) => {
    if (remember) saveClosePreference("fold");
    setShowCloseConfirm(false);
    if (!isTauriRuntime()) return;
    try {
      const mainWindow = getCurrentWindow();
      await mainWindow.setSkipTaskbar(true);
      await mainWindow.hide();
    } catch (error) {
      console.warn("[window] unable to fold window to tray", error);
    }
  };
  const openAIAssistant = (mode: AssistantMode = "general") => {
    setAiAssistantMode(mode);
    setShowAIAssistant(true);
  };
  const requestWindowClose = () => {
    const action = rememberedCloseAction();
    if (action === "close") { void confirmWindowClose(false); return; }
    if (action === "fold") { void foldWindow(false); return; }
    openCloseConfirm();
  };
  const toggleWindowMaximize = async () => {
    if (!isTauriRuntime()) return;
    const appWindow = getCurrentWindow();
    await appWindow.toggleMaximize();
    setIsWindowMaximized(await appWindow.isMaximized());
  };

  onMount(() => {
    if (!isTauriRuntime()) return;
    const appWindow = getCurrentWindow();
    const windowSizeStorageKey = "portnest-window-size-v1";
    const windowFitStorageKey = "portnest-window-fit-v4";
    let unlistenResize: (() => void) | undefined;
    let resizeSaveTimer: number | undefined;
    let windowLayoutReady = false;

    const readSavedWindowSize = () => {
      try {
        const raw = localStorage.getItem(windowSizeStorageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
        const width = Number(parsed.width);
        const height = Number(parsed.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 480 || height < 360) return null;
        return { width: Math.round(width), height: Math.round(height) };
      } catch {
        return null;
      }
    };

    const persistWindowSize = async () => {
      if (!windowLayoutReady) return;
      try {
        if (await appWindow.isMaximized()) return;
        const [size, scale] = await Promise.all([appWindow.innerSize(), appWindow.scaleFactor()]);
        const width = Math.round(size.width / scale);
        const height = Math.round(size.height / scale);
        if (width < 480 || height < 360) return;
        localStorage.setItem(windowSizeStorageKey, JSON.stringify({ width, height }));
      } catch (error) {
        console.warn("[window] unable to persist window size", error);
      }
    };

    const applyInitialWindowSize = async () => {
      const saved = readSavedWindowSize();
      if (saved) {
        const maxWidth = Math.max(960, Math.min(1880, Math.round(window.screen.availWidth * .98)));
        const maxHeight = Math.max(600, Math.min(1160, Math.round(window.screen.availHeight * .98)));
        const width = Math.max(960, Math.min(saved.width, maxWidth));
        const height = Math.max(600, Math.min(saved.height, maxHeight));
        await appWindow.setSize(new LogicalSize(width, height));
        await appWindow.center();
        return;
      }
      if (localStorage.getItem(windowFitStorageKey) !== "1") {
        const width = Math.max(960, Math.min(1880, Math.round(window.screen.availWidth * 0.96)));
        const height = Math.max(600, Math.min(1160, Math.round(window.screen.availHeight * 0.93)));
        await appWindow.setSize(new LogicalSize(width, height));
        await appWindow.center();
        localStorage.setItem(windowFitStorageKey, "1");
      }
    };

    void applyInitialWindowSize()
      .catch(error => console.warn("[window] unable to apply initial window size", error))
      .finally(() => {
        window.setTimeout(() => { windowLayoutReady = true; }, 450);
      });

    void appWindow.isMaximized().then(setIsWindowMaximized);
    void appWindow.onCloseRequested(event => {
      if (allowWindowClose) return;
      void persistWindowSize();
      event.preventDefault();
      requestWindowClose();
    }).then(unlisten => { unlistenWindowClose = unlisten; });
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then(setIsWindowMaximized);
      if (!windowLayoutReady) return;
      window.clearTimeout(resizeSaveTimer);
      resizeSaveTimer = window.setTimeout(() => { void persistWindowSize(); }, 450);
    }).then(unlisten => { unlistenResize = unlisten; });
    onCleanup(() => {
      window.clearTimeout(resizeSaveTimer);
      unlistenWindowClose?.();
      unlistenResize?.();
    });
  });

  const activeSession = () => sessions().find(s => s.id === activeSessionId());

  // 服务器概览开合会改变终端区宽度。ResizeObserver 的防抖偶发漏掉最终一次
  // 布局，导致 xterm 画布与容器不一致（终端显示异常）。这里在布局稳定后
  // 对活动会话终端强制再执行一次 fit + resizeShell。
  createEffect(() => {
    const collapsed = uiStore.overviewCollapsed();
    const sessionId = activeSessionId();
    if (!sessionId) return;
    const handle = window.setTimeout(() => {
      refitTerminal(sessionId);
    }, 160);
    onCleanup(() => window.clearTimeout(handle));
    void collapsed;
  });
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
    if (isTauriRuntime()) {
      try { setAppVersion(await getVersion()); } catch (error) { console.warn("[version] unable to read runtime version", error); }
    }
    initTheme();

    if (!isTauriRuntime()) {
      setProtocols([{ id: "ssh", name: "SSH" }, { id: "local", name: "本地终端" }, { id: "mysql", name: "MySQL" }, { id: "postgresql", name: "PostgreSQL" }, { id: "highgo", name: "HighGo 瀚高数据库" }]);
      sessionStore.hydrate([]);
      return;
    }

    // Load connections from database first
    await connectionStore.loadConnections();
    sessionStore.hydrate(connectionStore.state.connections);

    try {
      const supportedProtocols = await api.getProtocols();
      setProtocols(supportedProtocols.filter(protocol => ["ssh", "local", "mysql", "postgresql", "highgo"].includes(protocol.id)));
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
    if (modifier && !event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault(); handleNewConnection(); return;
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
    if (modifier && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault(); openAIAssistant("general"); return;
    }
    if (event.ctrlKey && event.key === "Tab" && sessions().length > 1) {
      event.preventDefault();
      const current = sessions().findIndex(session => session.id === activeSessionId());
      const direction = event.shiftKey ? -1 : 1;
      const next = (current + direction + sessions().length) % sessions().length;
      handleSwitchSession(sessions()[next].id);
    }
  };
  onMount(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    const unregisterAgentLauncher = aiContextStore.registerAgentLauncher(mode => openAIAssistant(mode));
    onCleanup(unregisterAgentLauncher);
  });
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

  const recoverChangedHostKey = async (sessionId: string, conn: ConnectionRecord, cause: unknown) => {
    if (!(cause instanceof SshApiError) || cause.code !== "HOST_KEY") return false;
    const fingerprint = cause.message.match(/新指纹:\s*(\S+)/)?.[1];
    if (!fingerprint) return false;
    const accepted = await feedback.confirm(
      `${cause.message}\n\n这可能是服务器重装导致，也可能表示连接被劫持。请先通过服务器控制台或可信渠道核对新指纹。确认该变化可信后，是否移除旧记录并重新连接？`,
      "SSH 主机身份已变化",
    );
    if (!accepted || !sessions().some(session => session.id === sessionId)) return false;
    await api.updateSshHostKey(conn.id, fingerprint);
    await openShellForSession(sessionId, conn);
    feedback.success(`已更新 ${conn.host}:${conn.port} 的 SSH 主机密钥`);
    return true;
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
          try {
            if (await recoverChangedHostKey(sessionId, conn, e)) return;
          } catch (recoveryError) {
            e = recoveryError;
            console.error("SSH host key recovery failed:", recoveryError);
          }
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
    } else if (isDatabaseProtocol(conn.protocol)) {
      const sessionId = createSession(conn);
      try {
        await api.databaseConnect(conn.id);
        sessionStore.update(sessionId, { status: "connected", error: undefined, viewMode: "database" });
      } catch (e) {
        sessionStore.update(sessionId, { status: "error", error: String(e), viewMode: "database" });
      }
    } else {
      feedback.info("当前版本专注于 SSH / SFTP，其他连接能力将在后续版本开放。");
    }
  };

  // Release any remote resources owned by session before it is dropped from state.
  // Called from handleCloseSession. remainingSessions is the post-close snapshot so we
  // can decide whether this session was the last tab of a given connection (relevant for
  // docker, which uses a single per-connection session).
  const closeSessionResources = async (session: SessionTab, remainingSessions: SessionTab[]) => {
    if (session.shellId) {
      try {
        await api.disconnectShell(session.shellId);
      } catch (e) {
        console.error("[closeSessionResources] disconnectShell failed:", session.id, e);
      }
    }
    if (isDatabaseProtocol(session.connection.protocol) && !remainingSessions.some(item => item.connection.id === session.connection.id)) {
      try { await api.databaseDisconnect(session.connection.id); } catch (e) { console.error("[database] disconnect failed", e); }
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
    if (!session) return;
    if (isDatabaseProtocol(session.connection.protocol)) {
      sessionStore.update(sessionId, { status: "connecting", error: undefined });
      try { await api.databaseConnect(session.connection.id); sessionStore.update(sessionId, { status: "connected", viewMode: "database" }); }
      catch (e) { sessionStore.update(sessionId, { status: "error", error: String(e), viewMode: "database" }); }
      return;
    }
    if (session.connection.protocol !== "ssh" && session.connection.protocol !== "local") return;
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
      try {
        if (await recoverChangedHostKey(sessionId, session.connection, e)) return;
      } catch (recoveryError) {
        e = recoveryError;
        console.error("[handleReconnect] SSH host key recovery failed:", recoveryError);
      }
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

  const handleSessionEnded = (sessionId: string) => {
    sessionStore.update(sessionId, { status: "disconnected", error: undefined, shellId: undefined });
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
    } else if (isDatabaseProtocol(session.connection.protocol)) {
      void api.databaseConnect(session.connection.id)
        .then(() => sessionStore.update(newSessionId, { status: "connected", viewMode: "database" }))
        .catch(error => sessionStore.update(newSessionId, { status: "error", error: String(error), viewMode: "database" }));
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

  const handleNewConnection = (folderId?: string, protocol?: string) => {
    setNewConnectionDefaultFolderId(folderId);
    setNewConnectionDefaultProtocol(protocol || (uiStore.assetFilter() === "database" ? "mysql" : "ssh"));
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
      throw e;
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

  const folderNameError = () => {
    const name = newFolderName().trim();
    if (!name) return "请输入文件夹名称";
    if (name.length > 64) return "文件夹名称不能超过 64 个字符";
    const parentId = newFolderParentId();
    if (connectionStore.state.folders.some(folder => folder.parentId === parentId && folder.name.trim().toLowerCase() === name.toLowerCase())) {
      return "当前目录已存在同名文件夹";
    }
    return "";
  };

  const folderBreadcrumb = (folderId: string | null) => {
    if (!folderId) return "资产列表";
    const parts: string[] = [];
    let current = connectionStore.state.folders.find(folder => folder.id === folderId);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      parts.unshift(current.name);
      current = current.parentId
        ? connectionStore.state.folders.find(folder => folder.id === current!.parentId)
        : undefined;
    }
    return ["资产列表", ...parts].join(" / ");
  };

  const handleCreateFolder = async () => {
    setNewFolderTouched(true);
    const name = newFolderName().trim();
    if (!name || folderNameError()) return;
    try {
      await connectionStore.addFolder(name, newFolderParentId());
      setShowNewFolderDialog(false);
      setNewFolderName("");
      setNewFolderParentId(null);
      setNewFolderTouched(false);
    } catch (e) {
      console.error("Create folder error:", e);
      feedback.error("创建文件夹失败: " + e);
    }
  };

  const handleNewFolder = (parentId?: string) => {
    setNewFolderParentId(parentId ?? null);
    setNewFolderName("");
    setNewFolderTouched(false);
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
    const collapseWidth = 50;
    let collapsed = false;
    const finish = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onMouseMove = (moveEvent: MouseEvent) => {
      if (collapsed) return;
      const nextWidth = Math.min(480, startWidth + moveEvent.clientX - startX);
      if (nextWidth <= collapseWidth) {
        collapsed = true;
        setSidebarWidth(startWidth);
        finish();
        uiStore.setAssetTreeVisible(false);
        return;
      }
      setSidebarWidth(nextWidth);
    };
    const onMouseUp = () => {
      if (!collapsed && sidebarWidth() > collapseWidth) {
        localStorage.setItem("portnest-sidebar-width", String(sidebarWidth()));
      }
      finish();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div class="app-container">
      <div class="app-titlebar">
        <span class="titlebar-title" data-tauri-drag-region><b>P</b><span>PortNest</span></span>
        <Show when={activeSession()}>
          <span class="titlebar-active-connection" data-tauri-drag-region>
            <ProtocolIcon kind={activeSession()!.connection.protocol} />
            <span>{activeSession()!.displayName || activeSession()!.connection.name}</span>
          </span>
        </Show>
        <div class="titlebar-spacer" data-tauri-drag-region />
        <div class="titlebar-actions">
          <button class="titlebar-btn titlebar-quick-switch" title="快速切换 Ctrl+K" aria-label="快速切换" onClick={() => { setQuickQuery(""); setShowQuickSwitcher(true); }}>
            <Icon name="search" />
          </button>
          <button class="titlebar-btn" title="设置" aria-label="设置" onClick={() => void openSettingsWindow()}>
            <Icon name="settings" />
          </button>
          <div class="titlebar-workspace-status">
            <span class="status-dot online" /> SSH / SFTP
          </div>
          <div class="titlebar-controls">
          <div class="app-menu-container">
            <button class="titlebar-btn" onClick={() => setShowAppMenu(!showAppMenu())}>
              <Icon name="more" />
            </button>
            <Show when={showAppMenu()}>
              <div class="app-menu-dropdown">
                <button class="app-menu-item" onClick={() => { setShowAppMenu(false); handleNewConnection(); }}>
                  <span class="app-menu-icon"><Icon name="plus" size={14} /></span>
                  <span class="app-menu-label">新建连接</span>
                  <span class="app-menu-shortcut">Ctrl+N</span>
                </button>
                <button class="app-menu-item" onClick={() => { setShowAppMenu(false); setQuickQuery(""); setShowQuickSwitcher(true); }}>
                  <span class="app-menu-icon"><Icon name="search" size={14} /></span>
                  <span class="app-menu-label">快速搜索</span>
                  <span class="app-menu-shortcut">Ctrl+K</span>
                </button>
                <Show when={activeSession()}>
                  <button class="app-menu-item" onClick={() => { handleBack(); setShowAppMenu(false); }}>
                    <span class="app-menu-icon"><Icon name="back" size={14} /></span>
                    <span class="app-menu-label">关闭当前标签</span>
                    <span class="app-menu-shortcut">Ctrl+W</span>
                  </button>
                </Show>
                <div class="app-menu-divider" />
                <button class="app-menu-item" onClick={() => { setShowSessionTransfer(true); setShowAppMenu(false); }}>
                  <span class="app-menu-icon"><Icon name="transfer" size={14} /></span>
                  <span class="app-menu-label">导入 / 导出会话</span>
                </button>
                <button class="app-menu-item" onClick={() => { setShowKeyManager(true); setShowAppMenu(false); }}>
                  <span class="app-menu-icon"><Icon name="key" size={14} /></span>
                  <span class="app-menu-label">密钥管理器</span>
                </button>
                <button class="app-menu-item" onClick={() => { void openSettingsWindow(); setShowAppMenu(false); }}>
                  <span class="app-menu-icon"><Icon name="settings" size={14} /></span>
                  <span class="app-menu-label">设置</span>
                </button>
                <div class="app-menu-divider" />
                <button class="app-menu-item" onClick={() => { setShowAbout(true); setShowAppMenu(false); }}>
                  <span class="app-menu-icon"><Icon name="info" size={14} /></span>
                  <span class="app-menu-label">关于 PortNest</span>
                </button>
                <button class="app-menu-item" onClick={() => { setShowAppMenu(false); openCloseConfirm(); }}>
                  <span class="app-menu-icon"><Icon name="close" size={14} /></span>
                  <span class="app-menu-label">关闭窗口</span>
                  <span class="app-menu-shortcut">Alt+F4</span>
                </button>
              </div>
              <div class="app-menu-overlay" onClick={() => setShowAppMenu(false)} />
            </Show>
          </div>
          <div class="titlebar-window-controls">
            <button class="titlebar-btn titlebar-btn-win" onClick={() => withAppWindow(appWindow => appWindow.minimize())} title="最小化" aria-label="最小化窗口">
              <Icon name="minimize" />
            </button>
            <button class="titlebar-btn titlebar-btn-win" onClick={() => void toggleWindowMaximize()} title={isWindowMaximized() ? "还原窗口" : "最大化"} aria-label={isWindowMaximized() ? "还原窗口" : "最大化窗口"}>
              <Icon name={isWindowMaximized() ? "restore" : "maximize"} />
            </button>
            <button class="titlebar-btn titlebar-btn-win titlebar-btn-close" onClick={requestWindowClose} title="关闭" aria-label="关闭窗口">
              <Icon name="close" />
            </button>
          </div>
          </div>
        </div>
      </div>
      <div class={`app-body ${showAIAssistant() ? "ai-dock-open" : ""} ${uiStore.filesStacked() && activeSession() && !assetListActive() && !uiStore.filesCollapsed() && !showAIAssistant() ? "files-layout-stacked" : ""}`}>
        <Sidebar
          width={sidebarWidth()}
          selectedId={activeSession()?.connection.id}
          onConnect={handleConnect}
          onEdit={handleEdit}
          onDelete={handleDelete}
        onOpenSettings={() => void openSettingsWindow()}
        onOpenAI={() => { if (showAIAssistant()) setShowAIAssistant(false); else openAIAssistant("general"); }}
        aiOpen={showAIAssistant()}
        onCloseAI={() => setShowAIAssistant(false)}
        onOpenTransfer={() => setShowSessionTransfer(true)}
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
            onOpenTransfer={() => setShowSessionTransfer(true)}
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
                <Icon name="list" /> 列表
              </button>
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
                        <span class="session-tab-pin" title="已固定"><Icon name="pin" size={13} /></span>
                      </Show>
                      <span class="session-tab-terminal-icon"><ProtocolIcon kind={session.connection.protocol} /></span>
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
                        <Icon name="close" size={12} />
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
                <button class="tab-context-menu-item" onClick={() => handleReconnect(tabContextMenu()!.sessionId)}>
                  <Icon name="refresh" size={14} /><span>断开重连</span>
                </button>
                <div class="tab-context-menu-divider" />
              </Show>
              <button class="tab-context-menu-item" onClick={() => handleRename(tabContextMenu()!.sessionId)}>
                <Icon name="edit" size={14} /><span>重命名</span>
              </button>
              <button class="tab-context-menu-item" onClick={() => handleCopyConnectionInfo(tabContextMenu()!.sessionId)}>
                <Icon name="copy" size={14} /><span>复制连接信息</span>
              </button>
              <button class="tab-context-menu-item" onClick={() => handleDuplicateSession(tabContextMenu()!.sessionId)}>
                <Icon name="copy" size={14} /><span>复制标签页</span>
              </button>
              <div class="tab-context-menu-divider" />
              <button class="tab-context-menu-item" onClick={() => handleCloseOthers(tabContextMenu()!.sessionId)}>
                <Icon name="close" size={14} /><span>关闭其他</span>
              </button>
              <button class="tab-context-menu-item" onClick={() => handleCloseRight(tabContextMenu()!.sessionId)}>
                <Icon name="close" size={14} /><span>关闭右侧</span>
              </button>
              <button class="tab-context-menu-item" onClick={() => handleCloseAll()}>
                <Icon name="close" size={14} /><span>关闭全部</span>
              </button>
              <div class="tab-context-menu-divider" />
              <button class="tab-context-menu-item" onClick={() => handleTogglePin(tabContextMenu()!.sessionId)}>
                <Icon name="pin" size={14} /><span>{tabContextMenuTarget()?.pinned ? "取消固定" : "固定标签"}</span>
              </button>
              <div class="tab-context-menu-divider" />
              <button class="tab-context-menu-item" onClick={() => {
                handleCloseSession(tabContextMenu()!.sessionId);
                setTabContextMenu(null);
              }}>
                <Icon name="close" size={14} /><span>关闭标签页</span>
              </button>
            </div>
            <div class="tab-context-menu-overlay" onClick={() => setTabContextMenu(null)} />
          </Show>

          <Show when={!assetListActive() && activeSession()}>{session => (
            <div class="session-action-bar">
              <div class="session-action-identity">
                <span class={`session-status-dot status-${session().status}`} />
                <strong>{session().status === "connected" ? "已连接" : session().status === "connecting" ? "连接中" : session().status === "reconnecting" ? `重连中 ${session().reconnectAttempt || ""}` : session().status === "restored" ? "离线恢复" : session().status === "error" ? "连接错误" : session().error ? "已断开" : "已结束"}</strong>
                <span>{session().connection.protocol === "local"
                  ? `本机 · ${localShellDisplayName(parseLocalProfile(session().connection.options).shell_type)}`
                  : `${session().connection.username}@${session().connection.host}:${session().connection.port}`}</span>
              </div>
              <div class="session-action-controls">
                <Show when={!isDatabaseProtocol(session().connection.protocol)}><label>编码<select value={session().encodingOverride || session().encoding || "UTF-8"} disabled={!session().shellId} onChange={event => void handleSetEncoding(session().id, event.currentTarget.value)}>
                  <option>UTF-8</option><option>GBK</option><option>GB2312</option><option>GB18030</option><option>Big5</option><option>Shift-JIS</option><option>EUC-KR</option><option>ISO-8859-1</option><option>Windows-1252</option><option>CP437</option>
                </select></label></Show>
                <Show when={session().connection.protocol === "ssh"}>
                  <button onClick={() => { setTunnelConnection(session().connection); setShowTunnels(true); }}>⇄ 隧道 {runningTunnelCount(session().connection.id) || ""}</button>
                </Show>
                <Show when={!isDatabaseProtocol(session().connection.protocol)}><button disabled={sessions().filter(item => item.status === "connected").length === 0} aria-expanded={showCommandComposer()} onClick={() => { setShowCommandComposer(value => !value); }}>⌁ 命令广播</button></Show>
                <button class={`session-ai-action ${isDatabaseProtocol(session().connection.protocol) ? "sql" : "terminal"}`} onClick={() => openAIAssistant(isDatabaseProtocol(session().connection.protocol) ? "sql" : "terminal")}>
                  <Icon name="sparkles" size={13} /> AI {isDatabaseProtocol(session().connection.protocol) ? "SQL" : "终端"}
                </button>
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
                onOpenTransfer={() => setShowSessionTransfer(true)}
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
                        onEnded={() => handleSessionEnded(session.id)}
                      />
                    )}
                    <Show when={isDatabaseProtocol(session.connection.protocol) && session.status === "connected"}>
                      <DatabaseWorkspace connection={session.connection} visible={sessionVisible()} onCloseConnection={() => void handleCloseSession(session.id)} />
                    </Show>
                    <Show when={(isDatabaseProtocol(session.connection.protocol) ? session.status !== "connected" : !session.shellId || session.status !== "connected")}>
                      <div class={`session-state-overlay state-${session.status}`}>
                        <span class={`session-state-icon status-${session.status}`}>{session.status === "connecting" || session.status === "reconnecting" ? "◌" : session.status === "error" ? "!" : "›_"}</span>
                        <h3>{session.status === "restored" ? "会话已从上次工作区恢复"
                          : session.status === "connecting" ? (session.connection.protocol === "local" ? "正在打开本地终端" : "正在建立 SSH 连接")
                          : session.status === "reconnecting" ? (session.connection.protocol === "local" ? "正在重新打开本地终端" : "正在重新连接")
                          : session.status === "error" ? (session.connection.protocol === "local" ? "本地终端打开失败" : "SSH 连接失败")
                          : (session.connection.protocol === "local" ? "本地终端已关闭" : session.error ? "SSH 会话已断开" : "SSH 会话已结束")}</h3>
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
           <Show when={showCommandComposer() && !!activeSession() && !isDatabaseProtocol(activeSession()!.connection.protocol)}>
             <div class="command-composer-resizer" aria-hidden="true" onMouseDown={startComposerResize} />
             <CommandBroadcast sessions={sessions()} activeSessionId={activeSessionId()} onClose={() => setShowCommandComposer(false)} height={composerHeight()} />
           </Show>
        </main>
        <Show when={showRightPanel() && !showAIAssistant()}>
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
        {/* 服务器概览：SSH 会话激活或面板展开时显示；收起时为右缘精简导轨。
            仅在会话健康（connected）时采集；总开关关闭时整个面板不渲染，
            卸载时取消采集并释放会话租约。 */}
        <Show when={(showRightPanel() || (activeSession()?.connection.protocol === "ssh" && !uiStore.overviewCollapsed())) && getOverviewSettings().enabled && !showAIAssistant()}>
          <ServerOverview connection={activeSession()?.connection} sessionConnected={activeSession()?.status === "connected"} />
        </Show>
      </Show>

      <Show when={showForm()}>
        <ConnectionForm
          connection={editingConnection() || undefined}
          protocols={protocols()}
          onSave={handleSave}
          onCancel={handleCancel}
          defaultFolderId={newConnectionDefaultFolderId()}
          defaultProtocol={newConnectionDefaultProtocol()}
        />
      </Show>

      <Show when={showSessionTransfer()}>
        <SessionImportExport onClose={() => setShowSessionTransfer(false)} />
      </Show>
      <Show when={showKeyManager()}>
        <SshKeyPicker onClose={() => setShowKeyManager(false)} onSelect={() => setShowKeyManager(false)} />
      </Show>

      <Show when={showNewFolderDialog()}>
        <div class="modal-overlay folder-create-overlay" onClick={() => setShowNewFolderDialog(false)}>
          <div
            class="folder-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-create-title"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === "Escape") setShowNewFolderDialog(false);
              if (event.key === "Enter" && (event.target as HTMLElement)?.tagName === "INPUT") {
                event.preventDefault();
                void handleCreateFolder();
              }
            }}
          >
            <header class="folder-create-header">
              <span class="folder-create-icon"><Icon name="folder" size={22} /></span>
              <div class="folder-create-heading">
                <span>{newFolderParentId() ? "子文件夹" : "资产组织"}</span>
                <h3 id="folder-create-title">{newFolderParentId() ? "新建子文件夹" : "新建文件夹"}</h3>
                <p>用一个清晰的名称整理连接资产。</p>
              </div>
              <button type="button" class="folder-create-close" onClick={() => setShowNewFolderDialog(false)} aria-label="关闭">
                <Icon name="close" size={16} />
              </button>
            </header>

            <div class="folder-create-body">
              <div class="folder-location-card">
                <span class="folder-location-icon"><Icon name="folderOpen" size={16} /></span>
                <div>
                  <small>创建位置</small>
                  <strong>{folderBreadcrumb(newFolderParentId())}</strong>
                </div>
              </div>

              <label class={`folder-name-field ${newFolderTouched() && folderNameError() ? "invalid" : ""}`}>
                <span>文件夹名称</span>
                <div class="folder-name-input">
                  <Icon name="folder" size={16} />
                  <input
                    autofocus
                    type="text"
                    maxlength={64}
                    placeholder="例如：生产环境"
                    value={newFolderName()}
                    onInput={event => setNewFolderName(event.currentTarget.value)}
                    onBlur={() => setNewFolderTouched(true)}
                  />
                  <Show when={newFolderName()}>
                    <button type="button" class="folder-name-clear" onClick={() => setNewFolderName("")} aria-label="清空名称">
                      <Icon name="close" size={13} />
                    </button>
                  </Show>
                </div>
                <div class="folder-name-meta">
                  <span class="folder-name-message">{newFolderTouched() && folderNameError() ? folderNameError() : "名称只用于资产列表展示，不会影响已有连接。"}</span>
                  <span class="folder-name-count">{newFolderName().length}/64</span>
                </div>
              </label>
            </div>

            <footer class="folder-create-footer">
              <span class="folder-dialog-hint"><kbd>Enter</kbd> 创建 <kbd>Esc</kbd> 关闭</span>
              <div class="folder-create-actions">
                <button type="button" class="connect-cancel-button" onClick={() => setShowNewFolderDialog(false)}>取消</button>
                <button type="button" class="connect-save-button primary" disabled={!!folderNameError()} onClick={() => void handleCreateFolder()}>创建文件夹</button>
              </div>
            </footer>
          </div>
        </div>
      </Show>

      <Show when={showAbout()}>
        <div class="modal-overlay" onClick={() => setShowAbout(false)}>
          <div class="modal-content" onClick={(e) => e.stopPropagation()} style={{ "max-width": "360px" }}>
            <h2>PortNest</h2>
            <p style={{ color: "var(--text-secondary)", "margin-bottom": "12px" }}>安全、专注的 SSH / SFTP 工作区</p>
            <p style={{ color: "var(--text-muted)", "font-size": "13px", "margin-bottom": "8px" }}>
              版本 {appVersion()} · 基于 Tauri 2.0 + SolidJS
            </p>
            <p style={{ color: "var(--text-muted)", "font-size": "13px" }}>
              支持 SSH、SFTP、本地终端与 MySQL / PostgreSQL / 瀚高数据库管理
            </p>
            <div class="form-actions" style={{ "margin-top": "20px" }}>
              <button class="btn-save" onClick={() => setShowAbout(false)}>关闭</button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={showCloseConfirm()}>
        <div class="modal-overlay close-confirm-overlay" role="presentation" onClick={() => setShowCloseConfirm(false)}>
          <div class="close-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="close-confirm-title" aria-describedby="close-confirm-description" onClick={event => event.stopPropagation()}>
            <h3 id="close-confirm-title" class="close-confirm-title">关闭窗口</h3>
            <div id="close-confirm-description" class="close-confirm-body">请选择关闭/折叠</div>
            <div class="close-confirm-footer">
              <label class="close-confirm-remember">
                <input type="checkbox" checked={saveCloseChoice()} onChange={event => setSaveCloseChoice(event.currentTarget.checked)} />
                <span>保存此次选项</span>
              </label>
              <div class="close-confirm-actions">
                <button type="button" class="close-confirm-action close-confirm-cancel" onClick={() => setShowCloseConfirm(false)}>取消</button>
                <button type="button" class="close-confirm-action close-confirm-exit" onClick={() => void confirmWindowClose()}>关闭</button>
                <button type="button" class="close-confirm-action close-confirm-fold" title="折叠到系统托盘" onClick={() => void foldWindow()}>折叠</button>
              </div>
            </div>
          </div>
        </div>
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
      <Show when={showAIAssistant()}>
        <AIAssistant connection={activeSession()?.connection} shellId={activeSession()?.shellId} initialMode={aiAssistantMode()} onModeChange={setAiAssistantMode} terminalContext={() => { const session = activeSession(); if (!session) return ""; const transcript = readTerminalTranscript(session.id, 160); const selection = readTerminalSelection(session.id); return [selection ? "当前终端选区:\n" + selection : "", transcript ? "最近终端输出:\n" + transcript : ""].filter(Boolean).join("\n\n"); }} sqlContext={() => { const base = aiContextStore.sqlContext(); const selection = aiContextStore.sqlSelection(); return [base, selection ? "当前 SQL 选区:\n" + selection : ""].filter(Boolean).join("\n\n"); }} onClose={() => setShowAIAssistant(false)} />
      </Show>
      <FeedbackHost />
      <TextContextMenu />
      </div>
    </div>
  );
};

export default App;
