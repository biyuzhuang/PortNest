import { Component, For, Show, createSignal, createEffect, on, onCleanup } from "solid-js";
import { api, type ConnectionRecord, type DashboardSnapshot } from "../utils/api";
import { uiStore } from "../stores/uiStore";
import { feedback } from "../stores/feedbackStore";
import { Icon } from "./Icon";
import {
  getOverviewSettings,
  appendTrend,
  getTrend,
  clearTrend,
  levelForPercent,
  levelForLoad,
  THRESHOLDS,
  type MetricLevel,
} from "../stores/dashboardStore";
import "./ServerOverview.css";

interface ServerOverviewProps {
  connection: ConnectionRecord | undefined;
  /** 活动终端 SSH 会话是否健康（connected）；异常时不采集。 */
  sessionConnected?: boolean;
}

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${units[index]}`;
}

/** 会话健康门控：只有 connected 状态才允许采集。 */
const sessionHealthy = (connected: boolean | undefined) => connected === true;

function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "--";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)}B/s`;
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 导轨速率显示：12K / 1.6K（K 起省略 B），无采样时显示 --。 */
function formatRailRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "--";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)}B`;
  const units = ["K", "M", "G", "T", "P"];
  // 先除第一个 1024（K），index 从 0 对应 K；否则单位会整体大一级（K 显示成 M）。
  let value = bytesPerSec / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")}${units[index]}`;
}

/** 导轨悬停提示用的完整速率（带 /s）。 */
function railRateTitle(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "--";
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

const levelClass = (level: MetricLevel) => `level-${level}`;

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export const ServerOverview: Component<ServerOverviewProps> = (props) => {
  const [snapshot, setSnapshot] = createSignal<DashboardSnapshot | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight = false;
  let currentConnectionId: string | null = null;

  const collect = async () => {
    const conn = props.connection;
    // 开关关闭时不获取任何指标（面板此时已不渲染，此处为兜底防御）。
    if (!conn || conn.protocol !== "ssh" || !sessionHealthy(props.sessionConnected) || !getOverviewSettings().enabled || inflight) return;
    inflight = true;
    try {
      const next = await api.dashboardCollect(conn.id);
      // 连接可能在等待期间被切换。
      if (props.connection?.id !== conn.id) return;
      setSnapshot(next);
      setError(null);
      if (next.cpu) {
        appendTrend(conn.id, {
          at: next.collected_at,
          cpu: next.cpu.total,
          mem: next.memory?.percent ?? 0,
          rx_rate: next.network?.rx_rate ?? 0,
          tx_rate: next.network?.tx_rate ?? 0,
        });
      }
    } catch (e) {
      if (props.connection?.id === conn.id) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      inflight = false;
    }
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  // 连接切换 / 会话健康 / 仪表盘开关变化：清理旧数据与定时器，并取消后端
  // 可能残留的采集。开关关闭时不自动采集（手动刷新仍可用）。
  createEffect(on(() => [props.connection?.id, props.sessionConnected, getOverviewSettings().enabled] as const, () => {
    const previousId = currentConnectionId;
    const nextId = props.connection?.id ?? null;
    const changedConnection = previousId !== nextId;
    if (previousId && previousId !== nextId) {
      void api.dashboardCancel(previousId).catch(() => {});
      clearTrend(previousId);
    }
    currentConnectionId = nextId;
    const healthy = sessionHealthy(props.sessionConnected);
    if (!healthy || !getOverviewSettings().enabled) {
      if (changedConnection || !healthy) {
        setSnapshot(null);
        setError(null);
      }
      return;
    }
    if (changedConnection) {
      setSnapshot(null);
      setError(null);
    }
    void collect();
  }));

  // 刷新频率 / 会话状态 / 仪表盘开关变化时重启轮询。
  createEffect(() => {
    const settings = getOverviewSettings();
    const conn = props.connection;
    stopTimer();
    if (!conn || conn.protocol !== "ssh" || !sessionHealthy(props.sessionConnected) || !settings.enabled || settings.refreshIntervalSec <= 0) return;
    timer = setInterval(() => void collect(), Math.max(settings.refreshIntervalSec, 2) * 1000);
  });

  onCleanup(() => {
    stopTimer();
    const id = props.connection?.id;
    if (id) void api.dashboardCancel(id).catch(() => {});
  });

  const loadLevel = (): MetricLevel => {
    const s = snapshot();
    if (!s?.system) return "normal";
    return levelForLoad(s.system.load[0], s.system.cores || 1);
  };

  const trend = () => (props.connection ? getTrend(props.connection.id) : []);

  // -------------------------------------------------------------------------
  // 诊断摘要
  // -------------------------------------------------------------------------

  const buildSummary = (): string => {
    const conn = props.connection;
    const s = snapshot();
    const lines: string[] = [];
    lines.push(`[PortNest 诊断摘要] ${conn?.name ?? "-"}（${conn?.username ?? "-"}@${conn?.host}:${conn?.port}）`);
    if (s?.system) {
      lines.push(`主机名 ${s.system.hostname} · 系统 ${s.system.os} · 内核 ${s.system.kernel} ${s.system.arch}`);
      lines.push(`运行时长 ${formatUptime(s.system.uptime_secs)} · 登录用户 ${s.system.users} · 核心数 ${s.system.cores || "-"}`);
      lines.push(`负载 ${s.system.load.map(v => v.toFixed(2)).join(" / ")}`);
    }
    if (s?.cpu) {
      lines.push(`CPU 平均 ${s.cpu.total.toFixed(1)}%（用户态 ${s.cpu.user.toFixed(1)}% / 内核态 ${s.cpu.system.toFixed(1)}% / I/O 等待 ${s.cpu.iowait.toFixed(1)}%）`);
    }
    if (s?.memory) {
      const m = s.memory;
      lines.push(`内存 ${formatBytes(m.used_b)}/${formatBytes(m.total_b)}（${m.percent.toFixed(1)}%） · Swap ${formatBytes(m.swap_used_b)}/${formatBytes(m.swap_total_b)}（${m.swap_percent.toFixed(1)}%）`);
    }
    if (s?.disk) {
      const root = s.disk.root_percent;
      if (root != null) lines.push(`根分区使用 ${root.toFixed(0)}%（${formatBytes(s.disk.root_used_b)}/${formatBytes(s.disk.root_total_b)}）`);
      const hot = s.disk.mounts.filter(m => m.total_b > 0).slice(0, 5);
      if (hot.length) lines.push(`挂载点：${hot.map(m => `${m.mount} ${m.percent.toFixed(0)}%`).join("、")}`);
    }
    if (s?.network) {
      const n = s.network;
      lines.push(`网络累计 ↓${formatBytes(n.rx_bytes)} ↑${formatBytes(n.tx_bytes)} · 速率 ↓${formatRate(n.rx_rate)} ↑${formatRate(n.tx_rate)}`);
    }
    if (s?.processes?.length) {
      const top = s.processes.slice(0, 3).map(p => `${p.name}(${p.pid}, CPU ${p.cpu.toFixed(1)}%)`).join("、");
      lines.push(`高占用进程：${top}`);
    }
    if (s?.gpu?.length) {
      lines.push(`GPU：${s.gpu.map(g => `${g.name} ${g.utilization.toFixed(0)}% ${g.temperature.toFixed(0)}℃`).join("、")}`);
    }
    const issues = s?.issues ?? [];
    if (issues.length) {
      lines.push(`降级项：${issues.map(i => `${i.section}${i.stale ? "(陈旧)" : ""}：${i.reason}`).join("；")}`);
    }
    if (error()) lines.push(`最近采集错误：${error()}`);
    if (s) lines.push(`采集于 ${new Date(s.collected_at * 1000).toLocaleString()}，耗时 ${s.duration_ms}ms`);
    return lines.join("\n");
  };

  const copySummary = async () => {
    try {
      await api.writeClipboardText(buildSummary());
      feedback.success("诊断摘要已复制到剪贴板");
    } catch (e) {
      feedback.error("复制失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  return (
    <Show
      when={!uiStore.overviewCollapsed()}
      fallback={<OverviewRail connection={props.connection} snapshot={snapshot()} error={error()} onExpand={() => uiStore.setOverviewCollapsed(false)} />}
    >
      <div class="server-overview" role="complementary" aria-label="服务器概览">
        <header class="overview-header">
          <strong>服务器概览</strong>
          <div class="overview-header-actions">
            <button class="overview-icon-button" onClick={() => void copySummary()} title="复制诊断摘要" aria-label="复制诊断摘要">
              <Icon name="copy" size={15} />
            </button>
            <button class="overview-icon-button" onClick={() => void collect()} title="立即刷新（独立于 10s 自动周期）" aria-label="立即刷新">
              <Icon name="refresh" size={15} />
            </button>
            <button class="overview-icon-button" onClick={() => uiStore.setOverviewCollapsed(true)} title="收起为精简概览" aria-label="收起概览">
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>
        <OverviewBody />
      </div>
    </Show>
  );

  function OverviewBody() {
    const system = () => snapshot()?.system;
    const cpu = () => snapshot()?.cpu;
    const memory = () => snapshot()?.memory;
    const disk = () => snapshot()?.disk;
    const network = () => snapshot()?.network;

    const tile = (label: string, value: string, level: MetricLevel = "normal") => (
      <div class={`overview-tile ${levelClass(level)}`}>
        <span class="overview-tile-value">{value}</span>
        <span class="overview-tile-label">{label}</span>
      </div>
    );

    const sparkline = (pick: (p: { cpu: number; mem: number; rx_rate: number; tx_rate: number }) => number) => {
      const points = trend();
      if (points.length < 2) return <div class="overview-trend-empty">暂无趋势数据</div>;
      const values = points.map(pick);
      const max = Math.max(...values, 1);
      const width = 100;
      const height = 36;
      const coords = values.map((v, i) => {
        const x = points.length > 1 ? (i / (points.length - 1)) * width : 0;
        const y = height - (v / max) * (height - 2) - 1;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      return (
        <svg class="overview-trend" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          <polyline points={coords} fill="none" stroke-width="1.5" />
        </svg>
      );
    };

    return (
      <Show when={props.connection} fallback={
        <div class="overview-empty">
          <span class="overview-empty-icon"><Icon name="terminal" size={26} /></span>
          <span>连接 SSH 会话后可查看服务器概览</span>
        </div>
      }>
        <div class="overview-scroll">
          <Show when={snapshot()?.backend_supported === false}>
            <div class="overview-banner error">{snapshot()?.message}</div>
          </Show>

          <Show when={error()}>
            <div class="overview-banner error">{error()}</div>
          </Show>

          <Show when={snapshot()} fallback={
            <div class="overview-loading">
              {!sessionHealthy(props.sessionConnected)
                ? "SSH 会话未连接，已暂停采集"
                : !getOverviewSettings().enabled
                  ? "自动采集已停用，可点击刷新按钮手动采集"
                  : "正在采集主机状态…"}
            </div>
          }>
            <section class="overview-section overview-basics">
              <div class="overview-basics-row">
                <span class="overview-basic"><Icon name="key" size={13} /> {system()?.hostname || "-"}</span>
                <span class="overview-basic"><Icon name="info" size={13} /> {system()?.os || "-"}</span>
                <span class="overview-basic"><Icon name="refresh" size={13} /> 运行 {formatUptime(system()?.uptime_secs ?? 0)}</span>
              </div>
              <div class="overview-basics-sub">
                <span>Host {props.connection?.host}:{props.connection?.port}</span>
                <span>内核 {system()?.kernel || "-"} {system()?.arch || ""}</span>
                <span>登录用户 {system()?.users ?? "-"}</span>
              </div>
            </section>

            <section class="overview-section">
              <div class="overview-tiles">
                {tile("平均 CPU", cpu() ? `${cpu()!.total.toFixed(1)}%` : "--", cpu() ? levelForPercent(cpu()!.total, THRESHOLDS.cpu) : "normal")}
                {tile("用户态", cpu() ? `${cpu()!.user.toFixed(1)}%` : "--")}
                {tile("内核态", cpu() ? `${cpu()!.system.toFixed(1)}%` : "--")}
                {tile("I/O 等待", cpu() ? `${cpu()!.iowait.toFixed(1)}%` : "--", cpu() && cpu()!.iowait >= 20 ? "warning" : "normal")}
                {tile("总 CPU", system() ? `${system()!.cores} 核` : "--")}
              </div>
              <div class="overview-loads">
                <span class={`overview-load ${levelClass(loadLevel())}`}>
                  负载 {system() ? system()!.load.map(v => v.toFixed(2)).join(" / ") : "--"}
                </span>
              </div>
            </section>

            <section class="overview-section overview-memory">
              <div class="overview-memory-item">
                <span class="overview-memory-label">物理内存</span>
                <UsageBarWithText used={memory()?.used_b ?? 0} total={memory()?.total_b ?? 0} level={memory() ? levelForPercent(memory()!.percent, THRESHOLDS.memory) : "normal"} />
              </div>
              <div class="overview-memory-item">
                <span class="overview-memory-label">Swap 内存</span>
                <UsageBarWithText used={memory()?.swap_used_b ?? 0} total={memory()?.swap_total_b ?? 0} level={memory() ? levelForPercent(memory()!.swap_percent, THRESHOLDS.swap) : "normal"} />
              </div>
            </section>

            <section class="overview-section overview-network">
              <div class="overview-network-row">
                <div><span class="overview-network-label">累计下行</span><strong>{formatBytes(network()?.rx_bytes ?? 0)}</strong></div>
                <div><span class="overview-network-label">累计上行</span><strong>{formatBytes(network()?.tx_bytes ?? 0)}</strong></div>
                <div><span class="overview-network-label">下行速率</span><strong>{formatRate(network()?.rx_rate)}</strong></div>
                <div><span class="overview-network-label">上行速率</span><strong>{formatRate(network()?.tx_rate)}</strong></div>
              </div>
              <div class="overview-trend-legend"><span class="dot cpu" /> CPU <span class="dot mem" /> 内存</div>
              <div class="overview-trend-wrap cpu">{sparkline(p => p.cpu)}</div>
              <div class="overview-trend-wrap mem">{sparkline(p => p.mem)}</div>
            </section>

            <Show when={(cpu()?.cores.length ?? 0) > 0}>
              <section class="overview-section">
                <h4>CPU 核心</h4>
                <div class="overview-cores">
                  <For each={cpu()!.cores}>{(core) => (
                    <div class="overview-core" title={`CPU${core.index + 1}: ${core.percent.toFixed(1)}%`}>
                      <span class="overview-core-label">CPU{core.index + 1}</span>
                      <div class={`overview-core-bar ${levelClass(levelForPercent(core.percent, THRESHOLDS.cpu))}`}>
                        <div class="overview-bar-fill" style={{ width: `${core.percent}%` }} />
                      </div>
                      <span class="overview-core-value">{core.percent.toFixed(1)}%</span>
                    </div>
                  )}</For>
                </div>
              </section>
            </Show>

            <Show when={(snapshot()?.gpu?.length ?? 0) > 0}>
              <section class="overview-section">
                <h4>GPU</h4>
                <table class="overview-table">
                  <thead><tr><th>GPU</th><th>使用率</th><th>温度</th><th>内存</th><th>功率</th></tr></thead>
                  <tbody>
                    <For each={snapshot()!.gpu!}>{(gpu) => (
                      <tr>
                        <td>{gpu.name}</td>
                        <td>{gpu.utilization.toFixed(0)}%</td>
                        <td>{gpu.temperature.toFixed(0)}℃</td>
                        <td>{formatBytes(gpu.mem_used_b)}/{formatBytes(gpu.mem_total_b)}</td>
                        <td>{gpu.power_watts != null ? `${gpu.power_watts.toFixed(0)}W` : "-"}</td>
                      </tr>
                    )}</For>
                  </tbody>
                </table>
              </section>
            </Show>

            <section class="overview-section">
              <h4>进程 <span class="overview-section-hint">按 CPU 排序</span></h4>
              <table class="overview-table">
                <thead><tr><th>进程</th><th>进程 ID</th><th>%CPU</th><th>内存</th></tr></thead>
                <tbody>
                  <For each={snapshot()?.processes ?? []}>{(proc) => (
                    <tr>
                      <td>{proc.name}</td>
                      <td>{proc.pid}</td>
                      <td>{proc.cpu.toFixed(1)}%</td>
                      <td>{formatBytes(proc.rss_b)}</td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </section>

            <section class="overview-section">
              <h4>磁盘挂载</h4>
              <div class="overview-mounts">
                <For each={disk()?.mounts ?? []}>{(mount) => (
                  <div class="overview-mount" title={`${mount.fs} 挂载于 ${mount.mount}`}>
                    <span class="overview-mount-name">{mount.mount || mount.fs}</span>
                    <div class={`overview-mount-bar ${levelClass(levelForPercent(mount.percent, THRESHOLDS.disk))}`}>
                      <div class="overview-bar-fill" style={{ width: `${mount.percent}%` }} />
                      <span class="overview-mount-text">{mount.percent.toFixed(0)}% · {formatBytes(mount.used_b)}/{formatBytes(mount.total_b)}</span>
                    </div>
                    <span class="overview-mount-path">{mount.fs}</span>
                  </div>
                )}</For>
              </div>
            </section>

            <footer class="overview-footer">
              <span>
                {getOverviewSettings().refreshIntervalSec > 0
                  ? `每 ${getOverviewSettings().refreshIntervalSec}s 自动刷新`
                  : "自动刷新已关闭"}
                {snapshot() ? ` · 耗时 ${snapshot()!.duration_ms}ms` : ""}
              </span>
              <button class="overview-copy-button" onClick={() => void copySummary()}>
                <Icon name="copy" size={13} /> 复制诊断摘要
              </button>
            </footer>
          </Show>

          <div class="overview-issues">
            <For each={snapshot()?.issues ?? []}>{(issue) => (
              <div class={`overview-issue ${issue.stale ? "stale" : ""}`} title={issue.reason}>
                <span>{issue.section}{issue.stale ? "（展示上次结果）" : ""}</span>
                <small>{issue.reason}</small>
              </div>
            )}</For>
          </div>
        </div>
      </Show>
    );
  }
};

// ---------------------------------------------------------------------------

const UsageBarWithText: Component<{ used: number; total: number; level: MetricLevel }> = (props) => {
  if (props.total <= 0) {
    return <span class="overview-memory-empty">-</span>;
  }
  const percent = Math.min(100, (props.used / props.total) * 100);
  return (
    <div class="overview-memory-bar">
      <div class={`overview-bar ${props.level}`}>
        <div class="overview-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <span class="overview-memory-text">{formatBytes(props.used)}/{formatBytes(props.total)}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 收起形态：右缘精简导轨
// ---------------------------------------------------------------------------

const OverviewRail: Component<{
  connection: ConnectionRecord | undefined;
  snapshot: DashboardSnapshot | null;
  error: string | null;
  onExpand: () => void;
}> = (props) => {
  const cpu = () => props.snapshot?.cpu;
  const mem = () => props.snapshot?.memory;
  const net = () => props.snapshot?.network;
  const disk = () => props.snapshot?.disk;
  const cpuLevel = () => (cpu() ? levelForPercent(cpu()!.total, THRESHOLDS.cpu) : "normal");

  return (
    <div class="server-overview rail" role="complementary" aria-label="服务器概览（精简）">
      <button
        class="overview-rail"
        onClick={props.onExpand}
        title="展开服务器概览"
        aria-label="展开服务器概览"
      >
        <span class="rail-glyph" aria-hidden="true"><Icon name="terminal" size={13} /></span>

        <div class="rail-group" title={`CPU 使用率 ${cpu()?.total.toFixed(1) ?? "-"}%`}>
          <span class="rail-label">CPU</span>
          <span class={`rail-pill cpu ${cpuLevel()}`}>{cpu() ? cpu()!.total.toFixed(1) : "--"}</span>
        </div>

        <div class="rail-group" title={`上行速率 ${railRateTitle(net()?.tx_rate)}`}>
          <span class="rail-label">上传</span>
          <span class="rail-pill up">{formatRailRate(net()?.tx_rate)}</span>
        </div>

        <span class="rail-divider" />

        <div class="rail-group" title={`下行速率 ${railRateTitle(net()?.rx_rate)}`}>
          <span class="rail-label">下载</span>
          <span class="rail-pill down">{formatRailRate(net()?.rx_rate)}</span>
        </div>

        <span class="rail-divider" />

        <div class="rail-group" title={`CPU 使用率 ${cpu()?.total.toFixed(1) ?? "-"}%`}>
          <span class="rail-label">CPU</span>
          <div class={`rail-gauge ${cpuLevel()}`}>
            <div class="rail-gauge-fill" style={{ height: `${cpu()?.total ?? 0}%` }} />
            <span class="rail-gauge-text">{cpu() ? `${cpu()!.total.toFixed(1)}%` : "--"}</span>
          </div>
        </div>

        <div class="rail-group" title={mem() ? `内存使用率 ${mem()!.percent.toFixed(1)}%（已用 ${formatBytes(mem()!.used_b)} / 共 ${formatBytes(mem()!.total_b)}）` : "内存"}>
          <span class="rail-label">内存</span>
          <div class={`rail-gauge ${mem() ? levelClass(levelForPercent(mem()!.percent, THRESHOLDS.memory)) : ""}`}>
            <div class="rail-gauge-fill" style={{ height: `${mem()?.percent ?? 0}%` }} />
            <span class="rail-gauge-text">{mem() ? `${mem()!.percent.toFixed(1)}%` : "--"}</span>
          </div>
        </div>

        <div class="rail-group" title={disk()?.root_percent != null ? `根分区使用率 ${disk()!.root_percent!.toFixed(1)}%（已用 ${formatBytes(disk()!.root_used_b)} / 共 ${formatBytes(disk()!.root_total_b)}）` : "磁盘"}>
          <span class="rail-label">磁盘</span>
          <div class={`rail-gauge ${disk()?.root_percent != null ? levelClass(levelForPercent(disk()!.root_percent!, THRESHOLDS.disk)) : ""}`}>
            <div class="rail-gauge-fill" style={{ height: `${disk()?.root_percent ?? 0}%` }} />
            <span class="rail-gauge-text">{disk()?.root_percent != null ? `${disk()!.root_percent!.toFixed(1)}%` : "--"}</span>
          </div>
        </div>
      </button>

      <Show when={props.error}>
        <div class="overview-rail-error" title={props.error!}>!</div>
      </Show>
    </div>
  );
};
