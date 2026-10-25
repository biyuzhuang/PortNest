import { invoke, isTauri } from "@tauri-apps/api/core";
import { feedback } from "../stores/feedbackStore";

export async function openSettingsWindow(page?: string) {
  if (page) localStorage.setItem("portnest-settings-page", page);

  if (isTauri()) {
    try {
      await invoke("open_settings_window");
    } catch (error) {
      console.error("Unable to open settings window", error);
      feedback.error(`无法打开设置窗口：${String(error)}`);
    }
    return;
  }

  const settingsUrl = new URL(window.location.href);
  settingsUrl.search = "";
  settingsUrl.hash = "";
  settingsUrl.searchParams.set("window", "settings");
  if (page) settingsUrl.searchParams.set("page", page);
  window.open(settingsUrl.toString(), "portnest-settings", "popup,width=920,height=720");
}
