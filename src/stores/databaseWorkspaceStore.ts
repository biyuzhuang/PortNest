import { createSignal } from "solid-js";
import type { DatabaseCharsetInfo, DatabaseColumnInfo, DatabaseIndexInfo, DatabaseTableInfo } from "../utils/api";
import {
  emptyFilterSpec,
  emptyPending,
  primaryKeyColumns,
  type ContextMenuState,
  type DatabaseTab,
  type QueryTab,
  type SortOrder,
  type TableSection,
  type TableTab,
  type WorkspaceTab,
} from "../components/database/types";

/**
 * 工作区状态按 connectionId 分片。
 *
 * 为什么不用 createStore：标签页里嵌着 QueryResult 与用户草稿，deep proxy 会让
 * `<For>` 的引用比较失效；信号 + 不可变替换的行为更可预测。为什么不放在组件里：
 * `App.tsx` 每个会话各持一个 DatabaseWorkspace 实例，切换会话时组件会被重建，
 * 放在模块级 Map 里才能保住「切走再切回，未提交的编辑还在」。
 */
export type WorkspaceState = {
  databases: () => Array<{ name: string; charset?: string; collation?: string }>;
  setDatabases: (value: Array<{ name: string; charset?: string; collation?: string }>) => void;
  tables: () => Record<string, DatabaseTableInfo[]>;
  setTables: (updater: (previous: Record<string, DatabaseTableInfo[]>) => Record<string, DatabaseTableInfo[]>) => void;
  expanded: () => Record<string, true>;
  toggleExpanded: (database: string) => boolean;
  expandDatabase: (database: string) => void;
  expandedGroups: () => Record<string, true>;
  toggleGroup: (database: string, group: "tables" | "views") => void;
  expandGroup: (database: string, group: "tables" | "views") => void;
  tabs: () => WorkspaceTab[];
  setTabs: (updater: (previous: WorkspaceTab[]) => WorkspaceTab[]) => void;
  activeId: () => string;
  setActiveId: (id: string) => void;
  activeTab: () => WorkspaceTab | null;
  patchTab: (id: string, patch: Partial<TableTab> | Partial<QueryTab> | Partial<DatabaseTab>) => void;
  openTab: (tab: WorkspaceTab) => void;
  closeTab: (id: string) => void;
  nextQueryNumber: () => number;
  treeFilter: () => string;
  setTreeFilter: (value: string) => void;
  objectQuery: (database: string) => string;
  setObjectQuery: (database: string, value: string) => void;
  objectSort: (database: string) => SortOrder | null;
  setObjectSort: (database: string, value: SortOrder | null) => void;
  pending: () => number;
  beginRequest: () => void;
  endRequest: () => void;
  loading: () => boolean;
  error: () => string;
  setError: (value: string) => void;
  charsets: () => DatabaseCharsetInfo[];
  setCharsets: (value: DatabaseCharsetInfo[]) => void;
  runningTabId: () => string | null;
  setRunningTabId: (value: string | null) => void;
  activity: () => string;
  setActivity: (value: string) => void;
  menu: () => ContextMenuState | null;
  setMenu: (value: ContextMenuState | null) => void;
  /** 表设计器草稿的应用次数，用于父层刷新列表 */
  bumpSchema: () => void;
  schemaVersion: () => number;
};

const registry = new Map<string, WorkspaceState>();

/** 只读模式是「使用者级」开关，不随连接分片 */
const [readOnly, setReadOnlySignal] = createSignal(localStorage.getItem("portnest.database.readOnly") === "1");
export const databaseReadOnly = readOnly;
export const setDatabaseReadOnly = (value: boolean) => {
  localStorage.setItem("portnest.database.readOnly", value ? "1" : "0");
  setReadOnlySignal(value);
};

export function workspaceState(connectionId: string): WorkspaceState {
  const existing = registry.get(connectionId);
  if (existing) return existing;

  const [databases, setDatabases] = createSignal<Array<{ name: string; charset?: string; collation?: string }>>([]);
  const [tables, setTablesRaw] = createSignal<Record<string, DatabaseTableInfo[]>>({});
  const [expanded, setExpanded] = createSignal<Record<string, true>>({});
  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, true>>({});
  const [tabs, setTabsRaw] = createSignal<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = createSignal("");
  const [queryCounter, setQueryCounter] = createSignal(0);
  const [treeFilter, setTreeFilter] = createSignal("");
  const [objectQueries, setObjectQueries] = createSignal<Record<string, string>>({});
  const [objectSorts, setObjectSorts] = createSignal<Record<string, SortOrder | null>>({});
  const [requests, setRequests] = createSignal(0);
  const [error, setErrorSignal] = createSignal("");
  const [charsets, setCharsets] = createSignal<DatabaseCharsetInfo[]>([]);
  const [runningTabId, setRunningTabId] = createSignal<string | null>(null);
  const [activity, setActivity] = createSignal("");
  const [menu, setMenu] = createSignal<ContextMenuState | null>(null);
  const [schemaVersion, setSchemaVersion] = createSignal(0);

  const state: WorkspaceState = {
    databases,
    setDatabases,
    tables,
    setTables: updater => setTablesRaw(updater),
    expanded,
    expandDatabase: database => setExpanded(current => (current[database] ? current : { ...current, [database]: true })),
    toggleExpanded: database => {
      const opened = !!expanded()[database];
      setExpanded(current => {
        const next = { ...current };
        if (opened) delete next[database]; else next[database] = true;
        return next;
      });
      return !opened;
    },
    expandedGroups,
    expandGroup: (database, group) => {
      const key = `${database}:${group}`;
      setExpandedGroups(current => (current[key] ? current : { ...current, [key]: true }));
    },
    toggleGroup: (database, group) => {
      const key = `${database}:${group}`;
      setExpandedGroups(current => {
        const next = { ...current };
        if (next[key]) delete next[key]; else next[key] = true;
        return next;
      });
    },
    tabs,
    setTabs: updater => setTabsRaw(updater),
    activeId,
    setActiveId,
    activeTab: () => tabs().find(item => item.id === activeId()) ?? null,
    patchTab: (id, patch) => setTabsRaw(items => items.map(item => (item.id === id ? ({ ...item, ...(patch as Record<string, unknown>) } as unknown as WorkspaceTab) : item))),
    openTab: tab => {
      setTabsRaw(items => (items.some(item => item.id === tab.id) ? items : [...items, tab]));
      setActiveId(tab.id);
    },
    closeTab: id => {
      const items = tabs();
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return;
      const next = items.filter(item => item.id !== id);
      setTabsRaw(next);
      if (activeId() === id) setActiveId(next[Math.max(0, index - 1)]?.id || next[0]?.id || "");
    },
    nextQueryNumber: () => {
      const number = queryCounter() + 1;
      setQueryCounter(number);
      return number;
    },
    treeFilter,
    setTreeFilter,
    objectQuery: database => objectQueries()[database] || "",
    setObjectQuery: (database, value) => setObjectQueries(current => ({ ...current, [database]: value })),
    objectSort: database => objectSorts()[database] ?? null,
    setObjectSort: (database, value) => setObjectSorts(current => ({ ...current, [database]: value })),
    pending: requests,
    beginRequest: () => setRequests(value => value + 1),
    endRequest: () => setRequests(value => Math.max(0, value - 1)),
    loading: () => requests() > 0,
    error,
    setError: setErrorSignal,
    charsets,
    setCharsets,
    runningTabId,
    setRunningTabId,
    activity,
    setActivity,
    menu,
    setMenu,
    bumpSchema: () => setSchemaVersion(value => value + 1),
    schemaVersion,
  };

  registry.set(connectionId, state);
  return state;
}

/** 关闭会话时释放状态，避免长会话堆积 */
export function disposeWorkspaceState(connectionId: string) {
  registry.delete(connectionId);
}

// ---------------------------------------------------------------------------
// 请求序号：放模块级 Map，不进信号。
// 若塞进 createStore，读取时会建立依赖并让每次写都触发无关组件重算；而且代理会
// 掩盖「同一 key 连续两次请求」的竞态判断。
// ---------------------------------------------------------------------------
const sequences = new Map<string, number>();

export function nextSequence(kind: string, connectionId: string, tabId: string) {
  const key = `${kind}:${connectionId}:${tabId}`;
  const value = (sequences.get(key) || 0) + 1;
  sequences.set(key, value);
  return value;
}

export function isLatestSequence(kind: string, connectionId: string, tabId: string, seq: number) {
  return sequences.get(`${kind}:${connectionId}:${tabId}`) === seq;
}

export function clearSequences(connectionId: string, tabId: string) {
  for (const key of [...sequences.keys()]) {
    if (key.includes(`:${connectionId}:${tabId}`)) sequences.delete(key);
  }
}

// 便捷构造器：新标签统一在这里建，避免各处字段漏填

export const makeDatabaseTab = (database: string): DatabaseTab => ({
  id: `database:${database}`,
  kind: "database",
  title: database,
  database,
  view: "list",
});

export const makeQueryTab = (id: string, number: number, database: string): QueryTab => ({
  id,
  kind: "query",
  title: `查询 ${number}`,
  database,
  sql: "SELECT 1;",
  result: null,
  dirty: false,
});

export const makeTableTab = (input: {
  database: string;
  table: string;
  section?: TableSection;
  columns?: DatabaseColumnInfo[];
  indexes?: DatabaseIndexInfo[];
}): TableTab => ({
  id: `table:${input.database}:${input.table}`,
  kind: "table",
  title: input.table,
  database: input.database,
  table: input.table,
  section: input.section ?? "data",
  dataView: "grid",
  page: 1,
  pageSize: 100,
  orders: [],
  filters: emptyFilterSpec(),
  columns: input.columns ?? [],
  indexes: input.indexes ?? [],
  rows: null,
  designer: null,
  preview: [],
  dirty: false,
  pending: emptyPending(),
  primaryKey: primaryKeyColumns(input.columns ?? []),
  columnWidths: {},
});
