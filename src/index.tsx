/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { SettingsModal } from "./components/SettingsModal";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initTheme } from "./stores/themeStore";

const isSettingsWindow = new URLSearchParams(window.location.search).get("window") === "settings";
document.addEventListener("contextmenu", event => event.preventDefault(), { capture: true });
initTheme();
render(
  () => isSettingsWindow
    ? <SettingsModal standalone onClose={() => {
        if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) void getCurrentWindow().close();
        else window.close();
      }} />
    : <App />,
  document.getElementById("root") as HTMLElement,
);
