import { Component, onMount, onCleanup, createEffect, on } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, ConnectionRecord } from "../utils/api";
import { getTerminalThemeConfig } from "../stores/themeStore";

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
        state.fitAddon.fit();
      }
    } catch (_) {}
  };

  const initTerminal = () => {
    if (!containerRef || !props.shellId || !props.sessionKey) return;

    const sessionKey = props.sessionKey;
    const shellId = props.shellId;

    console.log("[TerminalView] initTerminal:", sessionKey, "shellId:", shellId);

    const existingState = terminalStates.get(sessionKey);

    if (existingState && existingState.terminal.element?.isConnected && existingState.shellId === shellId && existingState.contentWritten) {
      console.log("[TerminalView] Terminal exists and connected, just fit:", sessionKey);
      doFit(existingState);
      return;
    }

    if (existingState && existingState.terminal.element?.isConnected) {
      console.log("[TerminalView] Disposing old terminal:", sessionKey);
      try {
        existingState.terminal.dispose();
      } catch (_) {}
    }

    if (existingState) {
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

    const resizeObserver = new ResizeObserver(() => {
      const currentState = terminalStates.get(sessionKey);
      if (currentState && containerRef?.offsetWidth > 0 && containerRef?.offsetHeight > 0) {
        try {
          currentState.fitAddon.fit();
        } catch (_) {}
      }
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

    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch (_) {}
    }, 50);
  };

  createEffect(on(() => [props.shellId, props.visible, props.sessionKey] as const, () => {
    const vis = isVisible();
    const shellId = props.shellId;
    const sessionKey = props.sessionKey;

    console.log("[TerminalView] createEffect:", sessionKey, "vis:", vis, "shellId:", shellId);

    if (vis && shellId && sessionKey && containerRef) {
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