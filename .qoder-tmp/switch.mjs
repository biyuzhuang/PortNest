import { writeFileSync } from "node:fs";

const PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mock = `(() => {
  const settings = { theme: "light", terminal_font_family: "Cascadia Mono", terminal_font_size: 13, terminal_line_height: 1.35, terminal_theme: "dark", ai_enabled: true, ai_provider: "openai", ai_model: "gpt-4o-mini", shortcuts: {} };
  let callbackId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" }, windows: [], webviews: [] },
    transformCallback(callback) { const id = ++callbackId; window["_" + id] = callback; return id; },
    unregisterCallback(id) { delete window["_" + id]; },
    convertFileSrc(path) { return path; },
    invoke(command) {
      if (command === "get_connections") return Promise.resolve([]);
      if (command === "get_folders") return Promise.resolve([]);
      if (command === "get_settings" || command === "get_app_settings") return Promise.resolve(settings);
      if (command === "save_settings" || command === "save_app_settings") return Promise.resolve(settings);
      if (command === "list_command_snippets" || command === "list_tunnels") return Promise.resolve([]);
      if (command === "get_version" || command === "plugin:app|version") return Promise.resolve("0.5.0");
      if (command === "get_platform") return Promise.resolve("windows");
      return Promise.resolve(null);
    }
  };
})();`;

async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/json/version`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("CDP not ready");
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") console.log("EXCEPTION", message.params.exceptionDetails?.text);
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

async function open(url) {
  const target = await (await fetch(`${ORIGIN}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("ws failed")); });
  const cdp = new Cdp(socket);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await cdp.send("Page.navigate", { url });
  await sleep(3500);
  await cdp.send("Runtime.evaluate", { expression: "localStorage.setItem('portnest-theme','light');localStorage.setItem('portnest-theme-skin','aurora');location.reload();" });
  await sleep(4000);
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result ? result.result.value : undefined;
  };
  return { cdp, evaluate, socket };
}

async function main() {
  await waitForCdp();
  const main = await open("http://localhost:1420/");
  const settings = await open("http://localhost:1420/?window=settings");
  console.log("initial", await main.evaluate("document.documentElement.dataset.skin"), await settings.evaluate("document.documentElement.dataset.skin"));

  const changed = await settings.evaluate(`(() => {
    const select = [...document.querySelectorAll('.settings-card select')].find(node => node.value === 'aurora');
    if (!select) return 'select-not-found';
    select.value = 'midnight';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  console.log("changed select ->", changed);
  await sleep(900);
  console.log("settings after", await settings.evaluate("document.documentElement.dataset.skin"), await settings.evaluate("localStorage.getItem('portnest-theme-skin')"));
  console.log("main after", await main.evaluate("document.documentElement.dataset.skin"), await main.evaluate("localStorage.getItem('portnest-theme-skin')"));

  await main.cdp.send("Runtime.evaluate", { expression: "location.reload()" });
  await sleep(4000);
  console.log("main reload", await main.evaluate("document.documentElement.dataset.skin"));
  const result = await main.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });
  writeFileSync(".qoder-tmp/switch-midnight-live.png", Buffer.from(result.data, "base64"));

  const switched = await settings.evaluate(`(() => {
    const select = [...document.querySelectorAll('.settings-card select')].find(node => node.value === 'midnight');
    if (!select) return 'select-not-found';
    select.value = 'ember';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await sleep(800);
  console.log("second switch ->", switched, await main.evaluate("document.documentElement.dataset.skin"));
  main.socket.close();
  settings.socket.close();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
