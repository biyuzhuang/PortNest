import { Component, Show, createSignal, onMount, onCleanup, createEffect } from "solid-js";
import { FileManager } from "./FileManager";
import { api, ConnectionRecord } from "../utils/api";
import "./RightPanel.css";

interface RightPanelProps {
  connection: ConnectionRecord | undefined;
  style?: any;
  sessionId?: string;
}

interface MetricsData {
  cpu: number;
  memory: number;
  disk: number;
  networkRx: number;
  networkTx: number;
}

export const RightPanel: Component<RightPanelProps> = (props) => {
  const [metrics, setMetrics] = createSignal<MetricsData | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sftpId, setSftpId] = createSignal<string | null>(null);

  let metricsInterval: number | null = null;
  let currentConnectionId: string | null = null;
  let currentSftpId: string | null = null;

  const fetchMetrics = async (conn: ConnectionRecord) => {
    let metricsShellId: string | null = null;

    try {
      const shellRes = await api.openShell(conn.id, 80, 24);
      metricsShellId = shellRes.shell_id;

      await api.writeShell(metricsShellId, "cat /proc/stat | head -1\n");
      await new Promise(r => setTimeout(r, 150));
      const cpuIdle1 = await api.readShell(metricsShellId);

      await new Promise(r => setTimeout(r, 300));

      await api.writeShell(metricsShellId, "cat /proc/stat | head -1\n");
      await new Promise(r => setTimeout(r, 150));
      const cpuIdle2 = await api.readShell(metricsShellId);

      await api.writeShell(metricsShellId, "free -m | grep Mem:\n");
      await new Promise(r => setTimeout(r, 150));
      const memData = await api.readShell(metricsShellId);

      await api.writeShell(metricsShellId, "df -h / | tail -1\n");
      await new Promise(r => setTimeout(r, 150));
      const diskData = await api.readShell(metricsShellId);

      await api.writeShell(metricsShellId, "cat /proc/net/dev | grep -E 'eth0|ens33|enp0s3|eno1|wlan0' | head -1\n");
      await new Promise(r => setTimeout(r, 150));
      const netData1 = await api.readShell(metricsShellId);

      await new Promise(r => setTimeout(r, 500));

      await api.writeShell(metricsShellId, "cat /proc/net/dev | grep -E 'eth0|ens33|enp0s3|eno1|wlan0' | head -1\n");
      await new Promise(r => setTimeout(r, 150));
      const netData2 = await api.readShell(metricsShellId);

      const cpuValues1 = cpuIdle1.match(/cpu\s+([\d\s]+)/);
      const cpuValues2 = cpuIdle2.match(/cpu\s+([\d\s]+)/);
      let cpuPercent = 0;

      if (cpuValues1 && cpuValues2) {
        const parseValues = (s: string) => s.trim().split(/\s+/).map(v => parseInt(v) || 0);
        const values1 = parseValues(cpuValues1[1]);
        const values2 = parseValues(cpuValues2[1]);

        const total1 = values1.reduce((a, b) => a + b, 0);
        const total2 = values2.reduce((a, b) => a + b, 0);
        const idle1 = values1[3] || 0;
        const idle2 = values2[3] || 0;

        if (total2 > total1) {
          const totalDelta = total2 - total1;
          const idleDelta = idle2 - idle1;
          cpuPercent = Math.min(100, Math.max(0, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
        }
      }

      const memParts = memData.match(/Mem:\s+(\d+)\s+(\d+)/);
      let memory = 0;
      if (memParts) {
        const memTotal = parseInt(memParts[1]) || 0;
        const memUsed = parseInt(memParts[2]) || 0;
        if (memTotal > 0) {
          memory = Math.min(100, Math.round((memUsed / memTotal) * 100));
        }
      }

      const diskMatch = diskData.match(/(\d+)%/);
      const disk = diskMatch ? parseInt(diskMatch[1]) : 0;

      let netRx = 0;
      let netTx = 0;
      const netIfMatch1 = netData1.match(/[^:\s]+:\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
      const netIfMatch2 = netData2.match(/[^:\s]+:\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (netIfMatch1 && netIfMatch2) {
        const rx1 = parseInt(netIfMatch1[1]) || 0;
        const tx1 = parseInt(netIfMatch1[2]) || 0;
        const rx2 = parseInt(netIfMatch2[1]) || 0;
        const tx2 = parseInt(netIfMatch2[2]) || 0;
        const intervalSec = 0.8;
        netRx = Math.min(100, Math.round((rx2 - rx1) / 1024 / intervalSec));
        netTx = Math.min(100, Math.round((tx2 - tx1) / 1024 / intervalSec));
      }

      await api.closeShell(metricsShellId);

      setMetrics({ cpu: cpuPercent, memory, disk, networkRx: netRx, networkTx: netTx });
      setError(null);
    } catch (e) {
      if (metricsShellId) {
        try {
          await api.closeShell(metricsShellId);
        } catch (_) {}
      }
      setError("无法获取指标");
      console.error("Metrics fetch error:", e);
    }
  };

  const openSftpForConnection = async (conn: ConnectionRecord) => {
    if (conn.id === currentConnectionId && currentSftpId) {
      setSftpId(currentSftpId);
      return;
    }

    if (currentSftpId) {
      try {
        await api.closeSftp(currentSftpId);
      } catch (_) {}
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

  createEffect(() => {
    const conn = props.connection;
    if (conn && conn.protocol === "ssh") {
      setIsLoading(true);
      openSftpForConnection(conn).then(() => {
        fetchMetrics(conn);
        setIsLoading(false);
      });

      if (metricsInterval) {
        clearInterval(metricsInterval);
      }
      metricsInterval = setInterval(() => {
        if (props.connection && props.connection.protocol === "ssh") {
          fetchMetrics(props.connection);
        }
      }, 5000);
    }
  });

  onCleanup(async () => {
    if (metricsInterval) {
      clearInterval(metricsInterval);
    }
    if (currentSftpId) {
      try {
        await api.closeSftp(currentSftpId);
      } catch (e) {
        console.error("Close SFTP error:", e);
      }
    }
  });

  const getMetricColorClass = (value: number): string => {
    if (value >= 80) return "high";
    if (value >= 50) return "medium";
    return "";
  };

  return (
    <div class="right-panel" style={props.style}>
      <div class="right-panel-top">
        <Show when={props.connection} fallback={<div class="right-panel-empty">
          <span class="right-panel-empty-icon">📂</span>
          <span>选择服务器查看文件</span>
        </div>}>
          <FileManager connection={props.connection!} sftpId={sftpId() ?? undefined} />
        </Show>
      </div>

      <div class="panel-divider" />

      <div class="right-panel-bottom">
        <Show when={error()}>
          <div class="right-panel-error">{error()}</div>
        </Show>
        <Show when={!error()}>
          <div class="mini-metrics">
            <div class="mini-metric">
              <div class="mini-metric-label">CPU</div>
              <div class="mini-metric-bar-container">
                <div
                  class="mini-metric-bar cpu"
                  style={{ height: `${metrics()?.cpu || 0}%` }}
                />
              </div>
              <div class={`mini-metric-value ${getMetricColorClass(metrics()?.cpu || 0)}`}>
                {metrics()?.cpu || 0}%
              </div>
            </div>

            <div class="mini-metric">
              <div class="mini-metric-label">MEM</div>
              <div class="mini-metric-bar-container">
                <div
                  class="mini-metric-bar memory"
                  style={{ height: `${metrics()?.memory || 0}%` }}
                />
              </div>
              <div class={`mini-metric-value ${getMetricColorClass(metrics()?.memory || 0)}`}>
                {metrics()?.memory || 0}%
              </div>
            </div>

            <div class="mini-metric">
              <div class="mini-metric-label">DISK</div>
              <div class="mini-metric-bar-container">
                <div
                  class="mini-metric-bar disk"
                  style={{ height: `${metrics()?.disk || 0}%` }}
                />
              </div>
              <div class={`mini-metric-value ${getMetricColorClass(metrics()?.disk || 0)}`}>
                {metrics()?.disk || 0}%
              </div>
            </div>

            <div class="mini-metric">
              <div class="mini-metric-label">NET↑</div>
              <div class="mini-metric-bar-container">
                <div
                  class="mini-metric-bar net-up"
                  style={{ height: `${Math.min(metrics()?.networkTx || 0, 100)}%` }}
                />
              </div>
              <div class="mini-metric-value">
                {metrics()?.networkTx || 0}KB
              </div>
            </div>

            <div class="mini-metric">
              <div class="mini-metric-label">NET↓</div>
              <div class="mini-metric-bar-container">
                <div
                  class="mini-metric-bar net-down"
                  style={{ height: `${Math.min(metrics()?.networkRx || 0, 100)}%` }}
                />
              </div>
              <div class="mini-metric-value">
                {metrics()?.networkRx || 0}KB
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};