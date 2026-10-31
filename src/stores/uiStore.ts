import { createSignal } from "solid-js";

// 全局 UI 状态：文件管理面板收起/展开
// 默认展开，SSH 连接成功后自动打开 SFTP 并加载文件列表
const [filesCollapsed, setFilesCollapsed] = createSignal(false);
const [filesStacked, setFilesStackedSignal] = createSignal(localStorage.getItem("portnest-files-stacked") === "true");
export type AssetFilter = "all" | "terminal" | "database";
const [assetFilter, setAssetFilter] = createSignal<AssetFilter>("all");
const [assetTreeVisible, setAssetTreeVisible] = createSignal(true);
const [selectedAssetFolderId, setSelectedAssetFolderId] = createSignal<string | null>(null);

const readFileViewOptions = (): Record<string, unknown> => {
  try { return JSON.parse(localStorage.getItem("portnest-file-view-options") || "{}"); }
  catch { return {}; }
};
const [pathLinked, setPathLinkedSignal] = createSignal(readFileViewOptions().pathLinked === true);

// 服务器概览：收起为右缘精简导轨，展开为详细面板；默认收起。
const readOverviewCollapsed = () => localStorage.getItem("portnest-overview-collapsed") !== "false";
const [overviewCollapsed, setOverviewCollapsedSignal] = createSignal(readOverviewCollapsed());

const setOverviewCollapsed = (value: boolean) => {
  localStorage.setItem("portnest-overview-collapsed", String(value));
  setOverviewCollapsedSignal(value);
};

const setPathLinked = (value: boolean) => {
  setPathLinkedSignal(value);
  const options = readFileViewOptions();
  options.pathLinked = value;
  localStorage.setItem("portnest-file-view-options", JSON.stringify(options));
};

export type WindowCloseAction = "ask" | "close" | "fold";

const WINDOW_CLOSE_KEY = "portnest-window-close-action";
const readWindowCloseAction = (): WindowCloseAction => {
  const value = localStorage.getItem(WINDOW_CLOSE_KEY);
  return value === "close" || value === "fold" ? value : "ask";
};
const [windowCloseAction, setWindowCloseActionSignal] = createSignal<WindowCloseAction>(readWindowCloseAction());

const setWindowCloseAction = (value: WindowCloseAction) => {
  if (value === "ask") localStorage.removeItem(WINDOW_CLOSE_KEY);
  else localStorage.setItem(WINDOW_CLOSE_KEY, value);
  setWindowCloseActionSignal(value);
};

// 设置页和主窗口运行在不同 WebView：localStorage 变更只会在另一个窗口触发 storage，
// 这里把两边共用的偏好重新读入 signal，避免主窗口继续使用旧值。
window.addEventListener("storage", event => {
  if (event.key === "portnest-file-view-options" || event.key === null) {
    setPathLinkedSignal(readFileViewOptions().pathLinked === true);
  }
  if (event.key === WINDOW_CLOSE_KEY || event.key === null) {
    setWindowCloseActionSignal(readWindowCloseAction());
  }
});

const DATABASE_PROTOCOLS = new Set(["mysql", "postgresql", "highgo"]);

export const matchesAssetFilter = (protocol: string, filter = assetFilter()) => {
  if (filter === "database") return DATABASE_PROTOCOLS.has(protocol);
  if (filter === "terminal") return protocol === "ssh" || protocol === "sftp" || protocol === "local";
  return protocol === "ssh" || protocol === "sftp" || protocol === "local" || DATABASE_PROTOCOLS.has(protocol);
};

export const uiStore = {
  filesCollapsed,
  setFilesCollapsed,
  toggleFiles: () => setFilesCollapsed(!filesCollapsed()),
  filesStacked,
  setFilesStacked: (value: boolean) => {
    localStorage.setItem("portnest-files-stacked", String(value));
    setFilesStackedSignal(value);
  },
  assetFilter,
  setAssetFilter,
  assetTreeVisible,
  setAssetTreeVisible,
  toggleAssetTree: () => setAssetTreeVisible(!assetTreeVisible()),
  selectedAssetFolderId,
  setSelectedAssetFolderId,
  pathLinked,
  setPathLinked,
  windowCloseAction,
  setWindowCloseAction,
  overviewCollapsed,
  setOverviewCollapsed,
  toggleOverview: () => setOverviewCollapsed(!overviewCollapsed()),
};
