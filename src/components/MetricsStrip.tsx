import { Component, createSignal, onCleanup, createEffect, For } from "solid-js";
import { api, ConnectionRecord } from "../utils/api";
import "./MetricsStrip.css";

interface MetricsStripProps {
  connection: ConnectionRecord | undefined;
}

interface MetricsData {
  cpu: number;
  memory: number;
  disk: number;
  networkRx: number;
  networkTx: number;
}

type MetricKey = "cpu" | "up" | "down" | "mem" | "disk";

interface MetricItem {
  key: MetricKey;
  label: string;
}

const ITEMS: MetricItem[] = [
  { key: "cpu", label: "CPU" },
  { key: "up", label: "上行" },
  { key: "down", label: "下行" },
  { key: "mem", label: "内存" },
  { key: "disk", label: "磁盘" },
];

export const MetricsStrip: Component<MetricsStripProps> = (props) => {
  const [metrics, setMetrics] = createSignal<MetricsData | null>(null);
  let metricsInterval: number | null = null;
  let lastConnId: string | null = null;

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

      await api.disconnectShell(metricsShellId);

      setMetrics({ cpu: cpuPercent, memory, disk, networkRx: netRx, networkTx: netTx });
    } catch (e) {
      if (metricsShellId) {
        try {
          await api.disconnectShell(metricsShellId);
        } catch (_) {}
      }
      console.error("Metrics fetch error:", e);
    }
  };

  createEffect(() => {
    const conn = props.connection;
    if (conn && conn.protocol === "ssh" && conn.id !== lastConnId) {
      lastConnId = conn.id;
      setMetrics(null);
      fetchMetrics(conn);

      if (metricsInterval) clearInterval(metricsInterval);
      metricsInterval = setInterval(() => {
        const c = props.connection;
        if (c && c.protocol === "ssh") {
          fetchMetrics(c);
        }
      }, 5000);
    } else if (!conn || conn.protocol !== "ssh") {
      if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
      }
      setMetrics(null);
      lastConnId = null;
    }
  });

  onCleanup(() => {
    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }
  });

  const getPercent = (key: MetricKey): number => {
    const m = metrics();
    if (!m) return 0;
    switch (key) {
      case "cpu":
        return m.cpu;
      case "mem":
        return m.memory;
      case "disk":
        return m.disk;
      case "up":
        return Math.min(m.networkTx, 100);
      case "down":
        return Math.min(m.networkRx, 100);
    }
  };

  return (
    <div class="metrics-strip" aria-label="服务器指标">
      <For each={ITEMS}>
        {(item) => (
          <div class="metrics-strip-item" title={`${item.label}: ${getPercent(item.key)}%`}>
            <div class={`metrics-strip-bar ${item.key}`}>
              <div class="metrics-strip-fill" style={{ width: `${getPercent(item.key)}%` }} />
            </div>
            <div class="metrics-strip-label">{item.label}</div>
          </div>
        )}
      </For>
    </div>
  );
};
