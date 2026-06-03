import { Component, onMount, onCleanup, createEffect, on } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, ConnectionRecord } from "../utils/api";
import { getTerminalThemeConfig, getTerminalSettings } from "../stores/themeStore";

interface TerminalViewProps {
  connection: ConnectionRecord;
  sessionKey?: string;
  visible?: boolean | (() => boolean);
  shellId?: string;
}

interface TerminalState {
  terminal: Terminal;
  fitAddon: FitAddon;
  shellId: string;
  readInterval: number | null;
  resizeObserver: ResizeObserver | null;
  initialized: boolean;
  contentWritten: boolean;
  connection: ConnectionRecord;
}

const terminalStates = new Map<string, TerminalState>();

export function getTerminalState(sessionKey: string): TerminalState | undefined {
  return terminalStates.get(sessionKey);
}

export function hasTerminalState(sessionKey: string): boolean {
  const state = terminalStates.get(sessionKey);
  return !!state && state.terminal.element?.isConnected === true;
}

export function disposeAllTerminals() {
  for (const [key, state] of terminalStates) {
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
    if (state.readInterval) {
      clearInterval(state.readInterval);
      state.readInterval = null;
    }
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

  const isVisible = () => {
    if (typeof props.visible === "function") {
      return props.visible();
    }
    return !!props.visible;
  };

  const doFit = (state: TerminalState) => {
    try {
      if (state.terminal.element?.isConnected && containerRef?.offsetWidth > 0 && containerRef?.offsetHeight > 0) {
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
      terminalStates.delete(sessionKey);
    }

    const themeConfig = getTerminalThemeConfig();

    const terminal = new Terminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 14,
      theme: {
        background: themeConfig.background,
        foreground: themeConfig.foreground,
        cursor: themeConfig.cursor,
        cursorAccent: themeConfig.cursorAccent,
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
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef);

    const readInterval = setInterval(async () => {
      const currentState = terminalStates.get(sessionKey);
      if (!currentState || shellId !== currentState.shellId) {
        if (readInterval) clearInterval(readInterval);
        return;
      }
      try {
        const data = await api.readShell(shellId);
        if (data && terminal.element?.isConnected) {
          terminal.write(data);
        }
      } catch (_) {}
    }, 50) as unknown as number;

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

    terminal.onData(async (data) => {
      try {
        await api.writeShell(shellId, data);
      } catch (e) {
        console.error("Write shell error:", e);
      }
    });

    // Ctrl+C: 有选中文本时复制，否则发送到远程
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          return false;
        }
        // No selection: xterm sends \x03 to onData
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        navigator.clipboard.readText().then(text => {
          if (text) api.writeShell(shellId, text.replace(/\r?\n/g, "\r"));
        }).catch(() => {});
        return false;
      }
      return true;
    });

    // 左键选中自动复制
    const settings = getTerminalSettings();
    if (settings.copyOnSelect) {
      terminal.onSelectionChange(() => {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
      });
    }

    terminal.element?.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          await api.writeShell(shellId, text.replace(/\r?\n/g, "\r"));
        }
      } catch (err) {
        console.error("Paste error:", err);
      }
    });

    const state: TerminalState = {
      terminal,
      fitAddon,
      shellId,
      readInterval,
      resizeObserver,
      initialized: true,
      contentWritten: true,
      connection: props.connection,
    };

    terminalStates.set(sessionKey, state);
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
        if (state.readInterval) {
          clearInterval(state.readInterval);
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

  return (
    <div
      ref={containerRef}
      class="terminal-container"
      style={{ width: "100%", height: "100%" }}
    />
  );
};

export type TerminalHandle = {
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
};