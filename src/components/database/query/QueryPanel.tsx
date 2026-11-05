import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type ConnectionRecord, type DatabaseAutocompleteItem, type DatabaseExplainResult } from "../../../utils/api";
import { feedback } from "../../../stores/feedbackStore";
import { aiContextStore } from "../../../stores/aiContextStore";
import { formatSql } from "../../../utils/sqlFormat";
import { Icon } from "../../Icon";
import type { QueryTab } from "../types";
import { QueryToolbar } from "./QueryToolbar";
import { QueryEditor } from "./QueryEditor";
import { ResultTabs } from "./ResultTabs";

type SavedQuery = { sql: string; database: string; savedAt: number };

const historyKey = (protocol: string) => `portnest.database.${protocol}.queryHistory`;
const favoritesKey = (protocol: string) => `portnest.database.${protocol}.queryFavorites`;

const loadSavedQueries = (key: string): SavedQuery[] => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as SavedQuery[]) : []; }
  catch { return []; }
};
const persistSavedQueries = (key: string, items: SavedQuery[]) => {
  try { localStorage.setItem(key, JSON.stringify(items.slice(0, 100))); } catch { /* 配额满时静默失败 */ }
};
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, " ");
const isReadOnlySql = (sql: string) => {
  const value = stripSqlComments(sql).trim().toUpperCase();
  if (/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/.test(value)) return true;
  if (value.startsWith("WITH ")) return !/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/.test(value);
  return false;
};
/** 去掉注释与字面量后再按分号切，避免把字符串里的 ; 当成语句分隔符 */
const statementHeads = (sql: string) => {
  const masked = stripSqlComments(sql)
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/`[^`]*`/g, "``");
  return masked.split(";").map(item => item.trim()).filter(Boolean);
};

const summarizeStatement = (sql: string) => {
  const text = stripSqlComments(sql).replace(/\s+/g, " ").trim();
  return text.length > 72 ? text.slice(0, 72) + "…" : text || "（空语句）";
};

const isDangerousSql = (sql: string) => {
  const value = stripSqlComments(sql).trim().toUpperCase();
  if (/^(DROP|TRUNCATE|ALTER|RENAME|GRANT|REVOKE|CREATE)\b/.test(value)) return true;
  if (/^DELETE\b/.test(value) && !/\bWHERE\b/.test(value)) return true;
  if (/^UPDATE\b/.test(value) && !/\bWHERE\b/.test(value)) return true;
  return false;
};

const HEIGHT_KEY = "portnest.database.editorHeight";

type Props = {
  tab: QueryTab;
  connection: ConnectionRecord;
  databases: Array<{ name: string }>;
  readOnly: boolean;
  running: boolean;
  onPatch: (patch: Partial<QueryTab>) => void;
  onExecute: (sql?: string) => void;
  onStop: () => void;
  onToggleReadOnly: () => void;
};

export const QueryPanel: Component<Props> = props => {
  const [selectedSql, setSelectedSql] = createSignal("");
  const [autocomplete, setAutocomplete] = createSignal<DatabaseAutocompleteItem[]>([]);
  const [history, setHistory] = createSignal<SavedQuery[]>(loadSavedQueries(historyKey(props.connection.protocol)));
  const [favorites, setFavorites] = createSignal<SavedQuery[]>(loadSavedQueries(favoritesKey(props.connection.protocol)));
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [favoritesOpen, setFavoritesOpen] = createSignal(false);
  const [height, setHeight] = createSignal(readHeight(props.tab.id));
  const [pane, setPane] = createSignal<"result" | "messages" | "profile" | "plan">("result");
  const [messages, setMessages] = createSignal<string[]>([]);
  const [explain, setExplain] = createSignal<DatabaseExplainResult | null>(null);
  const [explaining, setExplaining] = createSignal(false);
  let loadedDatabase = "";

  onCleanup(() => aiContextStore.setSQLSelection(""));

  createEffect(() => {
    const database = props.tab.database;
    if (database === loadedDatabase) return;
    loadedDatabase = database;
    if (!database) { setAutocomplete([]); return; }
    void api.databaseAutocomplete(props.connection.id, database).then(setAutocomplete).catch(() => setAutocomplete([]));
  });

  // 整批没跑起来时也要留一条可读的错误，否则界面上什么都看不到
  let lastError = "";
  createEffect(() => {
    const outcomes = props.tab.results ?? [];
    if (outcomes.length === 0) {
      const error = props.tab.stats?.error;
      if (error && error !== lastError) {
        lastError = error;
        setMessages(current => [`错误：${error}`, ...current].slice(0, 50));
        setPane("messages");
      }
      return;
    }
    lastError = "";
    const rolledBack = props.tab.batch?.transaction === "rolled_back"
      || props.tab.batch?.transaction === "rollback_failed";
    const lines = outcomes.map(item => {
      const label = `#${item.index} ${summarizeStatement(item.statement)}`;
      if (item.error) return `错误：${label} — ${item.error}`;
      const result = item.result;
      const detail = result && result.columns.length > 0 ? `返回 ${result.rows.length} 行` : `影响 ${result?.affected_rows ?? 0} 行`;
      // 回滚后不能再写「成功」，否则和「前面的语句均未生效」自相矛盾
      return `${rolledBack ? "已回滚" : "成功"}：${label} — ${detail}，耗时 ${item.duration_ms} ms`;
    });
    // 事务结果单独提示：回滚意味着前面的「成功」其实没有落库
    const batch = props.tab.batch;
    if (batch?.transaction === "rolled_back" || batch?.transaction === "rollback_failed") {
      const notice = batch.transaction === "rollback_failed"
        ? "错误：批次执行失败且回滚也失败，请立即人工检查数据"
        : batch.partial
          ? "警告：批次已回滚，但其中包含 DDL（隐式提交），那部分已生效"
          : "警告：批次执行失败，已回滚，前面的语句均未生效";
      lines.unshift(notice);
    }
    setMessages(current => [...lines.reverse(), ...current].slice(0, 50));
    // 有失败就跳到消息页：失败原因比空结果更值得先看到
    if (outcomes.some(item => item.error)) setPane("messages");
    else if (outcomes.some(item => item.result && item.result.columns.length > 0)) setPane("result");
  });

  // 结果序号存在标签上，切走再切回仍停在同一条
  const activeResult = () => props.tab.activeResult ?? 1;

  const currentSql = () => selectedSql().trim() ? selectedSql() : props.tab.sql;

  const execute = async () => {
    const sql = currentSql().trim();
    if (!sql) { feedback.info("请输入 SQL"); return; }
    const heads = statementHeads(sql);
    if (props.readOnly && heads.some(item => !isReadOnlySql(item))) {
      feedback.error("当前处于只读模式，只允许执行 SELECT / SHOW / DESCRIBE / EXPLAIN");
      return;
    }
    if (heads.some(isDangerousSql) && !await feedback.confirm("检测到高风险 SQL，可能修改或删除表结构/数据。确定继续执行吗？", "高风险 SQL")) return;
    recordHistory(sql);
    props.onExecute(selectedSql().trim() ? selectedSql() : undefined);
  };

  const recordHistory = (sql: string) => {
    const entry: SavedQuery = { sql, database: props.tab.database, savedAt: Date.now() };
    const next = [entry, ...history().filter(item => item.sql !== sql)].slice(0, 100);
    setHistory(next);
    persistSavedQueries(historyKey(props.connection.protocol), next);
  };

  const beautify = () => props.onPatch({ sql: formatSql(props.tab.sql), dirty: true });

  const toggleComment = () => {
    const sql = currentSql();
    const prefix = "-- ";
    const commented = sql.split("\n").every(line => line.trim() === "" || line.startsWith(prefix));
    const next = sql.split("\n").map(line => {
      if (line.trim() === "") return line;
      return commented ? line.replace(/^--\s?/, "") : prefix + line;
    }).join("\n");
    props.onPatch({ sql: next, dirty: true });
  };

  const saveSql = async () => {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await save({ title: "保存 SQL", defaultPath: "query-" + stamp + ".sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (typeof path !== "string") return;
    try { await api.databaseSaveSql(path, props.tab.sql); feedback.success("SQL 已保存"); }
    catch (cause) { feedback.error("保存 SQL 失败：" + String(cause)); }
  };

  const applySaved = (sql: string) => {
    props.onPatch({ sql, dirty: true });
    setHistoryOpen(false);
    setFavoritesOpen(false);
  };

  const toggleFavorite = () => {
    const sql = currentSql().trim();
    if (!sql) { feedback.info("当前没有可收藏的 SQL"); return; }
    const existing = favorites().find(item => item.sql === sql);
    const next = existing ? favorites().filter(item => item.sql !== sql) : [{ sql, database: props.tab.database, savedAt: Date.now() }, ...favorites()];
    setFavorites(next);
    persistSavedQueries(favoritesKey(props.connection.protocol), next);
    feedback.success(existing ? "已取消收藏" : "已收藏当前 SQL");
  };

  const runExplain = async () => {
    const sql = currentSql().trim();
    if (!sql) { feedback.info("请输入 SQL"); return; }
    setExplaining(true);
    setPane("plan");
    try { setExplain(await api.databaseExplainSql(props.connection.id, sql, props.tab.database || undefined)); }
    catch (cause) { feedback.error("获取执行计划失败：" + String(cause)); }
    finally { setExplaining(false); }
  };

  const beginResize = (event: PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height();
    const move = (moveEvent: PointerEvent) => setHeight(Math.min(720, Math.max(120, startHeight + moveEvent.clientY - startY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      writeHeight(props.tab.id, height());
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section class="db-query">
      <QueryToolbar
        database={props.tab.database}
        databases={props.databases}
        hasSelection={selectedSql().trim().length > 0}
        running={props.running}
        readOnly={props.readOnly}
        historyOpen={historyOpen()}
        favoritesOpen={favoritesOpen()}
        explaining={explaining()}
        onDatabaseChange={database => props.onPatch({ database, dirty: true })}
        onRun={() => void execute()}
        onStop={() => props.onStop()}
        onBeautify={beautify}
        onComment={toggleComment}
        onExplain={() => void runExplain()}
        onSave={() => void saveSql()}
        onToggleHistory={() => { setHistoryOpen(value => !value); setFavoritesOpen(false); }}
        onToggleFavorites={() => { setFavoritesOpen(value => !value); setHistoryOpen(false); }}
        onToggleReadOnly={() => props.onToggleReadOnly()}
        onOpenAgent={() => aiContextStore.openAgent("sql")}
      />

      <Show when={historyOpen() || favoritesOpen()}>
        <div class="db-query-list" role="dialog" aria-label={historyOpen() ? "查询历史" : "收藏的 SQL"}>
          <header>
            <strong>{historyOpen() ? "查询历史" : "收藏的 SQL"}</strong>
            <span class="db-toolbar-spacer" />
            <button class="db-icon-btn" aria-label="关闭" onClick={() => { setHistoryOpen(false); setFavoritesOpen(false); }}>
              <Icon name="close" size={12} />
            </button>
          </header>
          <For each={historyOpen() ? history() : favorites()} fallback={<p class="db-query-list-empty">还没有记录</p>}>{item => (
            <button class="db-query-list-item" onClick={() => applySaved(item.sql)}>
              <span>{item.sql.slice(0, 200)}</span>
              <small>{item.database || "未选择数据库"} · {new Date(item.savedAt).toLocaleString()}</small>
            </button>
          )}</For>
          <Show when={historyOpen()}>
            <footer>
              <button class="db-text-btn" onClick={toggleFavorite}>收藏当前 SQL</button>
            </footer>
          </Show>
        </div>
      </Show>

      <QueryEditor
        value={props.tab.sql}
        height={height()}
        autocomplete={autocomplete()}
        onChange={value => props.onPatch({ sql: value, dirty: true })}
        onSelection={setSelectedSql}
        onExecute={() => void execute()}
      />

      <div
        class="db-hsplit"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整编辑器高度"
        tabIndex={0}
        onPointerDown={beginResize}
        onDblClick={() => { setHeight(324); writeHeight(props.tab.id, 324); }}
        onKeyDown={event => {
          if (event.key === "ArrowUp") { setHeight(value => Math.max(120, value - 24)); }
          if (event.key === "ArrowDown") { setHeight(value => Math.min(720, value + 24)); }
        }}
      >
        <span />
      </div>

      <ResultTabs
        active={pane()}
        onActive={setPane}
        results={props.tab.results ?? []}
        batch={props.tab.batch ?? null}
        activeResult={activeResult()}
        onActiveResult={index => props.onPatch({ activeResult: index })}
        stats={props.tab.stats ?? null}
        messages={messages()}
        running={props.running}
        explain={explain()}
        explaining={explaining()}
        onExplain={() => void runExplain()}
      />
    </section>
  );
};

const readHeight = (tabId: string) => {
  const value = Number(localStorage.getItem(`${HEIGHT_KEY}.${tabId}`) || localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(value) && value >= 120 && value <= 720 ? value : 324;
};
const writeHeight = (tabId: string, value: number) => {
  localStorage.setItem(HEIGHT_KEY, String(Math.round(value)));
  localStorage.setItem(`${HEIGHT_KEY}.${tabId}`, String(Math.round(value)));
};
