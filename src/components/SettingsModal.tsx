import { Component, For, Show, createSignal, onMount } from "solid-js";
import {
  themeMode, setThemeMode, type ThemeMode, terminalThemes, getTerminalTheme,
  getTerminalThemePreferences, setTerminalThemePreferences, effectiveTheme, getTerminalSettings, setTerminalSettings,
  terminalBackgroundConfig, setTerminalBackgroundConfig, getEffectiveTerminalBackgroundStyle, type TerminalBackgroundStyle, type TerminalBackgroundConfig,
  type TerminalSettings,
} from "../stores/themeStore";
import { uiStore } from "../stores/uiStore";
import { clearTerminalBackgroundImage, loadTerminalBackgroundImage, saveTerminalBackgroundImage, terminalBackgroundImageUrl } from "../stores/terminalBackgroundStore";
import { Icon } from "./Icon";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import packageInfo from "../../package.json";
import { templateStore } from "../stores/templateStore";
import "./SettingsModal.css";

interface SettingsModalProps { onClose: () => void; standalone?: boolean; }
type Page = "appearance" | "ssh" | "templates" | "version";

const BACKGROUNDS: Array<[TerminalBackgroundStyle, string]> = [
  ["theme", "跟随主题"], ["solid", "自定义纯色"], ["midnight", "午夜渐变"], ["aurora", "极光渐变"], ["image", "背景图片"],
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

export const CommandTemplatesSettings: Component = () => {
  void templateStore.refresh();
  const [templateQuery, setTemplateQuery] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");
  const [editContent, setEditContent] = createSignal("");

  const filtered = () => {
    const query = templateQuery().trim().toLowerCase();
    const list = templateStore.templates().filter(item => (item.id.startsWith("draft-") ? true : true));
    if (!query) return list;
    return list.filter(item => `${item.name} ${item.content}`.toLowerCase().includes(query));
  };
  const beginEdit = (item: { id: string; name: string; content: string }) => { setEditingId(item.id); setEditName(item.name); setEditContent(item.content); };
  const createTemplate = () => {
    const draft = templateStore.addDraft();
    setEditingId(draft.id); setEditName(draft.name); setEditContent("");
  };
  const saveEditing = async () => {
    const id = editingId();
    if (!id || !editName().trim() || !editContent().trim()) return;
    const saved = await templateStore.save({ id: id.startsWith("draft-") ? undefined : id, name: editName().trim(), content: editContent() });
    if (id.startsWith("draft-")) setEditingId(saved.id);
  };
  const cancelEditing = () => {
    const id = editingId();
    if (id?.startsWith("draft-")) templateStore.discardDraft(id);
    setEditingId(null); setEditName(""); setEditContent("");
  };
  const deleteTemplate = async (id: string) => {
    if (id.startsWith("draft-")) { templateStore.discardDraft(id); if (editingId() === id) { setEditingId(null); setEditName(""); setEditContent(""); } return; }
    await templateStore.remove(id);
    if (editingId() === id) { setEditingId(null); setEditName(""); setEditContent(""); }
  };

  return <div class="settings-page">
    <div class="settings-page-heading"><h2>命令模板</h2><p>管理命令广播撰写窗格共用的命令模板列表，修改即时同步。</p></div>
    <h3>模板列表</h3>
    <div class="settings-grid settings-grid-single"><div class="settings-card templates-card">
      <div class="templates-toolbar">
        <input class="templates-search" placeholder="搜索模板名称或命令" value={templateQuery()} onInput={event => setTemplateQuery(event.currentTarget.value)} />
        <button class="settings-inline-button" onClick={createTemplate}>＋ 新增模板</button>
      </div>
      <Show when={!filtered().length}><p class="templates-empty">暂无模板，点击“新增模板”创建第一条命令。</p></Show>
      <div class="templates-list">
        <For each={filtered()}>{item => (
          <div class={`templates-row ${editingId() === item.id ? "editing" : ""}`}>
            <Show when={editingId() === item.id} fallback={
              <><div class="templates-row-main"><strong>{item.name}</strong><code>{item.content.split("\n")[0] || "（空）"}</code></div>
                <span class="settings-image-actions"><button class="settings-inline-button" onClick={() => beginEdit(item)}>编辑</button><button class="settings-inline-button danger" onClick={() => void deleteTemplate(item.id)}>删除</button></span></>
            }>
              <div class="templates-editor">
                <label><span>模板名称</span><input value={editName()} onInput={event => setEditName(event.currentTarget.value)} /></label>
                <label><span>命令内容</span><textarea value={editContent()} rows={3} onInput={event => setEditContent(event.currentTarget.value)} /></label>
                <span class="settings-image-actions">
                  <button class="settings-inline-button" onClick={() => void saveEditing()}>保存</button>
                  <button class="settings-inline-button" onClick={cancelEditing}>取消</button>
                </span>
              </div>
            </Show>
          </div>
        )}</For>
      </div>
    </div></div>
  </div>;
};

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [page, setPage] = createSignal<Page>("appearance");
  const [currentTerminalTheme, setCurrentTerminalTheme] = createSignal(getTerminalTheme());
  const [terminalThemePreferences, setThemePreferences] = createSignal(getTerminalThemePreferences());
  const [terminalSettings, setSettings] = createSignal<TerminalSettings>(getTerminalSettings());
  const [updateStatus, setUpdateStatus] = createSignal("检查更新");
  const [checkingUpdate, setCheckingUpdate] = createSignal(false);
  const [background, setBackground] = createSignal<TerminalBackgroundConfig>(terminalBackgroundConfig());
  const [imageError, setImageError] = createSignal("");
  const [appVersion, setAppVersion] = createSignal(packageInfo.version);
  let imageInputRef: HTMLInputElement | undefined;

  onMount(() => {
    void loadTerminalBackgroundImage(background().imageAssetId);
    void getVersion().then(setAppVersion).catch(() => setAppVersion(packageInfo.version));
  });

  const updateBackground = (patch: Partial<TerminalBackgroundConfig>) => {
    const next = { ...background(), ...patch };
    setBackground(next);
    setTerminalBackgroundConfig(next);
  };

  const updateThemePreferences = (patch: Partial<ReturnType<typeof getTerminalThemePreferences>>) => {
    const next = { ...terminalThemePreferences(), ...patch };
    setThemePreferences(next);
    setTerminalThemePreferences(next);
    setCurrentTerminalTheme(next.mode === "fixed" ? next.fixedTheme : effectiveTheme() === "light" ? next.lightTheme : next.darkTheme);
  };
  const chooseTerminalTheme = (name: string) => {
    const preferences = terminalThemePreferences();
    if (preferences.mode === "fixed") updateThemePreferences({ fixedTheme: name });
    else if (effectiveTheme() === "light") updateThemePreferences({ lightTheme: name });
    else updateThemePreferences({ darkTheme: name });
  };
  const previewBackgroundStyle = () => getEffectiveTerminalBackgroundStyle(background());

  const chooseBackgroundImage = async (file?: File) => {
    if (!file) return;
    setImageError("");
    try {
      const imageAssetId = await saveTerminalBackgroundImage(file);
      updateBackground({ style: "image", imageAssetId });
    } catch (error) { setImageError(error instanceof Error ? error.message : "无法读取图片"); }
    if (imageInputRef) imageInputRef.value = "";
  };

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
  const startWindowDrag = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) void getCurrentWindow().startDragging();
  };

  return (
    <div class={`settings-workspace ${props.standalone ? "standalone" : ""}`}>
      <header class="settings-topbar" onMouseDown={startWindowDrag}>
        <strong>PortNest</strong>
        <span>设置</span>
        <button onClick={props.onClose} aria-label="关闭设置"><Icon name="close" /></button>
      </header>

      <div class="settings-layout">
        <aside class="settings-sidebar">
          <h4>设置</h4>
          {navItem("appearance", "外观")}
          {navItem("ssh", "SSH / 终端")}
          {navItem("templates", "命令模板")}
          {navItem("version", "版本")}
        </aside>

        <main class="settings-main">
          <Show when={page() === "appearance"}>
            <div class="settings-page appearance-settings-page">
              <section class="settings-live-preview">
                <header><div><strong>实时预览</strong><span>主题、配色与字体修改会立即呈现在这里</span></div><em>实时生效</em></header>
                <div class="settings-live-preview-grid">
                  <div class="appearance-preview">
                    <div class="preview-titlebar"><i /><i /><i /><b /></div>
                    <div class="preview-layout"><aside /><section><nav /><div class="preview-table" /></section></div>
                  </div>
                  <div class={`terminal-settings-preview terminal-background-${previewBackgroundStyle()}`} style={{
                    color: terminalThemes[currentTerminalTheme()]?.foreground,
                    "font-family": terminalSettings().fontFamily,
                    "font-size": `${terminalSettings().fontSize}px`,
                    "line-height": String(terminalSettings().lineHeight),
                    "letter-spacing": `${terminalSettings().letterSpacing}px`,
                    "--preview-theme-background": terminalThemes[currentTerminalTheme()]?.background,
                    "--preview-green": terminalThemes[currentTerminalTheme()]?.green,
                    "--preview-blue": terminalThemes[currentTerminalTheme()]?.blue,
                    "--preview-solid": background().solidColor,
                    "--preview-image": terminalBackgroundImageUrl() ? `url("${terminalBackgroundImageUrl()}")` : "none",
                    "--preview-image-size": background().imageFit === "fill" ? "100% 100%" : background().imageFit,
                    "--preview-opacity": String(background().imageOpacity),
                    "--preview-overlay": String(background().imageOverlay),
                    "--preview-blur": `${background().imageBlur}px`,
                  }}>
                    <i class="terminal-preview-background" />
                    <div><span>user@server</span>:<b>~/app$</b> ls -all</div>
                    <div>drwxr-xr-x deploy deploy 4096 dist</div>
                    <div>-rw-r--r-- deploy deploy 256 .env</div>
                    <div><span>user@server</span>:<b>~/app$</b> <i class="terminal-preview-cursor" /></div>
                  </div>
                </div>
              </section>

              <h3>应用外观</h3>
              <div class="settings-grid settings-grid-single"><div class="settings-card">
                <label><span><b>主题模式</b><small>控制应用窗口、菜单和面板的明暗外观</small></span>
                  <select value={themeMode()} onChange={event => { setThemeMode(event.currentTarget.value as ThemeMode); setCurrentTerminalTheme(getTerminalTheme()); }}>
                    <option value="system">跟随系统</option><option value="light">明亮</option><option value="dark">暗黑</option>
                  </select>
                </label>
              </div></div>

              <h3>终端配色</h3>
              <div class="terminal-theme-grid">
                <For each={Object.entries(terminalThemes)}>{([key, value]) =>
                  <button class={currentTerminalTheme() === key ? "active" : ""} onClick={() => chooseTerminalTheme(key)}>
                    <span class="theme-swatch" style={{ background: value.background, color: value.foreground }}><i style={{ background: value.red }} /><i style={{ background: value.green }} /><i style={{ background: value.blue }} /></span>
                    <span>{value.name}</span>
                  </button>
                }</For>
              </div>

              <h3>终端样式</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <div class="settings-card-title"><strong>配色与字体</strong><span>决定终端文字的显示效果</span></div>
                  <label><span>配色模式</span><select value={terminalThemePreferences().mode} onChange={event => updateThemePreferences({ mode: event.currentTarget.value as "follow" | "fixed" })}><option value="follow">跟随应用明暗主题</option><option value="fixed">固定终端配色</option></select></label>
                  <Show when={terminalThemePreferences().mode === "follow"}>
                    <label><span>浅色终端主题</span><select value={terminalThemePreferences().lightTheme} onChange={event => updateThemePreferences({ lightTheme: event.currentTarget.value })}>
                      <For each={Object.entries(terminalThemes)}>{([key, value]) => <option value={key}>{value.name}</option>}</For>
                    </select></label>
                    <label><span>深色终端主题</span><select value={terminalThemePreferences().darkTheme} onChange={event => updateThemePreferences({ darkTheme: event.currentTarget.value })}>
                      <For each={Object.entries(terminalThemes)}>{([key, value]) => <option value={key}>{value.name}</option>}</For>
                    </select></label>
                  </Show>
                  <Show when={terminalThemePreferences().mode === "fixed"}><label><span>固定终端主题</span>
                    <select value={terminalThemePreferences().fixedTheme} onChange={event => updateThemePreferences({ fixedTheme: event.currentTarget.value })}>
                      <For each={Object.entries(terminalThemes)}>{([key, value]) => <option value={key}>{value.name}</option>}</For>
                    </select>
                  </label></Show>
                  <label><span>终端字体</span>
                    <select value={terminalSettings().fontFamily} onChange={event => updateSetting("fontFamily", event.currentTarget.value)}>
                      <option>JetBrains Mono, Cascadia Code, Consolas, monospace</option>
                      <option>Cascadia Code, Consolas, monospace</option><option>Consolas, monospace</option>
                    </select>
                  </label>
                  <label><span>终端字号</span><input type="number" min="9" max="28" value={terminalSettings().fontSize} onInput={event => updateSetting("fontSize", Number(event.currentTarget.value))} /></label>
                  <label><span>终端行高</span><input type="number" min="1" max="2" step="0.1" value={terminalSettings().lineHeight} onInput={event => updateSetting("lineHeight", Number(event.currentTarget.value))} /></label>
                  <label><span>终端间距</span><input type="number" min="-2" max="8" value={terminalSettings().letterSpacing} onInput={event => updateSetting("letterSpacing", Number(event.currentTarget.value))} /></label>
                </div>
                <div class="settings-card">
                  <div class="settings-card-title"><strong>终端背景</strong><span>背景风格和滚动缓存设置</span></div>
                  <label><span>终端背景</span>
                    <select value={background().style} onChange={event => updateBackground({ style: event.currentTarget.value as TerminalBackgroundStyle })}>
                      <For each={BACKGROUNDS}>{([key, label]) => <option value={key}>{label}</option>}</For>
                    </select>
                  </label>
                  <Show when={background().style === "solid"}><label><span>背景颜色</span><input type="color" value={background().solidColor} onInput={event => updateBackground({ solidColor: event.currentTarget.value })} /></label></Show>
                  <Show when={background().style === "image"}>
                    <label><span>背景图片</span><span class="settings-image-actions"><button class="settings-inline-button" onClick={() => imageInputRef?.click()}>选择图片</button><button class="settings-inline-button danger" disabled={!background().imageAssetId} onClick={() => void clearTerminalBackgroundImage().then(() => updateBackground({ imageAssetId: undefined, style: "theme" }))}>清除</button></span></label>
                    <label><span>填充方式</span><select value={background().imageFit} onChange={event => updateBackground({ imageFit: event.currentTarget.value as TerminalBackgroundConfig["imageFit"] })}><option value="cover">覆盖</option><option value="contain">包含</option><option value="fill">拉伸</option></select></label>
                    <label><span>图片透明度 <em>{Math.round(background().imageOpacity * 100)}%</em></span><input type="range" min="0.1" max="1" step="0.05" value={background().imageOpacity} onInput={event => updateBackground({ imageOpacity: Number(event.currentTarget.value) })} /></label>
                    <label><span>深色遮罩 <em>{Math.round(background().imageOverlay * 100)}%</em></span><input type="range" min="0" max="0.8" step="0.05" value={background().imageOverlay} onInput={event => updateBackground({ imageOverlay: Number(event.currentTarget.value) })} /></label>
                    <label><span>模糊度 <em>{background().imageBlur}px</em></span><input type="range" min="0" max="16" step="1" value={background().imageBlur} onInput={event => updateBackground({ imageBlur: Number(event.currentTarget.value) })} /></label>
                    <input ref={imageInputRef} class="settings-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseBackgroundImage(event.currentTarget.files?.[0])} />
                    <Show when={imageError()}><p class="settings-error">{imageError()}</p></Show>
                  </Show>
                  <label><span>最大缓存行数</span><input type="number" min="100" max="100000" value={terminalSettings().scrollback} onChange={event => updateSetting("scrollback", Number(event.currentTarget.value))} /></label>
                </div>
              </div>
            </div>
          </Show>

          <Show when={page() === "ssh"}>
            <div class="settings-page">
              <div class="settings-page-heading"><h2>SSH / 终端</h2><p>管理终端交互、连接恢复和 SFTP 工作区行为。</p></div>
              <h3>终端交互</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <div class="settings-card-title"><strong>剪贴板</strong><span>控制复制和粘贴快捷操作</span></div>
                  <label><span><b>选中后自动复制</b><small>鼠标选中文本后立即写入剪贴板</small></span><Toggle checked={terminalSettings().copyOnSelect} onChange={value => updateSetting("copyOnSelect", value)} /></label>
                  <label><span><b>Ctrl+V 粘贴</b><small>在终端中使用系统粘贴快捷键</small></span><Toggle checked={terminalSettings().ctrlVPaste} onChange={value => updateSetting("ctrlVPaste", value)} /></label>
                </div>
                <div class="settings-card">
                  <div class="settings-card-title"><strong>鼠标操作</strong><span>设置终端内鼠标按键行为</span></div>
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
                </div>
              </div>

              <h3>连接与文件管理</h3>
              <div class="settings-grid">
                <div class="settings-card">
                  <div class="settings-card-title"><strong>SSH 会话</strong><span>连接异常中断后的处理方式</span></div>
                  <label><span><b>断开后自动重连</b><small>网络恢复后自动尝试重新建立会话</small></span><Toggle checked={terminalSettings().reconnectOnDisconnect} onChange={value => updateSetting("reconnectOnDisconnect", value)} /></label>
                </div>
                <div class="settings-card">
                  <div class="settings-card-title"><strong>SFTP 文件管理</strong><span>设置文件工作区的默认行为</span></div>
                  <label><span>文件列表布局</span>
                    <select value={uiStore.filesStacked() ? "stacked" : "side"} onChange={event => uiStore.setFilesStacked(event.currentTarget.value === "stacked")}>
                      <option value="side">左右布局</option><option value="stacked">上下布局</option>
                    </select>
                  </label>
                  <label><span><b>连接后打开文件管理</b><small>SSH 会话建立后自动显示 SFTP 面板</small></span><Toggle checked={terminalSettings().openFileManagerOnConnect} onChange={value => updateSetting("openFileManagerOnConnect", value)} /></label>
                </div>
              </div>
              <p class="settings-note settings-session-note">会话标签、顺序、固定状态和活动标签会自动保存；应用启动后以离线标签恢复，不会自动批量连接。</p>
            </div>
          </Show>

          <Show when={page() === "templates"}>
            <CommandTemplatesSettings />
          </Show>

          <Show when={page() === "version"}>
            <div class="settings-page version-settings-page">
              <div class="settings-page-heading"><h2>版本</h2><p>查看当前版本并获取 PortNest 的最新更新。</p></div>
              <section class="version-card">
                <div class="version-mark">P</div>
                <div class="version-summary">
                  <strong>PortNest</strong>
                  <span>当前版本 {appVersion()}</span>
                  <p>SSH、SFTP、数据库与本地终端工作区</p>
                </div>
                <button class="version-update-button" disabled={checkingUpdate()} onClick={handleCheckUpdate}>
                  <Icon name="refresh" size={16} />
                  {updateStatus()}
                </button>
              </section>
              <div class="version-details">
                <div><span>更新方式</span><strong>自动下载并安装</strong></div>
                <div><span>设置存储</span><strong>本地保存</strong></div>
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
