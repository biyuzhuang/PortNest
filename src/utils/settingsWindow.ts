import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function openSettingsWindow() {
  const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (!isTauri) {
    window.open(`${window.location.origin}${window.location.pathname}?window=settings`, "portnest-settings", "popup,width=920,height=720");
    return;
  }
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const settings = new WebviewWindow("settings", {
    url: "?window=settings",
    title: "PortNest 设置",
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    center: true,
    resizable: true,
    decorations: false,
    focus: true,
  });
  settings.once("tauri://error", event => console.error("Unable to open settings window", event.payload));
}
