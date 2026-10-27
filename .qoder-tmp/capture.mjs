import { writeFileSync } from "node:fs";

const PORT = 9333;
const PREFIX = process.argv[2] || "asset-tree";
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
      if (command === "ping_host") {
        if (args && args.host === "192.0.2.50") return Promise.resolve({ reachable: false });
        return Promise.resolve({ reachable: true, latency_ms: args && args.host === "192.0.2.20" ? 42 : 18 });
      }
      if (command === "get_version" || command === "plugin:app|version") return Promise.resolve("0.5.0");
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

async function main() {
  await waitForCdp();
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
  await cdp.send("Page.navigate", { url: "http://localhost:1420/" });
  await sleep(6000);

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result ? result.result.value : undefined;
  };

  const rowCount = await evaluate("document.querySelectorAll('.asset-connection-row').length");
  const folderCount = await evaluate("document.querySelectorAll('.asset-folder-row').length");
  console.log(`rows=${rowCount} folders=${folderCount}`);

  const pillBefore = await evaluate("getComputedStyle(document.querySelector('.asset-selection')).display");
  console.log(`selection pill before select=${pillBefore}`);
  await evaluate("document.querySelectorAll('.asset-connection-row')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await sleep(300);
  const pillAfter = await evaluate("getComputedStyle(document.querySelector('.asset-selection')).display");
  console.log(`selection pill after select=${pillAfter}`);
  const light = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`.qoder-tmp/${PREFIX}-light.png`, Buffer.from(light.data, "base64"));
  const lightZoom = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 290, y: 78, width: 1140, height: 340, scale: 2 },
  });
  writeFileSync(`.qoder-tmp/${PREFIX}-light-zoom.png`, Buffer.from(lightZoom.data, "base64"));

  const databaseColor = await evaluate("getComputedStyle(document.querySelector('.asset-terminal-icon.protocol-database')).color");
  console.log(`database icon color=${databaseColor}`);

  await evaluate("(() => { const input = document.querySelector('.asset-search input'); input.value = 'zzzz'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(400);
  const empty = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 290, y: 78, width: 1140, height: 520, scale: 2 },
  });
  writeFileSync(`.qoder-tmp/${PREFIX}-empty.png`, Buffer.from(empty.data, "base64"));

  await evaluate("localStorage.setItem('portnest-theme', 'dark'); location.reload();");
  await sleep(6000);
  await evaluate("document.querySelectorAll('.asset-connection-row')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await sleep(300);
  const darkRows = await evaluate("document.querySelectorAll('.asset-connection-row').length");
  console.log(`dark rows=${darkRows}`);
  const dark = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`.qoder-tmp/${PREFIX}-dark.png`, Buffer.from(dark.data, "base64"));

  const title = await evaluate("document.title");
  const footer = await evaluate("getComputedStyle(document.querySelector('.asset-footer')).display");
  const primary = await evaluate("getComputedStyle(document.querySelector('.asset-primary')).backgroundColor");
  console.log(`title=${title} footer=${footer} primary=${primary}`);

  await cdp.send("Browser.close").catch(() => {});
  socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
