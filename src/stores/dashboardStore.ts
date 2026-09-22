import { createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// 服务器概览设置（localStorage 持久化）
// ---------------------------------------------------------------------------

/** 支持的刷新间隔（秒）；0 表示关闭自动刷新。 */
export const REFRESH_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "关闭" },
  { value: 2, label: "2 秒" },
  { value: 5, label: "5 秒" },
  { value: 10, label: "10 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "60 秒" },
];

const SETTINGS_KEY = "portnest-overview-settings-v2";

export interface OverviewSettings {
  /** 主机状态仪表盘总开关（默认开启）；关闭时停用自动采集。 */
  enabled: boolean;
  /** 刷新间隔秒数，0 = 关闭自动刷新。 */
  refreshIntervalSec: number;
}

/** 需求约定：默认开启；指标每 10 秒刷新一次。 */
const DEFAULT_SETTINGS: OverviewSettings = { enabled: true, refreshIntervalSec: 10 };

function readSettings(): OverviewSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const interval = Number(raw.refreshIntervalSec);
    const valid = REFRESH_OPTIONS.some(option => option.value === interval);
    return {
      enabled: raw.enabled !== false,
      refreshIntervalSec: valid ? interval : DEFAULT_SETTINGS.refreshIntervalSec,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const [overviewSettings, setOverviewSettingsInternal] = createSignal<OverviewSettings>(readSettings());

// 设置页运行在独立的 webview 窗口里：Solid signal 不跨窗口互通，但同源
// localStorage 变更会广播 storage 事件。监听它让主窗口的设置即时生效，
// 无需重启应用。
window.addEventListener("storage", event => {
  if (event.key === SETTINGS_KEY || event.key === null) {
    setOverviewSettingsInternal(readSettings());
  }
});

export const getOverviewSettings = () => overviewSettings();

export function setOverviewSettings(patch: Partial<OverviewSettings>) {
  const next = { ...overviewSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  setOverviewSettingsInternal(next);
}

// ---------------------------------------------------------------------------
// 趋势环形缓冲（每个连接独立，仅保存在内存中）
// ---------------------------------------------------------------------------

export interface TrendPoint {
  at: number;
  cpu: number;
  mem: number;
  rx_rate: number;
  tx_rate: number;
}

/** 最多保留 120 个采样点（按 5s 刷新约 10 分钟）。 */
const MAX_TREND_POINTS = 120;
/** 最多同时缓存 3 个最近活跃连接的趋势。 */
const MAX_TREND_CONNECTIONS = 4;

const trends = new Map<string, TrendPoint[]>();

export function appendTrend(connectionId: string, point: TrendPoint) {
  let list = trends.get(connectionId);
  if (!list) {
    if (trends.size >= MAX_TREND_CONNECTIONS) {
      // 淘汰最久未更新的连接趋势。
      const oldest = [...trends.entries()].sort((a, b) => a[1][a[1].length - 1]?.at - b[1][b[1].length - 1]?.at)[0];
      if (oldest) trends.delete(oldest[0]);
    }
    list = [];
    trends.set(connectionId, list);
  }
  list.push(point);
  if (list.length > MAX_TREND_POINTS) list.splice(0, list.length - MAX_TREND_POINTS);
}

export function getTrend(connectionId: string): TrendPoint[] {
  return trends.get(connectionId) ?? [];
}

export function clearTrend(connectionId: string) {
  trends.delete(connectionId);
}

// ---------------------------------------------------------------------------
// 阈值状态（正常 / 警告 / 严重）
// ---------------------------------------------------------------------------

export type MetricLevel = "normal" | "warning" | "critical";

export const THRESHOLDS = {
  cpu: { warning: 60, critical: 85 },
  memory: { warning: 70, critical: 90 },
  disk: { warning: 80, critical: 90 },
  swap: { warning: 50, critical: 80 },
};

/** 负载除以核心数超过该比例视为警告 / 严重。 */
export const LOAD_RATIO = { warning: 0.7, critical: 1.2 };

export function levelForPercent(percent: number, thresholds: { warning: number; critical: number }): MetricLevel {
  if (percent >= thresholds.critical) return "critical";
  if (percent >= thresholds.warning) return "warning";
  return "normal";
}

export function levelForLoad(load1: number, cores: number): MetricLevel {
  const ratio = cores > 0 ? load1 / cores : load1;
  if (ratio >= LOAD_RATIO.critical) return "critical";
  if (ratio >= LOAD_RATIO.warning) return "warning";
  return "normal";
}
