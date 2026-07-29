import { createSignal, createEffect } from "solid-js";

export type ThemeMode = "light" | "dark" | "system";

export interface ThemeColors {
  "--bg-primary": string;
  "--bg-secondary": string;
  "--bg-tertiary": string;
  "--bg-hover": string;
  "--text-primary": string;
  "--text-secondary": string;
  "--text-muted": string;
  "--accent": string;
  "--accent-hover": string;
  "--success": string;
  "--warning": string;
  "--error": string;
  "--border": string;
  "--border-light": string;
}

const themes: Record<"light" | "dark", ThemeColors> = {
  light: {
    "--bg-primary": "#f9fafb",
    "--bg-secondary": "#ffffff",
    "--bg-tertiary": "#f3f4f6",
    "--bg-hover": "#e5e7eb",
    "--text-primary": "#111827",
    "--text-secondary": "#6b7280",
    "--text-muted": "#9ca3af",
    "--accent": "#3b82f6",
    "--accent-hover": "#2563eb",
    "--success": "#10b981",
    "--warning": "#f59e0b",
    "--error": "#ef4444",
    "--border": "#e5e7eb",
    "--border-light": "#d1d5db",
  },
  dark: {
    "--bg-primary": "#0a0e17",
    "--bg-secondary": "#111827",
    "--bg-tertiary": "#1f2937",
    "--bg-hover": "#374151",
    "--text-primary": "#f9fafb",
    "--text-secondary": "#9ca3af",
    "--text-muted": "#6b7280",
    "--accent": "#3b82f6",
    "--accent-hover": "#2563eb",
    "--success": "#10b981",
    "--warning": "#f59e0b",
    "--error": "#ef4444",
    "--border": "#1f2937",
    "--border-light": "#374151",
  },
};

const STORAGE_KEY = "portnest-theme";

function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

function getStoredTheme(): ThemeMode {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  }
  return "system";
}

const [themeMode, setThemeModeInternal] = createSignal<ThemeMode>(getStoredTheme());
const [effectiveTheme, setEffectiveTheme] = createSignal<"light" | "dark">(
  getStoredTheme() === "system" ? getSystemTheme() : getStoredTheme() as "light" | "dark"
);

export function setThemeMode(mode: ThemeMode) {
  setThemeModeInternal(mode);
  localStorage.setItem(STORAGE_KEY, mode);

  const effective = mode === "system" ? getSystemTheme() : mode;
  setEffectiveTheme(effective);
  applyTheme(effective);
}

export function toggleTheme() {
  const current = effectiveTheme();
  const newTheme = current === "dark" ? "light" : "dark";
  setThemeMode(newTheme);
}

function applyTheme(theme: "light" | "dark") {
  const colors = themes[theme];
  const root = document.documentElement;

  Object.entries(colors).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });

  root.setAttribute("data-theme", theme);
}

export function initTheme() {
  applyTheme(effectiveTheme());

  if (typeof window !== "undefined" && window.matchMedia) {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", (e) => {
      if (themeMode() === "system") {
        const newTheme = e.matches ? "dark" : "light";
        setEffectiveTheme(newTheme);
        applyTheme(newTheme);
      }
    });
  }
}

export { themeMode, effectiveTheme };

// Terminal theme presets
export interface TerminalTheme {
  name: string;
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const terminalThemes: Record<string, TerminalTheme> = {
  vscode_dark: {
    name: "VS Code Dark",
    foreground: "#cccccc",
    background: "#1e1e1e",
    cursor: "#ffffff",
    cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2455ff",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  },
  vscode_light: {
    name: "VS Code Light",
    foreground: "#000000",
    background: "#ffffff",
    cursor: "#000000",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    black: "#000000",
    red: "#d32f2f",
    green: "#388a3c",
    yellow: "#c77d08",
    blue: "#1565c0",
    magenta: "#8e24aa",
    cyan: "#00838f",
    white: "#e0e0e0",
    brightBlack: "#616161",
    brightRed: "#ef5350",
    brightGreen: "#66bb6a",
    brightYellow: "#ffca28",
    brightBlue: "#42a5f5",
    brightMagenta: "#ab47bc",
    brightCyan: "#26c6da",
    brightWhite: "#ffffff",
  },
  solarized_dark: {
    name: "Solarized Dark",
    foreground: "#839496",
    background: "#002b36",
    cursor: "#839496",
    cursorAccent: "#002b36",
    selectionBackground: "#274642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  monokai: {
    name: "Monokai",
    foreground: "#f8f8f2",
    background: "#272822",
    cursor: "#f8f8f0",
    cursorAccent: "#272822",
    selectionBackground: "#49483e",
    black: "#272822",
    red: "#f92672",
    green: "#a6e22e",
    yellow: "#e6db74",
    blue: "#66d9ef",
    magenta: "#ae81ff",
    cyan: "#a1efe4",
    white: "#f8f8f2",
    brightBlack: "#75715e",
    brightRed: "#f92672",
    brightGreen: "#a6e22e",
    brightYellow: "#e6db74",
    brightBlue: "#66d9ef",
    brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4",
    brightWhite: "#f9f8f5",
  },
  dracula: {
    name: "Dracula",
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
};

const terminalThemeKey = "portnest-terminal-theme";
const [terminalThemeRevision, setTerminalThemeRevision] = createSignal(0);

export function getTerminalTheme(): string {
  return localStorage.getItem(terminalThemeKey) || "vscode_dark";
}

export function setTerminalTheme(name: string) {
  localStorage.setItem(terminalThemeKey, name);
  setTerminalThemeRevision(value => value + 1);
}

export function getTerminalThemeConfig(): TerminalTheme {
  return terminalThemes[getTerminalTheme()] || terminalThemes.vscode_dark;
}

// Terminal behavior settings
const TERMINAL_SETTINGS_KEY = "portnest-terminal-settings";
const [terminalSettingsRevision, setTerminalSettingsRevision] = createSignal(0);

export interface TerminalSettings {
  copyOnSelect: boolean;
  rightClickAction: "paste" | "none";
  middleClickAction: "paste" | "none";
  ctrlVPaste: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  scrollback: number;
  commandHints: boolean;
  sshHistory: boolean;
  reconnectOnDisconnect: boolean;
  terminalBell: boolean;
}

export function getTerminalSettings(): TerminalSettings {
  const defaults: TerminalSettings = {
    copyOnSelect: true,
    rightClickAction: "paste",
    middleClickAction: "none",
    ctrlVPaste: true,
    fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1,
    letterSpacing: 0,
    scrollback: 1000,
    commandHints: true,
    sshHistory: true,
    reconnectOnDisconnect: false,
    terminalBell: false,
  };
  try {
    const stored = localStorage.getItem(TERMINAL_SETTINGS_KEY);
    if (stored) return { ...defaults, ...JSON.parse(stored) };
  } catch {}
  return defaults;
}

export function setTerminalSettings(settings: TerminalSettings) {
  localStorage.setItem(TERMINAL_SETTINGS_KEY, JSON.stringify(settings));
  setTerminalSettingsRevision(value => value + 1);
}

export { terminalSettingsRevision, terminalThemeRevision };

export type TerminalBackgroundStyle = "striped" | "solid_dark" | "solid_light" | "midnight";
const TERMINAL_BACKGROUND_KEY = "portnest-terminal-background";

function getStoredTerminalBackground(): TerminalBackgroundStyle {
  const value = localStorage.getItem(TERMINAL_BACKGROUND_KEY);
  return value === "solid_dark" || value === "solid_light" || value === "midnight" || value === "striped"
    ? value
    : "striped";
}

const [terminalBackgroundStyle, setTerminalBackgroundStyleSignal] =
  createSignal<TerminalBackgroundStyle>(getStoredTerminalBackground());

export function setTerminalBackgroundStyle(style: TerminalBackgroundStyle) {
  localStorage.setItem(TERMINAL_BACKGROUND_KEY, style);
  setTerminalBackgroundStyleSignal(style);
}

export { terminalBackgroundStyle };
