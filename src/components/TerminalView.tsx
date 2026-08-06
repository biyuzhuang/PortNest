import { Component, onMount, onCleanup, createEffect, on, createSignal, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { api, ConnectionRecord } from "../utils/api";
import { getTerminalThemeConfig, getTerminalSettings, terminalBackgroundStyle, terminalSettingsRevision, terminalThemeRevision } from "../stores/themeStore";
import { sessionStore } from "../stores/sessionStore";

interface TerminalViewProps {
  connection: ConnectionRecord;
  sessionKey?: string;
  visible?: boolean | (() => boolean);
  shellId?: string;
  onDisconnected?: (error?: unknown) => void;
}

interface TerminalState {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  shellId: string;
  readInterval: number | null;
  stopPolling: () => void;
  resizeObserver: ResizeObserver | null;
  initialized: boolean;
  contentWritten: boolean;
  connection: ConnectionRecord;
}

const terminalStates = new Map<string, TerminalState>();

const terminalCursorColors = (backgroundStyle: string, fallbackCursor: string, fallbackAccent: string) =>
  backgroundStyle === "striped" || backgroundStyle === "solid_light"
    ? { cursor: "#2563eb", cursorAccent: "#ffffff" }
    : { cursor: fallbackCursor, cursorAccent: fallbackAccent };

export function getTerminalState(sessionKey: string): TerminalState | undefined {
  return terminalStates.get(sessionKey);
}

export function hasTerminalState(sessionKey: string): boolean {
  const state = terminalStates.get(sessionKey);
  return !!state && state.terminal.element?.isConnected === true;
}

export function disposeAllTerminals() {
  for (const state of terminalStates.values()) {
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
    if (state.readInterval) {
      clearInterval(state.readInterval);
      state.readInterval = null;
    }
    state.stopPolling();
    if (state.terminal.element?.isConnected) {
      try {
        state.terminal.dispose();
      } catch (_) {}
    }
  }
  terminalStates.clear();
}

export const TerminalView: Component<TerminalViewProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  const [showSearch, setShowSearch] = createSignal(false);
  const [searchTerm, setSearchTerm] = createSignal("");

  const isVisible = () => {
    if (typeof props.visible === "function") {
      return props.visible();
    }
    return !!props.visible;
  };

  const doFit = (state: TerminalState) => {
    try {
      const container = containerRef;
      if (state.terminal.element?.isConnected && container && container.offsetWidth > 0 && container.offsetHeight > 0) {
        const prevCols = state.terminal.cols;
        const prevRows = state.terminal.rows;
        state.fitAddon.fit();
        const cols = state.terminal.cols;
        const rows = state.terminal.rows;
        if (cols !== prevCols || rows !== prevRows) {
          // Keep the remote PTY in sync with the rendered grid so programs
          //  that query TIOCGWINSZ (top, htop, vim, less, ...) position their
          //  cursor correctly.
          api.resizeShell(state.shellId, cols, rows).catch((e) => {
            console.warn("[TerminalView] resizeShell failed:", e);
          });
        }
      }
    } catch (_) {}
  };

  const initTerminal = () => {
    if (!containerRef || !props.shellId || !props.sessionKey) {
      console.log("[TerminalView] initTerminal skipped: missing params");
      return;
    }

    const sessionKey = props.sessionKey;
    const shellId = props.shellId;

    console.log("[TerminalView] initTerminal:", sessionKey, "shellId:", shellId, "hasContainer:", !!containerRef);

    const existingState = terminalStates.get(sessionKey);

    if (existingState) {
      console.log("[TerminalView] Existing state:", {
        elementConnected: existingState.terminal.element?.isConnected,
        shellId: existingState.shellId,
        contentWritten: existingState.contentWritten,
        currentShellId: shellId
      });

      if (existingState.terminal.element?.isConnected && existingState.shellId === shellId && existingState.contentWritten) {
        console.log("[TerminalView] Reusing existing terminal:", sessionKey);
        doFit(existingState);
        return;
      }

      if (existingState.terminal.element?.isConnected) {
        console.log("[TerminalView] Disposing old terminal:", sessionKey);
        try {
          existingState.terminal.dispose();
        } catch (_) {}
      }

      if (existingState.resizeObserver) {
        existingState.resizeObserver.disconnect();
        existingState.resizeObserver = null;
      }
      if (existingState.readInterval) {
        clearInterval(existingState.readInterval);
        existingState.readInterval = null;
      }
      existingState.stopPolling();
      terminalStates.delete(sessionKey);
    }

    const themeConfig = getTerminalThemeConfig();
    const backgroundStyle = terminalBackgroundStyle();
    const terminalBackground = backgroundStyle === "striped"
      ? "#00000000"
      : backgroundStyle === "solid_light" ? "#ffffff"
      : backgroundStyle === "midnight" ? "#101827"
      : themeConfig.background;
    const terminalForeground = backgroundStyle === "striped" || backgroundStyle === "solid_light"
      ? "#111827"
      : themeConfig.foreground;
    const cursorColors = terminalCursorColors(
      backgroundStyle,
      themeConfig.cursor,
      themeConfig.cursorAccent,
    );

    const settings = getTerminalSettings();
    const terminal = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
      theme: {
        background: terminalBackground,
        foreground: terminalForeground,
        cursor: cursorColors.cursor,
        cursorAccent: cursorColors.cursorAccent,
        selectionBackground: themeConfig.selectionBackground,
        black: themeConfig.black,
        red: themeConfig.red,
        green: themeConfig.green,
        yellow: themeConfig.yellow,
        blue: themeConfig.blue,
        magenta: themeConfig.magenta,
        cyan: themeConfig.cyan,
        white: themeConfig.white,
        brightBlack: themeConfig.brightBlack,
        brightRed: themeConfig.brightRed,
        brightGreen: themeConfig.brightGreen,
        brightYellow: themeConfig.brightYellow,
        brightBlue: themeConfig.brightBlue,
        brightMagenta: themeConfig.brightMagenta,
        brightCyan: themeConfig.brightCyan,
        brightWhite: themeConfig.brightWhite,
      },
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: settings.scrollback,
      // SSH PTYs already provide the cursor movement they need. Rewriting every
      // LF as CRLF corrupts cursor positioning in full-screen programs such as vi.
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)));

    terminal.open(containerRef);

    let readTimer: number | null = null;
    let stopped = false;
    let disconnectHandled = false;

    const handleShellFailure = (error: unknown) => {
      if (disconnectHandled || stopped) return;
      disconnectHandled = true;
      console.error("[TerminalView] SSH session disconnected:", error);
      terminal.writeln("");
      terminal.writeln("\x1b[1;31m连接已中断，请重新连接。\x1b[0m");
      if (getTerminalSettings().reconnectOnDisconnect) terminal.writeln("\x1b[33m正在尝试自动重连…\x1b[0m");
      props.onDisconnected?.(error);
    };

    const pollShell = async () => {
      const currentState = terminalStates.get(sessionKey);
      if (!currentState || shellId !== currentState.shellId) {
        return;
      }
      let hadData = false;
      try {
        const data = await api.readShell(shellId);
        hadData = data.length > 0;
        if (data && terminal.element?.isConnected) {
          // Wait until xterm has parsed this batch. This provides backpressure for
          // very large output and ensures terminal query replies are emitted before
          // the next batch is fetched.
          await new Promise<void>((resolve) => terminal.write(data, resolve));
        }
      } catch (error) {
        handleShellFailure(error);
        return;
      }
      if (!stopped) {
        // Continue immediately while data is flowing. Use a short idle delay to
        // avoid a hot invoke loop when the remote shell has nothing to send.
        readTimer = window.setTimeout(pollShell, hadData ? 0 : 16);
        currentState.readInterval = readTimer;
      }
    };

    let sessionLastHeight = 0;
    let sessionLastWidth = 0;
    let fitTimer: number | null = null;

    const resizeObserver = new ResizeObserver(() => {
      // Fit + resizeShell on ANY dimension change. The right-panel toggle and
      // the splitter drag both change the rendered cols/rows of the terminal,
      // and TUI programs need TIOCGWINSZ to match the actual grid.
      const currentHeight = containerRef?.offsetHeight || 0;
      const currentWidth = containerRef?.offsetWidth || 0;

      if (currentWidth > 0 && currentHeight > 0 &&
          (currentHeight !== sessionLastHeight || currentWidth !== sessionLastWidth)) {
        if (fitTimer !== null) clearTimeout(fitTimer);
        fitTimer = window.setTimeout(() => {
          const currentState = terminalStates.get(sessionKey);
          if (currentState) {
            doFit(currentState);
          }
        }, 100);
      }
      sessionLastHeight = currentHeight;
      sessionLastWidth = currentWidth;
    });
    resizeObserver.observe(containerRef);

    terminal.writeln(`\x1b[1;32mConnected to ${props.connection.name}\x1b[0m`);
    terminal.writeln(`\x1b[32mHost: ${props.connection.host}:${props.connection.port}\x1b[0m`);
    terminal.writeln("");

    const sendData = (data: string) => {
      return sessionStore.sendText(sessionKey, data).catch(error => {
        handleShellFailure(error);
        throw error;
      });
    };

    terminal.onData((data) => {
      void sendData(data);
    });

    // Ctrl+C: 有选中文本时复制，否则发送到远程
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        setShowSearch(true);
        queueMicrotask(() => searchInputRef?.focus());
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const selection = terminal.getSelection();
        if (selection) {
          api.writeClipboardText(selection).catch(() => {});
          return false;
        }
        // No selection: xterm sends \x03 to onData
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        if (!getTerminalSettings().ctrlVPaste) return true;
        api.readClipboardText().then(text => {
          if (text) sendData(text.replace(/\r?\n/g, "\r"));
        }).catch(() => {});
        return false;
      }
      return true;
    });

    // 左键选中自动复制
    terminal.onSelectionChange(() => {
      if (getTerminalSettings().copyOnSelect) {
        const selection = terminal.getSelection();
        if (selection) {
          api.writeClipboardText(selection).catch(() => {});
        }
      }
    });

    terminal.element?.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      if (getTerminalSettings().rightClickAction !== "paste") return;
      try {
        const text = await api.readClipboardText();
        if (text) {
          await sendData(text.replace(/\r?\n/g, "\r"));
        }
      } catch (err) {
        console.error("Paste error:", err);
      }
    });

    terminal.element?.addEventListener("mousedown", async (e) => {
      if (e.button !== 1 || getTerminalSettings().middleClickAction !== "paste") return;
      e.preventDefault();
      try {
        const text = await api.readClipboardText();
        if (text) await sendData(text.replace(/\r?\n/g, "\r"));
      } catch (_) {}
    });

    const state: TerminalState = {
      terminal,
      fitAddon,
      searchAddon,
      shellId,
      readInterval: null,
      stopPolling: () => {
        stopped = true;
        if (readTimer !== null) window.clearTimeout(readTimer);
      },
      resizeObserver,
      initialized: true,
      contentWritten: true,
      connection: props.connection,
    };

    terminalStates.set(sessionKey, state);
    void pollShell();
    console.log("[TerminalView] Created new terminal state for:", sessionKey);

    setTimeout(() => {
      doFit(state);
    }, 50);
  };

  createEffect(on(() => [props.shellId, isVisible(), props.sessionKey] as const, () => {
    const vis = isVisible();
    const shellId = props.shellId;
    const sessionKey = props.sessionKey;

    console.log("[TerminalView] createEffect:", sessionKey, "vis:", vis, "shellId:", shellId);

    if (vis && shellId && sessionKey && containerRef) {
      const existingState = terminalStates.get(sessionKey);
      if (existingState && existingState.terminal.element?.isConnected && existingState.shellId === shellId && existingState.contentWritten) {
        console.log("[TerminalView] createEffect: terminal exists, skipping init");
        return;
      }
      console.log("[TerminalView] createEffect: calling initTerminal");
      initTerminal();
    }
  }, { defer: true }));

  createEffect(() => {
    const style = terminalBackgroundStyle();
    terminalSettingsRevision();
    terminalThemeRevision();
    const state = props.sessionKey ? terminalStates.get(props.sessionKey) : undefined;
    if (!state) return;
    const theme = getTerminalThemeConfig();
    const cursorColors = terminalCursorColors(style, theme.cursor, theme.cursorAccent);
    state.terminal.options.theme = {
      ...theme,
      background: style === "striped" ? "#00000000"
        : style === "solid_light" ? "#ffffff"
        : style === "midnight" ? "#101827"
        : theme.background,
      foreground: style === "striped" || style === "solid_light" ? "#111827" : theme.foreground,
      cursor: cursorColors.cursor,
      cursorAccent: cursorColors.cursorAccent,
    };
    const settings = getTerminalSettings();
    state.terminal.options.fontFamily = settings.fontFamily;
    state.terminal.options.fontSize = settings.fontSize;
    state.terminal.options.lineHeight = settings.lineHeight;
    state.terminal.options.letterSpacing = settings.letterSpacing;
    state.terminal.options.scrollback = settings.scrollback;
    doFit(state);
  });

  onMount(() => {
    console.log("[TerminalView] onMount:", props.sessionKey);
    const vis = isVisible();
    const shellId = props.shellId;
    const sessionKey = props.sessionKey;

    if (vis && shellId && sessionKey && containerRef) {
      initTerminal();
    }
  });

  onCleanup(() => {
    console.log("[TerminalView] onCleanup:", props.sessionKey);
    if (props.sessionKey) {
      const state = terminalStates.get(props.sessionKey);
      if (state) {
        state.stopPolling();
        if (state.readInterval) {
          clearTimeout(state.readInterval);
          state.readInterval = null;
        }
        if (state.resizeObserver) {
          state.resizeObserver.disconnect();
          state.resizeObserver = null;
        }
        if (state.terminal.element?.isConnected) {
          try {
            state.terminal.dispose();
          } catch (_) {}
        }
        terminalStates.delete(props.sessionKey);
        console.log("[TerminalView] Cleaned up terminal state for:", props.sessionKey);
      }
    }
  });

  const search = (previous = false) => {
    const state = props.sessionKey ? terminalStates.get(props.sessionKey) : undefined;
    if (!state || !searchTerm()) return;
    if (previous) state.searchAddon.findPrevious(searchTerm(), { incremental: true });
    else state.searchAddon.findNext(searchTerm(), { incremental: true });
  };

  return (
    <div class="terminal-view">
      <Show when={showSearch()}>
        <div class="terminal-search-bar">
          <input ref={searchInputRef} value={searchTerm()} placeholder="搜索终端输出" onInput={event => { setSearchTerm(event.currentTarget.value); search(); }} onKeyDown={event => {
            if (event.key === "Enter") search(event.shiftKey);
            if (event.key === "Escape") { setShowSearch(false); terminalStates.get(props.sessionKey || "")?.terminal.focus(); }
          }} />
          <button onClick={() => search(true)} title="上一个">↑</button><button onClick={() => search(false)} title="下一个">↓</button>
          <button onClick={() => setShowSearch(false)} title="关闭">×</button>
        </div>
      </Show>
      <div ref={containerRef} class={`terminal-container terminal-background-${terminalBackgroundStyle()}`} />
    </div>
  );
};

export type TerminalHandle = {
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
};
