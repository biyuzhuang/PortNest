import { Component, For, Show as SolidShow, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  api,
  isPostgresCompatibleProtocol,
  type ConnectionRecord,
  type DatabaseTableChangeSet,
  type DatabaseTableDefinition,
} from "../../utils/api";
import { feedback } from "../../stores/feedbackStore";
import { aiContextStore } from "../../stores/aiContextStore";
import { Icon } from "../Icon";
import "../../styles/database/index.css";
import {
  databaseReadOnly,
  disposeWorkspaceState,
  isLatestSequence,
  makeDatabaseTab,
  makeQueryTab,
  makeTableTab,
  nextSequence,
  setDatabaseReadOnly,
  workspaceState,
} from "../../stores/databaseWorkspaceStore";
import { ObjectTreePane } from "./nav/ObjectTreePane";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { StatusBar } from "./StatusBar";
import { InfoPane } from "./InfoPane";
import { ObjectPanel } from "./objects/ObjectPanel";
import { QueryPanel } from "./query/QueryPanel";
import { TableWorkspace, type TableActions } from "./table/TableWorkspace";
import type { CellEdit } from "./table/DataGrid";
import {
  cellText,
  csvCell,
  formatCell,
  formatBytes,
  isNullValue,
  parseCellValue,
  rowToInsertSql,
  rowToJson,
  rowToUpdateSql,
  type ContextMenuState,
  type DdlView,
  type FilterSpec,
  type QueryTab,
  type SortOrder,
  type TableSection,
  type TableTab,
  type WorkspaceTab,
} from "./types";

const Show = SolidShow as unknown as Component<any>;

interface Props { connection: ConnectionRecord; visible: boolean; onCloseConnection: () => void }
interface CreateDialog { name: string; charset: string; collation: string; error: string }
interface ImportDialog { path: string; database: string; continueOnError: boolean }

export const DatabaseWorkspace: Component<Props> = props => {
  const state = workspaceState(props.connection.id);
  const protocol = () => props.connection.protocol;
  const databaseLabel = () => protocol() === "highgo" ? "瀚高数据库 (HighGo)" : isPostgresCompatibleProtocol(protocol()) ? "PostgreSQL" : "MySQL";

  const [ddlView, setDdlView] = createSignal<DdlView>(null);
  const [createDialog, setCreateDialog] = createSignal<CreateDialog | null>(null);
  const [importDialog, setImportDialog] = createSignal<ImportDialog | null>(null);
  const [infoOpen, setInfoOpen] = createSignal(false);

  const activeTab = createMemo(() => state.tabs().find(item => item.id === state.activeId()) ?? null);

  const run = async <T,>(job: () => Promise<T>): Promise<T> => {
    state.beginRequest();
    state.setError("");
    try { return await job(); }
    catch (cause) { state.setError(String(cause)); throw cause; }
    finally { state.endRequest(); }
  };

  // ---------------------------------------------------------------------------
  // 元数据加载
  // ---------------------------------------------------------------------------
  const refreshTables = async (database: string) => {
    const data = await run(() => api.databaseListTables(props.connection.id, database));
    state.setTables(previous => ({ ...previous, [database]: data }));
  };

  const refreshDatabases = async () => {
    const data = await run(() => api.databaseListDatabases(props.connection.id));
    state.setDatabases(data);
    const names = new Set(data.map(item => item.name));
    state.setTabs(items => {
      const next = items.filter(item => !item.database || names.has(item.database));
      if (!next.some(item => item.id === state.activeId())) state.setActiveId(next[0]?.id || "");
      return next;
    });
    await Promise.all(Object.keys(state.expanded()).filter(name => names.has(name)).map(name => refreshTables(name).catch(() => undefined)));
  };

  createEffect(() => { if (props.visible && state.databases().length === 0) void refreshDatabases().catch(() => undefined); });

  const activateDatabase = async (database: string) => {
    state.openTab(makeDatabaseTab(database));
    state.expandDatabase(database);
    state.expandGroup(database, "tables");
    state.expandGroup(database, "views");
    if (!state.tables()[database]) await refreshTables(database).catch(() => undefined);
  };

  /** 把列/索引还原成设计器需要的结构；外键在打开设计器时单独拉 */
  // PostgreSQL 的自增有两种来源：GENERATED AS IDENTITY 和 SERIAL（默认值里的 nextval）
  const looksAutoIncrement = (column: TableTab["columns"][number]): boolean =>
    column.extra.includes("auto_increment")
    || column.extra === "identity"
    || (column.default_value || "").trimStart().toLowerCase().startsWith("nextval(");

  const makeDesigner = (database: string, table: string, columns: TableTab["columns"], indexes: TableTab["indexes"]): DatabaseTableDefinition => {
    const grouped = new Map<string, { name: string; kind: "PRIMARY" | "UNIQUE" | "INDEX"; columns: Array<{ name: string; prefix_length?: number; direction?: string }> }>();
    for (const index of indexes) {
      if (!index.column) continue;
      // MySQL 的主键叫 PRIMARY，PostgreSQL 的叫 <表名>_pkey，只能靠后端标记识别
      const kind = index.primary || index.name === "PRIMARY" ? "PRIMARY" : index.unique ? "UNIQUE" : "INDEX";
      const item = grouped.get(index.name) || { name: index.name, kind, columns: [] };
      const descending = index.direction === "D" || index.direction?.toUpperCase() === "DESC";
      item.columns.push({ name: index.column, prefix_length: index.prefix_length, direction: descending ? "DESC" : "ASC" });
      grouped.set(index.name, item);
    }
    const info = (state.tables()[database] || []).find(item => item.name === table);
    return {
      database,
      name: table,
      original_name: table,
      engine: info?.engine || "InnoDB",
      charset: info?.collation?.split("_")[0] || columns.find(item => item.charset)?.charset || "utf8mb4",
      collation: info?.collation,
      comment: info?.comment || "",
      columns: columns.map(item => ({
        name: item.name,
        column_type: item.column_type,
        nullable: item.nullable,
        default_value: item.default_value,
        auto_increment: looksAutoIncrement(item),
        charset: item.charset,
        collation: item.collation,
        comment: item.comment,
        generation_expression: item.generation_expression,
        extra: item.extra,
      })),
      indexes: [...grouped.values()],
      foreign_keys: [],
    };
  };

  const loadTable = async (database: string, table: string, section: TableSection = "data") => {
    const id = `table:${database}:${table}`;
    const existing = state.tabs().find(item => item.id === id) as TableTab | undefined;
    if (existing) {
      state.setActiveId(id);
      if (section === "design" && !existing.designer) { void startDesign(existing); return; }
      if (section !== existing.section) state.patchTab(id, { section });
      return;
    }
    const [columns, indexes, rows] = await run(() => Promise.all([
      api.databaseListColumns(props.connection.id, database, table),
      api.databaseListIndexes(props.connection.id, database, table),
      api.databaseFetchRows(props.connection.id, database, table, 1, 100),
    ]));
    const tab = makeTableTab({ database, table, section, columns, indexes });
    state.openTab({ ...tab, rows });
    if (section === "design") {
      const opened = state.tabs().find(item => item.id === id) as TableTab | undefined;
      if (opened) void startDesign(opened);
    }
  };

  const loadPage = async (target: TableTab, page: number, overrides?: { orders?: SortOrder[]; filters?: FilterSpec; pageSize?: number }) => {
    const seq = nextSequence("page", props.connection.id, target.id);
    const orders = overrides?.orders ?? target.orders;
    const filters = overrides?.filters ?? target.filters;
    const pageSize = overrides?.pageSize ?? target.pageSize;
    try {
      const rows = await run(() => api.databaseFetchRows(
        props.connection.id, target.database, target.table, page, pageSize,
        orders[0] ?? null, null, orders, { conjunction: filters.conjunction, conditions: filters.conditions.map(item => ({ column: item.column, operator: item.operator, value: item.value, value2: item.value2 ?? null })) },
      ));
      if (isLatestSequence("page", props.connection.id, target.id, seq)) {
        state.patchTab(target.id, { rows, page, orders, filters, pageSize });
      }
    } catch { /* run() 已展示错误 */ }
  };

  const reloadTab = (id: string) => {
    const tab = state.tabs().find(item => item.id === id) as TableTab | undefined;
    if (tab) void loadPage(tab, 1);
  };

  // ---------------------------------------------------------------------------
  // 标签
  // ---------------------------------------------------------------------------
  const newQuery = (database = activeDatabase()) => {
    const number = state.nextQueryNumber();
    const tab = makeQueryTab(`query:${number}:${Date.now()}`, number, database);
    state.openTab(tab);
    return tab.id;
  };
  const activeDatabase = () => activeTab()?.database || "";

  const newTable = (database: string) => {
    const tab = makeTableTab({ database, table: "new_table", section: "design" });
    state.openTab({ ...tab, id: `new-table:${database}:${Date.now()}`, title: "新建表", dirty: true, isNew: true, designer: blankDesignerFor(database) });
  };

  const closeTab = async (id: string) => {
    const items = state.tabs();
    const target = items.find(item => item.id === id);
    if (!target) return;
    if (target.kind !== "database" && target.dirty) {
      const message = target.kind === "query" ? "SQL 查询尚未保存，确定关闭并丢弃内容吗？" : "表设计尚未应用，确定关闭并丢弃修改吗？";
      if (!await feedback.confirm(message, "关闭标签")) return;
    }
    state.closeTab(id);
  };

  // ---------------------------------------------------------------------------
  // 表数据：待提交变更
  // ---------------------------------------------------------------------------
  const rowKeyFor = (tab: TableTab, rowIndex: number) => {
    if (tab.primaryKey.length === 0) return `row:${rowIndex}`;
    const values = tab.rows?.rows[rowIndex]?.values ?? [];
    return `pk:${tab.primaryKey.map(name => String(values[tab.rows!.columns.indexOf(name)])).join("\u0001")}`;
  };
  const rowObject = (tab: TableTab, values: unknown[]) =>
    Object.fromEntries((tab.rows?.columns || []).map((name, index) => [name, values[index]]));
  const effectiveValues = (tab: TableTab, rowIndex: number) => {
    const base = tab.rows?.rows[rowIndex]?.values ?? [];
    const updated = tab.pending.updates[rowKeyFor(tab, rowIndex)]?.values;
    if (!updated) return [...base];
    return base.map((value, index) => {
      const name = tab.rows!.columns[index];
      return name in updated ? updated[name] : value;
    });
  };
  const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

  const patchPending = (tabId: string, patch: Partial<TableTab["pending"]>) => {
    const tab = state.tabs().find(item => item.id === tabId) as TableTab | undefined;
    if (!tab) return;
    state.patchTab(tabId, { pending: { ...tab.pending, ...patch } });
  };

  const commitCell = (tab: TableTab, edit: CellEdit) => {
    if (!tab.rows) return;
    const original = tab.rows.rows[edit.rowIndex]?.values ?? [];
    const columnIndex = tab.rows.columns.indexOf(edit.column);
    const next = effectiveValues(tab, edit.rowIndex);
    next[columnIndex] = parseCellValue(edit.raw, original[columnIndex]);
    const changed: Record<string, unknown> = {};
    tab.rows.columns.forEach((name, index) => { if (!sameValue(next[index], original[index])) changed[name] = next[index]; });
    const key = rowKeyFor(tab, edit.rowIndex);
    const updates = { ...tab.pending.updates };
    if (Object.keys(changed).length > 0) updates[key] = { values: changed, original: rowObject(tab, original) };
    else delete updates[key];
    patchPending(tab.id, { updates });
  };

  const applyChanges = async (tab: TableTab) => {
    if (!tab.rows) return;
    const deletes: Array<Record<string, unknown>> = [];
    tab.rows.rows.forEach((row, index) => {
      if (tab.pending.deletes[rowKeyFor(tab, index)]) deletes.push(rowObject(tab, row.values));
    });
    const changes: DatabaseTableChangeSet = {
      inserts: tab.pending.inserted.map(item => item.values).filter(values => Object.keys(values).length > 0),
      updates: Object.values(tab.pending.updates),
      deletes,
    };
    if (changes.inserts.length + changes.updates.length + changes.deletes.length === 0) {
      feedback.info("没有需要应用的修改");
      return;
    }
    state.setRunningTabId(tab.id);
    try {
      const count = await run(() => api.databaseApplyTableChanges(props.connection.id, tab.database, tab.table, changes));
      feedback.success(`已提交 ${count} 条修改`);
      patchPending(tab.id, { inserted: [], updates: {}, deletes: {}, selected: {} });
      await loadPage(tab, tab.page);
    } catch { /* run() 已展示错误 */ }
    finally { if (state.runningTabId() === tab.id) state.setRunningTabId(null); }
  };

  const selectedRows = (tab: TableTab) => {
    if (!tab.rows) return [] as unknown[][];
    const rows: unknown[][] = [];
    Object.keys(tab.pending.selected).forEach(key => {
      if (key.startsWith("row:")) {
        const index = Number(key.slice(4));
        if (!tab.pending.deletes[key]) rows.push(effectiveValues(tab, index));
      }
      if (key.startsWith("pk:")) {
        const index = tab.rows!.rows.findIndex((_row, i) => rowKeyFor(tab, i) === key);
        if (index >= 0) rows.push(effectiveValues(tab, index));
      }
      if (key.startsWith("new:")) {
        const id = Number(key.slice(4));
        const item = tab.pending.inserted.find(entry => entry.id === id);
        if (item) rows.push(tab.rows!.columns.map(name => item.values[name] ?? null));
      }
    });
    return rows;
  };

  const exportCsv = (tab: TableTab, rows: unknown[][], name: string) => {
    if (!tab.rows || rows.length === 0) { feedback.info("没有可导出的记录"); return; }
    const content = [tab.rows.columns.map(csvCell).join(","), ...rows.map(row => row.map(csvCell).join(","))].join("\r\n");
    download(`${name}.csv`, "\uFEFF" + content, "text/csv;charset=utf-8");
  };

  const copyAs = async (tab: TableTab, kind: "insert" | "update" | "json") => {
    if (!tab.rows) return;
    const rows = selectedRows(tab);
    const data = rows.length > 0 ? rows : tab.rows.rows.map(row => row.values);
    if (data.length === 0) { feedback.info("当前没有可复制的记录"); return; }
    const text = kind === "json"
      ? data.map(row => rowToJson(tab.rows!.columns, row)).join("\n")
      : kind === "insert"
        ? data.map(row => rowToInsertSql(tab.table, tab.rows!.columns, row)).join("\n")
        : data.map(row => rowToUpdateSql(tab.table, tab.rows!.columns, row, tab.primaryKey)).join("\n");
    try { await navigator.clipboard.writeText(text); feedback.success(`已复制 ${data.length} 条 ${kind.toUpperCase()}`); }
    catch (cause) { feedback.error("复制失败：" + String(cause)); }
  };

  const tableActions = (tab: TableTab): TableActions => ({
    onSectionChange: section => {
      if (section === "design" && !tab.designer) { void startDesign(tab); return; }
      state.patchTab(tab.id, { section });
    },
    onRefresh: () => void loadPage(tab, tab.page),
    onSort: column => {
      const current = tab.orders.find(item => item.column === column);
      const next: SortOrder[] = current
        ? current.direction === "asc" ? [{ column, direction: "desc" }] : []
        : [{ column, direction: "asc" }];
      void loadPage(tab, 1, { orders: next });
    },
    onApplyFilters: (filters, orders) => void loadPage(tab, 1, { filters, orders }),
    onPageChange: page => void loadPage(tab, page),
    onPageSizeChange: size => void loadPage(tab, 1, { pageSize: size }),
    onStop: () => void stopQuery(),
    onCommitCell: edit => commitCell(tab, edit),
    onInsertedEdit: (id, column, raw) => {
      patchPending(tab.id, {
        inserted: tab.pending.inserted.map(item => item.id === id ? { ...item, values: { ...item.values, [column]: parseCellValue(raw, undefined) } } : item),
      });
    },
    onAddRecord: () => {
      const nextId = tab.pending.inserted.reduce((max, item) => Math.max(max, item.id), 0) + 1;
      patchPending(tab.id, { inserted: [...tab.pending.inserted, { id: nextId, values: {} }] });
    },
    onDeleteSelected: () => {
      const keys = Object.keys(tab.pending.selected);
      if (keys.length === 0) { feedback.info("请先勾选要删除的记录"); return; }
      const removeIds = new Set(keys.filter(key => key.startsWith("new:")).map(key => Number(key.slice(4))));
      const deletes = { ...tab.pending.deletes };
      const updates = { ...tab.pending.updates };
      keys.forEach(key => {
        if (key.startsWith("new:")) return;
        deletes[key] = true;
        delete updates[key];
      });
      patchPending(tab.id, { deletes, updates, selected: {}, inserted: tab.pending.inserted.filter(item => !removeIds.has(item.id)) });
    },
    onToggleRow: key => {
      const selected = { ...tab.pending.selected };
      if (selected[key]) delete selected[key]; else selected[key] = true;
      patchPending(tab.id, { selected });
    },
    onToggleAll: () => {
      if (Object.keys(tab.pending.selected).length > 0) { patchPending(tab.id, { selected: {} }); return; }
      const selected: Record<string, true> = {};
      tab.rows?.rows.forEach((_row, index) => { if (!tab.pending.deletes[rowKeyFor(tab, index)]) selected[rowKeyFor(tab, index)] = true; });
      tab.pending.inserted.forEach(item => { selected[`new:${item.id}`] = true; });
      patchPending(tab.id, { selected });
    },
    onDiscard: () => patchPending(tab.id, { inserted: [], updates: {}, deletes: {}, selected: {} }),
    onApplyChanges: () => void applyChanges(tab),
    onCopySelected: () => {
      const rows = selectedRows(tab);
      if (rows.length === 0) { feedback.info("请先勾选要复制的记录"); return; }
      const text = [(tab.rows?.columns || []).join("\t"), ...rows.map(row => row.map(value => isNullValue(value) ? "NULL" : formatCell(value)).join("\t"))].join("\n");
      void navigator.clipboard.writeText(text).then(() => feedback.success("已复制选中记录"));
    },
    onCopyAs: kind => void copyAs(tab, kind),
    onExportSelected: () => exportCsv(tab, selectedRows(tab), `${tab.table}-selected`),
    onExportPage: () => exportCsv(tab, (tab.rows?.rows || []).map(row => row.values), tab.table),
    onExportCsvFile: () => exportCsv(tab, (tab.rows?.rows || []).map(row => row.values), tab.table),
    onOpenDdl: () => void openDdl(tab.database, tab.table),
    onResizeColumn: (column, width) => {
      const widths = { ...tab.columnWidths, [column]: Math.round(width) };
      state.patchTab(tab.id, { columnWidths: widths });
      localStorage.setItem(columnWidthKey(props.connection.id, tab.database, tab.table), JSON.stringify(widths));
    },
    onFormIndexChange: () => undefined,
    onDesignChange: designer => state.patchTab(tab.id, { designer, dirty: true, preview: [] }),
    onPreviewDesign: () => void previewDesign(tab),
    onApplyDesign: () => void applyDesign(tab),
    onDiscardDesign: () => state.patchTab(tab.id, {
      designer: tab.designerBase ? structuredClone(tab.designerBase) : tab.designer,
      dirty: false,
      preview: [],
    }),
    onImportCsv: file => void importCsv(tab, file),
  });

  // ---------------------------------------------------------------------------
  // 设计器
  // ---------------------------------------------------------------------------
  const startDesign = async (tab: TableTab) => {
    const base = makeDesigner(tab.database, tab.table, tab.columns, tab.indexes);
    state.patchTab(tab.id, { section: "design", designer: base, designerBase: structuredClone(base), dirty: false, preview: [] });
    try {
      const foreignKeys = await api.databaseListForeignKeys(props.connection.id, tab.database, tab.table);
      const current = state.tabs().find(item => item.id === tab.id) as TableTab | undefined;
      if (!current?.designer) return;
      const merged = { ...current.designer, foreign_keys: foreignKeys };
      state.patchTab(tab.id, { designer: merged, designerBase: structuredClone(merged) });
    } catch { /* 外键读取失败不阻塞设计器 */ }
  };

  const previewDesign = async (tab: TableTab) => {
    if (!tab.designer) return;
    try { state.patchTab(tab.id, { preview: await run(() => api.databasePreviewTable(props.connection.id, tab.designer!)) }); }
    catch { /* run() 已展示错误 */ }
  };

  const applyDesign = async (tab: TableTab) => {
    if (!tab.designer) return;
    try {
      const statements = await run(() => api.databasePreviewTable(props.connection.id, tab.designer!));
      state.patchTab(tab.id, { preview: statements });
      if (!await feedback.confirm(`${databaseLabel()} 的 DDL 可能隐式提交且不能整体回滚，确认执行预览中的 ${statements.length} 条语句吗？`, "应用表设计")) return;
      const result = tab.isNew
        ? await run(() => api.databaseCreateTable(props.connection.id, tab.designer!))
        : await run(() => api.databaseApplyTable(props.connection.id, tab.designer!, statements));
      if (result.error) { state.setError(`已完成 ${result.completed}/${result.statements.length} 步：${result.error}`); return; }
      await refreshTables(tab.database);
      if (tab.isNew) {
        const name = tab.designer!.name;
        state.closeTab(tab.id);
        await loadTable(tab.database, name, "structure");
      } else {
        state.patchTab(tab.id, { dirty: false, section: "structure", designerBase: tab.designer ? structuredClone(tab.designer) : null });
        reloadTab(tab.id);
      }
    } catch { /* run() 已展示错误 */ }
  };

  // ---------------------------------------------------------------------------
  // 数据库级操作
  // ---------------------------------------------------------------------------
  const showCreateDatabase = async () => {
    if (state.charsets().length === 0) {
      try { state.setCharsets(await run(() => api.databaseListCharsets(props.connection.id))); } catch { return; }
    }
    const utf8 = state.charsets().find(item => item.name === "utf8mb4") || state.charsets()[0];
    setCreateDialog({ name: "", charset: utf8?.name || "utf8mb4", collation: utf8?.default_collation || "", error: "" });
    state.setMenu(null);
  };
  const submitCreateDatabase = async () => {
    const value = createDialog();
    if (!value) return;
    if (!value.name.trim()) { setCreateDialog({ ...value, error: "数据库名称不能为空" }); return; }
    try {
      await run(() => api.databaseCreateDatabase(props.connection.id, value.name.trim(), value.charset, value.collation));
      setCreateDialog(null);
      await refreshDatabases();
      await activateDatabase(value.name.trim());
    } catch (cause) { setCreateDialog({ ...value, error: String(cause) }); }
  };

  const chooseImport = async (database = "") => {
    const path = await open({ multiple: false, directory: false, title: "选择 SQL 文件", filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (typeof path === "string") setImportDialog({ path, database, continueOnError: false });
    state.setMenu(null);
  };
  const importSql = async () => {
    const value = importDialog();
    if (!value) return;
    const result = await run(() => api.databaseImportSql(props.connection.id, value.path, value.database || undefined, value.continueOnError));
    setImportDialog(null);
    await refreshDatabases();
    if (result.failures.length > 0) feedback.error(`导入完成：成功 ${result.completed}/${result.total}，失败 ${result.failures.length}；首个错误位于语句 ${result.failures[0].statement}：${result.failures[0].summary}`);
    else feedback.success(`SQL 导入完成，共执行 ${result.completed} 条语句`);
  };
  const exportSql = async (database: string) => {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await save({ title: "导出 SQL", defaultPath: `${database}-${stamp}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!path) return;
    const result = await run(() => api.databaseExportSql(props.connection.id, path, database));
    feedback.success(`导出完成：${result.tables} 张表，${result.rows} 行数据`);
    state.setMenu(null);
  };

  const removeDatabase = async (database: string) => {
    if (await feedback.prompt(`删除数据库将永久删除全部对象。请输入 ${database} 确认：`, "", "删除数据库") !== database) return;
    await run(() => api.databaseDropDatabase(props.connection.id, database));
    state.setTabs(items => {
      const next = items.filter(item => item.database !== database);
      if (!next.some(item => item.id === state.activeId())) state.setActiveId(next[0]?.id || "");
      return next;
    });
    await refreshDatabases();
  };

  const tableAction = async (action: "truncate" | "drop" | "rename" | "clone", database: string, table: string) => {
    let target: string | undefined;
    if (action === "rename" || action === "clone") {
      target = await feedback.prompt(action === "rename" ? "新表名" : "副本表名", action === "clone" ? `${table}_copy` : table, action === "rename" ? "重命名表" : "新建相似表") || undefined;
      if (!target) return;
    }
    if ((action === "truncate" || action === "drop") && await feedback.prompt(`请输入 ${table} 确认${action === "drop" ? "删除" : "清空"}：`, "", action === "drop" ? "删除表" : "清空表") !== table) return;
    await run(() => api.databaseTableAction(props.connection.id, database, table, action, target));
    if (action === "drop" || action === "rename") {
      state.setTabs(items => items.filter(item => !(item.kind === "table" && item.database === database && item.table === table)));
    }
    await refreshTables(database);
    state.setMenu(null);
  };

  const openDdl = async (database: string, table: string) => {
    try { setDdlView({ database, table, sql: await run(() => api.databaseShowCreate(props.connection.id, database, table)) }); }
    catch { /* run() 已展示错误 */ }
  };

  const importCsv = async (tab: TableTab, file: File) => {
    const content = await file.text();
    if (!await feedback.confirm("CSV 导入在事务中执行，任一行失败将整体回滚。继续吗？", "导入 CSV")) return;
    try {
      const count = await run(() => api.databaseImportCsv(props.connection.id, tab.database, tab.table, content));
      feedback.success(`已导入 ${count} 行`);
      await loadPage(tab, 1);
    } catch { /* run() 已展示错误 */ }
  };

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------
  const executeQuery = async (tab: QueryTab, sqlOverride?: string) => {
    const sql = sqlOverride && sqlOverride.trim() ? sqlOverride : tab.sql;
    const seq = nextSequence("query", props.connection.id, tab.id);
    const startedAt = performance.now();
    state.setRunningTabId(tab.id);
    try {
      const batch = await run(() => api.databaseExecuteSqlBatch(props.connection.id, sql, tab.database));
      const outcomes = batch.statements;
      if (isLatestSequence("query", props.connection.id, tab.id, seq)) {
        // 优先展示第一条有结果集的语句；全是 DML 时退回最后一条
        const withColumns = outcomes.filter(item => item.result && item.result.columns.length > 0);
        const primary = (withColumns[0] ?? [...outcomes].reverse().find(item => item.result))?.result ?? null;
        const totals = outcomes.reduce(
          (acc, item) => ({
            rows: acc.rows + (item.result?.rows.length ?? 0),
            affected: acc.affected + (item.result?.affected_rows ?? 0),
          }),
          { rows: 0, affected: 0 },
        );
        const failure = outcomes.find(item => item.error);
        state.patchTab(tab.id, {
          result: primary,
          results: outcomes,
          batch: { transaction: batch.transaction, partial: batch.partial, error: batch.error },
          activeResult: withColumns[0]?.index ?? outcomes[outcomes.length - 1]?.index ?? 1,
          stats: {
            elapsedMs: Math.round(performance.now() - startedAt),
            rows: totals.rows,
            affectedRows: totals.affected,
            statement: sql,
            finishedAt: Date.now(),
            error: failure?.error ?? batch.error ?? undefined,
          },
        });
      }
    } catch (cause) {
      // 整批没跑起来（连接断开、提交失败等）：清掉上一次的结果，避免看起来像本次的
      state.patchTab(tab.id, {
        result: null,
        results: [],
        batch: null,
        stats: { elapsedMs: Math.round(performance.now() - startedAt), rows: 0, affectedRows: 0, statement: sql, finishedAt: Date.now(), error: String(cause) },
      });
    } finally {
      if (state.runningTabId() === tab.id) state.setRunningTabId(null);
    }
  };
  const stopQuery = async () => {
    try { await api.databaseCancelQuery(props.connection.id); feedback.info("已请求停止当前查询"); }
    catch (cause) { feedback.error("停止查询失败：" + String(cause)); }
  };

  // ---------------------------------------------------------------------------
  // 生命周期与快捷键
  // ---------------------------------------------------------------------------
  createEffect(() => {
    const tab = activeTab();
    if (!props.visible || !tab) { aiContextStore.setSQLContext(""); return; }
    const lines: string[] = [
      `数据库类型: ${databaseLabel()}`,
      `当前数据库: ${tab.database || "未选择"}`,
      `当前对象: ${tab.title}`,
    ];
    if (tab.kind === "query") {
      lines.push("当前 SQL:", tab.sql || "（空查询）");
      if (tab.result) {
        lines.push(`结果列: ${tab.result.columns.join(", ")}`, `结果行数: ${tab.result.rows.length}${tab.result.truncated ? "（已截断）" : ""}`);
        if (tab.result.rows.length > 0) {
          lines.push("结果预览:");
          lines.push(...tab.result.rows.slice(0, 5).map(row => {
            const record: Record<string, unknown> = {};
            tab.result!.columns.forEach((column, index) => { record[column] = row.values[index]; });
            return JSON.stringify(record).slice(0, 900);
          }));
        }
      }
    } else if (tab.kind === "table") {
      lines.push(`数据表: ${tab.table}`, `当前视图: ${tab.section}`);
      if (tab.columns.length > 0) {
        lines.push("字段结构:", ...tab.columns.slice(0, 80).map(column =>
          `- ${column.name} ${column.column_type}${column.nullable ? "" : " NOT NULL"}${column.default_value != null ? ` DEFAULT ${column.default_value}` : ""}${column.comment ? ` -- ${column.comment}` : ""}`));
      }
      if (tab.indexes.length > 0) {
        lines.push("索引:", ...tab.indexes.slice(0, 40).map(index => `- ${index.name}: ${index.column || ""}${index.unique ? " UNIQUE" : ""}`));
      }
    }
    aiContextStore.setSQLContext(lines.join("\n").slice(0, 16_000));
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "F6") { event.preventDefault(); setInfoOpen(value => !value); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") { event.preventDefault(); newQuery(); }
  };
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    const cleanup = aiContextStore.registerSQLDraftApplier(sql => {
      if (!props.visible) return false;
      const tab = activeTab();
      if (tab?.kind === "query") { state.patchTab(tab.id, { sql, dirty: true }); return true; }
      const id = newQuery(tab?.database || activeDatabase());
      state.patchTab(id, { sql, dirty: true });
      return true;
    });
    onCleanup(cleanup);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    aiContextStore.setSQLContext("");
    disposeWorkspaceState(props.connection.id);
  });

  // 列宽从 localStorage 恢复到首次打开的表标签
  createEffect(() => {
    for (const tab of state.tabs()) {
      if (tab.kind !== "table" || Object.keys(tab.columnWidths).length > 0) continue;
      const raw = localStorage.getItem(columnWidthKey(props.connection.id, tab.database, tab.table));
      if (!raw) continue;
      try {
        const widths = JSON.parse(raw) as Record<string, number>;
        if (Object.keys(widths).length > 0) state.patchTab(tab.id, { columnWidths: widths });
      } catch { /* 忽略损坏的本地数据 */ }
    }
  });

  const activeObject = createMemo(() => {
    const tab = activeTab();
    if (!tab) return "";
    return tab.kind === "table" ? `${tab.database}:${tab.table}` : `database:${tab.database}`;
  });

  const objectText = createMemo(() => {
    const tab = activeTab();
    if (!tab) return "";
    if (tab.kind === "table") return `${tab.table} · ${tab.rows?.rows.length ?? 0} 行`;
    if (tab.kind === "query") return `${tab.title} · ${tab.result?.rows.length ?? 0} 行`;
    return `${tab.title} · ${(state.tables()[tab.database] || []).filter(item => item.kind === "BASE TABLE").length} 张表`;
  });

  return (
    <div class="db-workspace" onClick={() => state.setMenu(null)} onContextMenu={event => {
      event.preventDefault();
      state.setMenu({ x: event.clientX, y: event.clientY, kind: "workspace" });
    }}>
      <ObjectTreePane
        state={state}
        databaseLabel={databaseLabel()}
        activeObject={activeObject()}
        onActivateDatabase={database => void activateDatabase(database)}
        onOpenTable={(database, table) => void loadTable(database, table)}
        onCreateDatabase={() => void showCreateDatabase()}
        onRefresh={() => void refreshDatabases()}
        onContextMenu={menu => state.setMenu(menu)}
      />

      <main class="db-main" onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        state.setMenu({ x: event.clientX, y: event.clientY, kind: "workspace" });
      }}>
        <WorkspaceTabBar
          tabs={state.tabs()}
          activeId={state.activeId()}
          onSelect={id => state.setActiveId(id)}
          onClose={id => void closeTab(id)}
          onNewQuery={() => newQuery()}
        />

        <Show when={state.error()}>
          <div class="db-error">
            <Icon name="alert" size={13} />
            <span>{state.error()}</span>
            <button class="db-icon-btn" aria-label="关闭错误提示" onClick={() => state.setError("")}><Icon name="close" size={12} /></button>
          </div>
        </Show>

        <div class="db-main-body">
          <div class="db-content">
            <Show when={!activeTab()}>
              <div class="db-empty">
                <span class="db-empty-icon"><Icon name="database" size={22} /></span>
                <h3>选择数据库、表或新建查询</h3>
                <p>对象会在这里以可关闭的标签打开；双击对象树里的表直接进入数据页。</p>
                <button class="db-btn is-primary" onClick={() => newQuery()}><Icon name="query" size={13} />新建 SQL 查询</button>
              </div>
            </Show>

            {/* key 用标签 id：patchTab 会替换标签对象，若以对象为 key，每次改状态都会重建整棵子树 */}
            <Show when={activeTab()?.kind === "database" ? activeTab()!.id : null} keyed>
              {(id: string) => {
                const tab = createMemo(() => state.tabs().find(item => item.id === id) as Extract<WorkspaceTab, { kind: "database" }> | undefined);
                return <Show when={tab()}>{(current: () => Extract<WorkspaceTab, { kind: "database" }>) => <ObjectPanel
                  state={state}
                  connectionId={props.connection.id}
                  tab={current()}
                  tables={state.tables()[current().database] || []}
                  viewCount={(state.tables()[current().database] || []).filter(item => item.kind === "VIEW").length}
                  onOpenTable={(database, table) => void loadTable(database, table)}
                  onNewTable={database => newTable(database)}
                  onNewQuery={database => newQuery(database)}
                  onRefresh={database => void refreshTables(database)}
                  onExportSql={database => void exportSql(database)}
                  onShowDdl={(database, table) => void openDdl(database, table)}
                />}</Show>;
              }}
            </Show>

            <Show when={activeTab()?.kind === "query" ? activeTab()!.id : null} keyed>
              {(id: string) => {
                const tab = createMemo(() => state.tabs().find(item => item.id === id) as QueryTab | undefined);
                return <Show when={tab()}>{(current: () => QueryTab) => (
                  <QueryPanel
                    tab={current()}
                    connection={props.connection}
                    databases={state.databases()}
                    readOnly={databaseReadOnly()}
                    running={state.runningTabId() === current().id}
                    onPatch={patch => state.patchTab(current().id, patch)}
                    onExecute={sql => void executeQuery(current(), sql)}
                    onStop={() => void stopQuery()}
                    onToggleReadOnly={() => setDatabaseReadOnly(!databaseReadOnly())}
                  />
                )}</Show>;
              }}
            </Show>

            <Show when={activeTab()?.kind === "table" ? activeTab()!.id : null} keyed>
              {(id: string) => {
                const tab = createMemo(() => state.tabs().find(item => item.id === id) as TableTab | undefined);
                return <Show when={tab()}>{(current: () => TableTab) => (
                  <TableWorkspace
                    state={state}
                    tab={current()}
                    protocol={protocol()}
                    running={state.runningTabId() === current().id}
                    readOnly={databaseReadOnly()}
                    actions={tableActions(current())}
                  />
                )}</Show>;
              }}
            </Show>
          </div>

          <Show when={infoOpen()}>
            <InfoPane
              tab={activeTab()}
              connectionInfo={{ protocol: protocol(), host: props.connection.host, port: props.connection.port, database: activeDatabase() }}
              onClose={() => setInfoOpen(false)}
            />
          </Show>
        </div>

        <StatusBar
          databaseLabel={databaseLabel()}
          database={activeDatabase()}
          objectText={objectText()}
          running={state.runningTabId() !== null}
          activity={state.loading() ? "正在加载…" : ""}
          readOnly={databaseReadOnly()}
          onToggleReadOnly={() => setDatabaseReadOnly(!databaseReadOnly())}
          infoOpen={infoOpen()}
          onToggleInfo={() => setInfoOpen(value => !value)}
        />
      </main>

      <Show when={ddlView()}>
        <div class="db-drawer-scrim" onClick={() => setDdlView(null)} />
        <aside class="db-drawer" role="dialog" aria-label="建表语句">
          <header>
            <div><strong>建表语句</strong><small>{ddlView()!.database} / {ddlView()!.table}</small></div>
            <button class="db-icon-btn" aria-label="关闭" title="关闭" onClick={() => setDdlView(null)}><Icon name="close" size={14} /></button>
          </header>
          <pre class="db-ddl">{ddlView()!.sql}</pre>
          <footer>
            <button class="db-text-btn" onClick={() => { void navigator.clipboard.writeText(ddlView()!.sql); feedback.success("已复制 DDL"); }}>复制</button>
            <button class="db-text-btn" onClick={() => setDdlView(null)}>关闭</button>
          </footer>
        </aside>
      </Show>

      <Show when={state.menu()}>
        <ContextMenu
          menu={state.menu()!}
          databaseLabel={databaseLabel()}
          onClose={() => state.setMenu(null)}
          actions={{
            createDatabase: () => void showCreateDatabase(),
            newQuery: database => newQuery(database),
            newTable: database => newTable(database),
            importSql: database => void chooseImport(database),
            exportSql: database => void exportSql(database),
            refreshDatabases: () => void refreshDatabases(),
            refreshTables: database => void refreshTables(database),
            openDatabase: database => void activateDatabase(database),
            openTable: (database, table) => void loadTable(database, table),
            designTable: (database, table) => void loadTable(database, table, "design"),
            copy: text => void navigator.clipboard.writeText(text),
            removeDatabase: database => void removeDatabase(database),
            tableAction: (action, database, table) => void tableAction(action, database, table),
            copyCreate: (database, table) => void api.databaseShowCreate(props.connection.id, database, table).then(sql => navigator.clipboard.writeText(sql)).then(() => feedback.success("建表 SQL 已复制")),
            closeConnection: () => props.onCloseConnection(),
          }}
        />
      </Show>

      <Show when={createDialog()}>
        {() => {
          const value = createDialog()!;
          const selected = state.charsets().find(item => item.name === value.charset);
          return <div class="db-dialog-backdrop">
            <div class="db-dialog" role="dialog" aria-label="新建数据库">
              <h2>新建数据库</h2>
              <label class="db-field-line"><span>数据库名称</span><input class="db-input" autofocus value={value.name} onInput={event => setCreateDialog({ ...value, name: event.currentTarget.value, error: "" })} /></label>
              <label class="db-field-line"><span>字符集</span>
                <select class="db-select" value={value.charset} onChange={event => {
                  const charset = state.charsets().find(item => item.name === event.currentTarget.value)!;
                  setCreateDialog({ ...value, charset: charset.name, collation: charset.default_collation, error: "" });
                }}>
                  <For each={state.charsets()}>{item => <option value={item.name}>{item.name} — {item.description}</option>}</For>
                </select>
              </label>
              <label class="db-field-line"><span>排序规则</span>
                <select class="db-select" value={value.collation} onChange={event => setCreateDialog({ ...value, collation: event.currentTarget.value, error: "" })}>
                  <For each={selected?.collations || []}>{item => <option value={item}>{item}</option>}</For>
                </select>
              </label>
              <Show when={value.error}><p class="db-dialog-error">{value.error}</p></Show>
              <footer>
                <button class="db-btn" onClick={() => setCreateDialog(null)}>取消</button>
                <button class="db-btn is-primary" disabled={state.loading()} onClick={() => void submitCreateDatabase()}>{state.loading() ? "创建中…" : "创建"}</button>
              </footer>
            </div>
          </div>;
        }}
      </Show>

      <Show when={importDialog()}>
        {() => {
          const value = importDialog()!;
          return <div class="db-dialog-backdrop">
            <div class="db-dialog" role="dialog" aria-label="导入 SQL 文件">
              <h2>导入 SQL 文件</h2>
              <label class="db-field-line"><span>文件</span><input class="db-input" value={value.path} readOnly /></label>
              <label class="db-field-line"><span>默认数据库</span>
                <select class="db-select" value={value.database} onChange={event => setImportDialog({ ...value, database: event.currentTarget.value })}>
                  <option value="">由 SQL 文件指定</option>
                  <For each={state.databases()}>{item => <option value={item.name}>{item.name}</option>}</For>
                </select>
              </label>
              <label class="db-checkbox">
                <input type="checkbox" checked={value.continueOnError} onChange={event => setImportDialog({ ...value, continueOnError: event.currentTarget.checked })} />
                遇到错误后继续执行
              </label>
              <p class="db-dialog-note">{databaseLabel()} 的 DDL 可能隐式提交，导入无法整体回滚。</p>
              <footer>
                <button class="db-btn" onClick={() => setImportDialog(null)}>取消</button>
                <button class="db-btn is-primary" disabled={state.loading()} onClick={() => void importSql()}>{state.loading() ? "导入中…" : "开始导入"}</button>
              </footer>
            </div>
          </div>;
        }}
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------

const blankDesignerFor = (database: string): DatabaseTableDefinition => ({
  database,
  name: "new_table",
  engine: "InnoDB",
  charset: "utf8mb4",
  comment: "",
  columns: [{ name: "id", column_type: "BIGINT", nullable: false, auto_increment: true, comment: "" }],
  indexes: [{ name: "PRIMARY", kind: "PRIMARY", columns: [{ name: "id", direction: "ASC" }] }],
  foreign_keys: [],
});

const columnWidthKey = (connectionId: string, database: string, table: string) =>
  `portnest.database.widths.${connectionId}.${database}.${table}`;

const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

type MenuActions = {
  createDatabase: () => void;
  newQuery: (database?: string) => void;
  newTable: (database: string) => void;
  importSql: (database?: string) => void;
  exportSql: (database: string) => void;
  refreshDatabases: () => void;
  refreshTables: (database: string) => void;
  openDatabase: (database: string) => void;
  openTable: (database: string, table: string) => void;
  designTable: (database: string, table: string) => void;
  copy: (text: string) => void;
  removeDatabase: (database: string) => void;
  tableAction: (action: "truncate" | "drop" | "rename" | "clone", database: string, table: string) => void;
  copyCreate: (database: string, table: string) => void;
  closeConnection: () => void;
};

const ContextMenu: Component<{ menu: ContextMenuState; databaseLabel: string; onClose: () => void; actions: MenuActions }> = props => (
  <div class="db-context" style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }} onClick={event => event.stopPropagation()} role="menu">
    <Show when={props.menu.kind === "workspace"}>
      <button onClick={() => props.actions.createDatabase()}>新建数据库</button>
      <button onClick={() => { props.actions.newQuery(); props.onClose(); }}>新建查询</button>
      <button onClick={() => props.actions.importSql()}>导入 SQL</button>
      <button onClick={() => { props.actions.refreshDatabases(); props.onClose(); }}>刷新数据库</button>
      <hr />
      <button class="is-danger" onClick={() => { props.onClose(); props.actions.closeConnection(); }}>关闭 {props.databaseLabel} 连接</button>
    </Show>
    <Show when={props.menu.kind === "database"}>
      <button onClick={() => { props.actions.openDatabase(props.menu.database!); props.onClose(); }}>打开数据库</button>
      <button onClick={() => { props.actions.newTable(props.menu.database!); props.onClose(); }}>新建表</button>
      <button onClick={() => { props.actions.newQuery(props.menu.database!); props.onClose(); }}>新建查询</button>
      <button onClick={() => props.actions.importSql(props.menu.database)}>导入 SQL</button>
      <button onClick={() => props.actions.exportSql(props.menu.database!)}>导出 SQL</button>
      <button onClick={() => { props.actions.refreshTables(props.menu.database!); props.onClose(); }}>刷新</button>
      <button onClick={() => props.actions.copy(props.menu.database!)}>复制名称</button>
      <hr />
      <button class="is-danger" onClick={() => props.actions.removeDatabase(props.menu.database!)}>删除数据库</button>
    </Show>
    <Show when={props.menu.kind === "table"}>
      <button onClick={() => { props.actions.openTable(props.menu.database!, props.menu.table!); props.onClose(); }}>打开数据</button>
      <button onClick={() => { props.actions.designTable(props.menu.database!, props.menu.table!); props.onClose(); }}>设计表</button>
      <button onClick={() => props.actions.tableAction("clone", props.menu.database!, props.menu.table!)}>新建相似表</button>
      <button onClick={() => props.actions.tableAction("rename", props.menu.database!, props.menu.table!)}>重命名</button>
      <button onClick={() => props.actions.copyCreate(props.menu.database!, props.menu.table!)}>复制建表 SQL</button>
      <button onClick={() => props.actions.copy(props.menu.table!)}>复制名称</button>
      <hr />
      <button class="is-danger" onClick={() => props.actions.tableAction("truncate", props.menu.database!, props.menu.table!)}>清空表</button>
      <button class="is-danger" onClick={() => props.actions.tableAction("drop", props.menu.database!, props.menu.table!)}>删除表</button>
    </Show>
  </div>
);

// 兼容旧引用：部分面板仍在用这几个纯函数
export { cellText, formatBytes };

// 保持文件末尾对未使用导入的显式引用，避免 tree-shaking 误删类型
void csvCell;
