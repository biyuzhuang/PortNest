import { Component, createSignal, For, Show } from "solid-js";
import { themeMode, effectiveTheme, setThemeMode, ThemeMode, terminalThemes, getTerminalTheme, setTerminalTheme, getTerminalSettings, setTerminalSettings } from "../stores/themeStore";
import "./SettingsModal.css";

interface SettingsModalProps {
  onClose: () => void;
}

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<"general" | "terminal" | "appearance">("general");
  const [currentTerminalTheme, setCurrentTerminalTheme] = createSignal(getTerminalTheme());
  const terminalSettings = getTerminalSettings();
  const [copyOnSelect, setCopyOnSelect] = createSignal(terminalSettings.copyOnSelect);

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
  };

  const handleTerminalThemeChange = (name: string) => {
    setTerminalTheme(name);
    setCurrentTerminalTheme(name);
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div class="settings-tabs">
          <button
            class={`settings-tab ${activeTab() === "general" ? "active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            通用
          </button>
          <button
            class={`settings-tab ${activeTab() === "terminal" ? "active" : ""}`}
            onClick={() => setActiveTab("terminal")}
          >
            终端
          </button>
          <button
            class={`settings-tab ${activeTab() === "appearance" ? "active" : ""}`}
            onClick={() => setActiveTab("appearance")}
          >
            外观
          </button>
        </div>

        <div class="settings-content">
          <Show when={activeTab() === "general"}>
            <div class="settings-section">
              <h3>连接设置</h3>
              <div class="setting-item">
                <label>
                  <input type="checkbox" defaultChecked />
                  <span>启动时自动恢复上次会话</span>
                </label>
              </div>
              <div class="setting-item">
                <label>
                  <input type="checkbox" defaultChecked />
                  <span>连接时播放提示音</span>
                </label>
              </div>
            </div>
          </Show>

          <Show when={activeTab() === "terminal"}>
            <div class="settings-section">
              <h3>终端主题</h3>
              <div class="terminal-theme-grid">
                <For each={Object.entries(terminalThemes)}>
                  {([name, theme]) => (
                    <div
                      class={`terminal-theme-card ${currentTerminalTheme() === name ? "selected" : ""}`}
                      onClick={() => handleTerminalThemeChange(name)}
                    >
                      <div
                        class="theme-preview"
                        style={{
                          background: theme.background,
                          color: theme.foreground,
                        }}
                      >
                        <span style={{ color: theme.green }}>$</span> ls -la
                        <div style={{ color: theme.foreground }}>
                          drwxr-xr-x
                          <div style={{ color: theme.foreground }}>
                            -rw-r--r--
                          </div>
                        </div>
                      </div>
                      <div class="theme-name">{theme.name}</div>
                    </div>
                  )}
                </For>
              </div>

              <h3>终端选项</h3>
              <div class="setting-item">
                <label>
                  <input type="checkbox" checked disabled />
                  <span>Ctrl+C 有选中时复制，无选中时发送中断</span>
                </label>
              </div>
              <div class="setting-item">
                <label>
                  <input type="checkbox" checked disabled />
                  <span>Ctrl+V 粘贴系统剪贴板</span>
                </label>
              </div>
              <div class="setting-item">
                <label>
                  <input type="checkbox" checked disabled />
                  <span>右键粘贴系统剪贴板</span>
                </label>
              </div>
              <div class="setting-item">
                <label>
                  <input
                    type="checkbox"
                    checked={copyOnSelect()}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked;
                      setCopyOnSelect(checked);
                      const s = getTerminalSettings();
                      s.copyOnSelect = checked;
                      setTerminalSettings(s);
                    }}
                  />
                  <span>左键选中文本时自动复制到剪贴板</span>
                </label>
              </div>
            </div>
          </Show>

          <Show when={activeTab() === "appearance"}>
            <div class="settings-section">
              <h3>主题模式</h3>
              <div class="theme-options">
                <div
                  class={`theme-option ${themeMode() === "light" ? "selected" : ""}`}
                  onClick={() => handleThemeChange("light")}
                >
                  <div class="theme-preview light-preview">
                    <div class="preview-sidebar" />
                    <div class="preview-content">
                      <div class="preview-header" />
                      <div class="preview-body" />
                    </div>
                  </div>
                  <span>明亮</span>
                </div>
                <div
                  class={`theme-option ${themeMode() === "dark" ? "selected" : ""}`}
                  onClick={() => handleThemeChange("dark")}
                >
                  <div class="theme-preview dark-preview">
                    <div class="preview-sidebar" />
                    <div class="preview-content">
                      <div class="preview-header" />
                      <div class="preview-body" />
                    </div>
                  </div>
                  <span>暗黑</span>
                </div>
                <div
                  class={`theme-option ${themeMode() === "system" ? "selected" : ""}`}
                  onClick={() => handleThemeChange("system")}
                >
                  <div class="theme-preview system-preview">
                    <div class="preview-sidebar" />
                    <div class="preview-content">
                      <div class="preview-header" />
                      <div class="preview-body" />
                    </div>
                  </div>
                  <span>跟随系统</span>
                </div>
              </div>
            </div>
          </Show>
        </div>

        <div class="form-actions">
          <button class="btn-save" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};