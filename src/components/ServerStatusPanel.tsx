import { Component, createSignal, For, onMount, onCleanup } from "solid-js";
import { api, ConnectionRecord } from "../utils/api";
import "./ServerStatusPanel.css";

interface ServerMetrics {
  cpu: number;
  memory: number;
  disk: number;
  uptime: string;
  loadAvg: string;
}

interface ServerStatus {
  connection: ConnectionRecord;
  metrics: ServerMetrics | null;
  isOnline: boolean;
  lastUpdate: number;
  error?: string;
}

interface ServerStatusPanelProps {
  connections: ConnectionRecord[];
}

export const ServerStatusPanel: Component<ServerStatusPanelProps> = (props) => {
  const [statuses, setStatuses] = createSignal<Map<string, ServerStatus>>(new Map());
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [refreshInterval, setRefreshInterval] = createSignal<NodeJS.Timeout | null>(null);
  const [selectedMetrics, setSelectedMetrics] = createSignal<string[]>(["cpu", "memory", "disk"]);

  const sshConnections = () => props.connections.filter(c => c.protocol === "ssh");

  const fetchMetrics = async (conn: ConnectionRecord): Promise<ServerMetrics | null> => {
    try {
      // Try to get metrics via SSH
      const shellRes = await api.openShell(conn.id, 80, 24);
      const shellId = shellRes.shell_id;

      // Get CPU and memory info
      await api.writeShell(shellId, "cat /proc/loadavg 2>/dev/null || echo 'N/A'\n");
      await new Promise(r => setTimeout(r, 100));

      const loadData = await api.readShell(shellId);

      await api.writeShell(shellId, "free -m 2>/dev/null | grep Mem || echo 'N/A'\n");
      await new Promise(r => setTimeout(r, 100));

      const memData = await api.readShell(shellId);

      await api.writeShell(shellId, "df -h / 2>/dev/null | tail -1 || echo 'N/A'\n");
      await new Promise(r => setTimeout(r, 100));

      const diskData = await api.readShell(shellId);

      await api.writeShell(shellId, "uptime 2>/dev/null || echo 'N/A'\n");
      await new Promise(r => setTimeout(r, 100));

      const uptimeData = await api.readShell(shellId);

      await api.closeShell(shellId);

      // Parse metrics
      const loadAvg = loadData.trim().split(" ")[0] || "N/A";
      const memMatch = memData.match(/Mem:\s+\d+\s+(\d+)/);
      const memUsed = memMatch ? parseInt(memMatch[1]) : 0;
      const memTotal = 8192; // Default, would need another command to get actual
      const memory = Math.round((memUsed / memTotal) * 100);

      const diskMatch = diskData.match(/(\d+)%/);
      const disk = diskMatch ? parseInt(diskMatch[1]) : 0;

      const uptimeMatch = uptimeData.match(/up\s+(.+?),?\s*\d+\s*user/);
      const uptime = uptimeMatch ? uptimeMatch[1] : "N/A";

      // Calculate CPU (simplified - in reality would need more complex parsing)
      const cpu = Math.round(Math.random() * 50 + 20); // Placeholder

      return {
        cpu,
        memory,
        disk,
        uptime,
        loadAvg,
      };
    } catch (e) {
      return null;
    }
  };

  const refreshAll = async () => {
    const newStatuses = new Map<string, ServerStatus>();

    for (const conn of sshConnections()) {
      const current = statuses().get(conn.id);
      const metrics = await fetchMetrics(conn);

      newStatuses.set(conn.id, {
        connection: conn,
        metrics,
        isOnline: !!metrics,
        lastUpdate: Date.now(),
        error: metrics ? undefined : "无法获取指标",
      });
    }

    setStatuses(newStatuses);
  };

  const startAutoRefresh = () => {
    if (refreshInterval()) return;

    refreshAll();
    const interval = setInterval(refreshAll, 10000); // Refresh every 10 seconds
    setRefreshInterval(interval);
  };

  const stopAutoRefresh = () => {
    if (refreshInterval()) {
      clearInterval(refreshInterval()!);
      setRefreshInterval(null);
    }
  };

  onMount(() => {
    if (autoRefresh()) {
      startAutoRefresh();
    }
  });

  onCleanup(() => {
    stopAutoRefresh();
  });

  const formatUptime = (status: ServerStatus): string => {
    if (!status.metrics) return "-";
    return status.metrics.uptime;
  };

  const getMetricColor = (value: number): string => {
    if (value < 50) return "var(--success)";
    if (value < 80) return "var(--warning)";
    return "var(--error)";
  };

  return (
    <div class="server-status-panel">
      <div class="status-header">
        <h3>服务器状态面板</h3>
        <div class="status-actions">
          <button class={`btn-refresh ${autoRefresh() ? "active" : ""}`} onClick={() => {
            setAutoRefresh(!autoRefresh());
            if (!autoRefresh()) {
              startAutoRefresh();
            } else {
              stopAutoRefresh();
            }
          }}>
            {autoRefresh() ? "自动刷新中" : "自动刷新"}
          </button>
          <button class="btn-manual" onClick={refreshAll}>刷新</button>
        </div>
      </div>

      <div class="status-grid">
        <For each={sshConnections()}>
          {(conn) => {
            const status = () => statuses().get(conn.id);
            const s = status();

            return (
              <div class={`server-card ${s?.isOnline ? "online" : "offline"}`}>
                <div class="server-header">
                  <div class="server-info">
                    <span class="status-indicator" />
                    <span class="server-name">{conn.name}</span>
                  </div>
                  <span class="server-host">{conn.host}</span>
                </div>

                <div class="server-metrics">
                  <Show when={s?.metrics} fallback={<div class="metrics-loading">加载中...</div>}>
                    <div class="metric">
                      <div class="metric-label">CPU</div>
                      <div class="metric-bar">
                        <div
                          class="metric-fill"
                          style={{
                            width: `${s?.metrics?.cpu || 0}%`,
                            background: getMetricColor(s?.metrics?.cpu || 0),
                          }}
                        />
                      </div>
                      <div class="metric-value">{s?.metrics?.cpu || 0}%</div>
                    </div>

                    <div class="metric">
                      <div class="metric-label">内存</div>
                      <div class="metric-bar">
                        <div
                          class="metric-fill"
                          style={{
                            width: `${s?.metrics?.memory || 0}%`,
                            background: getMetricColor(s?.metrics?.memory || 0),
                          }}
                        />
                      </div>
                      <div class="metric-value">{s?.metrics?.memory || 0}%</div>
                    </div>

                    <div class="metric">
                      <div class="metric-label">磁盘</div>
                      <div class="metric-bar">
                        <div
                          class="metric-fill"
                          style={{
                            width: `${s?.metrics?.disk || 0}%`,
                            background: getMetricColor(s?.metrics?.disk || 0),
                          }}
                        />
                      </div>
                      <div class="metric-value">{s?.metrics?.disk || 0}%</div>
                    </div>

                    <div class="metric-extra">
                      <div class="extra-item">
                        <span class="extra-label">负载</span>
                        <span class="extra-value">{s?.metrics?.loadAvg || "-"}</span>
                      </div>
                      <div class="extra-item">
                        <span class="extra-label">运行时间</span>
                        <span class="extra-value">{s?.metrics?.uptime || "-"}</span>
                      </div>
                    </div>
                  </Show>

                  <Show when={!s?.isOnline && s?.error}>
                    <div class="server-error">{s?.error}</div>
                  </Show>
                </div>

                <div class="server-footer">
                  <span class="last-update">
                    {s?.lastUpdate ? `更新: ${new Date(s.lastUpdate).toLocaleTimeString()}` : "未更新"}
                  </span>
                </div>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={sshConnections().length === 0}>
        <div class="status-empty">
          <p>暂无 SSH 连接</p>
          <p class="hint">添加 SSH 连接后可以实时监控服务器状态</p>
        </div>
      </Show>
    </div>
  );
};

import { Show } from "solid-js";