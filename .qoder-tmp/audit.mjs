import { writeFileSync } from "node:fs";

const PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mock = `(() => {
  const now = Math.floor(Date.now() / 1000);
  const connections = [
    { id: "c1", name: "demo-web-01", protocol: "ssh", host: "192.0.2.10", port: 22, username: "deploy", credential_id: "k1", folder_id: null, sort_order: 1, created_at: now - 86400 * 42, last_connected_at: now - 3600 },
    { id: "c2", name: "demo-db-master", protocol: "mysql", host: "192.0.2.20", port: 3306, username: "root", credential_id: "k2", folder_id: null, sort_order: 2, created_at: now - 86400 * 30, last_connected_at: now - 7200 },
    { id: "c3", name: "demo-edge", protocol: "ssh", host: "192.0.2.50", port: 22, username: "ops", credential_id: "k3", folder_id: null, sort_order: 3, created_at: now - 86400 * 16, last_connected_at: now - 86400 },
    { id: "c4", name: "本地终端", protocol: "local", host: "", port: 0, username: "", credential_id: "k4", folder_id: null, sort_order: 4, created_at: now - 86400 * 12, last_connected_at: now - 900 },
    { id: "c5", name: "demo-bastion", protocol: "ssh", host: "192.0.2.30", port: 2222, username: "ops", credential_id: "k5", folder_id: "f1", sort_order: 1, created_at: now - 86400 * 60, last_connected_at: now - 86400 },
    { id: "c6", name: "demo-cache", protocol: "postgresql", host: "192.0.2.40", port: 5432, username: "postgres", credential_id: "k6", folder_id: "f2", sort_order: 1, created_at: now - 86400 * 8 }
  ];
  const folders = [
    { id: "f1", name: "生产环境", parent_id: null, sort_order: 1, created_at: now - 86400 * 60 },
    { id: "f2", name: "测试集群", parent_id: null, sort_order: 2, created_at: now - 86400 * 20 }
  ];
  const settings = {
    theme: "light",
    terminal_font_family: "Cascadia Mono",
    terminal_font_size: 13,
    terminal_line_height: 1.35,
    terminal_theme: "dark",
    terminal_cursor_style: "bar",
    terminal_cursor_blink: true,
    terminal_scrollback: 5000,
    terminal_bell: false,
    terminal_copy_on_select: true,
    terminal_confirm_close: true,
    ssh_default_keepalive: 30,
    ssh_default_timeout: 15,
    files_collapsed: false,
    files_width: 360,
    ai_enabled: true,
    ai_provider: "openai",
    ai_model: "gpt-4o-mini",
    ai_models: [],
    ai_permissions: "ask",
    ai_presets: [],
    ai_mcp_servers: [],
    ai_custom_search: [],
    shortcuts: {},
    storage_provider: "local"
  };
  let callbackId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
      windows: [],
      webviews: []
    },
    transformCallback(callback) {
      const id = ++callbackId;
      window["_" + id] = callback;
      return id;
    },
    unregisterCallback(id) { delete window["_" + id]; },
    convertFileSrc(path) { return path; },
    invoke(command, args) {
      if (command === "get_connections") return Promise.resolve(connections);
      if (command === "get_folders") return Promise.resolve(folders);
      if (command === "get_protocols") return Promise.resolve([{ id: "ssh", name: "SSH" }, { id: "mysql", name: "MySQL" }]);
      if (command === "get_settings" || command === "get_app_settings") return Promise.resolve(settings);
      if (command === "save_settings" || command === "save_app_settings") return Promise.resolve(settings);
      if (command === "get_ai_config") return Promise.resolve({ providers: [], models: [], presets: [], permissions: "ask" });
      if (command === "ai_get_configs") return Promise.resolve([
        {
          id: "p1", enabled: true, provider: "openai", protocol: "openai_chat",
          endpoint: "https://api.openai.com/v1", api_key: "sk-demo", model: "gpt-4o-mini",
          display_name: "OpenAI", context_window: 128000, max_output: 16384, temperature: 0.7,
          custom_headers: {}, proxy_mode: "auto",
          models: [
            { model: "gpt-4o-mini", enabled: true, context_window: 128000, max_output: 16384, supports_tool_calling: true, supports_image_input: true, supports_image_output: false },
            { model: "gpt-4o", enabled: false, context_window: 128000, max_output: 16384, supports_tool_calling: true, supports_image_input: true, supports_image_output: false },
            { model: "o4-mini", enabled: false, context_window: 200000, max_output: 100000, supports_tool_calling: true, supports_image_input: true, supports_image_output: false }
          ]
        },
        {
          id: "p2", enabled: false, provider: "ollama", protocol: "ollama",
          endpoint: "http://127.0.0.1:11434", api_key: "", model: "qwen2.5-coder:14b",
          display_name: "Ollama 本地", context_window: 32768, max_output: 8192, temperature: 0.2,
          custom_headers: {}, proxy_mode: "none",
          models: [
            { model: "qwen2.5-coder:14b", enabled: true, context_window: 32768, max_output: 8192, supports_tool_calling: true, supports_image_input: false, supports_image_output: false }
          ]
        }
      ]);
      if (command === "get_version" || command === "plugin:app|version") return Promise.resolve("0.5.0");
      if (command === "list_command_snippets") return Promise.resolve([
        { id: "s1", kind: "snippet", name: "查看服务状态", content: "systemctl status {{service}} --no-pager", tags: '["运维"]', variables: '[{"name":"service"}]', favorite: true, created_at: 1760000000, updated_at: 1760000000 },
        { id: "s2", kind: "snippet", name: "清理 7 天前日志", content: "find /var/log -name '*.log' -mtime +7 -delete", tags: '["清理"]', variables: "[]", favorite: false, created_at: 1760000000, updated_at: 1760000000 }
      ]);
      if (command === "list_tunnels") return Promise.resolve([]);
      if (command === "get_platform") return Promise.resolve("windows");
      if (command === "is_maximized") return Promise.resolve(false);
      if (command === "ping_host") {
        if (args && args.host === "192.0.2.50") return Promise.resolve({ reachable: false });
        return Promise.resolve({ reachable: true, latency_ms: args && args.host === "192.0.2.20" ? 42 : 18 });
      }
      return Promise.resolve(null);
    }
  };
})();`;

async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/json/version`);
      if (response.ok) return response.json();
    } catch {
      // Edge is still starting.
    }
    await sleep(250);
  }
  throw new Error("Edge CDP endpoint did not become ready");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        console.log("PAGE EXCEPTION:", message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        console.log("PAGE CONSOLE ERROR:", message.params.args.map(arg => arg.value || arg.description).join(" "));
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function openPage(url, options = {}) {
  const theme = options.theme || "light";
  const skin = options.skin || "aurora";
  const targetResponse = await fetch(`${ORIGIN}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("CDP websocket failed"));
  });
  const cdp = new CdpClient(socket);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await cdp.send("Page.navigate", { url });
  await sleep(4000);
  await cdp.send("Runtime.evaluate", { expression: `localStorage.setItem('portnest-theme','${theme}'); localStorage.setItem('portnest-theme-skin','${skin}'); location.reload();` });
  await sleep(5000);

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result ? result.result.value : undefined;
  };

  const shot = async (name, clip) => {
    const params = { format: "png" };
    if (clip) params.clip = { ...clip, scale: clip.scale || 2 };
    const result = await cdp.send("Page.captureScreenshot", params);
    writeFileSync(`.qoder-tmp/audit-${name}.png`, Buffer.from(result.data, "base64"));
    console.log(`shot ${name}`);
  };

  return { cdp, evaluate, shot, socket };
}

async function mainWindow() {
  const { cdp, evaluate, shot, socket } = await openPage("http://localhost:1420/");
  await shot("shell", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await shot("sidebar", { x: 0, y: 30, width: 330, height: 560, scale: 2 });

  await evaluate("document.querySelector('.app-menu-container > button')?.click()");
  await sleep(400);
  await shot("app-menu", { x: 1040, y: 20, width: 400, height: 420, scale: 2 });

  await evaluate("document.querySelector('.app-menu-overlay')?.click()");
  await sleep(200);
  await evaluate("document.querySelector('.titlebar-quick-switch')?.click()");
  await sleep(500);
  await shot("quick-switcher", { x: 300, y: 90, width: 840, height: 520, scale: 2 });
  await evaluate("document.querySelector('.quick-switcher-overlay')?.click()");
  await sleep(200);

  await evaluate("document.querySelector('.module-rail-ai')?.click()");
  await sleep(1200);
  await shot("ai-panel", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await evaluate("document.querySelector('.module-rail-ai')?.click()");
  await sleep(400);

  await evaluate("document.querySelector('.folder-header')?.click()");
  await sleep(400);
  await shot("sidebar-expanded", { x: 0, y: 30, width: 330, height: 620, scale: 2 });

  await evaluate("(() => { const row = document.querySelector('.connection-item'); row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 260 })); })()");
  await sleep(400);
  await shot("context-menu", { x: 60, y: 180, width: 420, height: 420, scale: 2 });

  await evaluate("localStorage.setItem('portnest-theme', 'dark'); location.reload();");
  await sleep(5000);
  await evaluate("document.querySelector('.app-menu-container > button')?.click()");
  await sleep(400);
  await shot("app-menu-dark", { x: 1040, y: 20, width: 400, height: 420, scale: 2 });
  await evaluate("document.querySelector('.app-menu-overlay')?.click()");
  await sleep(200);
  await evaluate("document.querySelector('.folder-header')?.click()");
  await sleep(300);
  await shot("sidebar-dark", { x: 0, y: 30, width: 330, height: 620, scale: 2 });

  await cdp.send("Target.closeTarget", { targetId: undefined }).catch(() => {});
  socket.close();
}

async function settingsWindow() {
  const { evaluate, shot, socket } = await openPage("http://localhost:1420/?window=settings");
  await shot("settings-appearance", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await shot("settings-nav", { x: 0, y: 0, width: 360, height: 900, scale: 1.5 });

  const clickNav = async (label) => {
    await evaluate(`(() => { const btn = [...document.querySelectorAll('.settings-sidebar button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); btn?.click(); })()`);
    await sleep(600);
    console.log(`nav ${label} -> ${await evaluate("document.querySelector('.settings-page-heading h2')?.textContent")}`);
  };

  await clickNav("终端");
  await shot("settings-terminal", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await clickNav("模型配置");
  await sleep(800);
  await shot("settings-ai", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await evaluate("document.querySelector('.ai-model-configure')?.click()");
  await sleep(400);
  await shot("settings-ai-expanded", { x: 360, y: 90, width: 1080, height: 640, scale: 1.4 });
  await shot("settings-footer", { x: 360, y: 770, width: 1080, height: 130, scale: 1.6 });
  await evaluate("document.querySelector('.ai-provider-add-button')?.click()");
  await sleep(400);
  await shot("settings-ai-picker", { x: 360, y: 90, width: 1080, height: 700, scale: 1.4 });
  await evaluate("document.querySelector('.ai-provider-picker-backdrop')?.click()");
  await sleep(200);
  await clickNav("MCP");
  await shot("settings-mcp", { x: 360, y: 60, width: 1080, height: 760, scale: 1.2 });
  await clickNav("自定义搜索引擎");
  await shot("settings-search", { x: 360, y: 60, width: 1080, height: 760, scale: 1.2 });
  await clickNav("账号");
  await shot("settings-account", { x: 360, y: 60, width: 1080, height: 760, scale: 1.2 });
  await clickNav("命令模板");
  await shot("settings-templates", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await evaluate("document.querySelector('.templates-toolbar .settings-inline-button')?.click()");
  await sleep(400);
  await shot("settings-templates-edit", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await clickNav("储存仓库");
  await shot("settings-vault", { x: 340, y: 60, width: 1100, height: 760, scale: 1.2 });
  await clickNav("数据库");
  await shot("settings-database", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await clickNav("快捷键");
  await evaluate("localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4000);
  await clickNav("命令模板");
  await evaluate("document.querySelector('.templates-toolbar .settings-inline-button')?.click()");
  await sleep(400);
  await shot("settings-templates-edit-dark", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  socket.close();
}

async function templatesWindow() {
  const { evaluate, shot, socket } = await openPage("http://localhost:1420/?window=settings");
  const clickNav = async (label) => {
    await evaluate(`(() => { const btn = [...document.querySelectorAll('.settings-sidebar button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); btn?.click(); })()`);
    await sleep(600);
  };
  await clickNav("命令模板");
  await shot("settings-templates-full", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await evaluate("document.querySelector('.templates-toolbar .settings-inline-button')?.click()");
  await sleep(400);
  await shot("settings-templates-edit-full", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  const clickShortcutGroup = async (index) => {
    await evaluate(`(() => {
      const heading = [...document.querySelectorAll('.settings-sidebar h4')].find(node => node.textContent.trim() === '快捷键');
      let node = heading && heading.nextElementSibling, index = 0;
      while (node && node.tagName === 'BUTTON') {
        if (index === ${index}) { node.click(); return; }
        node = node.nextElementSibling; index += 1;
      }
    })()`);
    await sleep(600);
  };
  await clickShortcutGroup(0);
  await shot("settings-shortcuts", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await clickShortcutGroup(2);
  await shot("settings-shortcuts-ssh", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await evaluate("localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4000);
  await clickNav("命令模板");
  await evaluate("document.querySelector('.templates-toolbar .settings-inline-button')?.click()");
  await sleep(400);
  await shot("settings-templates-edit-dark-full", { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  socket.close();
}

async function skinWindow(skin) {
  const { evaluate, shot, socket } = await openPage("http://localhost:1420/", { skin, theme: "light" });
  await shot(`skin-${skin}-shell-light`, { x: 0, y: 0, width: 1440, height: 900, scale: 1 });

  const openTransfer = async () => {
    await evaluate("document.querySelector('.app-menu-container > button')?.click()");
    await sleep(300);
    await evaluate("(() => { const btn = [...document.querySelectorAll('.app-menu-item')].find(b => b.textContent.includes('导入 / 导出会话')); btn?.click(); })()");
    await sleep(700);
  };
  const openImportTab = async () => {
    await evaluate("(() => { const tab = [...document.querySelectorAll('.session-transfer-tab')].find(b => b.textContent.includes('导入')); tab?.click(); })()");
    await sleep(500);
  };

  await openTransfer();
  await shot(`skin-${skin}-transfer-export-light`, { x: 260, y: 50, width: 920, height: 800, scale: 1.5 });
  await openImportTab();
  await shot(`skin-${skin}-transfer-import-light`, { x: 260, y: 50, width: 920, height: 800, scale: 1.5 });

  await evaluate("localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4500);
  await shot(`skin-${skin}-shell-dark`, { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await openTransfer();
  await shot(`skin-${skin}-transfer-export-dark`, { x: 260, y: 50, width: 920, height: 800, scale: 1.5 });
  await openImportTab();
  await shot(`skin-${skin}-transfer-import-dark`, { x: 260, y: 50, width: 920, height: 800, scale: 1.5 });
  socket.close();

  const settings = await openPage("http://localhost:1420/?window=settings", { skin, theme: "light" });
  await settings.shot(`skin-${skin}-settings-light`, { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  await settings.evaluate("localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4500);
  await settings.shot(`skin-${skin}-settings-dark`, { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  settings.socket.close();
}

async function main() {
  await waitForCdp();
  if (process.argv[2] === "skins") {
    const skins = process.argv[3] ? [process.argv[3]] : ["aurora", "mist", "ember", "midnight"];
    for (const skin of skins) await skinWindow(skin);
    return;
  }
  if (process.argv[2] === "templates") {
    await templatesWindow();
    return;
  }
  await mainWindow();
  await settingsWindow();
  const targets = await (await fetch(`${ORIGIN}/json/list`)).json();
  for (const target of targets) {
    if (target.type === "page") {
      await fetch(`${ORIGIN}/json/close/${target.id}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
