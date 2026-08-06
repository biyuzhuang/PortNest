import { createSignal } from "solid-js";

// 全局 UI 状态：文件管理面板收起/展开
// 默认展开，SSH 连接成功后自动打开 SFTP 并加载文件列表
const [filesCollapsed, setFilesCollapsed] = createSignal(false);
const [filesStacked, setFilesStackedSignal] = createSignal(localStorage.getItem("portnest-files-stacked") === "true");
export type AssetFilter = "all" | "terminal";
const [assetFilter, setAssetFilter] = createSignal<AssetFilter>("all");
const [assetTreeVisible, setAssetTreeVisible] = createSignal(true);
const [selectedAssetFolderId, setSelectedAssetFolderId] = createSignal<string | null>(null);

const readFileViewOptions = (): Record<string, unknown> => {
  try { return JSON.parse(localStorage.getItem("portnest-file-view-options") || "{}"); }
  catch { return {}; }
};
const [pathLinked, setPathLinkedSignal] = createSignal(readFileViewOptions().pathLinked === true);

const setPathLinked = (value: boolean) => {
  setPathLinkedSignal(value);
  const options = readFileViewOptions();
  options.pathLinked = value;
  localStorage.setItem("portnest-file-view-options", JSON.stringify(options));
};

export const matchesAssetFilter = (protocol: string, filter = assetFilter()) => {
  void filter;
  return protocol === "ssh" || protocol === "sftp";
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
};
