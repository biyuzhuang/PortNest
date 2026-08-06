import { Component, Show, createSignal, onCleanup, createEffect, on } from "solid-js";
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

  let currentShellId: string | null = null;
  let currentSftpId: string | null = null;
  let disposed = false;
  let opening = false;

  // SFTP 使用当前 Shell 的 SSH transport，在独立 Channel 上运行。
  const openSftpForShell = async () => {
    const conn = props.connection;
    const shellId = props.shellId;
    if (!conn || conn.protocol !== "ssh" || !shellId) return;

    if (currentSftpId && currentShellId === shellId) {
      setSftpId(currentSftpId);
      return;
    }
    if (opening) return;

    if (currentSftpId) {
      try {
        await api.closeSftp(currentSftpId);
      } catch (_) {}
      currentSftpId = null;
      setSftpId(null);
    }

    opening = true;
    try {
      const response = await api.openSftpForShell(shellId);
      // 等待期间面板可能已卸载/折叠，需要立即回收刚打开的通道
      if (disposed || uiStore.filesCollapsed()) {
        try { await api.closeSftp(response.sftp_id); } catch (_) {}
        return;
      }
      currentSftpId = response.sftp_id;
      currentShellId = shellId;
      setSftpId(response.sftp_id);
    } catch (e) {
      console.error("SFTP open error:", e);
    } finally {
      opening = false;
    }
  };

  // SFTP：面板展开且活动会话是 SSH 时按需打开；折叠时关闭通道；
  // 切换连接/标签时复用或重开
  createEffect(on(() => [props.shellId, uiStore.filesCollapsed()] as const, () => {
    if (uiStore.filesCollapsed() || !props.shellId) {
      if (currentSftpId) {
        void api.closeSftp(currentSftpId).catch(() => {});
        currentSftpId = null;
        currentShellId = null;
        setSftpId(null);
      }
      return;
    }
    void openSftpForShell();
  }));

  onCleanup(async () => {
    disposed = true;
    if (currentSftpId) {
      try {
        await api.closeSftp(currentSftpId);
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
          <FileManager connection={props.connection!} sessionKey={props.sessionId} sftpId={sftpId() ?? undefined} />
        </Show>
      </div>
    </div>
  );
};
