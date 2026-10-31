/* @refresh reload */
// Design tokens first: every later stylesheet resolves its colours through them.
import "./styles/tokens.css";
import { render } from "solid-js/web";
import App from "./App";
import { SettingsModal } from "./components/SettingsModal";
import { FeedbackHost } from "./components/FeedbackHost";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initTheme } from "./stores/themeStore";
import "./visual-refresh.css";
// Loaded last so the asset tree can override the older global layers.
import "./components/AssetList.css";
// Final layer: aligns the remaining pages, menus and expanders with the tree.
import "./components/Surfaces.css";
// Theme skins layer: owns palettes per data-skin/data-theme and re-introduces gradients.
import "./components/Themes.css";
// Application shell: titlebar, rail, session header, status bar.
import "./styles/shell.css";
// Asset tree panel: rows, filters, folder counts.
import "./styles/tree.css";
// Right dock: SFTP panel, path bar, file rows, transfers.
import "./styles/panel.css";
// Form controls and primary-action typography.
import "./styles/forms.css";
// Command palette, menus and modal shells.
import "./styles/overlays.css";
// Create/edit asset window: compact geometry wins over the legacy App.css
// metrics, so it is loaded after every other layer.
import "./components/ConnectionForm.css";

const isSettingsWindow = new URLSearchParams(window.location.search).get("window") === "settings";
document.addEventListener("contextmenu", event => event.preventDefault(), { capture: true });
// Bubble phase so xterm's Ctrl+F search runs first; only suppress WebView2's native find.
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
  }
});
initTheme();
render(
  () => isSettingsWindow
    ? <>
        <SettingsModal standalone onClose={() => {
          if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) void getCurrentWindow().close();
          else window.close();
        }} />
        <FeedbackHost />
      </>
    : <App />,
  document.getElementById("root") as HTMLElement,
);
