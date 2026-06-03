import { Component, Show, createSignal, onCleanup, createEffect } from "solid-js";
import { FileManager } from "./FileManager";
import { api, ConnectionRecord } from "../utils/api";
import { uiStore } from "../stores/uiStore";
import "./RightPanel.css";

interface RightPanelProps {
  connection: ConnectionRecord | undefined;
  style?: any;
  sessionId?: string;
  shellId?: string;
}

export const RightPanel: Component<RightPanelProps> = (props) => {
  const [sftpId, setSftpId] = createSignal<string | null>(null);

  let currentConnectionId: string | null = null;
  let currentSftpId: string | null = null;

  // 独立 SFTP 连接（不复用 shell 的 SSH 会话），避免 SFTP 期间
  // ssh2 set_blocking 切换阻塞住 shell 读循环。
  const openSftpForConnection = async () => {
    const conn = props.connection;
    if (!conn || conn.protocol !== "ssh") return;

    if (currentSftpId && currentConnectionId === conn.id) {
      setSftpId(currentSftpId);
      return;
    }

    if (currentSftpId) {
      try {
        await api.closeSftpIndependent(currentSftpId);
      } catch (_) {}
      currentSftpId = null;
      setSftpId(null);
    }

    try {
      const response = await api.openSftp(conn.id);
      currentSftpId = response.sftp_id;
      currentConnectionId = conn.id;
      setSftpId(response.sftp_id);
    } catch (e) {
      console.error("SFTP open error:", e);
    }
  };

  // SFTP：仅在面板展开且活动会话是 SSH 时按需打开；切换连接时复用/重开
  createEffect(() => {
    if (uiStore.filesCollapsed()) return;
    openSftpForConnection();
  });

  onCleanup(async () => {
    if (currentSftpId) {
      try {
        await api.closeSftpIndependent(currentSftpId);
      } catch (e) {
        console.error("Close SFTP error:", e);
      }
    }
  });

  return (
    <div class="right-panel" style={props.style} hidden={uiStore.filesCollapsed()}>
      <button
        class="right-panel-collapse-btn"
        onClick={() => uiStore.setFilesCollapsed(true)}
        title="收起文件面板"
        aria-label="收起文件面板"
      >
        ›
      </button>
      <div class="right-panel-top">
        <Show when={props.connection} fallback={<div class="right-panel-empty">
          <span class="right-panel-empty-icon">📂</span>
          <span>选择服务器查看文件</span>
        </div>}>
          <FileManager connection={props.connection!} sftpId={sftpId() ?? undefined} />
        </Show>
      </div>
    </div>
  );
};