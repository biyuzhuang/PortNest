import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "src/App.css",
  "src/components/AIAssistant.css",
  "src/components/Surfaces.css",
  "src/visual-refresh.css",
];

const pct = (raw) => {
  const value = Math.round(parseFloat(raw) * 1000) / 10;
  return String(value);
};

const rgbaMap = [
  [/rgba\(\s*79\s*,\s*124\s*,\s*255\s*,\s*([0-9.]+)\s*\)/g, "pn-blue"],
  [/rgba\(\s*20\s*,\s*184\s*,\s*166\s*,\s*([0-9.]+)\s*\)/g, "pn-teal"],
  [/rgba\(\s*108\s*,\s*92\s*,\s*231\s*,\s*([0-9.]+)\s*\)/g, "pn-violet"],
  [/rgba\(\s*139\s*,\s*92\s*,\s*246\s*,\s*([0-9.]+)\s*\)/g, "pn-violet"],
  [/rgba\(\s*14\s*,\s*165\s*,\s*233\s*,\s*([0-9.]+)\s*\)/g, "pn-cyan"],
];

const hexMap = [
  [/#4f7cff/gi, "var(--pn-blue)"],
  [/#6c5ce7/gi, "var(--pn-violet)"],
  [/#7c5cfc/gi, "var(--pn-violet)"],
  [/#14b8a6/gi, "var(--pn-teal)"],
  [/#0ea5e9/gi, "var(--pn-cyan)"],
];

for (const file of files) {
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n").map((line) => {
    if (/^\s*--pn-(blue|indigo|violet|teal|cyan):/.test(line)) return line;
    let next = line;
    for (const [pattern, token] of rgbaMap) {
      next = next.replace(pattern, (_, alpha) => `color-mix(in srgb, var(--${token}) ${pct(alpha)}%, transparent)`);
    }
    for (const [pattern, replacement] of hexMap) {
      next = next.replace(pattern, replacement);
    }
    return next;
  });
  const result = lines.join("\n");
  if (result !== original) {
    writeFileSync(file, result);
    console.log(`tokenized ${file}`);
  }
}
