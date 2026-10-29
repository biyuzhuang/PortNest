#!/usr/bin/env node
/**
 * Dump computed styles for a list of selectors into JSON, so a CSS refactor can
 * be compared property by property instead of only by pixels.
 *
 * Usage:
 *   node design/tools/style-fingerprint.mjs --url "http://localhost:1420/" \
 *     --evalFile design/tools/eval-open-context-menu.js \
 *     --selectors ".asset-context-menu,.hexhub-context-item,.hexhub-context-header" \
 *     --out design/verify/fp-before.json [--props all|width,color,...]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(p => existsSync(p));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const value = argv[i + 1];
    out[argv[i].slice(2)] = value && !value.startsWith("--") ? (i += 1, value) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "http://localhost:1420/";
const setup = args.setup ?? "localStorage.setItem('portnest-theme','light')";
const selectors = String(args.selectors ?? "").split(",").filter(Boolean);
const props = args.props && args.props !== "all" ? String(args.props).split(",") : null;
const outPath = resolve(args.out ?? "design/verify/fingerprint.json");

const port = 9200 + Math.floor(Math.random() * 90);
const profile = `${tmpdir()}/portnest-fp-${port}`;
const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let socket;
let nextId = 0;
const pending = new Map();
const events = new Map();
function send(method, params = {}) {
  const id = (nextId += 1);
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolvePromise, rejectPromise });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rejectPromise(new Error(`${method} timed out`)); } }, 30000);
  });
}
function once(name) {
  return new Promise(resolvePromise => {
    const list = events.get(name) ?? [];
    list.push(resolvePromise);
    events.set(name, list);
  });
}
async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

try {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await getJson("/json/version"))?.webSocketDebuggerUrl) break; } catch { /* wait */ }
    await sleep(250);
  }
  const page = (await getJson("/json/list")).find(t => t.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolvePromise, rejectPromise } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rejectPromise(new Error(msg.error.message)); else resolvePromise(msg.result);
      return;
    }
    if (msg.method && events.has(msg.method)) {
      const list = events.get(msg.method);
      if (list?.length) list.shift()(msg.params);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

  async function load(target) {
    const loaded = once("Page.loadEventFired");
    await send("Page.navigate", { url: target });
    await loaded;
    await sleep(900);
    await send("Runtime.evaluate", { expression: setup, awaitPromise: true });
    const reloaded = once("Page.loadEventFired");
    await send("Page.reload", { ignoreCache: false });
    await reloaded;
    await sleep(1500);
  }

  await load(url);
  if (typeof args.evalFile === "string") {
    const source = await readFile(resolve(args.evalFile), "utf8");
    const result = await send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
    console.log("eval:", JSON.stringify(result.result.value));
    await sleep(400);
  }

  const fingerprint = {};
  for (const selector of selectors) {
    const node = await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const cs = getComputedStyle(el);
        const props = ${JSON.stringify(props)};
        const names = props ?? Array.from(cs);
        const values = {};
        for (const name of names) values[name] = cs.getPropertyValue(name);
        return { values, rect: [el.getBoundingClientRect().width, el.getBoundingClientRect().height] };
      })()`,
      returnByValue: true,
    });
    fingerprint[selector] = node.result.value;
  }
  await writeFile(outPath, JSON.stringify(fingerprint, null, 2));
  console.log(`wrote ${outPath}`);
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(250);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
