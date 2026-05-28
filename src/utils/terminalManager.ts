import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getTerminalThemeConfig } from "../stores/themeStore";

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  shellId: string;
  dispose: () => void;
}

class TerminalManager {
  private terminals: Map<string, TerminalInstance> = new Map();

  createTerminal(sessionKey: string, shellId: string, container: HTMLElement): TerminalInstance | null {
    const existing = this.terminals.get(sessionKey);
    if (existing && existing.shellId === shellId && existing.terminal.element?.isConnected) {
      console.log("[TerminalManager] Reusing existing terminal for:", sessionKey);
      return existing;
    }

    console.log("[TerminalManager] Creating new terminal for:", sessionKey, "shellId:", shellId);
    this.disposeTerminal(sessionKey);

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
    terminal.open(container);

    const instance: TerminalInstance = {
      terminal,
      fitAddon,
      shellId,
      dispose: () => {
        console.log("[TerminalManager] Disposing terminal for:", sessionKey);
        if (terminal.element?.isConnected) {
          try {
            terminal.dispose();
          } catch (e) {
            console.error("[TerminalManager] Error disposing terminal:", e);
          }
        }
      }
    };

    this.terminals.set(sessionKey, instance);
    console.log("[TerminalManager] Terminal created, total count:", this.terminals.size);

    return instance;
  }

  getTerminal(sessionKey: string): TerminalInstance | undefined {
    return this.terminals.get(sessionKey);
  }

  hasTerminal(sessionKey: string): boolean {
    const instance = this.terminals.get(sessionKey);
    return !!instance && instance.terminal.element?.isConnected === true;
  }

  disposeTerminal(sessionKey: string): void {
    const instance = this.terminals.get(sessionKey);
    if (instance) {
      console.log("[TerminalManager] Disposing terminal:", sessionKey);
      try {
        instance.dispose();
      } catch (e) {
        console.error("[TerminalManager] Error disposing:", e);
      }
      this.terminals.delete(sessionKey);
    }
  }

  disposeAll(): void {
    console.log("[TerminalManager] Disposing all terminals");
    for (const [key, instance] of this.terminals) {
      try {
        instance.dispose();
      } catch (e) {
        console.error("[TerminalManager] Error disposing:", e);
      }
    }
    this.terminals.clear();
  }
}

export const terminalManager = new TerminalManager();