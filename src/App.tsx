import { Component, createSignal, onMount, Show, For, createEffect, on, createMemo } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { RightPanel } from "./components/RightPanel";
import { ConnectionForm } from "./components/ConnectionForm";
import { QueryEditor } from "./components/QueryEditor";
import { AIChat } from "./components/AIChat";
import { TerminalView } from "./components/TerminalView";
import { FileManager } from "./components/FileManager";
import { SettingsModal } from "./components/SettingsModal";
import { DockerDashboard } from "./components/DockerDashboard";
import { connectionStore, ConnectionRecord, ConnectionConfig } from "./stores/connectionStore";
import { initTheme } from "./stores/themeStore";
import { api, dockerApi, ProtocolInfo } from "./utils/api";
import "./App.css";

type ViewMode = "terminal" | "query" | "ai" | "files" | "docker";

type SessionTab = {
  id: string;
  connection: ConnectionRecord;
  viewMode: ViewMode;
  activeTab: "query" | "structure" | "security" | "monitor" | "ai";
  displayName?: string;
  shellId?: string;
  sftpId?: string;
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

  const isSessionActive = (sessionId: string) => createMemo(() => activeSessionId() === sessionId);

  const renderSessionContent = () => {
    const session = activeSession();
    if (!session) return null;

    const renderTerminal = () => (
      <TerminalView
        key={session.id}
        sessionKey={session.id}
        connection={session.connection}
        visible={true}
        shellId={session.shellId}
      />
    );

    const renderFileManager = () => (
      <FileManager
        key={session.id + "-files"}
        sessionKey={session.id}
        connection={session.connection}
        sftpId={session.sftpId}
      />
    );

    const renderQueryEditor = () => (
      <QueryEditor key={session.id} connection={session.connection} />
    );

    const renderDocker = () => (
      <DockerDashboard key={session.id} connectionId={session.id} />
    );

    if (session.connection.protocol === "ssh") {
      if (session.viewMode === "files") {
        return renderFileManager();
      }
      return renderTerminal();
    }

    if (session.connection.protocol === "mysql" || session.connection.protocol === "postgresql") {
      return renderQueryEditor();
    }

    if (session.connection.protocol === "docker") {
      return renderDocker();
    }

    return null;
  };

  const generateDisplayName = (conn: ConnectionRecord) => {
    const existingCount = sessions().filter(s => s.connection.id === conn.id).length;
    return existingCount > 0 ? `${conn.name}(${existingCount + 1})` : conn.name;
  };

  onMount(async () => {
    initTheme();
    try {
      const supportedProtocols = await api.getProtocols();
      setProtocols(supportedProtocols);
    } catch (e) {
      console.error("Failed to get protocols:", e);
    }

    // Create built-in SSH test connection if not exists
    try {
      const connections = await api.getConnections();
      const hasTestConnection = connections.some(c => c.name === "测试" && c.host === "192.0.2.10");
      if (!hasTestConnection) {
        await api.saveConnection({
          name: "测试",
          protocol: "ssh",
          host: "192.0.2.10",
          port: 22,
          username: "root",
          auth_type: "password",
          password: "",
        });
        await connectionStore.loadConnections();
      }
    } catch (e) {
      console.error("Failed to create test connection:", e);
    }
  });

  const BUILTIN_CONNECTIONS = [
    {
      id: "builtin-test-ssh",
      name: "测试",
      protocol: "ssh",
      host: "192.0.2.10",
      port: 22,
      username: "root",
      password: "",
      auth_type: "password",
      folder_id: undefined,
      created_at: 0,
      updated_at: 0,
    }
  ];

  const isBuiltinConnection = (connId: string) => connId.startsWith("builtin-");

  const createSession = (conn: ConnectionRecord, viewMode: ViewMode = "terminal") => {
    const sessionId = `${conn.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const displayName = generateDisplayName(conn);
    const newSession: SessionTab = {
      id: sessionId,
      connection: conn,
      viewMode,
      activeTab: "query",
      displayName,
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

  const openSftpForSession = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    if (!session || session.sftpId || !session.shellId) return;

    console.log("[openSftp] Opening SFTP via shell:", sessionId);
    try {
      const sftpResponse = await api.openSftpForShell(session.shellId);
      if (!sessions().some(s => s.id === sessionId)) {
        await api.closeSftp(sftpResponse.sftp_id);
        return;
      }
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, sftpId: sftpResponse.sftp_id } : s
      ));
    } catch (e) {
      console.error("Failed to open SFTP:", e);
    }
  };

  const handleConnect = async (conn: ConnectionRecord) => {
    console.log("[handleConnect] Starting connection:", conn.name, conn.id, "builtin:", isBuiltinConnection(conn.id));

    if (conn.protocol === "docker") {
      try {
        await dockerApi.connect(conn.id);
      } catch (e) {
        console.error("Docker connection failed:", e);
        alert("Docker 连接失败: " + e);
        return;
      }
      createSession(conn, "docker");
    } else if (conn.protocol === "ssh") {
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
      createSession(conn, conn.protocol === "mysql" || conn.protocol === "postgresql" ? "query" : "terminal");
    }
  };

  const handleCloseSession = async (sessionId: string) => {
    console.log("[App] handleCloseSession:", sessionId);
    console.log("[App] Current sessions:", sessions().map(s => s.id));

    const currentSessions = sessions();
    const session = currentSessions.find(s => s.id === sessionId);
    const closingActive = activeSessionId() === sessionId;

    if (session) {
      if (session.shellId) {
        try {
          await api.disconnectShell(session.shellId);
        } catch (e) {
          console.error("Failed to disconnect shell:", e);
        }
      }
      if (session.sftpId) {
        try {
          await api.closeSftp(session.sftpId);
        } catch (e) {
          console.error("Failed to close SFTP:", e);
        }
      }
    }

    const newSessions = currentSessions.filter(s => s.id !== sessionId);

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

  const handleSwitchSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
  };

  const handleDuplicateSession = async (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId);
    if (!session || !session.connection?.id) return;

    const newSessionId = `${session.connection.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const displayName = generateDisplayName(session.connection);
    const newSession: SessionTab = {
      id: newSessionId,
      connection: { ...session.connection },
      viewMode: session.viewMode,
      activeTab: session.activeTab,
      displayName,
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
    setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleBack = () => {
    const currentId = activeSessionId();
    if (currentId) {
      handleCloseSession(currentId);
    }
  };

  const switchSessionViewMode = (sessionId: string, mode: ViewMode) => {
    const session = sessions().find(s => s.id === sessionId);
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, viewMode: mode } : s));
    // 切换到文件视图时按需打开 SFTP
    if (mode === "files" && session?.connection.protocol === "ssh") {
      openSftpForSession(sessionId);
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
        await api.deleteConnection(conn.id);
        connectionStore.deleteConnection(conn.id);
      } catch (e) {
        console.error("Delete connection error:", e);
        alert("删除连接失败: " + e);
      }
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
      const folder = await api.createFolder(name);
      connectionStore.addFolder(folder);
      setShowNewFolderDialog(false);
      setNewFolderName("");
    } catch (e) {
      console.error("Create folder error:", e);
      alert("创建文件夹失败: " + e);
    }
  };

  const handleOpenFiles = (conn: ConnectionRecord) => {
    const existingSession = sessions().find(s => s.connection.id === conn.id && s.viewMode === "files");
    if (existingSession) {
      setActiveSessionId(existingSession.id);
      return;
    }
    // 如果有当前连接的终端会话，复用其 SSH 连接打开 SFTP
    const terminalSession = sessions().find(s => s.connection.id === conn.id && s.viewMode === "terminal" && s.shellId);
    if (terminalSession) {
      const sessionId = createSession(conn, "files");
      openSftpForSession(sessionId);
      return;
    }
    // 否则独立打开 SFTP
    const sessionId = createSession(conn, "files");
    if (conn.protocol === "ssh") {
      (async () => {
        try {
          const sftpResponse = await api.openSftp(conn.id);
          setSessions(prev => prev.map(s =>
            s.id === sessionId ? { ...s, sftpId: sftpResponse.sftp_id } : s
          ));
        } catch (e) {
          console.error("Failed to open SFTP:", e);
        }
      })();
    }
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
        <span class="titlebar-title" data-tauri-drag-region>PortNest</span>
        <div class="titlebar-spacer" data-tauri-drag-region />
        <div class="titlebar-controls">
          <Show when={activeSession()}>
            <Show when={activeSession()?.connection.protocol === "ssh"}>
              <button class="titlebar-btn" onClick={() => {
                const s = activeSession();
                if (s) switchSessionViewMode(s.id, s.viewMode === "terminal" ? "files" : "terminal");
              }}>
                {activeSession()?.viewMode === "terminal" ? "📂" : "🖥️"}
              </button>
            </Show>
          </Show>
          <div class="app-menu-container">
            <button class="titlebar-btn" onClick={() => setShowAppMenu(!showAppMenu())}>
              ⋮
            </button>
            <Show when={showAppMenu()}>
              <div class="app-menu-dropdown">
                <Show when={activeSession()?.connection.protocol === "ssh"}>
                  <div class="app-menu-item" onClick={() => {
                    const s = activeSession();
                    if (s) switchSessionViewMode(s.id, s.viewMode === "terminal" ? "files" : "terminal");
                    setShowAppMenu(false);
                  }}>
                    {activeSession()?.viewMode === "terminal" ? "📂 切换到文件视图" : "🖥️ 切换到终端视图"}
                  </div>
                </Show>
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
          onOpenAI={(conn) => {
            const existingSession = sessions().find(s => s.connection.id === conn.id && s.viewMode === "ai");
            if (existingSession) {
              setActiveSessionId(existingSession.id);
            } else {
              const sessionId = createSession(conn, "ai");
              const session = sessions().find(s => s.id === sessionId);
              if (session) {
                session.viewMode = "ai";
                setSessions([...sessions()]);
              }
            }
          }}
          onOpenFiles={handleOpenFiles}
        onOpenSettings={() => setShowSettings(true)}
        onNewConnection={handleNewConnection}
        onNewFolder={() => setShowNewFolderDialog(true)}
        onCopyConnection={handleCopyConnection}
      />

      <Show when={!activeSession()}>
        <main class="main-content">
          <div class="welcome-panel">
            <div class="welcome-header">
              <h1>PortNest</h1>
              <p>一站式开发运维中枢</p>
            </div>
            <div class="quick-start">
              <h3>快速开始</h3>
              <ul>
                <li>在左侧列表点击连接即可开始会话</li>
                <li>右键连接可以编辑、删除、复制或进行 AI 诊断</li>
                <li>数据库连接支持 SQL 查询功能</li>
                <li>SSH 连接支持终端交互和文件传输</li>
                <li>点击右上角 ⋮ 打开菜单</li>
              </ul>
            </div>
          </div>
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
                      <span class="session-tab-name">{session.displayName || session.connection.name}</span>
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
              <div class="tab-context-menu-item" onClick={() => handleDuplicateSession(tabContextMenu()!.sessionId)}>
                复制标签页
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
                    {session.connection.protocol === "ssh" && session.viewMode === "files" && (
                      <FileManager
                        sessionKey={session.id}
                        connection={session.connection}
                        sftpId={session.sftpId}
                      />
                    )}
                    {(session.connection.protocol === "mysql" || session.connection.protocol === "postgresql") && (
                      <QueryEditor connection={session.connection} />
                    )}
                    {session.connection.protocol === "docker" && (
                      <DockerDashboard connectionId={session.id} />
                    )}
                  </div>
                );
              }}
            </For>
          </div>
        </main>
        <Show when={showRightPanel()}>
          <div class="panel-splitter" onMouseDown={startResize} />
          <RightPanel connection={activeSession()?.connection} shellId={activeSession()?.shellId} style={{ width: `${rightPanelWidth()}px` }} />
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
            <h3>新建文件夹</h3>
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
            <p style={{ color: "var(--text-secondary)", "margin-bottom": "12px" }}>一站式开发运维中枢</p>
            <p style={{ color: "var(--text-muted)", "font-size": "13px", "margin-bottom": "8px" }}>
              版本 0.1.0 · 基于 Tauri 2.0 + SolidJS
            </p>
            <p style={{ color: "var(--text-muted)", "font-size": "13px" }}>
              支持 SSH · SFTP · MySQL · PostgreSQL · Docker · RDP
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