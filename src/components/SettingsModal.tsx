import { Component, For, Show, createSignal } from "solid-js";
import {
  themeMode, setThemeMode, type ThemeMode, terminalThemes, getTerminalTheme,
  setTerminalTheme, getTerminalSettings, setTerminalSettings,
  terminalBackgroundStyle, setTerminalBackgroundStyle, type TerminalBackgroundStyle,
  type TerminalSettings,
} from "../stores/themeStore";
import { uiStore } from "../stores/uiStore";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./SettingsModal.css";

interface SettingsModalProps { onClose: () => void; }
type Page = "appearance" | "terminalAppearance" | "general" | "ssh";

const BACKGROUNDS: Array<[TerminalBackgroundStyle, string]> = [
  ["striped", "PortNest 条纹"], ["solid_dark", "纯色深色"],
  ["solid_light", "纯色浅色"], ["midnight", "午夜渐变"],
];

const Toggle: Component<{ checked: boolean; onChange: (value: boolean) => void }> = (props) => (
  <button
    type="button"
    class={`settings-switch ${props.checked ? "on" : ""}`}
    role="switch"
    aria-checked={props.checked}
    onClick={() => props.onChange(!props.checked)}
  ><span /></button>
);

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [page, setPage] = createSignal<Page>("appearance");
  const [currentTerminalTheme, setCurrentTerminalTheme] = createSignal(getTerminalTheme());
  const [terminalSettings, setSettings] = createSignal<TerminalSettings>(getTerminalSettings());
  const [updateStatus, setUpdateStatus] = createSignal("检查更新");
  const [checkingUpdate, setCheckingUpdate] = createSignal(false);

  const handleCheckUpdate = async () => {
    if (checkingUpdate()) return;
    setCheckingUpdate(true);
    setUpdateStatus("正在检查...");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("已是最新版本");
        return;
      }
      setUpdateStatus(`正在下载 ${update.version}...`);
      await update.downloadAndInstall(event => {
        if (event.event === "Finished") setUpdateStatus("安装完成，正在重启...");
      });
      await relaunch();
    } catch (error) {
      console.error("Update failed:", error);
      setUpdateStatus("检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const updateSetting = <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => {
    const next = { ...terminalSettings(), [key]: value };
    setSettings(next);
    setTerminalSettings(next);
  };

  const navItem = (id: Page, label: string) => (
    <button class={page() === id ? "active" : ""} onClick={() => setPage(id)}>{label}</button>
  );

  return (
    <div class="settings-workspace">
      <header class="settings-topbar">
        <strong>PortNest</strong>
        <span>设置</span>
        <button onClick={props.onClose} aria-label="关闭设置">×</button>
      </header>

      <div class="settings-layout">
        <aside class="settings-sidebar">
          <h4>外观</h4>
          {navItem("appearance", "基础")}
          {navItem("terminalAppearance", "终端")}
          <h4>通用</h4>
          {navItem("general", "基础")}
          {navItem("ssh", "SSH / 终端")}
        </aside>

        <main class="settings-main">
          <Show when={page() === "appearance"}>
            <div class="settings-page">
              <div class="appearance-preview">
                <div class="preview-titlebar"><i /><i /><i /><b /></div>
                <div class="preview-layout"><aside /><section><nav /><div class="preview-table" /></section></div>
              </div>
              <h3>基础</h3>
              <div class="settings-grid"><div class="settings-card">
                <label><span>主题模式</span>
                  <select value={themeMode()} onChange={event => setThemeMode(event.currentTarget.value as ThemeMode)}>
                    <option value="system">跟随系统</option><option value="light">明亮</option><option value="dark">暗黑</option>
                  </select>
                </label>
              </div></div>
            </div>
          </Show>

          <Show when={page() === "terminalAppearance"}>
            <div class="settings-page">
              <div class={`terminal-settings-preview terminal-background-${terminalBackgroundStyle()}`}>
                <div><span>user@server</span>:<b>~/app$</b> ls -all</div>
                <div>drwxr-xr-x deploy deploy 4096 dist</div>
                <div>-rw-r--r-- deploy deploy 256 .env</div>
                <div><span>user@server</span>:<b>~/app$</b></div>
              </div>
              <h3>主题</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span>终端主题</span>
                    <select value={currentTerminalTheme()} onChange={event => {
                      setTerminalTheme(event.currentTarget.value);
                      setCurrentTerminalTheme(event.currentTarget.value);
                    }}>
                      <For each={Object.entries(terminalThemes)}>{([key, value]) => <option value={key}>{value.name}</option>}</For>
                    </select>
                  </label>
                  <label><span>终端字体</span>
                    <select value={terminalSettings().fontFamily} onChange={event => updateSetting("fontFamily", event.currentTarget.value)}>
                      <option>JetBrains Mono, Cascadia Code, Consolas, monospace</option>
                      <option>Cascadia Code, Consolas, monospace</option><option>Consolas, monospace</option>
                    </select>
                  </label>
                  <label><span>终端字号</span><input type="number" min="9" max="28" value={terminalSettings().fontSize} onChange={event => updateSetting("fontSize", Number(event.currentTarget.value))} /></label>
                  <label><span>终端行高</span><input type="number" min="1" max="2" step="0.1" value={terminalSettings().lineHeight} onChange={event => updateSetting("lineHeight", Number(event.currentTarget.value))} /></label>
                  <label><span>终端间距</span><input type="number" min="-2" max="8" value={terminalSettings().letterSpacing} onChange={event => updateSetting("letterSpacing", Number(event.currentTarget.value))} /></label>
                </div>
                <div class="settings-card">
                  <label><span>条纹背景</span><Toggle checked={terminalBackgroundStyle() === "striped"} onChange={value => setTerminalBackgroundStyle(value ? "striped" : "solid_dark")} /></label>
                  <label><span>终端背景</span>
                    <select value={terminalBackgroundStyle()} onChange={event => setTerminalBackgroundStyle(event.currentTarget.value as TerminalBackgroundStyle)}>
                      <For each={BACKGROUNDS}>{([key, label]) => <option value={key}>{label}</option>}</For>
                    </select>
                  </label>
                  <label><span>最大缓存行数</span><input type="number" min="100" max="100000" value={terminalSettings().scrollback} onChange={event => updateSetting("scrollback", Number(event.currentTarget.value))} /></label>
                </div>
              </div>
            </div>
          </Show>

          <Show when={page() === "general"}>
            <div class="settings-page">
              <h3>基础</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span>应用更新</span><button class="settings-inline-button" disabled={checkingUpdate()} onClick={handleCheckUpdate}>{updateStatus()}</button></label>
                  <p class="settings-note">会话标签、顺序、固定状态和活动标签会自动保存；应用启动后以离线标签恢复，不会自动批量连接。</p>
                </div>
              </div>
            </div>
          </Show>

          <Show when={page() === "ssh"}>
            <div class="settings-page">
              <h3>终端</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span>鼠标选中自动复制</span><Toggle checked={terminalSettings().copyOnSelect} onChange={value => updateSetting("copyOnSelect", value)} /></label>
                </div>
                <div class="settings-card">
                  <label><span>连接断开自动重连</span><Toggle checked={terminalSettings().reconnectOnDisconnect} onChange={value => updateSetting("reconnectOnDisconnect", value)} /></label>
                  <label><span>鼠标中键执行</span>
                    <select value={terminalSettings().middleClickAction} onChange={event => updateSetting("middleClickAction", event.currentTarget.value as "paste" | "none")}>
                      <option value="none">不执行</option><option value="paste">粘贴</option>
                    </select>
                  </label>
                  <label><span>鼠标右键执行</span>
                    <select value={terminalSettings().rightClickAction} onChange={event => updateSetting("rightClickAction", event.currentTarget.value as "paste" | "none")}>
                      <option value="paste">粘贴</option><option value="none">不执行</option>
                    </select>
                  </label>
                  <label><span>Ctrl+V 粘贴</span><Toggle checked={terminalSettings().ctrlVPaste} onChange={value => updateSetting("ctrlVPaste", value)} /></label>
                </div>
              </div>
              <h3>SFTP</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <label><span>文件列表布局</span>
                    <select value={uiStore.filesStacked() ? "stacked" : "side"} onChange={event => uiStore.setFilesStacked(event.currentTarget.value === "stacked")}>
                      <option value="side">左右布局</option><option value="stacked">上下布局</option>
                    </select>
                  </label>
                </div>
                <div class="settings-card">
                  <label><span>默认展开文件区</span><Toggle checked={!uiStore.filesCollapsed()} onChange={value => uiStore.setFilesCollapsed(!value)} /></label>
                </div>
              </div>
            </div>
          </Show>
        </main>
      </div>

      <footer class="settings-footer">
        <span>设置已自动保存并立即生效</span>
        <button onClick={props.onClose}>完成</button>
      </footer>
    </div>
  );
};
