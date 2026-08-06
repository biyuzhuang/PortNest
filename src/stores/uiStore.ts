import { createSignal } from "solid-js";

// 全局 UI 状态：文件管理面板收起/展开
// 默认展开，SSH 连接成功后自动打开 SFTP 并加载文件列表
const [filesCollapsed, setFilesCollapsed] = createSignal(false);
const [filesStacked, setFilesStackedSignal] = createSignal(localStorage.getItem("portnest-files-stacked") === "true");
export type AssetFilter = "all" | "terminal";
const [assetFilter, setAssetFilter] = createSignal<AssetFilter>("all");
const [assetTreeVisible, setAssetTreeVisible] = createSignal(true);
const [selectedAssetFolderId, setSelectedAssetFolderId] = createSignal<string | null>(null);

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
};
