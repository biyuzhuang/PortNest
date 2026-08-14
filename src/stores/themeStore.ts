import { createSignal } from "solid-js";

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
  return "light";
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
  publishAppearance();
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
        setTerminalThemeRevision(value => value + 1);
        publishAppearance();
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

const makeTheme = (name: string, background: string, foreground: string, palette: Partial<TerminalTheme>): TerminalTheme => ({
  name, background, foreground, cursor: foreground, cursorAccent: background,
  selectionBackground: "#4b6a8b88", black: "#1b1f27", red: "#e06c75", green: "#98c379",
  yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#d7dae0",
  brightBlack: "#6b7280", brightRed: "#ff7b86", brightGreen: "#b4e88d", brightYellow: "#ffd68a",
  brightBlue: "#7dc4ff", brightMagenta: "#dc8df2", brightCyan: "#70d5e0", brightWhite: "#ffffff", ...palette,
});

Object.assign(terminalThemes, {
  one_dark: makeTheme("One Dark", "#282c34", "#abb2bf", { selectionBackground: "#3e4451", black: "#1e2127", brightBlack: "#5c6370" }),
  nord: makeTheme("Nord", "#2e3440", "#d8dee9", { selectionBackground: "#434c5e", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0" }),
  tokyo_night: makeTheme("Tokyo Night", "#1a1b26", "#c0caf5", { selectionBackground: "#33467c", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff" }),
  catppuccin_mocha: makeTheme("Catppuccin Mocha", "#1e1e2e", "#cdd6f4", { selectionBackground: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#cba6f7", cyan: "#94e2d5" }),
  gruvbox_dark: makeTheme("Gruvbox Dark", "#282828", "#ebdbb2", { selectionBackground: "#504945", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588", magenta: "#b16286", cyan: "#689d6a" }),
  github_dark: makeTheme("GitHub Dark", "#0d1117", "#c9d1d9", { selectionBackground: "#264f78", red: "#ff7b72", green: "#7ee787", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf" }),
  solarized_light: makeTheme("Solarized Light", "#fdf6e3", "#657b83", { cursor: "#586e75", cursorAccent: "#fdf6e3", selectionBackground: "#eee8d5", black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#586e75", brightWhite: "#fdf6e3" }),
  github_light: makeTheme("GitHub Light", "#ffffff", "#24292f", { cursor: "#0969da", cursorAccent: "#ffffff", selectionBackground: "#b6d7f8", black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#d0d7de", brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#bf8700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#f6f8fa" }),
  one_light: makeTheme("One Light", "#fafafa", "#383a42", { cursor: "#526fff", cursorAccent: "#fafafa", selectionBackground: "#bfceff", black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#986801", blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#d7dae0", brightBlack: "#696c77", brightRed: "#ca1243", brightGreen: "#50a14f", brightYellow: "#c18401", brightBlue: "#4078f2", brightMagenta: "#a626a4", brightCyan: "#0184bc", brightWhite: "#ffffff" }),
  quiet_light: makeTheme("Quiet Light", "#f5f5f5", "#333333", { cursor: "#54494b", cursorAccent: "#f5f5f5", selectionBackground: "#c9d0d9", black: "#333333", red: "#aa3731", green: "#448c27", yellow: "#9c5d27", blue: "#325cc0", magenta: "#7a3e9d", cyan: "#008c95", white: "#d7d7d7", brightBlack: "#777777", brightRed: "#c43e37", brightGreen: "#5aa332", brightYellow: "#b57a31", brightBlue: "#4876d6", brightMagenta: "#9454b8", brightCyan: "#00a1aa", brightWhite: "#ffffff" }),
  gruvbox_light: makeTheme("Gruvbox Light", "#fbf1c7", "#3c3836", { cursor: "#3c3836", cursorAccent: "#fbf1c7", selectionBackground: "#d5c4a1", black: "#3c3836", red: "#cc241d", green: "#79740e", yellow: "#b57614", blue: "#076678", magenta: "#8f3f71", cyan: "#427b58", white: "#ebdbb2", brightBlack: "#7c6f64", brightRed: "#9d0006", brightGreen: "#98971a", brightYellow: "#d79921", brightBlue: "#458588", brightMagenta: "#b16286", brightCyan: "#689d6a", brightWhite: "#f9f5d7" }),
});

const terminalThemeKey = "portnest-terminal-theme";
const TERMINAL_THEME_PREFERENCES_KEY = "portnest-terminal-theme-preferences";
const [terminalThemeRevision, setTerminalThemeRevision] = createSignal(0);

export type TerminalThemeMode = "follow" | "fixed";
export interface TerminalThemePreferences {
  mode: TerminalThemeMode;
  lightTheme: string;
  darkTheme: string;
  fixedTheme: string;
}

export function getTerminalThemePreferences(): TerminalThemePreferences {
  const legacy = localStorage.getItem(terminalThemeKey) || "vscode_dark";
  const defaults: TerminalThemePreferences = { mode: "follow", lightTheme: "vscode_light", darkTheme: legacy, fixedTheme: legacy };
  try {
    const stored = JSON.parse(localStorage.getItem(TERMINAL_THEME_PREFERENCES_KEY) || "null");
    return stored ? { ...defaults, ...stored } : defaults;
  } catch { return defaults; }
}

export function setTerminalThemePreferences(preferences: TerminalThemePreferences) {
  localStorage.setItem(TERMINAL_THEME_PREFERENCES_KEY, JSON.stringify(preferences));
  localStorage.setItem(terminalThemeKey, preferences.mode === "fixed" ? preferences.fixedTheme : preferences.darkTheme);
  setTerminalThemeRevision(value => value + 1);
  publishAppearance();
}

export function getTerminalTheme(): string {
  const preferences = getTerminalThemePreferences();
  if (preferences.mode === "fixed") return preferences.fixedTheme;
  return effectiveTheme() === "light" ? preferences.lightTheme : preferences.darkTheme;
}

export function setTerminalTheme(name: string) {
  const preferences = getTerminalThemePreferences();
  if (preferences.mode === "fixed") preferences.fixedTheme = name;
  else if (effectiveTheme() === "light") preferences.lightTheme = name;
  else preferences.darkTheme = name;
  setTerminalThemePreferences(preferences);
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
  openFileManagerOnConnect: boolean;
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
    openFileManagerOnConnect: true,
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
  publishAppearance();
}

export { terminalSettingsRevision, terminalThemeRevision };

export type TerminalBackgroundStyle = "theme" | "solid" | "midnight" | "aurora" | "image" | "solid_dark" | "solid_light";
export type TerminalImageFit = "cover" | "contain" | "fill";
export interface TerminalBackgroundConfig {
  style: TerminalBackgroundStyle;
  solidColor: string;
  imageFit: TerminalImageFit;
  imageOpacity: number;
  imageOverlay: number;
  imageBlur: number;
  imageAssetId?: string;
}
const TERMINAL_BACKGROUND_KEY = "portnest-terminal-background";
const TERMINAL_BACKGROUND_CONFIG_KEY = "portnest-terminal-background-config";
const backgroundDefaults: TerminalBackgroundConfig = { style: "theme", solidColor: "#101827", imageFit: "cover", imageOpacity: 0.72, imageOverlay: 0.35, imageBlur: 0 };
const allowedBackgroundStyles: TerminalBackgroundStyle[] = ["theme", "solid", "solid_dark", "solid_light", "midnight", "aurora", "image"];
const normalizeBackgroundStyle = (value: unknown): TerminalBackgroundStyle =>
  allowedBackgroundStyles.includes(value as TerminalBackgroundStyle) ? value as TerminalBackgroundStyle : "theme";

function getStoredTerminalBackground(): TerminalBackgroundStyle {
  const value = localStorage.getItem(TERMINAL_BACKGROUND_KEY);
  return normalizeBackgroundStyle(value);
}

function getStoredTerminalBackgroundConfig(): TerminalBackgroundConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(TERMINAL_BACKGROUND_CONFIG_KEY) || "null");
    if (stored) {
      const { striped: _removedStripedSetting, ...supported } = stored;
      return { ...backgroundDefaults, ...supported, style: normalizeBackgroundStyle(stored.style) };
    }
  } catch {}
  const legacyStyle = getStoredTerminalBackground();
  return { ...backgroundDefaults, style: legacyStyle };
};

export function getEffectiveTerminalBackgroundStyle(config = terminalBackgroundConfig()): TerminalBackgroundStyle {
  return config.style;
}

const [terminalBackgroundStyle, setTerminalBackgroundStyleSignal] =
  createSignal<TerminalBackgroundStyle>(getStoredTerminalBackgroundConfig().style);
const [terminalBackgroundConfig, setTerminalBackgroundConfigSignal] = createSignal<TerminalBackgroundConfig>(getStoredTerminalBackgroundConfig());
const [appearanceRevision, setAppearanceRevision] = createSignal(0);

const appearanceChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("portnest-appearance") : null;
const publishAppearance = () => {
  setAppearanceRevision(value => value + 1);
  appearanceChannel?.postMessage({ revision: Date.now() });
};
appearanceChannel?.addEventListener("message", () => {
  setTerminalBackgroundConfigSignal(getStoredTerminalBackgroundConfig());
  setTerminalBackgroundStyleSignal(getStoredTerminalBackgroundConfig().style);
  const mode = getStoredTheme();
  setThemeModeInternal(mode);
  const effective = mode === "system" ? getSystemTheme() : mode;
  setEffectiveTheme(effective);
  applyTheme(effective);
  setTerminalThemeRevision(value => value + 1);
  setTerminalSettingsRevision(value => value + 1);
  setAppearanceRevision(value => value + 1);
});

export function setTerminalBackgroundStyle(style: TerminalBackgroundStyle) {
  const next = { ...terminalBackgroundConfig(), style: normalizeBackgroundStyle(style) };
  localStorage.setItem(TERMINAL_BACKGROUND_KEY, next.style);
  localStorage.setItem(TERMINAL_BACKGROUND_CONFIG_KEY, JSON.stringify(next));
  setTerminalBackgroundConfigSignal(next);
  setTerminalBackgroundStyleSignal(next.style);
  publishAppearance();
}

export function setTerminalBackgroundConfig(config: TerminalBackgroundConfig) {
  const { striped: _removedStripedSetting, ...supported } = config as TerminalBackgroundConfig & { striped?: boolean };
  const normalized = { ...supported, style: normalizeBackgroundStyle(config.style) };
  localStorage.setItem(TERMINAL_BACKGROUND_CONFIG_KEY, JSON.stringify(normalized));
  localStorage.setItem(TERMINAL_BACKGROUND_KEY, normalized.style);
  setTerminalBackgroundConfigSignal(normalized);
  setTerminalBackgroundStyleSignal(normalized.style);
  publishAppearance();
}

export { terminalBackgroundStyle, terminalBackgroundConfig, appearanceRevision };
