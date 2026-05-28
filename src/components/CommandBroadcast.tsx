import { Component, createSignal, For, Show } from "solid-js";
import { api, ConnectionRecord } from "../utils/api";
import "./CommandBroadcast.css";

interface BroadcastSession {
  connection: ConnectionRecord;
  shellId: string | null;
  output: string[];
  isConnected: boolean;
}

interface CommandBroadcastProps {
  connections: ConnectionRecord[];
}

export const CommandBroadcast: Component<CommandBroadcastProps> = (props) => {
  const [sessions, setSessions] = createSignal<BroadcastSession[]>([]);
  const [command, setCommand] = createSignal("");
  const [isBroadcasting, setIsBroadcasting] = createSignal(false);
  const [executingSessions, setExecutingSessions] = createSignal<Set<string>>(new Set());

  const connectAll = async () => {
    const newSessions: BroadcastSession[] = [];

    for (const conn of props.connections.filter(c => c.protocol === "ssh")) {
      try {
        const response = await api.openShell(conn.id, 80, 24);
        newSessions.push({
          connection: conn,
          shellId: response.shell_id,
          output: [`[${conn.name}] 已连接`],
          isConnected: true,
        });
      } catch (e) {
        newSessions.push({
          connection: conn,
          shellId: null,
          output: [`[${conn.name}] 连接失败: ${e}`],
          isConnected: false,
        });
      }
    }

    setSessions(newSessions);
  };

  const disconnectAll = async () => {
    for (const session of sessions()) {
      if (session.shellId) {
        try {
          await api.closeShell(session.shellId);
        } catch (e) {
          console.error("Close shell error:", e);
        }
      }
    }
    setSessions([]);
  };

  const executeCommand = async () => {
    const cmd = command();
    if (!cmd.trim()) return;

    setIsBroadcasting(true);
    setExecutingSessions(new Set(sessions().filter(s => s.isConnected).map(s => s.shellId!)));

    const updatedSessions = [...sessions()];

    for (let i = 0; i < updatedSessions.length; i++) {
      const session = updatedSessions[i];
      if (!session.isConnected || !session.shellId) continue;

      try {
        await api.writeShell(session.shellId, cmd + "\r");
        updatedSessions[i] = {
          ...session,
          output: [...session.output, `$ ${cmd}`],
        };
      } catch (e) {
        updatedSessions[i] = {
          ...session,
          output: [...session.output, `[${session.connection.name}] 发送失败: ${e}`],
        };
      }
    }

    setSessions(updatedSessions);
    setCommand("");
    setIsBroadcasting(false);
    setExecutingSessions(new Set());

    // Start polling for output
    pollOutputs();
  };

  const pollOutputs = async () => {
    const updatedSessions = [...sessions()];
    let hasChanges = false;

    for (let i = 0; i < updatedSessions.length; i++) {
      const session = updatedSessions[i];
      if (!session.isConnected || !session.shellId) continue;

      try {
        const data = await api.readShell(session.shellId);
        if (data) {
          updatedSessions[i] = {
            ...session,
            output: [...session.output, data],
          };
          hasChanges = true;
        }
      } catch (e) {
        // Ignore read errors during polling
      }
    }

    if (hasChanges) {
      setSessions(updatedSessions);
      setTimeout(pollOutputs, 100);
    }
  };

  const clearOutput = (index: number) => {
    const updatedSessions = [...sessions()];
    updatedSessions[index] = {
      ...updatedSessions[index],
      output: [],
    };
    setSessions(updatedSessions);
  };

  return (
    <div class="command-broadcast">
      <div class="broadcast-header">
        <h3>命令广播</h3>
        <div class="broadcast-actions">
          <button class="btn-connect" onClick={connectAll}>连接所有</button>
          <button class="btn-disconnect" onClick={disconnectAll}>断开所有</button>
        </div>
      </div>

      <Show when={sessions().length === 0}>
        <div class="broadcast-empty">
          <p>点击"连接所有"以连接到所有 SSH 服务器</p>
          <p class="hint">支持同时向多个服务器发送相同命令</p>
        </div>
      </Show>

      <Show when={sessions().length > 0}>
        <div class="command-input-area">
          <input
            type="text"
            class="command-input"
            placeholder="输入命令后按 Enter 广播到所有会话..."
            value={command()}
            onInput={(e) => setCommand(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && !isBroadcasting() && executeCommand()}
            disabled={isBroadcasting()}
          />
          <button
            class="btn-execute"
            onClick={executeCommand}
            disabled={isBroadcasting() || !command().trim()}
          >
            {isBroadcasting() ? "执行中..." : "广播"}
          </button>
        </div>

        <div class="sessions-grid">
          <For each={sessions()}>
            {(session, index) => (
              <div class={`session-panel ${session.isConnected ? "connected" : "disconnected"}`}>
                <div class="session-header">
                  <div class="session-title">
                    <span class="status-dot" style={{ background: session.isConnected ? "var(--success)" : "var(--error)" }} />
                    <span class="session-name">{session.connection.name}</span>
                  </div>
                  <button class="btn-clear" onClick={() => clearOutput(index())}>清空</button>
                </div>
                <div class="session-output">
                  <For each={session.output}>
                    {(line) => (
                      <div class="output-line" innerHTML={line.replace(/\r?\n/g, "<br/>")} />
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};