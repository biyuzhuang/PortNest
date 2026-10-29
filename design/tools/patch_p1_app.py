"""P1 — reshape the app shell markup: titlebar, merged session header, status bar."""

import pathlib
import sys

p = pathlib.Path("src/App.tsx")
src = p.read_text(encoding="utf-8")


def replace(old: str, new: str, label: str):
    global src
    count = src.count(old)
    if count != 1:
        print(f"FAIL {label}: anchor found {count} times")
        sys.exit(1)
    src = src.replace(old, new, 1)
    print(f"ok   {label}")


# --- helper next to activeSession -------------------------------------------
replace(
    '  const activeSession = () => sessions().find(s => s.id === activeSessionId());\n',
    '''  const activeSession = () => sessions().find(s => s.id === activeSessionId());

  // Single source for the human status label used by the status bar.
  const sessionStatusLabel = (session: SessionTab) => {
    switch (session.status) {
      case "connected": return "已连接";
      case "connecting": return "连接中";
      case "reconnecting": return session.reconnectAttempt ? `重连中 ${session.reconnectAttempt}` : "重连中";
      case "restored": return "待恢复";
      case "error": return "连接错误";
      case "disconnected": return "已断开";
      default: return "已结束";
    }
  };
''',
    "status label helper",
)

# --- titlebar: breadcrumb + search pill, drop the SSH/SFTP badge -------------
replace(
    '''        <Show when={activeSession()}>
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
            </button>''',
    '''        <span class="titlebar-divider" />
        <Show when={activeSession()}>
          <span class="titlebar-crumb" data-tauri-drag-region>
            <ProtocolIcon kind={activeSession()!.connection.protocol} />
            <b>{activeSession()!.displayName || activeSession()!.connection.name}</b>
            <span class="titlebar-crumb-host">
              {activeSession()!.connection.protocol === "local"
                ? "本机终端"
                : `${activeSession()!.connection.username}@${activeSession()!.connection.host}:${activeSession()!.connection.port}`}
            </span>
          </span>
        </Show>
        <div class="titlebar-spacer" data-tauri-drag-region />
        <button class="titlebar-search" title="快速切换 Ctrl+K" aria-label="快速切换连接" onClick={() => { setQuickQuery(""); setShowQuickSwitcher(true); }}>
          <Icon name="search" size={13} />
          <span>搜索连接、命令或设置</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div class="titlebar-actions">
          <button class="titlebar-btn" title="设置" aria-label="设置" onClick={() => void openSettingsWindow()}>
            <Icon name="settings" />
          </button>
          <div class="app-menu-container">
            <button class="titlebar-btn" title="更多" aria-label="更多操作" aria-expanded={showAppMenu()} onClick={() => setShowAppMenu(!showAppMenu())}>
              <Icon name="more" />
            </button>''',
    "titlebar head",
)

replace(
    '''            <button class="titlebar-btn titlebar-btn-win titlebar-btn-close" onClick={requestWindowClose} title="关闭" aria-label="关闭窗口">
              <Icon name="close" />
            </button>
          </div>
          </div>
        </div>
      </div>''',
    '''            <button class="titlebar-btn titlebar-btn-win titlebar-btn-close" onClick={requestWindowClose} title="关闭" aria-label="关闭窗口">
              <Icon name="close" />
            </button>
          </div>
        </div>
      </div>''',
    "titlebar tail",
)

# --- session header: tabs + actions on one line -----------------------------
replace(
    '''          <div class="session-tabs-bar">
            <div class="session-tabs">
              <button
                class={`session-list-tab ${assetListActive() ? "active" : ""}`}
                onClick={() => setAssetListActive(true)}
              >
                <Icon name="list" /> 列表
              </button>''',
    '''          <div class="session-header">
            <div class="session-tabs">
              <button
                class={`session-list-tab ${assetListActive() ? "active" : ""}`}
                title="资产列表"
                aria-label="资产列表"
                onClick={() => setAssetListActive(true)}
              >
                <Icon name="list" size={15} />
              </button>''',
    "session header open",
)

replace(
    '''              </For>
            </div>
          </div>

          <Show when={tabContextMenu()}>''',
    '''              </For>
            </div>
            <Show when={!assetListActive() && activeSession()}>{session => (
              <div class="session-actions">
                <span class={`session-status-dot status-${session().status}`} title={sessionStatusLabel(session())} />
                <Show when={!isDatabaseProtocol(session().connection.protocol)}>
                  <label class="session-encoding" title="终端编码">
                    <select
                      value={session().encodingOverride || session().encoding || "UTF-8"}
                      disabled={!session().shellId}
                      aria-label="终端编码"
                      onChange={event => void handleSetEncoding(session().id, event.currentTarget.value)}
                    >
                      <option>UTF-8</option><option>GBK</option><option>GB2312</option><option>GB18030</option><option>Big5</option><option>Shift-JIS</option><option>EUC-KR</option><option>ISO-8859-1</option><option>Windows-1252</option><option>CP437</option>
                    </select>
                  </label>
                </Show>
                <Show when={session().connection.protocol === "ssh"}>
                  <button class="session-action-btn" title="端口转发" onClick={() => { setTunnelConnection(session().connection); setShowTunnels(true); }}>
                    <Icon name="link" size={13} />
                    <span>隧道</span>
                    <Show when={runningTunnelCount(session().connection.id) > 0}>{runningTunnelCount(session().connection.id)}</Show>
                  </button>
                </Show>
                <Show when={!isDatabaseProtocol(session().connection.protocol)}>
                  <button
                    class="session-action-btn"
                    title="命令广播"
                    disabled={sessions().filter(item => item.status === "connected").length === 0}
                    aria-expanded={showCommandComposer()}
                    onClick={() => setShowCommandComposer(value => !value)}
                  >
                    <Icon name="transfer" size={13} />
                    <span>广播</span>
                  </button>
                </Show>
                <button
                  class="session-action-btn"
                  title={isDatabaseProtocol(session().connection.protocol) ? "AI SQL 助手" : "AI 终端助手"}
                  onClick={() => openAIAssistant(isDatabaseProtocol(session().connection.protocol) ? "sql" : "terminal")}
                >
                  <Icon name="sparkles" size={13} />
                  <span>AI</span>
                </button>
                <button class="session-action-btn" title="重新连接" onClick={() => void handleReconnect(session().id)}>
                  <Icon name="refresh" size={13} />
                  <span>重连</span>
                </button>
              </div>
            )}</Show>
          </div>

          <Show when={tabContextMenu()}>''',
    "session actions inline",
)

# --- drop the old standalone action bar -------------------------------------
old_action_bar = '''          <Show when={!assetListActive() && activeSession()}>{session => (
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

'''
replace(old_action_bar, "", "old action bar removed")

# --- global status bar ------------------------------------------------------
replace(
    '''      <FeedbackHost />
      <TextContextMenu />
      </div>
    </div>
  );''',
    '''      <FeedbackHost />
      <TextContextMenu />
      </div>

      <footer class="app-statusbar">
        <span class="app-statusbar-item">
          <span class={`status-dot ${activeSession() ? `status-${activeSession()!.status}` : "online"}`} />
          {activeSession() ? sessionStatusLabel(activeSession()!) : "就绪"}
          <Show when={activeSession()}>
            <b>{activeSession()!.displayName || activeSession()!.connection.name}</b>
          </Show>
        </span>
        <Show when={activeSession()}>
          <span class="app-statusbar-item mono">
            {activeSession()!.connection.protocol === "local"
              ? `本机 · ${localShellDisplayName(parseLocalProfile(activeSession()!.connection.options).shell_type)}`
              : `${activeSession()!.connection.host}:${activeSession()!.connection.port}`}
          </span>
        </Show>
        <span class="app-statusbar-spacer" />
        <Show when={activeSession() && !isDatabaseProtocol(activeSession()!.connection.protocol)}>
          <span class="app-statusbar-item mono">{activeSession()!.encodingOverride || activeSession()!.encoding || "UTF-8"}</span>
        </Show>
        <Show when={activeSession() && runningTunnelCount(activeSession()!.connection.id) > 0}>
          <span class="app-statusbar-item">隧道 {runningTunnelCount(activeSession()!.connection.id)}</span>
        </Show>
        <span class="app-statusbar-item">{sessions().length} 个标签</span>
        <span class="app-statusbar-item mono">v{appVersion()}</span>
      </footer>
    </div>
  );''',
    "status bar",
)

p.write_text(src, encoding="utf-8")
print("App.tsx written:", len(src.splitlines()), "lines")
