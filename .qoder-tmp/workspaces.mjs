import { writeFileSync } from "node:fs";

const PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const files = [
  { name: "dist", path: "/srv/app/dist", size: 0, is_dir: true, is_link: false, modified: 1716700000, permissions: "drwxr-xr-x", owner_group: "deploy deploy" },
  { name: "logs", path: "/srv/app/logs", size: 0, is_dir: true, is_link: false, modified: 1716700000, permissions: "drwxr-xr-x", owner_group: "deploy deploy" },
  { name: "deploy.sh", path: "/srv/app/deploy.sh", size: 842, is_dir: false, is_link: false, modified: 1716700000, permissions: "-rw-r--r--", owner_group: "deploy deploy" },
  { name: "app.log", path: "/srv/app/app.log", size: 524288, is_dir: false, is_link: false, modified: 1716700000, permissions: "-rw-r--r--", owner_group: "deploy deploy" },
  { name: "package.json", path: "/srv/app/package.json", size: 1331, is_dir: false, is_link: false, modified: 1716700000, permissions: "-rw-r--r--", owner_group: "deploy deploy" }
];

const databases = [
  { name: "app_prod", charset: "utf8mb4", collation: "utf8mb4_general_ci" },
  { name: "app_staging", charset: "utf8mb4", collation: "utf8mb4_general_ci" },
  { name: "analytics", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" }
];

const tables = [
  { name: "users", kind: "BASE TABLE", engine: "InnoDB", rows: 12842, comment: "用户账户", data_length: 3145728, index_length: 524288, auto_increment: 12843, collation: "utf8mb4_general_ci", created_at: "2025-01-12 09:14:02", updated_at: "2026-10-21 18:03:44" },
  { name: "orders", kind: "BASE TABLE", engine: "InnoDB", rows: 98213, comment: "订单主表", data_length: 18874368, index_length: 4194304, auto_increment: 98214, collation: "utf8mb4_general_ci", created_at: "2025-01-12 09:16:40", updated_at: "2026-10-26 07:21:10" },
  { name: "order_items", kind: "BASE TABLE", engine: "InnoDB", rows: 312455, comment: "订单明细", data_length: 52428800, index_length: 10485760, auto_increment: 312456, collation: "utf8mb4_general_ci", created_at: "2025-01-12 09:17:11", updated_at: "2026-10-26 07:21:12" },
  { name: "sessions", kind: "BASE TABLE", engine: "InnoDB", rows: 2048, comment: "登录会话", data_length: 524288, index_length: 131072, auto_increment: 2049, collation: "utf8mb4_general_ci", created_at: "2025-02-03 11:02:15", updated_at: "2026-10-27 03:44:51" },
  { name: "audit_logs", kind: "BASE TABLE", engine: "InnoDB", rows: 884211, comment: "审计日志", data_length: 209715200, index_length: 33554432, auto_increment: 884212, collation: "utf8mb4_general_ci", created_at: "2025-02-03 11:03:40", updated_at: "2026-10-27 06:59:02" },
  { name: "v_active_users", kind: "VIEW", engine: null, rows: 0, comment: "近 30 天活跃用户", collation: null, created_at: null, updated_at: null }
];

const columns = [
  { name: "id", data_type: "bigint", column_type: "bigint unsigned", nullable: false, extra: "auto_increment", comment: "主键", key: "PRI", ordinal: 1 },
  { name: "email", data_type: "varchar", column_type: "varchar(190)", nullable: false, extra: "", comment: "登录邮箱", key: "UNI", charset: "utf8mb4", collation: "utf8mb4_general_ci", ordinal: 2 },
  { name: "display_name", data_type: "varchar", column_type: "varchar(80)", nullable: true, extra: "", comment: "显示名", key: "", charset: "utf8mb4", collation: "utf8mb4_general_ci", ordinal: 3 },
  { name: "role", data_type: "enum", column_type: "enum('admin','member')", nullable: false, default_value: "member", extra: "", comment: "角色", key: "", charset: "utf8mb4", collation: "utf8mb4_general_ci", ordinal: 4 },
  { name: "created_at", data_type: "datetime", column_type: "datetime", nullable: false, default_value: "CURRENT_TIMESTAMP", extra: "DEFAULT_GENERATED", comment: "", key: "", ordinal: 5 }
];

const indexes = [
  { name: "PRIMARY", unique: true, column: "id", sequence: 1, index_type: "BTREE" },
  { name: "uk_users_email", unique: true, column: "email", sequence: 1, index_type: "BTREE" },
  { name: "idx_users_role", unique: false, column: "role", sequence: 1, index_type: "BTREE" }
];

const rowsResult = {
  columns: ["id", "email", "display_name", "role", "created_at"],
  affected_rows: 0,
  execution_time_ms: 4,
  truncated: false,
  rows: [
    { values: [1, "ada@example.com", "Ada", "admin", "2025-01-12 09:20:11"] },
    { values: [2, "linus@example.com", "Linus", "member", "2025-01-12 09:24:47"] },
    { values: [3, "grace@example.com", "Grace", "member", "2025-01-13 14:02:08"] },
    { values: [4, "alan@example.com", "Alan", "admin", "2025-01-15 08:44:19"] },
    { values: [5, "barbara@example.com", "Barbara", "member", "2025-01-16 17:31:55"] },
    { values: [6, "donald@example.com", "Donald", "member", "2025-01-18 10:12:36"] },
    { values: [7, "margaret@example.com", "Margaret", "admin", "2025-01-19 06:58:12"] },
    { values: [8, "edsger@example.com", "Edsger", "member", "2025-01-21 19:27:40"] }
  ]
};

const charsets = [
  { name: "utf8mb4", description: "UTF-8 Unicode", default_collation: "utf8mb4_0900_ai_ci", collations: ["utf8mb4_0900_ai_ci", "utf8mb4_general_ci", "utf8mb4_unicode_ci"] },
  { name: "utf8", description: "UTF-8 Unicode", default_collation: "utf8_general_ci", collations: ["utf8_general_ci", "utf8_unicode_ci"] },
  { name: "gbk", description: "GBK Simplified Chinese", default_collation: "gbk_chinese_ci", collations: ["gbk_chinese_ci", "gbk_bin"] }
];

const snapshot = {
  connection_id: "c1",
  collected_at: Math.floor(Date.now() / 1000),
  duration_ms: 184,
  backend_supported: true,
  issues: [],
  system: { hostname: "web-01", os: "Ubuntu 24.04 LTS", kernel: "6.8.0-45-generic", arch: "x86_64", uptime_secs: 1598400, load: [0.42, 0.55, 0.61], users: 2, cores: 8 },
  cpu: {
    total: 23.4, user: 15.2, system: 6.1, iowait: 1.4, steal: 0,
    cores: [
      { index: 0, percent: 31.2, user: 20.1, system: 8.4, iowait: 1.2 },
      { index: 1, percent: 18.6, user: 12.4, system: 4.9, iowait: 0.8 },
      { index: 2, percent: 42.1, user: 28.7, system: 10.2, iowait: 2.1 },
      { index: 3, percent: 12.8, user: 8.1, system: 3.5, iowait: 0.4 },
      { index: 4, percent: 9.4, user: 6.2, system: 2.1, iowait: 0.3 },
      { index: 5, percent: 28.4, user: 18.3, system: 7.6, iowait: 1.1 },
      { index: 6, percent: 21.0, user: 14.0, system: 5.6, iowait: 0.9 },
      { index: 7, percent: 15.5, user: 10.2, system: 4.1, iowait: 0.6 }
    ]
  },
  memory: { total_b: 8375186227, used_b: 3422552064, available_b: 4952634163, percent: 40.9, swap_total_b: 2147483648, swap_used_b: 134217728, swap_percent: 6.3 },
  disk: {
    root_percent: 62.4, root_total_b: 53687091200, root_used_b: 33498722304,
    mounts: [
      { fs: "/dev/sda1", mount: "/", total_b: 53687091200, used_b: 33498722304, avail_b: 20188368896, percent: 62.4 },
      { fs: "/dev/sdb1", mount: "/data", total_b: 214748364800, used_b: 85899345920, avail_b: 128849018880, percent: 40.0 }
    ]
  },
  network: { rx_bytes: 88234178919, tx_bytes: 3489160423, rx_rate: 1843200, tx_rate: 196608, interfaces: [{ name: "eth0", rx_bytes: 88234178919, tx_bytes: 3489160423 }] },
  processes: [
    { pid: 1422, cpu: 12.4, mem_percent: 4.1, rss_b: 343597383, name: "node" },
    { pid: 811, cpu: 4.8, mem_percent: 2.2, rss_b: 184549376, name: "nginx" },
    { pid: 933, cpu: 2.1, mem_percent: 1.4, rss_b: 117440512, name: "postgres" }
  ],
  gpu: []
};

const snippets = [
  { id: "s1", kind: "snippet", name: "查看服务状态", content: "systemctl status {{service}} --no-pager", tags: "[\"运维\"]", variables: "[{\"name\":\"service\"}]", favorite: true, created_at: 1760000000, updated_at: 1760000000 },
  { id: "s2", kind: "snippet", name: "清理 7 天前日志", content: "find /var/log -name '*.log' -mtime +7 -delete", tags: "[\"清理\"]", variables: "[]", favorite: false, created_at: 1760000000, updated_at: 1760000000 },
  { id: "s3", kind: "snippet", name: "重启应用", content: "sudo systemctl restart {{app}} && journalctl -u {{app}} -n 50", tags: "[\"发布\"]", variables: "[{\"name\":\"app\"}]", favorite: false, created_at: 1760000000, updated_at: 1760000000 }
];

const mock = `(() => {
  const now = Math.floor(Date.now() / 1000);
  const connections = [
    { id: "c1", name: "demo-web-01", protocol: "ssh", host: "192.0.2.10", port: 22, username: "deploy", credential_id: "k1", folder_id: null, sort_order: 1, created_at: now - 86400 * 42, last_connected_at: now - 3600 },
    { id: "c2", name: "demo-db-master", protocol: "mysql", host: "192.0.2.20", port: 3306, username: "root", credential_id: "k2", folder_id: null, sort_order: 2, created_at: now - 86400 * 30, last_connected_at: now - 7200 },
    { id: "c4", name: "本地终端", protocol: "local", host: "", port: 0, username: "", credential_id: "k4", folder_id: null, sort_order: 4, created_at: now - 86400 * 12, last_connected_at: now - 900 }
  ];
  const folders = [
    { id: "f1", name: "生产环境", parent_id: null, sort_order: 1, created_at: now - 86400 * 60 }
  ];
  const settings = {
    theme: "light", terminal_font_family: "Cascadia Mono", terminal_font_size: 13,
    terminal_line_height: 1.35, terminal_theme: "dark", terminal_cursor_style: "bar",
    terminal_cursor_blink: true, terminal_scrollback: 5000, terminal_bell: false,
    terminal_copy_on_select: true, terminal_confirm_close: true,
    ssh_default_keepalive: 30, ssh_default_timeout: 15,
    files_collapsed: false, files_width: 360, open_file_manager_on_connect: true,
    ai_enabled: false, ai_provider: "openai", ai_model: "", ai_models: [], ai_permissions: "ask",
    ai_presets: [], ai_mcp_servers: [], ai_custom_search: [], shortcuts: {}, storage_provider: "local"
  };
  let callbackId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" }, windows: [], webviews: [] },
    transformCallback(callback) { const id = ++callbackId; window["_" + id] = callback; return id; },
    unregisterCallback(id) { delete window["_" + id]; },
    convertFileSrc(path) { return path; },
    invoke(command, args) {
      const files = ${JSON.stringify(files)};
      const databases = ${JSON.stringify(databases)};
      const tables = ${JSON.stringify(tables)};
      const columns = ${JSON.stringify(columns)};
      const indexes = ${JSON.stringify(indexes)};
      const rowsResult = ${JSON.stringify(rowsResult)};
      const charsets = ${JSON.stringify(charsets)};
      const snapshot = ${JSON.stringify(snapshot)};
      if (command === "get_connections") return Promise.resolve(connections);
      if (command === "get_folders") return Promise.resolve(folders);
      if (command === "get_protocols") return Promise.resolve([{ id: "ssh", name: "SSH" }, { id: "mysql", name: "MySQL" }]);
      if (command === "get_settings" || command === "get_app_settings") return Promise.resolve(settings);
      if (command === "save_settings" || command === "save_app_settings") return Promise.resolve(settings);
      if (command === "ai_get_configs") return Promise.resolve([]);
      if (command === "ai_get_config") return Promise.resolve(null);
      if (command === "database_connect" || command === "database_disconnect") return Promise.resolve(null);
      if (command === "database_list_databases") return Promise.resolve(databases);
      if (command === "database_list_tables") return Promise.resolve(tables);
      if (command === "database_list_columns") return Promise.resolve(columns);
      if (command === "database_list_indexes") return Promise.resolve(indexes);
      if (command === "database_fetch_rows") return Promise.resolve(rowsResult);
      if (command === "database_list_charsets") return Promise.resolve(charsets);
      if (command === "database_autocomplete") return Promise.resolve(tables.map(item => ({ table: item.name, column: "id" })));
      if (command === "database_execute_sql") return Promise.resolve(rowsResult);
      if (command === "dashboard_collect") return Promise.resolve(snapshot);
      if (command === "dashboard_cancel") return Promise.resolve(null);
      if (command === "list_command_snippets") return Promise.resolve(${JSON.stringify(snippets)});
      if (command === "save_command_snippet") return Promise.resolve({ id: "s-new", kind: "snippet", name: args?.input?.name || "新模板", content: args?.input?.content || "", tags: "[]", variables: "[]", favorite: false, created_at: Math.floor(Date.now() / 1000), updated_at: Math.floor(Date.now() / 1000) });
      if (command === "delete_command_snippet") return Promise.resolve(null);
      if (command === "open_shell") return Promise.resolve({ shell_id: "shell-1", encoding: "utf-8" });
      if (command === "open_local_shell") return Promise.resolve({ shell_id: "shell-1", encoding: "utf-8" });
      if (command === "read_shell") return Promise.resolve("");
      if (command === "write_shell" || command === "resize_shell" || command === "disconnect_shell") return Promise.resolve(null);
      if (command === "set_shell_encoding") return Promise.resolve("utf-8");
      if (command === "open_sftp_for_shell" || command === "open_sftp") return Promise.resolve({ sftp_id: "sftp-1" });
      if (command === "list_sftp_dir") return Promise.resolve(files);
      if (command === "list_sftp_transfers") return Promise.resolve([]);
      if (command === "list_tunnels") return Promise.resolve([]);
      if (command === "get_version" || command === "plugin:app|version") return Promise.resolve("0.5.0");
      if (command === "get_platform") return Promise.resolve("windows");
      if (command === "is_maximized") return Promise.resolve(false);
      if (command === "ping_host") return Promise.resolve({ reachable: true, latency_ms: 18 });
      if (command === "get_ssh_keys") return Promise.resolve([]);
      if (command === "ssh_exec" || command === "exec_shell") return Promise.resolve("");
      if (command && (command.startsWith("plugin:") || command.startsWith("get_"))) return Promise.resolve(null);
      return Promise.resolve(null);
    }
  };
})();`;

async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/json/version`);
      if (response.ok) return response.json();
    } catch { /* Edge is starting */ }
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

async function openPage(url) {
  const targetResponse = await fetch(`${ORIGIN}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("CDP websocket failed")); });
  const cdp = new CdpClient(socket);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await cdp.send("Page.navigate", { url });
  await sleep(4000);
  await cdp.send("Runtime.evaluate", { expression: "localStorage.removeItem('portnest-session-snapshot-v1');localStorage.setItem('portnest-theme','light');localStorage.setItem('portnest-theme-skin','aurora'); location.reload();" });
  await sleep(5000);
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result ? result.result.value : undefined;
  };
  const shot = async (name, clip) => {
    const params = { format: "png" };
    if (clip) params.clip = { ...clip, scale: clip.scale || 1 };
    const result = await cdp.send("Page.captureScreenshot", params);
    writeFileSync(`.qoder-tmp/ws-${name}.png`, Buffer.from(result.data, "base64"));
    console.log(`shot ${name}`);
  };
  return { cdp, evaluate, shot, socket };
}

async function main() {
  await waitForCdp();
  const { evaluate, shot, cdp, socket } = await openPage("http://localhost:1420/");
  await evaluate(`(() => { const row = [...document.querySelectorAll('.asset-connection-row')].find(r => r.textContent.includes('demo-web-01')); row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await sleep(5000);
  console.log("tabs:", await evaluate("document.querySelectorAll('.session-tab').length"));
  console.log("file rows:", await evaluate("document.querySelectorAll('.file-row').length"));
  await shot("session-light");
  await shot("files-light", { x: 1040, y: 30, width: 400, height: 870 });

  await evaluate("document.querySelector('.nav-btn[title=\"更多操作\"]')?.click()");
  await sleep(500);
  await shot("file-menu", { x: 1000, y: 60, width: 440, height: 820, scale: 1.6 });
  await evaluate("document.querySelector('.file-options-overlay')?.click()");
  await sleep(200);

  await shot("rail-light", { x: 1384, y: 30, width: 56, height: 870, scale: 3 });
  await evaluate("document.querySelector('.overview-rail')?.click()");
  await sleep(1600);
  await shot("overview-light", { x: 1000, y: 30, width: 440, height: 870, scale: 1.6 });
  await evaluate("document.querySelector('.overview-icon-button[title=\"收起为精简概览\"]')?.click()");
  await sleep(400);

  await evaluate("(() => { const btn = [...document.querySelectorAll('.session-action-controls button')].find(b => b.textContent.includes('隧道')); btn?.click(); })()");
  await sleep(700);
  await shot("tunnel-light", { x: 720, y: 40, width: 720, height: 820, scale: 1.5 });
  await evaluate("document.querySelector('.workspace-drawer-header button')?.click()");
  await sleep(300);

  await evaluate("(() => { const btn = [...document.querySelectorAll('.session-action-controls button')].find(b => b.textContent.includes('命令广播')); btn?.click(); })()");
  await sleep(700);
  await shot("broadcast-light");
  await evaluate("document.querySelector('.command-composer-close')?.click()");
  await sleep(300);

  await evaluate("localStorage.removeItem('portnest-session-snapshot-v1');localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4500);
  await evaluate(`(() => { const row = [...document.querySelectorAll('.asset-connection-row')].find(r => r.textContent.includes('demo-web-01')); row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await sleep(4000);
  await shot("session-dark");
  await shot("files-dark", { x: 1040, y: 30, width: 400, height: 870 });
  await evaluate("document.querySelector('.overview-rail')?.click()");
  await sleep(1600);
  await shot("overview-dark", { x: 1000, y: 30, width: 440, height: 870, scale: 1.6 });
  await evaluate("document.querySelector('.overview-icon-button[title=\"收起为精简概览\"]')?.click()");
  await sleep(300);

  // Database workspace, light theme.
  await evaluate("localStorage.removeItem('portnest-session-snapshot-v1');localStorage.setItem('portnest-theme','light'); location.reload();");
  await sleep(4500);
  await evaluate(`(() => { const row = [...document.querySelectorAll('.asset-connection-row')].find(r => r.textContent.includes('demo-db-master')); row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await sleep(3500);
  await evaluate("document.querySelector('.mysql-tree-row.database')?.click()");
  await sleep(1800);
  console.log("mysql dbs:", await evaluate("document.querySelectorAll('.mysql-tree-row.database').length"));
  await shot("db-light");
  await evaluate("document.querySelector('.mysql-tree-row.object')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await sleep(1800);
  await shot("db-table-light");

  await evaluate("document.querySelector('.mysql-tree-row.database')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 190, clientY: 120 }))");
  await sleep(400);
  await shot("db-menu", { x: 140, y: 80, width: 330, height: 420, scale: 2 });
  await evaluate("document.querySelector('.mysql-workspace')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await sleep(200);

  await evaluate("(() => { const btn = [...document.querySelectorAll('.mysql-tree header button')].find(b => b.textContent.includes('数据库')); btn?.click(); })()");
  await sleep(600);
  await shot("db-dialog", { x: 360, y: 120, width: 720, height: 620, scale: 1.5 });
  await evaluate("document.querySelector('.mysql-dialog footer button')?.click()");
  await sleep(300);

  await evaluate("localStorage.removeItem('portnest-session-snapshot-v1');localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4500);
  await evaluate(`(() => { const row = [...document.querySelectorAll('.asset-connection-row')].find(r => r.textContent.includes('demo-db-master')); row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await sleep(3500);
  await evaluate("document.querySelector('.mysql-tree-row.database')?.click()");
  await sleep(1800);
  await shot("db-dark");

  // Connection form + custom select popover.
  await evaluate("localStorage.removeItem('portnest-session-snapshot-v1');localStorage.setItem('portnest-theme','light'); location.reload();");
  await sleep(4500);
  await evaluate("document.querySelector('.asset-icon-button[aria-label=\"新建连接\"]')?.click()");
  await sleep(900);
  await shot("connection-form-light");
  await evaluate("document.querySelector('.connect-form-grid .app-select-trigger')?.click()");
  await sleep(400);
  await shot("select-menu-light", { x: 300, y: 100, width: 800, height: 680, scale: 1.5 });
  await evaluate("document.body.click()");
  await sleep(200);

  await evaluate("localStorage.setItem('portnest-theme','dark'); location.reload();");
  await sleep(4500);
  await evaluate("document.querySelector('.asset-icon-button[aria-label=\"新建连接\"]')?.click()");
  await sleep(900);
  await shot("connection-form-dark");
  await evaluate("document.querySelector('.connect-form-grid .app-select-trigger')?.click()");
  await sleep(400);
  await shot("select-menu-dark", { x: 300, y: 100, width: 800, height: 680, scale: 1.5 });
  await evaluate("document.body.click()");
  await sleep(200);
  socket.close();
  const targets = await (await fetch(`${ORIGIN}/json/list`)).json();
  for (const target of targets) if (target.type === "page") await fetch(`${ORIGIN}/json/close/${target.id}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
