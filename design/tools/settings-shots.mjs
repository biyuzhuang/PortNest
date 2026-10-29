#!/usr/bin/env node
/**
 * Screenshot every settings page in both themes through the DevTools Protocol.
 *
 * One browser session is reused, so a full 18-page × 2-theme sweep takes a few
 * seconds instead of one browser launch per shot. The settings window is a real
 * route (`?window=settings&page=<page>`), so every shot reflects the shipped
 * markup and the real cascade order.
 *
 * Usage:
 *   node design/tools/settings-shots.mjs --prefix r7-before --dir design/verify
 *   node design/tools/settings-shots.mjs --prefix r7-after --themes dark
 *   node design/tools/settings-shots.mjs --prefix x --pages appearance,terminal
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

const PAGES = [
  "appearance", "terminal",
  "general", "ssh", "database", "cli",
  "aiModels", "aiMcp", "aiSearch",
  "account",
  "shortcutsBasic", "shortcutsEditor", "shortcutsSsh", "shortcutsDatabase", "shortcutsDocker",
  "templates", "storage", "version",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    out[key.slice(2)] = value && !value.startsWith("--") ? (i += 1, value) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = args.url ?? "http://localhost:1420/";
const outDir = resolve(args.dir ?? "design/verify");
const prefix = args.prefix ?? "settings";
const width = Number(args.width ?? 920);
const height = Number(args.height ?? 720);
const scale = Number(args.scale ?? 2);
const settle = Number(args.wait ?? 900);
const themes = String(args.themes ?? "light,dark").split(",").filter(Boolean);
const pages = args.pages ? String(args.pages).split(",").filter(Boolean) : PAGES;

const browser = EDGE_CANDIDATES.find(p => existsSync(p));
if (!browser) {
  console.error("No Edge/Chrome binary found.");
  process.exit(1);
}

const port = 9700 + Math.floor(Math.random() * 200);
const profile = `${tmpdir()}/portnest-settings-${port}`;
const child = spawn(browser, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function waitForBrowser() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const version = await getJson("/json/version");
      if (version?.webSocketDebuggerUrl) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("browser did not expose a debugging endpoint");
}

let socket;
let nextId = 0;
const pending = new Map();
const events = new Map();

function send(method, params = {}) {
  const id = (nextId += 1);
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolvePromise, rejectPromise });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectPromise(new Error(`${method} timed out`));
      }
    }, 30000);
  });
}

function once(eventName) {
  return new Promise(resolvePromise => {
    const list = events.get(eventName) ?? [];
    list.push(resolvePromise);
    events.set(eventName, list);
  });
}

function cleanup() {
  try { socket?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}

async function load(url) {
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await sleep(settle);
}

const problems = [];
const captured = [];

try {
  await waitForBrowser();
  const targets = await getJson("/json/list");
  const page = targets.find(t => t.type === "page");
  if (!page) throw new Error("no page target");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });

  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolvePromise, rejectPromise } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rejectPromise(new Error(msg.error.message));
      else resolvePromise(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const text = msg.params.exceptionDetails?.exception?.description
        ?? msg.params.exceptionDetails?.text ?? "unknown";
      problems.push(`exception: ${String(text).split("\n")[0]}`);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      problems.push(`console.error: ${msg.params.args.map(a => a.value ?? a.description ?? "?").join(" ")}`);
    }
    if (msg.method && events.has(msg.method)) {
      const list = events.get(msg.method);
      if (list?.length) list.shift()(msg.params);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: scale, mobile: false,
  });

  await load(base);
  await mkdir(outDir, { recursive: true });

  for (const theme of themes) {
    await send("Runtime.evaluate", {
      expression: `localStorage.setItem('portnest-theme', ${JSON.stringify(theme)}); localStorage.removeItem('portnest-settings-page'); 'ok'`,
    });
    for (const name of pages) {
      const url = `${base}?window=settings&page=${name}`;
      problems.length = 0;
      await load(url);
      const info = await send("Runtime.evaluate", {
        expression: `(() => ({
          heading: document.querySelector('.settings-page-heading h2')?.textContent?.trim() ?? null,
          nav: document.querySelector('.settings-sidebar button.active')?.textContent?.trim() ?? null,
          main: document.querySelector('.settings-main')?.scrollHeight ?? 0,
          view: window.innerHeight,
        }))()`,
        returnByValue: true,
      });
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = resolve(outDir, `${prefix}-${name}-${theme}.png`);
      await writeFile(file, Buffer.from(shot.data, "base64"));
      captured.push(file);
      const value = info.result.value;
      const flag = problems.length ? ` !! ${problems.join(" | ")}` : "";
      console.log(`${theme.padEnd(5)} ${name.padEnd(18)} heading=${JSON.stringify(value.heading)} nav=${JSON.stringify(value.nav)} scroll=${value.main}/${value.view}${flag}`);
    }
  }
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
