#!/usr/bin/env node
/**
 * Screenshot the running PortNest dev server through the Chrome DevTools
 * Protocol, so theme, skin, viewport and localStorage state can be set
 * before the shot is taken.
 *
 * Usage:
 *   node design/tools/cdp-shot.mjs --url "http://localhost:1420/" --out shot.png \
 *     --width 1520 --height 1000 [--scale 2] [--wait 2000] \
 *     [--setup "localStorage.setItem('portnest-theme','dark')"]
 *
 * `--setup` runs in the page context before the reload, so it can seed
 * localStorage. It runs once per reload; the app then boots with that state.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
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
const url = args.url ?? "http://localhost:1420/";
const outPath = resolve(args.out ?? "shot.png");
const width = Number(args.width ?? 1520);
const height = Number(args.height ?? 1000);
const scale = Number(args.scale ?? 2);
const settle = Number(args.wait ?? 2200);
const setup = typeof args.setup === "string" ? args.setup : null;

const browser = EDGE_CANDIDATES.find(p => existsSync(p));
if (!browser) {
  console.error("No Edge/Chrome binary found.");
  process.exit(1);
}

const port = 9300 + Math.floor(Math.random() * 400);
const profile = `${tmpdir()}/portnest-cdp-${port}`;

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
    if (msg.method) {
      const list = events.get(msg.method);
      if (list?.length) list.shift()(msg.params);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: scale, mobile: false,
  });

  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await sleep(1200); // let Solid finish mounting and fonts settle

  if (setup) {
    await send("Runtime.evaluate", { expression: setup, awaitPromise: true });
    const reloaded = once("Page.loadEventFired");
    await send("Page.reload", { ignoreCache: false });
    await reloaded;
    await sleep(settle);
  } else {
    await sleep(settle);
  }

  // Run a script inside the page (file is easier than shell quoting for CJK).
  const evalSource = typeof args.evalFile === "string"
    ? await readFile(resolve(args.evalFile), "utf8")
    : (typeof args.eval === "string" ? args.eval : null);
  if (evalSource) {
    const evaluated = await send("Runtime.evaluate", {
      expression: evalSource,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("eval:", JSON.stringify(evaluated.result.value));
  }

  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(data, "base64"));

  const title = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  console.log(`ok ${outPath} (${width}x${height} @${scale}x) title=${JSON.stringify(title.result.value)}`);
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
