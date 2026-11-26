import { createSignal } from "solid-js";

/**
 * 数据库模块偏好（设置 · 通用 · 数据库）。
 *
 * 与外观的整体缩放分开：缩放是页面级行为，这里的每一项只影响数据库工作区的
 * 具体表现，缺省值与设置页截图保持一致。
 *
 * 注意：设置页运行在独立的 Tauri 窗口，`window.dispatchEvent` 只在同一个窗口内
 * 可见。这里必须走跨窗口通道（BroadcastChannel / storage 事件 / Tauri emit），
 * 否则主窗口读到的永远是启动时的那份快照。
 */

export type TabLabelMode = "database-connection" | "database" | "table";
export type TableCacheMode = "on-connect" | "on-expand" | "off";
export type TextAlignMode = "center" | "left" | "right";
export type ScrollMode = "natural" | "smooth";

export interface DatabaseSettings {
  /** 表格字体（数据网格与结果集） */
  tableFont: string;
  /** 打开连接时自动展开数据库（默认关闭：连接后所有库保持折叠） */
  autoExpandOnConnect: boolean;
  /** 迁移标记：把旧版本默认的「自动展开」一次性关掉 */
  autoExpandMigrated?: boolean;
  /** 数据库标签显示信息 */
  tabLabelMode: TabLabelMode;
  /** 表缓存策略 */
  tableCache: TableCacheMode;
  /** 横向滚动时主键列保持可见 */
  fixedPrimaryKey: boolean;
  /** 统计总行数 */
  statTotalRows: boolean;
  /** 复合数据表头 */
  compositeHeader: boolean;
  /** 加载全库字段 */
  loadAllColumns: boolean;
  /** 文本对齐 */
  textAlign: TextAlignMode;
  /** 每页行数 */
  pageSize: number;
  /** 在资产树表节点后显示注释 */
  showTableComment: boolean;
  /** 在资产树的库名右侧显示字符集编码 */
  showDatabaseCharset: boolean;
  /** 单击表时展开右侧信息栏；关闭后单击只选中，不弹信息栏 */
  openInfoOnClick: boolean;
  /** 执行高风险 SQL 前确认 */
  confirmDangerousSql: boolean;
  /** 批量执行出错立即停止 */
  stopOnError: boolean;
  /** 滚动方式 */
  scrollMode: ScrollMode;
  /** 游标滚动速度 */
  wheelSpeed: number;
  /** Redis 键列表上限 */
  redisKeyLimit: number;
  /** Redis 显示键值 */
  redisShowValues: boolean;
  /** Redis 分组分隔符 */
  redisSeparator: string;
}

/** 名称沿用设置页截图，值是可真正命中的字体栈（缺字时逐级回退，不会退化成正文字体） */
export const databaseTableFonts: Array<{ label: string; value: string }> = [
  { label: "JetBrainsMono, NotoSansSC", value: '"JetBrains Mono", "Noto Sans SC", "Cascadia Mono", Consolas, monospace' },
  { label: "Cascadia Mono", value: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  { label: "Consolas", value: "Consolas, monospace" },
  { label: "系统默认（随窗口）", value: "var(--font-ui)" },
];

export const databaseSettingsDefaults: DatabaseSettings = {
  tableFont: '"JetBrains Mono", "Noto Sans SC", "Cascadia Mono", Consolas, monospace',
  autoExpandOnConnect: false,
  tabLabelMode: "database-connection",
  tableCache: "on-connect",
  fixedPrimaryKey: true,
  statTotalRows: false,
  compositeHeader: false,
  loadAllColumns: false,
  textAlign: "center",
  pageSize: 500,
  showTableComment: true,
  showDatabaseCharset: false,
  openInfoOnClick: true,
  confirmDangerousSql: true,
  stopOnError: false,
  scrollMode: "natural",
  wheelSpeed: 1,
  redisKeyLimit: 10000,
  redisShowValues: true,
  redisSeparator: ":",
};

const STORAGE_KEY = "portnest-database-settings";
/** 跨窗口通道名，Tauri 事件与 BroadcastChannel 共用 */
const SYNC_CHANNEL = "portnest-database-settings";
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 10000;

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/** 把任意来源（本地存储 / 另一个窗口）的原始值收敛成合法设置 */
function normalizeSettings(raw: Partial<DatabaseSettings> | null | undefined): DatabaseSettings {
  const stored = raw ?? {};
  // 老版本的默认值是「打开连接时自动展开所有库」，新默认改为折叠。
  // 只在迁移标记缺失时纠正一次，用户之后手动打开仍然生效。
  const migrated = stored.autoExpandMigrated === true;
  return {
    ...databaseSettingsDefaults,
    ...(migrated ? stored : { ...stored, autoExpandOnConnect: false }),
    autoExpandMigrated: true,
    pageSize: clampInt(stored.pageSize, PAGE_SIZE_MIN, PAGE_SIZE_MAX, databaseSettingsDefaults.pageSize),
    wheelSpeed: clampInt(stored.wheelSpeed, 1, 10, databaseSettingsDefaults.wheelSpeed),
    redisKeyLimit: clampInt(stored.redisKeyLimit, 10, 1000000, databaseSettingsDefaults.redisKeyLimit),
    redisSeparator:
      typeof stored.redisSeparator === "string" && stored.redisSeparator
        ? stored.redisSeparator
        : databaseSettingsDefaults.redisSeparator,
  };
}

export function getDatabaseSettings(): DatabaseSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<DatabaseSettings> | null;
    if (!stored) return databaseSettingsDefaults;
    return normalizeSettings(stored);
  } catch {
    return databaseSettingsDefaults;
  }
}

const [databaseSettings, setDatabaseSettingsInternal] = createSignal<DatabaseSettings>(getDatabaseSettings());
export { databaseSettings };

/**
 * 设置变更次数。
 *
 * 组件除了读 `databaseSettings()`，再顺手读一下这个计数：任何来源（本窗口、
 * 设置窗口、其他窗口）改动设置都会把它 +1，保证订阅方一定重算。
 */
const [databaseSettingsEpoch, setDatabaseSettingsEpoch] = createSignal(0);
export { databaseSettingsEpoch };

const isTauriWindow = () =>
  typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

const syncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(SYNC_CHANNEL) : null;

let lastApplied = "";
let applyingRemote = false;

/** 收到别处的设置：只更新本地，不再向外广播，避免两个窗口来回打转 */
function applyIncoming(raw: Partial<DatabaseSettings> | null | undefined) {
  if (!raw) return;
  const next = normalizeSettings(raw);
  const stamp = JSON.stringify(next);
  if (stamp === lastApplied) return;
  lastApplied = stamp;
  applyingRemote = true;
  setDatabaseSettingsInternal(next);
  applyDatabaseTableFont(next.tableFont);
  setDatabaseSettingsEpoch(value => value + 1);
  applyingRemote = false;
}

if (typeof window !== "undefined") {
  // ① 同窗口：设置页与主界面若共用窗口（浏览器预览）时走这里
  window.addEventListener(SYNC_CHANNEL, event => {
    applyIncoming((event as CustomEvent<DatabaseSettings>).detail);
  });

  // ② 跨窗口：Chromium 的 BroadcastChannel 在同一 profile 的不同 WebView 间可用
  if (syncChannel) syncChannel.onmessage = event => applyIncoming(event.data);

  // ③ 兜底：localStorage 被另一个窗口改写时浏览器会派发 storage 事件
  window.addEventListener("storage", event => {
    if (event.key !== STORAGE_KEY) return;
    applyIncoming(getDatabaseSettings());
  });

  // ④ Tauri 原生事件：跨窗口最可靠的通道（WebView2 之间存储事件不保证送达）
  if (isTauriWindow()) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<DatabaseSettings>(SYNC_CHANNEL, event => applyIncoming(event.payload)))
      .catch(() => undefined);
  }
}

export function setDatabaseSettings(patch: Partial<DatabaseSettings>) {
  const next = normalizeSettings({ ...getDatabaseSettings(), ...patch });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  lastApplied = JSON.stringify(next);
  setDatabaseSettingsInternal(next);
  applyDatabaseTableFont(next.tableFont);
  setDatabaseSettingsEpoch(value => value + 1);
  if (applyingRemote) return;

  // 广播给其他窗口（设置页 ↔ 主窗口是两个独立 WebView）
  window.dispatchEvent(new CustomEvent(SYNC_CHANNEL, { detail: next }));
  syncChannel?.postMessage(next);
  if (isTauriWindow()) {
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SYNC_CHANNEL, next))
      .catch(() => undefined);
  }
}

/** 表格字体通过 CSS 变量下发，数据网格与结果集共用 */
export function applyDatabaseTableFont(font: string) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--db-table-font", font);
}

export function initDatabaseSettings() {
  const settings = getDatabaseSettings();
  lastApplied = JSON.stringify(settings);
  setDatabaseSettingsInternal(settings);
  applyDatabaseTableFont(settings.tableFont);

  if (typeof window === "undefined") return;
  /**
   * 保险丝：从设置窗口切回主窗口时，对着 localStorage 再核一次。
   * 跨窗口事件通道在某些 WebView2 组合下可能丢掉一条消息，而「点回主窗口」
   * 必然会触发 focus —— 用它兜住，绝不会出现改了设置要重启才生效的情况。
   */
  const resync = () => {
    const stored = getDatabaseSettings();
    if (JSON.stringify(stored) !== lastApplied) applyIncoming(stored);
  };
  window.addEventListener("focus", resync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resync();
  });
}
