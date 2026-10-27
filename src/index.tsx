/* @refresh reload */
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

const isSettingsWindow = new URLSearchParams(window.location.search).get("window") === "settings";
document.addEventListener("contextmenu", event => event.preventDefault(), { capture: true });
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
