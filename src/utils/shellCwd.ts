//! 终端 cwd 跟踪：对用户输入的 shell 命令行做轻量解析，模拟 cd/pushd/popd 等
//! 路径变更，供文件管理器联动。真实 shell 的别名/函数/脚本内 cd 无法覆盖，
//! 可通过 PNCWD 探针（printf 'PNCWD:%s\n' "$PWD"）校准。

export interface CwdState {
  cwd: string;
  /** 上一个目录，用于 cd - */
  previous: string;
  /** 目录栈，用于 pushd/popd */
  stack: string[];
  unknown: boolean;
}

export interface CwdEvalResult {
  cwd?: string;
  unknown?: boolean;
}

export const defaultHomePath = (username?: string): string => {
  if (!username) return "/";
  if (username === "root") return "/root";
  return `/home/${username}`;
};

/** 折叠 .、..、重复斜杠；保留绝对路径前缀 */
export function normalizeRemotePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) return "/" + joined;
  return joined || ".";
}

/** 解析 cd 目标：~ 展开、绝对路径、相对路径 */
export function resolveTarget(cwd: string, target: string, home: string): string {
  if (target === "~") return home;
  if (target.startsWith("~/")) return normalizeRemotePath(home + target.slice(1));
  if (target.startsWith("/")) return normalizeRemotePath(target);
  return normalizeRemotePath(cwd + "/" + target);
}

/** 在引号外按 &&、||、;、|、换行切分命令行链 */
export function splitChain(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n" || ch === "\r") {
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** 按空白切词，支持单/双引号与反斜杠转义 */
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of segment) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const NESTED_SHELLS = new Set([
  "bash", "zsh", "fish", "ksh", "tcsh", "dash", "su", "ssh", "mosh", "tmux", "screen",
]);
const CONTAINER_RUNNERS = new Set(["docker", "podman"]);

/**
 * 评估一行命令对 cwd 的影响。返回 null 表示无变化；
 * unknown=true 表示进入了无法跟踪的嵌套 shell，需暂停联动直至下次 cd 或探针校准。
 */
export function evaluateCommandLine(line: string, state: CwdState, home: string): CwdEvalResult | null {
  const segments = splitChain(line).filter(segment => !segment.includes("("));
  if (segments.length === 0) return null;

  let cwd = state.cwd;
  let previous = state.previous;
  const stack = [...state.stack];
  let changed = false;
  let unknown = false;

  const commit = (next: string) => {
    previous = cwd;
    cwd = normalizeRemotePath(next);
    changed = true;
  };

  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length === 0) continue;
    const [command, ...args] = tokens;

    if (NESTED_SHELLS.has(command)) {
      unknown = true;
      continue;
    }
    if (command === "sudo") {
      if (args.some(arg => arg === "-i" || arg === "-s") || NESTED_SHELLS.has(args[0] ?? "")) {
        unknown = true;
      }
      continue;
    }
    if (CONTAINER_RUNNERS.has(command)) {
      if (args.includes("exec") || args.includes("run") || args.includes("-it")) {
        unknown = true;
      }
      continue;
    }

    if (command === "cd") {
      if (args.length === 0) {
        commit(home);
      } else if (args.length === 1) {
        if (args[0] === "-") {
          if (previous) {
            const next = previous;
            previous = cwd;
            cwd = next;
            changed = true;
          }
        } else {
          commit(resolveTarget(cwd, args[0], home));
        }
      }
      continue;
    }
    if (command === "pushd") {
      if (args.length === 0) {
        if (stack.length > 0) {
          const top = stack.shift()!;
          stack.unshift(cwd);
          previous = cwd;
          cwd = top;
          changed = true;
        }
      } else if (args.length === 1 && !/^[+-]\d+$/.test(args[0])) {
        stack.unshift(cwd);
        commit(resolveTarget(cwd, args[0], home));
      }
      continue;
    }
    if (command === "popd") {
      if (args.length === 0 && stack.length > 0) {
        previous = cwd;
        cwd = stack.shift()!;
        changed = true;
      }
      continue;
    }
  }

  if (unknown) return { unknown: true };
  if (!changed) return null;
  state.cwd = cwd;
  state.previous = previous;
  state.stack = stack;
  return { cwd };
}

/**
 * 终端输入行缓冲：累积可打印字符，识别退格/整行清除等编辑键，
 * 在 Enter 时返回提交的命令行；转义序列（方向键、括号粘贴标记）被剥离。
 */
export class LineBuffer {
  private buffer = "";
  private escapeSeq = "";

  feed(data: string): string[] {
    const submitted: string[] = [];
    for (const ch of data) {
      if (this.escapeSeq) {
        this.escapeSeq += ch;
        const seq = this.escapeSeq;
        if (/^(\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[^\[\]])$/.test(seq)) {
          this.escapeSeq = "";
        }
        continue;
      }
      if (ch === "\x1b") {
        this.escapeSeq = "\x1b";
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const line = this.buffer;
        this.buffer = "";
        if (line.trim()) submitted.push(line);
        continue;
      }
      if (ch === "\x7f") {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }
      if (ch === "\x15" || ch === "\x0b" || ch === "\x03") {
        // Ctrl+U / Ctrl+K / Ctrl+C：清空当前行
        this.buffer = "";
        continue;
      }
      if (ch === "\x17") {
        // Ctrl+W：删除最后一个词
        const trimmed = this.buffer.replace(/\s+$/, "");
        const lastSpace = trimmed.lastIndexOf(" ");
        this.buffer = lastSpace === -1 ? "" : trimmed.slice(0, lastSpace + 1);
        continue;
      }
      if (ch >= " " || ch === "\t") this.buffer += ch;
    }
    return submitted;
  }

  reset() {
    this.buffer = "";
  }

  get current(): string {
    return this.buffer;
  }
}
