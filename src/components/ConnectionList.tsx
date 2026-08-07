import { Component, createSignal, For, Show } from "solid-js";
import { connectionStore } from "../stores/connectionStore";
import type { ConnectionRecord } from "../utils/api";

interface ConnectionListProps {
  onConnect: (conn: ConnectionRecord) => void;
  onEdit: (conn: ConnectionRecord) => void;
  onDelete: (conn: ConnectionRecord) => void;
  onOpenAI?: (conn: ConnectionRecord) => void;
}

export const ConnectionList: Component<ConnectionListProps> = (props) => {
  const { state } = connectionStore;

  const getProtocolIcon = (protocol: string) => {
    switch (protocol) {
      case "ssh": return ">";
      case "local": return "▣";
      case "rdp": return "⊟";
      case "sftp": return "↑↓";
      case "mysql": return "DB";
      case "postgresql": return "PG";
      default: return "?";
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

  return (
    <div class="connection-list">
      <Show when={state.loading}>
        <div class="loading">加载中...</div>
      </Show>

      <Show when={state.error}>
        <div class="error">{state.error}</div>
      </Show>

      <div class="connections-grid">
        <For each={state.connections}>
          {(conn) => (
            <div class="connection-card" style={{ "--accent": conn.color || getProtocolColor(conn.protocol) }}>
              <div class="connection-header">
                <span class="protocol-icon" style={{ color: getProtocolColor(conn.protocol) }}>
                  {getProtocolIcon(conn.protocol)}
                </span>
                <span class="connection-name">{conn.name}</span>
              </div>

              <div class="connection-info">
                <div class="host">{conn.protocol === "local" ? "本机" : `${conn.host}:${conn.port}`}</div>
                <div class="protocol">{conn.protocol.toUpperCase()}</div>
              </div>

              <div class="connection-actions">
                <button class="btn-connect" onClick={() => props.onConnect(conn)}>
                  连接
                </button>
                <Show when={props.onOpenAI}>
                  <button class="btn-ai" onClick={() => props.onOpenAI!(conn)}>
                    AI
                  </button>
                </Show>
                <button class="btn-edit" onClick={() => props.onEdit(conn)}>
                  编辑
                </button>
                <button class="btn-delete" onClick={() => props.onDelete(conn)}>
                  删除
                </button>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={!state.loading && state.connections.length === 0}>
        <div class="empty-state">
          <p>暂无连接</p>
          <p>点击右上角添加按钮创建新连接</p>
        </div>
      </Show>
    </div>
  );
};
