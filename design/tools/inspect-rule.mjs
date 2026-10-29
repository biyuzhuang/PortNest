#!/usr/bin/env node
/**
 * Print the CSS rules that match a selector, in cascade order, with the
 * declarations that survive the cascade for the properties of interest.
 *
 * Usage:
 *   node design/tools/inspect-rule.mjs --url "http://localhost:1420/?window=settings&page=appearance" \
 *     --selector ".settings-page .settings-card select" --props padding-right,border-top-color,width
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
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
const url = args.url ?? "http://localhost:1420/?window=settings&page=appearance";
const selector = args.selector ?? ".settings-page .settings-card select";
const props = String(args.props ?? "padding-right,border-top-color,width,color,background-color").split(",");
const setup = typeof args.setup === "string" ? args.setup : "localStorage.setItem('portnest-theme','light')";

const browser = EDGE_CANDIDATES.find(p => existsSync(p));
const port = 9900 + Math.floor(Math.random() * 90);
const profile = `${tmpdir()}/portnest-inspect-${port}`;
const child = spawn(browser, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}
async function waitForBrowser() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await getJson("/json/version"))?.webSocketDebuggerUrl) return; } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error("no debugging endpoint");
}

let socket;
let nextId = 0;
const pending = new Map();
const events = new Map();
function send(method, params = {}) {
  const id = (nextId += 1);
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 30000);
  });
}
function once(name) {
  return new Promise(resolve => {
    const list = events.get(name) ?? [];
    list.push(resolve);
    events.set(name, list);
  });
}

try {
  await waitForBrowser();
  const targets = await getJson("/json/list");
  const page = targets.find(t => t.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method && events.has(msg.method)) {
      const list = events.get(msg.method);
      if (list?.length) list.shift()(msg.params);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("CSS.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 920, height: 720, deviceScaleFactor: 1, mobile: false });

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
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(args.evalFile, "utf8");
    const result = await send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
    console.log("eval:", JSON.stringify(result.result.value));
    await sleep(400);
  }
  const doc = await send("DOM.getDocument", { depth: 0 });
  const found = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!found.nodeId) throw new Error(`no node for ${selector}`);
  const styles = await send("CSS.getMatchedStylesForNode", { nodeId: found.nodeId });

  const inline = styles.inlineStyle?.cssProperties ?? [];
  console.log("inline:", inline.map(p => `${p.name}: ${p.value}`).join("; ") || "(none)");
  const matches = styles.matchedCSSRules ?? [];
  for (const match of matches) {
    const rule = match.rule;
    const origin = rule.origin ?? "";
    const text = (rule.selectorList?.text ?? "").replace(/\s+/g, " ");
    const file = rule.styleSheetId ? "" : "";
    const declarations = (rule.style?.cssProperties ?? [])
      .filter(p => props.includes(p.name) && p.value)
      .map(p => `${p.name}: ${p.value}${p.important ? " !important" : ""}`);
    if (!declarations.length) continue;
    console.log(`  [${origin}${file}] ${text} { ${declarations.join("; ")} }`);
  }

  const computed = await send("CSS.getComputedStyleForNode", { nodeId: found.nodeId });
  console.log("computed:", computed.computedStyle
    .filter(p => props.includes(p.name))
    .map(p => `${p.name}=${p.value}`).join("  "));
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
