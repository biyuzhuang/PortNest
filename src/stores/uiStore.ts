import { createSignal } from "solid-js";

// 全局 UI 状态：文件管理面板收起/展开
// 默认展开，SSH 连接成功后自动打开 SFTP 并加载文件列表
const [filesCollapsed, setFilesCollapsed] = createSignal(false);

export const uiStore = {
  filesCollapsed,
  setFilesCollapsed,
  toggleFiles: () => setFilesCollapsed(!filesCollapsed()),
};