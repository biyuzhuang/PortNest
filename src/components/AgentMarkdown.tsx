import { Component, For, Show, createSignal } from "solid-js";

interface AgentMarkdownProps {
  content: string;
  onApplySql?: (sql: string) => void;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; language: string; code: string }
  | { kind: "divider" };

const splitTableRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

const isTableSeparator = (line: string) => {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
};

const parseAgentMarkdown = (content: string): Block[] => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", language, code: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim() || /^(#{1,4})\s+/.test(next) || /^\s*([-*]|\d+\.)\s+/.test(next) || next.trim().startsWith("```")) break;
      if (next.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
};

const InlineText: Component<{ text: string }> = props => {
  const segments = () => props.text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return <For each={segments()}>{segment => {
    if (segment.startsWith("**") && segment.endsWith("**")) return <strong>{segment.slice(2, -2)}</strong>;
    if (segment.startsWith("`") && segment.endsWith("`")) return <code class="agent-inline-code">{segment.slice(1, -1)}</code>;
    return <>{segment}</>;
  }}</For>;
};

const AgentCodeBlock: Component<{ language: string; code: string; onApplySql?: (sql: string) => void }> = props => {
  const [copied, setCopied] = createSignal(false);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  const canApplySql = () => props.language.toLowerCase() === "sql" && Boolean(props.onApplySql);
  return (
    <div class="agent-code-card">
      <header>
        <span>{props.language || "text"}</span>
        <div>
          <Show when={canApplySql()}>
            <button onClick={() => props.onApplySql?.(props.code)}>应用到编辑器</button>
          </Show>
          <button onClick={() => void copyCode()}>{copied() ? "已复制" : "复制"}</button>
        </div>
      </header>
      <pre><code>{props.code}</code></pre>
    </div>
  );
};

export const AgentMarkdown: Component<AgentMarkdownProps> = props => {
  const blocks = () => parseAgentMarkdown(props.content);
  return (
    <div class="agent-markdown">
      <For each={blocks()}>{block => {
        if (block.kind === "heading") {
          if (block.level === 1) return <h1><InlineText text={block.text} /></h1>;
          if (block.level === 2) return <h2><InlineText text={block.text} /></h2>;
          if (block.level === 3) return <h3><InlineText text={block.text} /></h3>;
          return <h4><InlineText text={block.text} /></h4>;
        }
        if (block.kind === "code") return <AgentCodeBlock language={block.language} code={block.code} onApplySql={props.onApplySql} />;
        if (block.kind === "table") return (
          <div class="agent-table-wrap">
            <table class="agent-table">
              <thead><tr><For each={block.headers}>{header => <th><InlineText text={header} /></th>}</For></tr></thead>
              <tbody><For each={block.rows}>{row => <tr><For each={block.headers}>{(_header, index) => <td><InlineText text={row[index()] || ""} /></td>}</For></tr>}</For></tbody>
            </table>
          </div>
        );
        if (block.kind === "list") {
          return block.ordered
            ? <ol class="agent-list"><For each={block.items}>{item => <li><InlineText text={item} /></li>}</For></ol>
            : <ul class="agent-list"><For each={block.items}>{item => <li><InlineText text={item} /></li>}</For></ul>;
        }
        if (block.kind === "divider") return <hr class="agent-divider" />;
        return <p class="agent-paragraph"><InlineText text={block.text} /></p>;
      }}</For>
    </div>
  );
};
