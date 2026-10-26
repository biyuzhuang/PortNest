import { Component, onMount, onCleanup, createEffect, on, createSignal, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { api, localShellDisplayName, parseLocalProfile, ConnectionRecord, SshApiError } from "../utils/api";
import { getTerminalThemeConfig, getTerminalSettings, getEffectiveTerminalBackgroundStyle, terminalBackgroundConfig, appearanceRevision, terminalSettingsRevision, terminalThemeRevision } from "../stores/themeStore";
import { loadTerminalBackgroundImage, terminalBackgroundImageUrl } from "../stores/terminalBackgroundStore";
import { sessionStore } from "../stores/sessionStore";
import { pathLinkStore } from "../stores/pathLinkStore";
import { LineBuffer, evaluateCommandLine, defaultHomePath, type CwdState } from "../utils/shellCwd";
import { Icon } from "./Icon";

interface TerminalViewProps {
  connection: ConnectionRecord;
  sessionKey?: string;
  visible?: boolean | (() => boolean);
  shellId?: string;
  onDisconnected?: (error?: unknown) => void;
  onEnded?: () => void;
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
  cwdState: CwdState;
  lineBuffer: LineBuffer;
  /** 立即执行一次 fit + resizeShell（绕过 ResizeObserver 防抖）。 */
  refit: () => void;
  /** Recompute command/path decorations for the visible viewport. */
  refreshHighlights: () => void;
  /** Dispose timers and decorations owned by the enhancement layer. */
  cleanupEnhancements: () => void;
}

const terminalStates = new Map<string, TerminalState>();

const isLightBackground = (style: string) => style === "solid_light";
const isLayerBackground = (style: string) => ["midnight", "aurora", "image"].includes(style);
const terminalCursorColors = (backgroundStyle: string, fallbackCursor: string, fallbackAccent: string) =>
  isLightBackground(backgroundStyle)
    ? { cursor: "#2563eb", cursorAccent: "#ffffff" }
    : { cursor: fallbackCursor, cursorAccent: fallbackAccent };

const PATH_TOKEN_PATTERN = /(^|[\s"'`([{:=])((?:~|\.{1,2})?\/[^\s"'`<>|]+|[A-Za-z]:\\[^\s"'`<>|]+)/g;
const COMMAND_TOKEN_PATTERN = /(^|[$#>❯]\s)([A-Za-z0-9_.\/~-]{1,80})(?=\s|$)/g;

type TerminalHighlightRange = { start: number; length: number; kind: "command" | "path" };

/** Find shell-command and path tokens without changing the terminal's input stream. */
function collectTerminalHighlightRanges(text: string): TerminalHighlightRange[] {
  const ranges: TerminalHighlightRange[] = [];
  const addRange = (start: number, rawToken: string, kind: TerminalHighlightRange["kind"]) => {
    const token = rawToken.replace(/[),.;:!?$]+$/, "");
    if (!token || start < 0) return;
    ranges.push({ start, length: token.length, kind });
  };

  for (const match of text.matchAll(PATH_TOKEN_PATTERN)) {
    const token = match[2];
    if (!token) continue;
    const start = match.index + match[0].lastIndexOf(token);
    const prefix = text.slice(Math.max(0, start - 8), start).toLowerCase();
    if (token.startsWith("//") || prefix.endsWith("http:") || prefix.endsWith("https:")) continue;
    addRange(start, token, "path");
  }
  for (const match of text.matchAll(COMMAND_TOKEN_PATTERN)) {
    const token = match[2];
    if (!token) continue;
    addRange(match.index + match[0].lastIndexOf(token), token, "command");
  }

  // Paths and commands can overlap; keep the first (usually most specific) range.
  ranges.sort((left, right) => left.start - right.start || right.length - left.length);
  const result: TerminalHighlightRange[] = [];
  for (const range of ranges) {
    if (result.some(existing => range.start < existing.start + existing.length && existing.start < range.start + range.length)) continue;
    result.push(range);
    if (result.length >= 160) break;
  }
  return result;
}

export function getTerminalState(sessionKey: string): TerminalState | undefined {
  return terminalStates.get(sessionKey);
}

/** Return the visible terminal scrollback as plain text for AI context. */
/** Return the current terminal selection for AI context. */
export function readTerminalSelection(sessionKey: string): string {
  const state = terminalStates.get(sessionKey);
  return state ? state.terminal.getSelection().trim() : "";
}

export function readTerminalTranscript(sessionKey: string, maxLines = 160): string {
  const state = terminalStates.get(sessionKey);
  if (!state) return "";
  const buffer = state.terminal.buffer.active;
  const start = Math.max(0, buffer.length - Math.max(1, maxLines));
  const lines: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").trim();
}

export function hasTerminalState(sessionKey: string): boolean {
  const state = terminalStates.get(sessionKey);
  return !!state && state.terminal.element?.isConnected === true;
}

/** 面板布局变化（如服务器概览开合）后立即重适配终端，不依赖 ResizeObserver 防抖。 */
export function refitTerminal(sessionKey: string) {
  const state = terminalStates.get(sessionKey);
  if (state) state.refit();
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
    state.cleanupEnhancements();
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
  const [terminalSettingsSnapshot, setTerminalSettingsSnapshot] = createSignal(getTerminalSettings());
  const [terminalRowHeight, setTerminalRowHeight] = createSignal(20);
  const stripedBackground = () => terminalSettingsSnapshot().stripedBackground;
  const highlightEnhancement = () => terminalSettingsSnapshot().highlightEnhancement;

  const isVisible = () => {
    if (typeof props.visible === "function") {
      return props.visible();
    }
    return !!props.visible;
  };
  const isLocal = () => props.connection.protocol === "local";
  const effectiveBackgroundStyle = () => getEffectiveTerminalBackgroundStyle(terminalBackgroundConfig());

  const updateTerminalRowHeight = (state: TerminalState) => {
    const screen = state.terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const screenHeight = screen?.getBoundingClientRect().height ?? 0;
    if (screenHeight > 0 && state.terminal.rows > 0) {
      setTerminalRowHeight(Number((screenHeight / state.terminal.rows).toFixed(3)));
    }
  };

  // 终端 fit：窗口/面板尺寸变化时只调整列数与行数（并同步远端 PTY 的
  // TIOCGWINSZ），字号保持用户设置不变，最大化/还原窗口不改变字体大小。
  const doFit = (state: TerminalState) => {
    try {
      const container = containerRef;
      if (state.terminal.element?.isConnected && container && container.offsetWidth > 0 && container.offsetHeight > 0) {
        const prevCols = state.terminal.cols;
        const prevRows = state.terminal.rows;
        state.fitAddon.fit();
        const cols = state.terminal.cols;
        const rows = state.terminal.rows;
        updateTerminalRowHeight(state);
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
      existingState.cleanupEnhancements();
      terminalStates.delete(sessionKey);
    }

    const themeConfig = getTerminalThemeConfig();
    const backgroundStyle = effectiveBackgroundStyle();
    const backgroundConfig = terminalBackgroundConfig();
    const settings = getTerminalSettings();
    const terminalBackground = isLayerBackground(backgroundStyle) || settings.stripedBackground
      ? "#00000000"
      : backgroundStyle === "solid_light" ? "#ffffff"
      : backgroundStyle === "solid_dark" ? "#1e1e1e"
      : backgroundStyle === "solid" ? backgroundConfig.solidColor
      : themeConfig.background;
    const terminalForeground = isLightBackground(backgroundStyle)
      ? "#111827"
      : themeConfig.foreground;
    const cursorColors = terminalCursorColors(
      backgroundStyle,
      themeConfig.cursor,
      themeConfig.cursorAccent,
    );

    const terminal = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      minimumContrastRatio: settings.highlightEnhancement ? 4.5 : 1,
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

    let highlightTimer: number | null = null;
    const highlightDecorations: Array<{ dispose: () => void }> = [];
    const clearHighlights = () => {
      for (const decoration of highlightDecorations.splice(0)) {
        try { decoration.dispose(); } catch (_) {}
      }
    };
    const refreshHighlights = () => {
      clearHighlights();
      if (!getTerminalSettings().highlightEnhancement || !terminal.element?.isConnected) return;
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal") return;
      const theme = getTerminalThemeConfig();
      const cursorLine = buffer.baseY + buffer.cursorY;
      for (let row = 0; row < terminal.rows; row += 1) {
        const lineIndex = buffer.viewportY + row;
        const line = buffer.getLine(lineIndex);
        if (!line) continue;
        const text = line.translateToString(true);
        if (!text) continue;
        for (const range of collectTerminalHighlightRanges(text)) {
          if (range.start >= terminal.cols) continue;
          try {
            const marker = terminal.registerMarker(lineIndex - cursorLine);
            if (!marker) continue;
            const decoration = terminal.registerDecoration({
              marker,
              x: range.start,
              width: Math.max(1, Math.min(range.length, terminal.cols - range.start)),
              foregroundColor: range.kind === "path" ? theme.blue : theme.cyan,
              layer: "top",
            });
            if (decoration) highlightDecorations.push(decoration);
            else marker.dispose();
          } catch (error) {
            console.warn("[TerminalView] highlight decoration failed:", error);
          }
        }
      }
    };
    const scheduleHighlightRefresh = () => {
      if (highlightTimer !== null) window.clearTimeout(highlightTimer);
      highlightTimer = window.setTimeout(() => {
        highlightTimer = null;
        refreshHighlights();
      }, 80);
    };
    const onWriteParsedDisposable = terminal.onWriteParsed(scheduleHighlightRefresh);
    const onScrollDisposable = terminal.onScroll(scheduleHighlightRefresh);

    let readTimer: number | null = null;
    let stopped = false;
    let disconnectHandled = false;

    const handleShellFailure = (error: unknown) => {
      if (disconnectHandled || stopped) return;
      const normalRemoteEnd = error instanceof SshApiError
        && error.code === "REMOTE_CLOSED"
        && /远端\s*Shell\s*已关闭|remote\s+shell\s+(?:was\s+)?closed/i.test(error.message);
      if (normalRemoteEnd) {
        disconnectHandled = true;
        stopped = true;
        props.onEnded?.();
        return;
      }
      disconnectHandled = true;
      console.error("[TerminalView] SSH session disconnected:", error);
      terminal.writeln("");
      terminal.writeln("\x1b[1;31m连接已中断，请重新连接。\x1b[0m");
      if (getTerminalSettings().reconnectOnDisconnect) terminal.writeln("\x1b[33m正在尝试自动重连…\x1b[0m");
      props.onDisconnected?.(error);
    };

    // 跨数据块累积 shell 输出并按行解析 PNCWD 探针结果，避免输出被分块拆散
    let cwdOutputBuffer = "";
    const parseCwdOutput = (chunk: string) => {
      cwdOutputBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = cwdOutputBuffer.indexOf("\n")) >= 0) {
        const line = cwdOutputBuffer.slice(0, newlineIndex);
        cwdOutputBuffer = cwdOutputBuffer.slice(newlineIndex + 1);
        const clean = line.replace(/\r$/, "");
        const markerIndex = clean.indexOf("PNCWD=");
        if (markerIndex >= 0) {
          const value = clean.slice(markerIndex + "PNCWD=".length).trim();
          if (value.startsWith("/")) {
            pathLinkStore.setCwd(sessionKey, value);
            const currentState = terminalStates.get(sessionKey);
            if (currentState) {
              currentState.cwdState.cwd = value;
              currentState.cwdState.unknown = false;
            }
            console.info("[TerminalView] PNCWD 探针结果:", value);
          }
        }
      }
      // 防止无换行的长输出（如 \r 进度条）导致缓冲无限增长
      if (cwdOutputBuffer.length > 4096) {
        cwdOutputBuffer = cwdOutputBuffer.slice(-1024);
      }
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
        const writeData = data ? handleTerminalQueries(data) : "";
        if (data && !isLocal()) {
          parseCwdOutput(data);
        }
        if (writeData && terminal.element?.isConnected) {
          // Wait until xterm has parsed this batch. This provides backpressure for
          // very large output and ensures terminal query replies are emitted before
          // the next batch is fetched. A parser crash (e.g. a DECRQM handler bug)
          // can leave the write callback pending forever; guard with a watchdog so
          // the terminal recovers instead of freezing the whole session.
          const writeDone = new Promise<void>((resolve) => terminal.write(writeData, resolve));
          let watchdogHandle: number | undefined;
          const watchdog = new Promise<"timeout">((resolve) => {
            watchdogHandle = window.setTimeout(() => resolve("timeout"), 4000);
          });
          const raceResult = await Promise.race([writeDone, watchdog]);
          if (watchdogHandle !== undefined) window.clearTimeout(watchdogHandle);
          if (raceResult === "timeout") {
            console.error("[TerminalView] xterm write stalled, resetting terminal:", sessionKey);
            try {
              terminal.reset();
            } catch (resetError) {
              console.error("[TerminalView] terminal.reset failed:", resetError);
            }
          }
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

    if (isLocal()) {
      terminal.writeln(`\x1b[32m本机终端 · ${localShellDisplayName(parseLocalProfile(props.connection.options).shell_type)}\x1b[0m`);
      terminal.writeln("");
    }

    const sendData = (data: string) => {
      return sessionStore.sendText(sessionKey, data).catch(error => {
        handleShellFailure(error);
        throw error;
      });
    };

    // ConPTY 下的 cmd / PowerShell 等控制台程序启动时会发送 DSR（CSI 6n）
    // 光标位置查询并阻塞等待应答（bash/vim 等还可能发送 DA 查询）。xterm.js
    // 内部解析器理论上会自动应答，但依赖解析器健康——压缩/二次构建破坏解析器
    // 时会出现应答丢失、write 回调永不执行、终端永久空白。因此对本地终端在
    // 写入 xterm 前显式摘除这些查询并直接应答，握手不再依赖解析器。
    let localQueryBuffer = "";
    const handleTerminalQueries = (data: string): string => {
      if (!isLocal()) return data;
      localQueryBuffer += data;

      const cursorReply = () => {
        try {
          const buffer = terminal.buffer.active;
          return `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}R`;
        } catch {
          return "\x1b[1;1R";
        }
      };
      const queries = [
        { seq: "\x1b[?6n", reply: () => `\x1b[?${cursorReply().slice(2)}` },
        { seq: "\x1b[6n", reply: cursorReply },
        { seq: "\x1b[?c", reply: () => "\x1b[?1;2c" },
        { seq: "\x1b[c", reply: () => "\x1b[?1;2c" },
      ];

      let cleaned = "";
      let pending = localQueryBuffer;
      while (true) {
        let earliest: { index: number; seq: string; reply: () => string } | null = null;
        for (const query of queries) {
          const index = pending.indexOf(query.seq);
          if (index >= 0 && (earliest === null || index < earliest.index)) {
            earliest = { index, seq: query.seq, reply: query.reply };
          }
        }
        if (earliest === null) break;
        cleaned += pending.slice(0, earliest.index);
        void sendData(earliest.reply());
        pending = pending.slice(earliest.index + earliest.seq.length);
      }

      // 只保留可能是查询序列前缀的尾部（如 "\x1b"、"\x1b["、"[\x1b[?6"），
      // 其余内容全部输出，避免把完整 OSC（如以 ESC \ 结尾）等误留在缓冲里
      const sequences = ["\x1b[?6n", "\x1b[6n", "\x1b[?c", "\x1b[c"];
      let keep = 0;
      for (let length = Math.min(pending.length, 4); length >= 1; length--) {
        const tail = pending.slice(pending.length - length);
        if (sequences.some(sequence => sequence.startsWith(tail) && sequence.length > tail.length)) {
          keep = length;
          break;
        }
      }
      localQueryBuffer = pending.slice(pending.length - keep);
      cleaned += pending.slice(0, pending.length - keep);
      return cleaned;
    };

    const cwdState: CwdState = {
      cwd: defaultHomePath(props.connection.username),
      previous: defaultHomePath(props.connection.username),
      stack: [],
      unknown: false,
    };
    const lineBuffer = new LineBuffer();

    terminal.onData((data) => {
      // 捕获输入命令，模拟 cd/pushd/popd 等路径变更，供文件管理器联动
      // 本地终端无文件管理面板，跳过路径跟踪
      if (!isLocal()) {
        const current = terminalStates.get(sessionKey);
        if (current) {
          const submitted = current.lineBuffer.feed(data);
          for (const line of submitted) {
            const result = evaluateCommandLine(line, current.cwdState, defaultHomePath(current.connection.username));
            if (result?.unknown) {
              pathLinkStore.setUnknown(sessionKey);
              console.info("[TerminalView] cwd 未知（进入嵌套 shell）:", line);
            } else if (result?.cwd) {
              pathLinkStore.setCwd(sessionKey, result.cwd);
              console.info("[TerminalView] cwd 更新:", line, "→", result.cwd);
            }
          }
        }
      }
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
      refreshHighlights,
      cleanupEnhancements: () => {
        if (highlightTimer !== null) window.clearTimeout(highlightTimer);
        highlightTimer = null;
        onWriteParsedDisposable.dispose();
        onScrollDisposable.dispose();
        clearHighlights();
      },
      resizeObserver,
      initialized: true,
      contentWritten: true,
      connection: props.connection,
      cwdState,
      lineBuffer,
      refit: () => doFit(state),
    };

    terminalStates.set(sessionKey, state);
    scheduleHighlightRefresh();
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
    const style = effectiveBackgroundStyle();
    const backgroundConfig = terminalBackgroundConfig();
    appearanceRevision();
    if (style === "image") void loadTerminalBackgroundImage(backgroundConfig.imageAssetId);
    terminalSettingsRevision();
    terminalThemeRevision();
    const settings = getTerminalSettings();
    setTerminalSettingsSnapshot(settings);
    const state = props.sessionKey ? terminalStates.get(props.sessionKey) : undefined;
    if (!state) return;
    const theme = getTerminalThemeConfig();
    const cursorColors = terminalCursorColors(style, theme.cursor, theme.cursorAccent);
    state.terminal.options.theme = {
      ...theme,
      background: isLayerBackground(style) || settings.stripedBackground ? "#00000000"
        : style === "solid_light" ? "#ffffff"
        : style === "solid_dark" ? "#1e1e1e"
        : style === "solid" ? backgroundConfig.solidColor
        : theme.background,
      foreground: isLightBackground(style) ? "#111827" : theme.foreground,
      cursor: cursorColors.cursor,
      cursorAccent: cursorColors.cursorAccent,
    };
    state.terminal.options.minimumContrastRatio = settings.highlightEnhancement ? 4.5 : 1;
    state.terminal.options.fontFamily = settings.fontFamily;
    state.terminal.options.fontSize = settings.fontSize;
    state.terminal.options.lineHeight = settings.lineHeight;
    state.terminal.options.letterSpacing = settings.letterSpacing;
    state.terminal.options.scrollback = settings.scrollback;
    state.refreshHighlights();
    // Let theme/background classes settle before xterm measures its canvas.
    window.requestAnimationFrame(() => {
      if (state.terminal.element?.isConnected) doFit(state);
    });
  });

  onMount(() => {
    console.log("[TerminalView] onMount:", props.sessionKey);
    const vis = isVisible();
    const shellId = props.shellId;
    const sessionKey = props.sessionKey;
    void loadTerminalBackgroundImage(terminalBackgroundConfig().imageAssetId);

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
        state.cleanupEnhancements();
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
    <div class={`terminal-view terminal-background-${effectiveBackgroundStyle()}${stripedBackground() ? " terminal-striped" : ""}${highlightEnhancement() ? " terminal-highlight-enhanced" : ""}`} style={{
      "--terminal-solid": effectiveBackgroundStyle() === "theme" ? getTerminalThemeConfig().background
        : effectiveBackgroundStyle() === "solid_light" ? "#ffffff"
        : effectiveBackgroundStyle() === "solid_dark" ? "#1e1e1e"
        : terminalBackgroundConfig().solidColor,
      "--terminal-image": terminalBackgroundImageUrl() ? `url("${terminalBackgroundImageUrl()}")` : "none",
      "--terminal-image-size": terminalBackgroundConfig().imageFit === "fill" ? "100% 100%" : terminalBackgroundConfig().imageFit,
      "--terminal-image-opacity": String(terminalBackgroundConfig().imageOpacity),
      "--terminal-image-overlay": String(terminalBackgroundConfig().imageOverlay),
      "--terminal-image-blur": `${terminalBackgroundConfig().imageBlur}px`,
      "--terminal-row-height": `${terminalRowHeight()}px`,
    }}>
      <div class="terminal-background-layer" aria-hidden="true" />
      <div class="terminal-stripes" aria-hidden="true" />
      <Show when={showSearch()}>
        <div class="terminal-search-bar">
          <input ref={searchInputRef} value={searchTerm()} placeholder="搜索终端输出" onInput={event => { setSearchTerm(event.currentTarget.value); search(); }} onKeyDown={event => {
            if (event.key === "Enter") search(event.shiftKey);
            if (event.key === "Escape") { setShowSearch(false); terminalStates.get(props.sessionKey || "")?.terminal.focus(); }
          }} />
          <button onClick={() => search(true)} title="上一个"><Icon name="chevronUp" size={14} /></button><button onClick={() => search(false)} title="下一个"><Icon name="chevronDown" size={14} /></button>
          <button onClick={() => setShowSearch(false)} title="关闭"><Icon name="close" size={14} /></button>
        </div>
      </Show>
      <div ref={containerRef} class="terminal-container" />
    </div>
  );
};

export type TerminalHandle = {
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
};
