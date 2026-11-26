import { Component, For, Show as SolidShow, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { readXlsx, rowsToCsv, writeXlsx, type SheetCell } from "../../utils/xlsx";
import {
  api,
  isPostgresCompatibleProtocol,
  type ConnectionRecord,
  type DatabaseTableChangeSet,
  type DatabaseTableDefinition,
  type DatabaseTableInfo,
} from "../../utils/api";
import { feedback } from "../../stores/feedbackStore";
import { aiContextStore } from "../../stores/aiContextStore";
import { Icon } from "../Icon";
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
import { databaseSettings } from "../../stores/databaseSettings";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { StatusBar } from "./StatusBar";
import { InfoPane } from "./InfoPane";
import { ObjectPanel } from "./objects/ObjectPanel";
import { ObjectInfoPane } from "./objects/ObjectInfoPane";
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
  type ContextMenuState,
  type DdlView,
  type FilterSpec,
  type ObjectScope,
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
  /** 单选的对象（`库:表`）：树和列表共用，只决定右侧「表信息」页内容，不代表已打开 */
  const [selectedObject, setSelectedObject] = createSignal("");
  const [objectInfoOpen, setObjectInfoOpen] = createSignal(false);

  const activeTab = createMemo(() => state.tabs().find(item => item.id === state.activeId()) ?? null);

  /**
   * 单击任何一张表：更新选中。信息栏是否跟着弹出由设置决定——
   * 关掉「单击表展开信息栏」后只高亮选中，需要看详情时切到「表信息」视图。
   */
  const selectObject = (database: string, table: string) => {
    if (!database || !table) { setSelectedObject(""); return; }
    setSelectedObject(`${database}:${table}`);
    if (databaseSettings().openInfoOnClick) setObjectInfoOpen(true);
  };

  /** 「表信息」整页视图里已经把属性铺开了，右侧信息页不再重复 */
  const detailViewOpen = createMemo(() => {
    const tab = activeTab();
    return tab?.kind === "database" && tab.view === "detail";
  });

  /** 右侧信息页展示的表：选中项里解析出来的库名 + 元数据 */
  const selectedTableInfo = createMemo(() => {
    const key = selectedObject();
    const separator = key.indexOf(":");
    if (separator <= 0) return null;
    const database = key.slice(0, separator);
    const name = key.slice(separator + 1);
    const info = (state.tables()[database] || []).find(item => item.name === name) ?? null;
    return { database, info };
  });

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

  /**
   * 按「表信息缓存」策略决定展开数据库时是否重新拉表列表：
   * - 连接时拉取：有缓存就直接用，只有首次展开才请求；
   * - 展开时刷新：每次展开都请求，旧数据保留到新数据返回；
   * - 不缓存：每次展开都请求，并先清空旧列表，避免展示过期结构。
   */
  const pendingTableLoads = new Set<string>();
  const ensureTables = (database: string) => {
    const mode = databaseSettings().tableCache;
    const cached = state.tables()[database];
    if (cached && mode === "on-connect") return Promise.resolve();
    if (pendingTableLoads.has(database)) return Promise.resolve();
    if (mode === "off" && cached) {
      state.setTables(previous => {
        const next = { ...previous };
        delete next[database];
        return next;
      });
    }
    pendingTableLoads.add(database);
    return refreshTables(database).catch(() => undefined).finally(() => pendingTableLoads.delete(database));
  };

  /** 自动展开只在首次拿到库列表时执行一次，后续刷新不打扰用户手动折叠 */
  let autoExpandApplied = false;

  const refreshDatabases = async () => {
    const data = await run(() => api.databaseListDatabases(props.connection.id));
    state.setDatabases(data);
    const names = new Set(data.map(item => item.name));
    state.setTabs(items => {
      const next = items.filter(item => !item.database || names.has(item.database));
      if (!next.some(item => item.id === state.activeId())) state.setActiveId(next[0]?.id || "");
      return next;
    });
    // 首次加载：按「打开连接时自动展开」把数据库展开到「表 / 视图」分组这一层，
    // 只展开直接子项，不继续向下钻（与对象树的分级展开规则一致）。
    if (!autoExpandApplied) {
      autoExpandApplied = true;
      if (databaseSettings().autoExpandOnConnect) data.forEach(item => state.expandDatabase(item.name));
    }
    await Promise.all(Object.keys(state.expanded()).filter(name => names.has(name)).map(name => refreshTables(name).catch(() => undefined)));
  };

  createEffect(() => { if (props.visible && state.databases().length === 0) void refreshDatabases().catch(() => undefined); });

  const activateDatabase = async (database: string, scope: ObjectScope = "all") => {
    // 切到别的库时，底部信息卡里的表已经不在视野内，清掉避免张冠李戴
    setSelectedObject(previous => previous.startsWith(`${database}:`) ? previous : "");
    // 单击只切换右侧内容区：不展开任何节点，展开状态完全由箭头 / 双击控制
    const id = `database:${database}`;
    const existing = state.tabs().find(item => item.id === id) as Extract<WorkspaceTab, { kind: "database" }> | undefined;
    if (existing) {
      state.setActiveId(id);
      if ((existing.objectScope ?? "all") !== scope) state.patchTab(id, { objectScope: scope });
    } else {
      state.openTab(makeDatabaseTab(database, scope));
    }
    if (!state.tables()[database]) await ensureTables(database);
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
    setSelectedObject(`${database}:${table}`);
    const id = `table:${database}:${table}`;
    const existing = state.tabs().find(item => item.id === id) as TableTab | undefined;
    if (existing) {
      state.setActiveId(id);
      if (section === "design" && !existing.designer) { void startDesign(existing); return; }
      if (section !== existing.section) state.patchTab(id, { section });
      return;
    }
    const [columns, indexes, rows, foreignKeys] = await run(() => Promise.all([
      api.databaseListColumns(props.connection.id, database, table),
      api.databaseListIndexes(props.connection.id, database, table),
      api.databaseFetchRows(props.connection.id, database, table, 1, 100),
      // 外键读失败不影响打开表：结构页的那一块会自己隐藏
      api.databaseListForeignKeys(props.connection.id, database, table).catch(() => []),
    ]));
    const tab = makeTableTab({ database, table, section, columns, indexes, foreignKeys });
    state.openTab({ ...tab, rows });
    void countRows(tab);
    if (section === "design") {
      const opened = state.tabs().find(item => item.id === id) as TableTab | undefined;
      if (opened) void startDesign(opened);
    }
  };

  /** 统计总行数：只在没有筛选条件时统计（带 WHERE 的全表 count 需要完整条件拼装，当前不猜） */
  const countRows = async (tab: TableTab) => {
    if (!databaseSettings().statTotalRows) return;
    if (tab.filters.conditions.length > 0) {
      state.patchTab(tab.id, { totalRows: null, totalLoading: false });
      return;
    }
    const quote = (name: string) => props.connection.protocol === "mysql"
      ? "`" + name.replace(/`/g, "``") + "`"
      : '"' + name.replace(/"/g, '""') + '"';
    state.patchTab(tab.id, { totalLoading: true });
    try {
      const result = await api.databaseExecuteSql(props.connection.id, `SELECT COUNT(*) AS total FROM ${quote(tab.database)}.${quote(tab.table)}`, tab.database);
      const raw = result.rows[0]?.values?.[0];
      const total = Number(raw);
      state.patchTab(tab.id, { totalRows: Number.isFinite(total) ? total : null, totalLoading: false });
    } catch {
      state.patchTab(tab.id, { totalRows: null, totalLoading: false });
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
        // 首页与刷新时重算；翻页沿用已有总数，避免每页都扫一次全表
        if (page === 1 || target.totalRows === undefined) void countRows(target);
      }
    } catch { /* run() 已展示错误 */ }
  };

  const reloadTab = (id: string) => {
    const tab = state.tabs().find(item => item.id === id) as TableTab | undefined;
    if (tab) void loadPage(tab, 1);
  };

  /**
   * 设置页改动后让已经打开的表立刻跟上。
   * 这几项不会自动响应：分页大小决定取多少行、总行数开关决定要不要统计、
   * 缓存策略决定表列表从哪来。其余项（对齐、复合表头、冻结主键、字体）
   * 都是按钮/样式层直接读 signal，不需要在这里处理。
   */
  let appliedSettings = { ...databaseSettings() };
  createEffect(() => {
    const current = databaseSettings();
    const previous = appliedSettings;
    appliedSettings = { ...current };
    const pageSizeChanged = previous.pageSize !== current.pageSize;
    const totalChanged = previous.statTotalRows !== current.statTotalRows;
    const cacheChanged = previous.tableCache !== current.tableCache;
    if (!pageSizeChanged && !totalChanged && !cacheChanged) return;

    if (pageSizeChanged) {
      for (const item of state.tabs()) {
        if (item.kind !== "table") continue;
        // 分页大小是存在标签上的，先同步再重新取数，否则还是按旧页长请求
        state.patchTab(item.id, { pageSize: current.pageSize, page: 1 });
        reloadTab(item.id);
      }
    }
    if (totalChanged) {
      for (const item of state.tabs()) {
        if (item.kind !== "table") continue;
        if (current.statTotalRows) void countRows(item as TableTab);
        else state.patchTab(item.id, { totalRows: null });
      }
    }
    if (cacheChanged) state.setTables(() => ({}));
  });

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
      // 只展开新建库的直接子项（表 / 视图分组），不继续向下钻
      state.expandDatabase(value.name.trim());
    } catch (cause) { setCreateDialog({ ...value, error: String(cause) }); }
  };

  const chooseImport = async (database = "") => {
    const path = await open({ multiple: false, directory: false, title: "选择 SQL 文件", filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (typeof path === "string") setImportDialog({ path, database, continueOnError: false });
    state.setMenu(null);
  };  const importSql = async () => {
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

  /** 单表导出：结构 + 全部数据，后端只会写这一张表 */
  const exportTableSql = async (database: string, table: string) => {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await save({ title: `导出表 ${table}`, defaultPath: `${table}-${stamp}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    state.setMenu(null);
    if (!path) return;
    const result = await run(() => api.databaseExportSql(props.connection.id, path, database, table));
    feedback.success(`导出完成：${result.tables} 张表，${result.rows} 行数据`);
  };

  /** 单表导入 CSV：不需要先打开表标签，直接按库.表写入 */
  const importTableCsv = async (database: string, table: string) => {
    state.setMenu(null);
    const path = await open({ multiple: false, directory: false, title: `导入 CSV 到 ${table}`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof path !== "string") return;
    let content: string;
    try {
      const bytes = await readFile(path);
      content = new TextDecoder("utf-8").decode(bytes);
    } catch (cause) {
      feedback.error(`读取 CSV 失败：${String(cause)}`);
      return;
    }
    if (!await feedback.confirm(`将把 ${path.split(/[\\/]/).pop()} 导入 ${database}.${table}，事务内执行，任一行失败整体回滚。继续吗？`, "导入 CSV")) return;
    try {
      const count = await run(() => api.databaseImportCsv(props.connection.id, database, table, content));
      feedback.success(`已导入 ${count} 行`);
      await refreshTables(database);
      const tab = state.tabs().find(item => item.kind === "table" && item.database === database && item.table === table) as TableTab | undefined;
      if (tab) await loadPage(tab, 1);
    } catch { /* run() 已展示错误 */ }
  };

  /** 整表取数：CSV / Excel 导出要的是「整张表」，按页拉取直到取空或触顶 */
  const fetchAllRows = async (database: string, table: string, limit = 100_000) => {
    const pageSize = 1000;
    const values: unknown[][] = [];
    let columns: string[] = [];
    for (let page = 1; values.length < limit; page += 1) {
      const result = await api.databaseFetchRows(props.connection.id, database, table, page, pageSize);
      if (page === 1) columns = result.columns;
      if (result.rows.length === 0) break;
      for (const row of result.rows) values.push(row.values);
      if (result.rows.length < pageSize) break;
    }
    return { columns, values };
  };

  /** 导出 CSV：整表数据，带 BOM 便于 Excel 直接双击打开 */
  const exportTableCsv = async (database: string, table: string) => {
    state.setMenu(null);
    try {
      const { columns, values } = await fetchAllRows(database, table);
      if (values.length === 0) { feedback.info("这张表没有数据"); return; }
      const content = [columns.map(csvCell).join(","), ...values.map(row => row.map(csvCell).join(","))].join("\r\n");
      download(`${table}.csv`, "\uFEFF" + content, "text/csv;charset=utf-8");
      feedback.success(`已导出 ${values.length} 行`);
    } catch (cause) {
      feedback.error(`导出 CSV 失败：${String(cause)}`);
    }
  };

  /** 导出 Excel：首行列名，其余按值类型写入（数字仍是数字，不变成文本） */
  const exportTableExcel = async (database: string, table: string) => {
    state.setMenu(null);
    try {
      const { columns, values } = await fetchAllRows(database, table);
      if (columns.length === 0) { feedback.info("这张表没有可导出的列"); return; }
      const sheet: SheetCell[][] = [columns, ...values.map(row => row.map(cell => toSheetCell(cell)))];
      downloadBytes(
        `${table}.xlsx`,
        writeXlsx(table, sheet),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      feedback.success(`已导出 ${values.length} 行`);
    } catch (cause) {
      feedback.error(`导出 Excel 失败：${String(cause)}`);
    }
  };

  /**
   * 导入 Excel：解析第一张工作表 → 转成 CSV → 复用已有的 CSV 导入事务。
   * 这样「表头必须是已存在的列」「整表回滚」这些约束和 CSV 导入完全一致。
   */
  const importTableExcel = async (database: string, table: string) => {
    state.setMenu(null);
    const path = await open({
      multiple: false,
      directory: false,
      title: `导入 Excel 到 ${table}`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (typeof path !== "string") return;
    let rows: string[][];
    try {
      rows = await readXlsx(await readFile(path));
    } catch (cause) {
      feedback.error(`读取 Excel 失败：${String(cause)}`);
      return;
    }
    if (rows.length < 2) { feedback.info("表格里没有数据行：首行必须是列名，其后是数据"); return; }
    const fileName = path.split(/[\\/]/).pop() ?? "Excel";
    if (!await feedback.confirm(`将把 ${fileName} 的第一张工作表（${rows.length - 1} 行）导入 ${database}.${table}，首行按列名匹配，任一行失败整体回滚。继续吗？`, "导入 Excel")) return;
    try {
      const count = await run(() => api.databaseImportCsv(props.connection.id, database, table, rowsToCsv(rows)));
      feedback.success(`已导入 ${count} 行`);
      await refreshTables(database);
      const tab = state.tabs().find(item => item.kind === "table" && item.database === database && item.table === table) as TableTab | undefined;
      if (tab) await loadPage(tab, 1);
    } catch { /* run() 已展示错误 */ }
  };

  /** 右键菜单统一入口：kind 决定弹哪种文件对话框 */
  const importTableFile = (database: string, table: string, kind: "sql" | "csv" | "excel") => {
    if (kind === "sql") void chooseImport(database);
    else if (kind === "csv") void importTableCsv(database, table);
    else void importTableExcel(database, table);
  };

  const exportTableFile = (database: string, table: string, kind: "sql" | "csv" | "excel") => {
    if (kind === "sql") void exportTableSql(database, table);
    else if (kind === "csv") void exportTableCsv(database, table);
    else void exportTableExcel(database, table);
  };

  const removeDatabase = async (database: string) => {    if (await feedback.prompt(`删除数据库将永久删除全部对象。请输入 ${database} 确认：`, "", "删除数据库") !== database) return;
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
      const batch = await run(() => api.databaseExecuteSqlBatch(props.connection.id, sql, tab.database, databaseSettings().stopOnError));
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

  /** 内容区当前对应的展示范围：数据库节点为 all，「表 / 视图」分组对应各自范围 */
  const activeScope = createMemo<ObjectScope>(() => {
    const tab = activeTab();
    return tab?.kind === "database" ? (tab.objectScope ?? "all") : "all";
  });

  const objectText = createMemo(() => {
    const tab = activeTab();
    if (!tab) return "";
    if (tab.kind === "table") return `${tab.table} · ${tab.rows?.rows.length ?? 0} 行`;
    if (tab.kind === "query") return `${tab.title} · ${tab.result?.rows.length ?? 0} 行`;
    // 数据库级标签：库名已经在左边单独显示一格，这里只补给对象数量，避免「sakila sakila」重复
    return `${(state.tables()[tab.database] || []).filter(item => item.kind === "BASE TABLE").length} 张表`;
  });

  return (
    <div class="db-workspace" onClick={() => state.setMenu(null)} onContextMenu={event => {
      event.preventDefault();
      state.setMenu({ x: event.clientX, y: event.clientY, kind: "workspace" });
    }}>
      <ObjectTreePane
        state={state}
        connectionTitle={props.connection.name || databaseLabel()}
        connectionMeta={`${databaseLabel()} · ${props.connection.host}:${props.connection.port}`}
        databaseLabel={databaseLabel()}
        activeObject={activeObject()}
        activeScope={activeScope()}
        selectedObject={selectedObject()}
        onSelectScope={(database, scope) => void activateDatabase(database, scope)}
        onSelectObject={key => {
          const separator = key.indexOf(":");
          if (separator > 0) selectObject(key.slice(0, separator), key.slice(separator + 1));
          else setSelectedObject("");
        }}
        onOpenTable={(database, table) => void loadTable(database, table)}
        onEnsureTables={database => void ensureTables(database)}
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
          connectionName={props.connection.name}
          activeId={state.activeId()}
          onSelect={id => state.setActiveId(id)}
          onClose={id => void closeTab(id)}
          onNewQuery={() => newQuery()}
        />

        <Show when={state.error()}>
          <div class="db-error">
            <Icon name="alert" size={14} />
            <span>{state.error()}</span>
            <button class="db-icon-btn" aria-label="关闭错误提示" onClick={() => state.setError("")}><Icon name="close" size={14} /></button>
          </div>
        </Show>

        <div class="db-main-body">
          <div class="db-content">
            <Show when={!activeTab()}>
              <div class="db-empty">
                <span class="db-empty-icon"><Icon name="database" size={24} /></span>
                <h3>选择数据库、表或新建查询</h3>
                <p>对象会在这里以可关闭的标签打开；双击对象树里的表直接进入数据页。</p>
                <button class="db-btn is-primary" onClick={() => newQuery()}><Icon name="query" size={14} />新建 SQL 查询</button>
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
                  selectedTable={selectedObject().startsWith(`${current().database}:`) ? selectedObject().slice(current().database.length + 1) : null}
                  onSelectTable={(database, table) => selectObject(database, table)}
                  onOpenTable={(database, table) => void loadTable(database, table)}
                  onDesignTable={(database, table) => void loadTable(database, table, "design")}
                  onDropTable={(database, table) => void tableAction("drop", database, table)}
                  onImportTable={(database, table) => void importTableCsv(database, table)}
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

          <Show when={objectInfoOpen() && !detailViewOpen() && selectedTableInfo()}>
            {(selection: () => { database: string; info: DatabaseTableInfo }) => (
              <ObjectInfoPane
                database={selection().database}
                table={selection().info}
                onClose={() => setObjectInfoOpen(false)}
              />
            )}
          </Show>

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
            <button class="db-icon-btn" aria-label="关闭" title="关闭" onClick={() => setDdlView(null)}><Icon name="close" size={16} /></button>
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
            importTableCsv: (database, table) => void importTableCsv(database, table),
            importTableFile,
            exportTableFile,
            exportTableSql: (database, table) => void exportTableSql(database, table),
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

/** 二进制版本（xlsx），Blob 直接吃 Uint8Array */
const downloadBytes = (name: string, bytes: Uint8Array, type: string) => {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

/** 数据库值 → 表格单元格：数字保留数字类型，对象转 JSON，NULL 留空 */
const toSheetCell = (value: unknown): SheetCell => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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
  importTableCsv: (database: string, table: string) => void;
  exportTableSql: (database: string, table: string) => void;
  /** 右键菜单的「导入 / 导出」子菜单统一入口，kind 决定文件类型 */
  importTableFile: (database: string, table: string, kind: "sql" | "csv" | "excel") => void;
  exportTableFile: (database: string, table: string, kind: "sql" | "csv" | "excel") => void;
  copy: (text: string) => void;
  removeDatabase: (database: string) => void;
  tableAction: (action: "truncate" | "drop" | "rename" | "clone", database: string, table: string) => void;
  copyCreate: (database: string, table: string) => void;
  closeConnection: () => void;
};

const ContextMenu: Component<{ menu: ContextMenuState; databaseLabel: string; onClose: () => void; actions: MenuActions }> = props => {
  const [position, setPosition] = createSignal({ left: props.menu.x, top: props.menu.y });
  const [flipSubmenu, setFlipSubmenu] = createSignal(false);
  let element: HTMLDivElement | undefined;

  // 先按光标位置渲染，再按实际尺寸校正一次：
  // 右边放不下就翻到光标左侧，下面放不下就整体上移，保证整块菜单都在视口内。
  onMount(() => {
    const rect = element?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    let left = props.menu.x;
    let top = props.menu.y;
    if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, props.menu.x - rect.width);
    if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - rect.height - margin);
    setPosition({ left, top });
    // 二级菜单默认向右展开，右侧空间不足时改成向左
    setFlipSubmenu(left + rect.width + 200 > window.innerWidth);
  });

  // 左键点在菜单之外（任意区域，包括资产树、工具栏、标签栏之外的空白）都关闭；
  // 右键按下不处理——那是「换个目标重新开菜单」，交给 contextmenu 事件自己覆盖。
  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (element?.contains(event.target as Node)) return;
      props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    });
  });

  const run = (action: () => void) => {
    props.onClose();
    action();
  };

  return (
    <div
      ref={element}
      class={`db-context ${flipSubmenu() ? "is-flip-submenu" : ""}`}
      style={{ left: `${position().left}px`, top: `${position().top}px` }}
      onClick={event => event.stopPropagation()}
      role="menu"
    >
      <Show when={props.menu.kind === "workspace"}>
        <button onClick={() => run(() => props.actions.createDatabase())}>新建数据库</button>
        <button onClick={() => run(() => props.actions.newQuery())}>新建查询</button>
        <button onClick={() => run(() => props.actions.importSql())}>导入 SQL</button>
        <button onClick={() => run(() => props.actions.refreshDatabases())}>刷新数据库</button>
        <hr />
        <button class="is-danger" onClick={() => run(() => props.actions.closeConnection())}>关闭 {props.databaseLabel} 连接</button>
      </Show>

      <Show when={props.menu.kind === "database"}>
        <button onClick={() => run(() => props.actions.openDatabase(props.menu.database!))}>打开数据库</button>
        <button onClick={() => run(() => props.actions.newTable(props.menu.database!))}>新建表</button>
        <button onClick={() => run(() => props.actions.newQuery(props.menu.database!))}>新建查询</button>
        <hr />
        <button onClick={() => run(() => props.actions.importSql(props.menu.database))}>导入 SQL…</button>
        <button onClick={() => run(() => props.actions.exportSql(props.menu.database!))}>导出整个库（SQL）…</button>
        <hr />
        <button onClick={() => run(() => props.actions.refreshTables(props.menu.database!))}>刷新</button>
        <button onClick={() => run(() => props.actions.copy(props.menu.database!))}>复制名称</button>
        <hr />
        <button class="is-danger" onClick={() => run(() => props.actions.removeDatabase(props.menu.database!))}>删除数据库</button>
      </Show>

      <Show when={props.menu.kind === "table"}>
        <button onClick={() => run(() => props.actions.openTable(props.menu.database!, props.menu.table!))}>打开数据</button>
        <button onClick={() => run(() => props.actions.designTable(props.menu.database!, props.menu.table!))}>设计表</button>
        <hr />

        {/* 导入：三种格式，子菜单里选，避免主菜单一行放三个「导入 …」 */}
        <div class="db-context-sub">
          <button class="has-sub" type="button">
            <span>导入</span>
            <Icon name="chevronRight" size={12} class="db-sub-caret" />
          </button>
          <div class="db-submenu" role="menu">
            <button onClick={() => run(() => props.actions.importTableFile(props.menu.database!, props.menu.table!, "sql"))}>SQL 文件…</button>
            <button onClick={() => run(() => props.actions.importTableFile(props.menu.database!, props.menu.table!, "csv"))}>CSV 文件…</button>
            <button onClick={() => run(() => props.actions.importTableFile(props.menu.database!, props.menu.table!, "excel"))}>Excel 文件…</button>
          </div>
        </div>

        {/* 导出：SQL 走服务端；CSV / Excel 走前端整表取数 */}
        <div class="db-context-sub">
          <button class="has-sub" type="button">
            <span>导出</span>
            <Icon name="chevronRight" size={12} class="db-sub-caret" />
          </button>
          <div class="db-submenu" role="menu">
            <button onClick={() => run(() => props.actions.exportTableFile(props.menu.database!, props.menu.table!, "sql"))}>SQL 脚本…</button>
            <button onClick={() => run(() => props.actions.exportTableFile(props.menu.database!, props.menu.table!, "csv"))}>CSV 文件…</button>
            <button onClick={() => run(() => props.actions.exportTableFile(props.menu.database!, props.menu.table!, "excel"))}>Excel 文件…</button>
          </div>
        </div>

        <hr />
        <button onClick={() => run(() => props.actions.tableAction("clone", props.menu.database!, props.menu.table!))}>新建相似表</button>
        <button onClick={() => run(() => props.actions.tableAction("rename", props.menu.database!, props.menu.table!))}>重命名</button>
        <button onClick={() => run(() => props.actions.copyCreate(props.menu.database!, props.menu.table!))}>复制建表 SQL</button>
        <button onClick={() => run(() => props.actions.copy(props.menu.table!))}>复制名称</button>
        <hr />
        <button class="is-danger" onClick={() => run(() => props.actions.tableAction("truncate", props.menu.database!, props.menu.table!))}>清空表</button>
        <button class="is-danger" onClick={() => run(() => props.actions.tableAction("drop", props.menu.database!, props.menu.table!))}>删除表</button>
      </Show>
    </div>
  );
};

// 兼容旧引用：部分面板仍在用这几个纯函数
export { cellText, formatBytes };

// 保持文件末尾对未使用导入的显式引用，避免 tree-shaking 误删类型
void csvCell;
