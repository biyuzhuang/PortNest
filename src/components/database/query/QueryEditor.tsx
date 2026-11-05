import { Component, For, Show, createSignal, onMount } from "solid-js";
import type { DatabaseAutocompleteItem } from "../../../utils/api";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "JOIN", "LEFT JOIN",
  "RIGHT JOIN", "INNER JOIN", "ON", "AND", "OR", "UNION", "UNION ALL",
  "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "EXPLAIN", "DESCRIBE", "SHOW TABLES",
  "COUNT", "SUM", "AVG", "MAX", "MIN", "AS", "ASC", "DESC", "NULL", "IS", "IN",
  "LIKE", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT",
];

const TOKEN = /(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|\\.|[^'])*')|(\b\d+(?:\.\d+)?\b)|(\b(?:SELECT|FROM|WHERE|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|UNION|ALL|CREATE|ALTER|DROP|TABLE|EXPLAIN|DESCRIBE|SHOW|TABLES|COUNT|SUM|AVG|MAX|MIN|AS|ASC|DESC|NULL|IS|NOT|IN|LIKE|BETWEEN|CASE|WHEN|THEN|ELSE|END|DISTINCT|WITH|PRIMARY|KEY|INDEX|DEFAULT|AUTO_INCREMENT|COMMENT|ENGINE|CHARSET|INT|BIGINT|VARCHAR|TEXT|DATETIME|TIMESTAMP|DECIMAL|BOOLEAN)\b)/gi;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 把 SQL 拆成带类名的 span；不做完整词法分析，但足以让关键字/字符串/注释可辨 */
const highlight = (sql: string) => {
  let result = "";
  let lastIndex = 0;
  for (const match of sql.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    result += escapeHtml(sql.slice(lastIndex, index));
    const [text, comment, string, number, keyword] = match;
    const kind = comment ? "is-comment" : string ? "is-string" : number ? "is-number" : keyword ? "is-keyword" : "";
    result += `<span class="${kind}">${escapeHtml(text)}</span>`;
    lastIndex = index + text.length;
  }
  result += escapeHtml(sql.slice(lastIndex));
  // 末尾补一个换行，避免最后一行空行塌陷
  return result + "\n";
};

type Props = {
  value: string;
  height: number;
  autocomplete: DatabaseAutocompleteItem[];
  onChange: (value: string) => void;
  onSelection: (selection: string) => void;
  onExecute: () => void;
};

export const QueryEditor: Component<Props> = props => {
  let textarea: HTMLTextAreaElement | undefined;
  let scroller: HTMLDivElement | undefined;

  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  const [popup, setPopup] = createSignal<{ top: number; left: number } | null>(null);
  const [cursorLine, setCursorLine] = createSignal(1);

  const lineCount = () => Math.max(1, props.value.split("\n").length);
  const lineHeight = 20;
  const charWidth = 7.85;
  const gutterWidth = 44;

  const caretPosition = () => {
    if (!textarea) return { line: 1, column: 0 };
    const before = props.value.slice(0, textarea.selectionStart ?? 0);
    const lines = before.split("\n");
    return { line: lines.length, column: lines[lines.length - 1].length };
  };

  const syncScroll = () => {
    if (!textarea || !scroller) return;
    scroller.scrollTop = textarea.scrollTop;
    scroller.scrollLeft = textarea.scrollLeft;
    const gutter = textarea.previousElementSibling as HTMLElement | null;
    if (gutter) gutter.scrollTop = textarea.scrollTop;
  };

  const updateSelection = () => {
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    props.onSelection(end > start ? props.value.slice(start, end) : "");
  };

  const hide = () => { setPopup(null); setSuggestions([]); };

  const refreshSuggestions = () => {
    if (!textarea) return;
    const position = textarea.selectionStart ?? 0;
    const before = props.value.slice(0, position);
    const prefix = (before.match(/[A-Za-z0-9_]*$/) || [""])[0];
    if (!prefix && !before.endsWith(".")) { hide(); return; }
    const tableMatch = before.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]*)$/);
    let candidates: string[];
    if (tableMatch) {
      const table = tableMatch[1].toLowerCase();
      candidates = props.autocomplete.filter(item => item.table.toLowerCase() === table).map(item => item.column);
    } else {
      const tables = Array.from(new Set(props.autocomplete.map(item => item.table)));
      const columns = Array.from(new Set(props.autocomplete.map(item => item.column)));
      candidates = [...tables, ...columns, ...KEYWORDS];
    }
    candidates = Array.from(new Set(candidates.filter(item => item.toLowerCase().startsWith(prefix.toLowerCase())))).slice(0, 18);
    if (candidates.length === 0) { hide(); return; }
    const caret = caretPosition();
    setCursorLine(caret.line);
    setSuggestions(candidates);
    setSuggestionIndex(0);
    setPopup({
      top: 8 + caret.line * lineHeight - (textarea.scrollTop || 0),
      left: gutterWidth + 12 + caret.column * charWidth - (textarea.scrollLeft || 0),
    });
  };

  const insertSuggestion = (value: string) => {
    if (!textarea) return;
    const position = textarea.selectionStart ?? 0;
    const before = props.value.slice(0, position);
    const after = props.value.slice(position);
    const prefixLength = (before.match(/[A-Za-z0-9_]*$/) || [""])[0].length;
    const next = before.slice(0, before.length - prefixLength) + value + " " + after;
    const nextPosition = before.length - prefixLength + value.length + 1;
    props.onChange(next);
    hide();
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(nextPosition, nextPosition); });
  };

  const indent = (outdent: boolean) => {
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const lineStart = props.value.lastIndexOf("\n", start - 1) + 1;
    const block = props.value.slice(lineStart, end);
    const shifted = outdent
      ? block.replace(/^ {1,2}/gm, "")
      : block.split("\n").map(line => "  " + line).join("\n");
    const next = props.value.slice(0, lineStart) + shifted + props.value.slice(end);
    props.onChange(next);
    requestAnimationFrame(() => {
      const delta = shifted.length - block.length;
      textarea?.setSelectionRange(start + (outdent ? 0 : 2), end + delta);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (popup() && suggestions().length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex(index => (index + 1) % suggestions().length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex(index => (index - 1 + suggestions().length) % suggestions().length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertSuggestion(suggestions()[suggestionIndex()]); return; }
      if (event.key === "Escape") { hide(); return; }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); props.onExecute(); return; }
    if (event.key === "F9") { event.preventDefault(); props.onExecute(); return; }
    if (event.key === "Tab") { event.preventDefault(); indent(event.shiftKey); return; }
    if (event.key === "Escape") hide();
  };

  onMount(() => {
    if (textarea) textarea.scrollTop = 0;
  });

  return (
    <div class="db-editor" style={{ height: `${props.height}px` }}>
      <div class="db-gutter" aria-hidden="true">
        <For each={Array.from({ length: lineCount() })}>{(_, index) => (
          <div class={cursorLine() === index() + 1 ? "is-current" : ""}>{index() + 1}</div>
        )}</For>
      </div>
      <div class="db-editor-scroll" ref={element => { scroller = element; }}>
        <pre class="db-code" aria-hidden="true" innerHTML={highlight(props.value) || "\n"} />
        <textarea
          ref={element => { textarea = element; }}
          class="db-code-input"
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          value={props.value}
          aria-label="SQL 编辑器"
          onInput={event => { props.onChange(event.currentTarget.value); updateSelection(); refreshSuggestions(); }}
          onScroll={syncScroll}
          onSelect={updateSelection}
          onMouseUp={updateSelection}
          onClick={refreshSuggestions}
          onKeyUp={refreshSuggestions}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(hide, 120)}
        />
      </div>
      <Show when={popup()}>
        <div class="db-autocomplete" style={{ top: `${popup()!.top}px`, left: `${popup()!.left}px` }}>
          <For each={suggestions()}>{(item, index) => (
            <button
              class={suggestionIndex() === index() ? "is-active" : ""}
              onMouseDown={event => { event.preventDefault(); insertSuggestion(item); }}
            >
              {item}
            </button>
          )}</For>
        </div>
      </Show>
    </div>
  );
};
