import { Component, For, Index, Show as SolidShow, createEffect, createMemo, createSignal } from "solid-js";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type ConnectionRecord, type MysqlCharsetInfo, type MysqlColumnDefinition, type MysqlColumnInfo, type MysqlIndexDefinition, type MysqlIndexInfo, type MysqlAutocompleteItem, type MysqlExplainResult, type MysqlTableChangeSet, type MysqlTableDefinition, type MysqlTableInfo, type QueryResult } from "../utils/api";
import { feedback } from "../stores/feedbackStore";
import { formatSql } from "../utils/sqlFormat";
import { Icon } from "./Icon";
import "./MysqlWorkspace.css";

interface Props { connection: ConnectionRecord; visible: boolean; onCloseConnection: () => void }
const Show = SolidShow as unknown as Component<any>;
type TableSection = "data" | "structure" | "design" | "transfer";
type DatabaseTab = { id: string; kind: "database"; title: string; database: string; view: "list" | "icons" };
type QueryTab = { id: string; kind: "query"; title: string; database: string; sql: string; result: QueryResult | null; dirty: boolean };
type TableTab = { id: string; kind: "table"; title: string; database: string; table: string; section: TableSection; page: number; columns: MysqlColumnInfo[]; indexes: MysqlIndexInfo[]; rows: QueryResult | null; designer: MysqlTableDefinition | null; preview: string[]; dirty: boolean; isNew?: boolean };
type WorkspaceTab = DatabaseTab | QueryTab | TableTab;
type ContextMenu = { x: number; y: number; kind: "workspace" | "database" | "table"; database?: string; table?: string };

const cellText = (value: unknown) => value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);
const csvCell = (value: unknown) => {
  if (value === null) return "\\N";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
const blankDesigner = (database: string): MysqlTableDefinition => ({ database, name: "new_table", engine: "InnoDB", charset: "utf8mb4", comment: "", columns: [{ name: "id", column_type: "BIGINT", nullable: false, auto_increment: true, comment: "" }], indexes: [{ name: "PRIMARY", kind: "PRIMARY", columns: [{ name: "id", direction: "ASC" }] }] });

export const MysqlWorkspace: Component<Props> = props => {
  const [databases, setDatabases] = createSignal<Array<{ name: string; charset?: string; collation?: string }>>([]);
  const [tables, setTables] = createSignal<Record<string, MysqlTableInfo[]>>({});
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());
  const [tabs, setTabs] = createSignal<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = createSignal("");
  const [queryCounter, setQueryCounter] = createSignal(0);
  const [filter, setFilter] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [menu, setMenu] = createSignal<ContextMenu | null>(null);
  const [charsets, setCharsets] = createSignal<MysqlCharsetInfo[]>([]);
  const [createDialog, setCreateDialog] = createSignal<{ name: string; charset: string; collation: string; error: string } | null>(null);
  const [importDialog, setImportDialog] = createSignal<{ path: string; database: string; continueOnError: boolean } | null>(null);
  const pageRequests = new Map<string, number>();
  const [runningQueryId, setRunningQueryId] = createSignal<string | null>(null);
  const [readOnly, setReadOnly] = createSignal(localStorage.getItem("portnest.mysql.readOnly") === "1");
  const queryRequests = new Map<string, number>();

  const activeTab = createMemo(() => tabs().find(item => item.id === activeId()) || null);
  const activeDatabase = createMemo(() => activeTab()?.database || "");
  const run = async <T,>(job: () => Promise<T>) => { setLoading(true); setError(""); try { return await job(); } catch (cause) { setError(String(cause)); throw cause; } finally { setLoading(false); } };
  const patchTab = (id: string, patch: Partial<WorkspaceTab>) => setTabs(items => items.map(item => item.id === id ? { ...item, ...patch } as WorkspaceTab : item));

  const refreshTables = async (database: string) => { const data = await run(() => api.mysqlListTables(props.connection.id, database)); setTables(previous => ({ ...previous, [database]: data })); };
  const refreshDatabases = async () => {
    const data = await run(() => api.mysqlListDatabases(props.connection.id)); setDatabases(data);
    const names = new Set(data.map(item => item.name));
    setTabs(items => {
      const next = items.filter(item => !item.database || names.has(item.database));
      if (!next.some(item => item.id === activeId())) setActiveId(next[0]?.id || "");
      return next;
    });
    await Promise.all([...expanded()].filter(name => names.has(name)).map(name => refreshTables(name).catch(() => undefined)));
  };
  createEffect(() => { if (props.visible && databases().length === 0) void refreshDatabases().catch(() => undefined); });

  const activateDatabase = async (database: string) => {
    const id = `database:${database}`;
    if (!tabs().some(item => item.id === id)) setTabs(items => [...items, { id, kind: "database", title: database, database, view: "list" }]);
    setActiveId(id); setExpanded(value => new Set(value).add(database));
    setExpandedGroups(value => new Set(value).add(`${database}:tables`).add(`${database}:views`));
    await refreshTables(database);
  };
  const makeDesigner = (database: string, table: string, columns: MysqlColumnInfo[], indexes: MysqlIndexInfo[]): MysqlTableDefinition => {
    const grouped = new Map<string, MysqlIndexDefinition>();
    for (const index of indexes) {
      if (!index.column) continue;
      const kind = index.name === "PRIMARY" ? "PRIMARY" : index.unique ? "UNIQUE" : "INDEX";
      const item = grouped.get(index.name) || { name: index.name, kind, columns: [] } as MysqlIndexDefinition;
      item.columns.push({ name: index.column, prefix_length: index.prefix_length, direction: index.direction === "D" ? "DESC" : "ASC" });
      grouped.set(index.name, item);
    }
    const info = tables()[database]?.find(item => item.name === table);
    const tableCollation = info?.collation;
    return {
      database,
      name: table,
      original_name: table,
      engine: info?.engine || "InnoDB",
      charset: tableCollation?.split("_")[0] || columns.find(item => item.charset)?.charset || "utf8mb4",
      collation: tableCollation,
      comment: info?.comment || "",
      columns: columns.map(item => ({
        name: item.name,
        column_type: item.column_type,
        nullable: item.nullable,
        default_value: item.default_value,
        auto_increment: item.extra.includes("auto_increment"),
        charset: item.charset,
        collation: item.collation,
        comment: item.comment,
        generation_expression: item.generation_expression,
        extra: item.extra,
      })),
      indexes: [...grouped.values()],
    };
  };
  const loadTable = async (database: string, table: string, section: TableSection = "data") => {
    const id = `table:${database}:${table}`; const existing = tabs().find(item => item.id === id) as TableTab | undefined;
    if (existing) { setActiveId(id); if (section === "design") patchTab(id, { section, designer: existing.designer || makeDesigner(database, table, existing.columns, existing.indexes) }); else if (section !== "data") patchTab(id, { section }); return; }
    const [columns, indexes, rows] = await run(() => Promise.all([api.mysqlListColumns(props.connection.id, database, table), api.mysqlListIndexes(props.connection.id, database, table), api.mysqlFetchRows(props.connection.id, database, table, 1, 100)]));
    setTabs(items => [...items, { id, kind: "table", title: table, database, table, section, page: 1, columns, indexes, rows, designer: section === "design" ? makeDesigner(database, table, columns, indexes) : null, preview: [], dirty: false }]); setActiveId(id);
  };
  const newQuery = (database = activeDatabase()) => { const number = queryCounter() + 1; setQueryCounter(number); const id = `query:${number}:${Date.now()}`; setTabs(items => [...items, { id, kind: "query", title: `查询 ${number}`, database, sql: "SELECT 1;", result: null, dirty: false }]); setActiveId(id); };
  const newTable = (database: string) => { const id = `new-table:${database}:${Date.now()}`; setTabs(items => [...items, { id, kind: "table", title: "新建表", database, table: "new_table", section: "design", page: 1, columns: [], indexes: [], rows: null, designer: blankDesigner(database), preview: [], dirty: true, isNew: true }]); setActiveId(id); };

  const closeTab = async (id: string) => {
    const items = tabs(); const index = items.findIndex(item => item.id === id); if (index < 0) return; const target = items[index];
    if (target.kind !== "database" && target.dirty && !await feedback.confirm(target.kind === "query" ? "SQL 查询尚未保存，确定关闭并丢弃内容吗？" : "表设计尚未应用，确定关闭并丢弃修改吗？", "关闭标签")) return;
    const next = items.filter(item => item.id !== id); setTabs(next); if (activeId() === id) setActiveId(next[Math.max(0, index - 1)]?.id || next[0]?.id || "");
  };
  const toggleDatabase = (database: string) => { const opened = expanded().has(database); setExpanded(value => { const next = new Set(value); opened ? next.delete(database) : next.add(database); return next; }); if (!opened && !tables()[database]) void refreshTables(database).catch(() => undefined); };
  const toggleGroup = (database: string, group: "tables" | "views") => { const key = `${database}:${group}`; setExpandedGroups(value => { const next = new Set(value); next.has(key) ? next.delete(key) : next.add(key); return next; }); };

  const showCreateDatabase = async () => {
    if (!charsets().length) setCharsets(await run(() => api.mysqlListCharsets(props.connection.id)));
    const utf8 = charsets().find(item => item.name === "utf8mb4") || charsets()[0];
    setCreateDialog({ name: "", charset: utf8?.name || "utf8mb4", collation: utf8?.default_collation || "", error: "" }); setMenu(null);
  };
  const submitCreateDatabase = async () => { const value = createDialog(); if (!value) return; if (!value.name.trim()) { setCreateDialog({ ...value, error: "数据库名称不能为空" }); return; } try { await run(() => api.mysqlCreateDatabase(props.connection.id, value.name.trim(), value.charset, value.collation)); setCreateDialog(null); await refreshDatabases(); await activateDatabase(value.name.trim()); } catch (cause) { setCreateDialog({ ...value, error: String(cause) }); } };

  const chooseImport = async (database = "") => { const path = await open({ multiple: false, directory: false, title: "选择 SQL 文件", filters: [{ name: "SQL", extensions: ["sql"] }] }); if (typeof path === "string") setImportDialog({ path, database, continueOnError: false }); setMenu(null); };
  const importSql = async () => { const value = importDialog(); if (!value) return; const result = await run(() => api.mysqlImportSql(props.connection.id, value.path, value.database || undefined, value.continueOnError)); setImportDialog(null); await refreshDatabases(); result.failures.length ? feedback.error(`导入完成：成功 ${result.completed}/${result.total}，失败 ${result.failures.length}；首个错误位于语句 ${result.failures[0].statement}：${result.failures[0].summary}`) : feedback.success(`SQL 导入完成，共执行 ${result.completed} 条语句`); };
  const exportSql = async (database: string) => { const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19); const path = await save({ title: "导出 SQL", defaultPath: `${database}-${stamp}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] }); if (!path) return; const result = await run(() => api.mysqlExportSql(props.connection.id, path, database)); feedback.success(`导出完成：${result.tables} 张表，${result.rows} 行数据`); setMenu(null); };

  const removeDatabase = async (database: string) => { if (await feedback.prompt(`删除数据库将永久删除全部对象。请输入 ${database} 确认：`, "", "删除数据库") !== database) return; await run(() => api.mysqlDropDatabase(props.connection.id, database)); setTabs(items => { const next=items.filter(item => item.database !== database); if(!next.some(item=>item.id===activeId()))setActiveId(next[0]?.id||""); return next; }); await refreshDatabases(); };
  const tableAction = async (action: "truncate" | "drop" | "rename" | "clone", database: string, table: string) => { let target: string | undefined; if (action === "rename" || action === "clone") { target = await feedback.prompt(action === "rename" ? "新表名" : "副本表名", action === "clone" ? `${table}_copy` : table, action === "rename" ? "重命名表" : "新建相似表") || undefined; if (!target) return; } if ((action === "truncate" || action === "drop") && await feedback.prompt(`请输入 ${table} 确认${action === "drop" ? "删除" : "清空"}：`, "", action === "drop" ? "删除表" : "清空表") !== table) return; await run(() => api.mysqlTableAction(props.connection.id, database, table, action, target)); if (action === "drop") setTabs(items => items.filter(item => !(item.kind === "table" && item.database === database && item.table === table))); if (action === "rename") setTabs(items => items.filter(item => !(item.kind === "table" && item.database === database && item.table === table))); await refreshTables(database); setMenu(null); };
  const copyCreate = async (database: string, table: string) => { await navigator.clipboard.writeText(await api.mysqlShowCreate(props.connection.id, database, table)); feedback.success("建表 SQL 已复制"); };

  const loadPage = async (target: TableTab, page: number) => {
    const seq = (pageRequests.get(target.id) || 0) + 1;
    pageRequests.set(target.id, seq);
    try {
      const rows = await run(() => api.mysqlFetchRows(props.connection.id, target.database, target.table, page, 100));
      if (pageRequests.get(target.id) === seq) patchTab(target.id, { rows, page });
    } catch {
      // run() 已展示错误。
    }
  };
  const applyTableChanges = async (target: TableTab, changes: MysqlTableChangeSet) => {
    setRunningQueryId(target.id);
    try {
      const count = await run(() => api.mysqlApplyTableChanges(props.connection.id, target.database, target.table, changes));
      feedback.success("已提交 " + count + " 条修改");
      await loadPage(target, target.page);
    } catch {
      // run() 已展示错误。
    } finally {
      if (runningQueryId() === target.id) setRunningQueryId(null);
    }
  };
  const executeQuery = async (target: QueryTab, sqlOverride?: string) => {
    const key = "query:" + target.id;
    const sql = sqlOverride && sqlOverride.trim() ? sqlOverride : target.sql;
    const seq = (queryRequests.get(key) || 0) + 1;
    queryRequests.set(key, seq);
    setRunningQueryId(target.id);
    try {
      const result = await run(() => api.mysqlExecuteSql(props.connection.id, sql, target.database));
      if (queryRequests.get(key) === seq) patchTab(target.id, { result });
    } catch {
      // run() 已展示错误。
    } finally {
      if (runningQueryId() === target.id) setRunningQueryId(null);
    }
  };
  const stopQuery = async () => {
    try {
      await api.mysqlCancelQuery(props.connection.id);
      feedback.info("已请求停止当前查询");
    } catch (cause) {
      feedback.error("停止查询失败：" + String(cause));
    }
  };
  const exportCsv = (target: TableTab) => {
    if (!target.rows) return;
    const content = [target.rows.columns.map(csvCell).join(","), ...target.rows.rows.map(row => row.values.map(csvCell).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = target.table + ".csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  const importCsv = async (target: TableTab, file?: File) => {
    if (!file) return;
    const content = await file.text();
    if (!await feedback.confirm("CSV 导入在事务中执行，任一行失败将整体回滚。继续吗？", "导入 CSV")) return;
    try {
      const count = await run(() => api.mysqlImportCsv(props.connection.id, target.database, target.table, content));
      feedback.success("已导入 " + count + " 行");
      await loadPage(target, 1);
    } catch {
      // run() 已展示错误。
    }
  };
  const startDesign = (target: TableTab) => patchTab(target.id, { section: "design", designer: makeDesigner(target.database, target.table, target.columns, target.indexes), dirty: false });
  const updateDesigner = (target: TableTab, designer: MysqlTableDefinition) => patchTab(target.id, { designer, dirty: true, preview: [] });
  const previewDesign = async (target: TableTab) => { if (target.designer) patchTab(target.id, { preview: await run(() => api.mysqlPreviewTable(props.connection.id, target.designer!)) }); };
  const applyDesign = async (target: TableTab) => {
    if (!target.designer) return;
    try {
      const statements = await run(() => api.mysqlPreviewTable(props.connection.id, target.designer!));
      patchTab(target.id, { preview: statements });
      if (!await feedback.confirm("MySQL DDL 可能隐式提交且不能整体回滚，确认执行预览中的语句吗？", "应用表设计")) return;
      const result = target.isNew
        ? await run(() => api.mysqlCreateTable(props.connection.id, target.designer!))
        : await run(() => api.mysqlApplyTable(props.connection.id, target.designer!, statements));
      if (result.error) {
        setError("已完成 " + result.completed + "/" + result.statements.length + " 步：" + result.error);
        return;
      }
      await refreshTables(target.database);
      if (target.isNew) {
        setTabs(items => items.filter(item => item.id !== target.id));
        await loadTable(target.database, target.designer!.name, "structure");
      } else {
        patchTab(target.id, { dirty: false, section: "structure" });
      }
    } catch {
      // run() 已展示错误。
    }
  };
  const formatBytes = (value?: number) => value == null ? "—" : value < 1024 ? `${value}B` : value < 1048576 ? `${(value / 1024).toFixed(1)}KB` : `${(value / 1048576).toFixed(1)}MB`;
  const filteredDatabases = createMemo(() => databases().filter(item => item.name.toLowerCase().includes(filter().toLowerCase())));

  return <div class="mysql-workspace" onClick={() => setMenu(null)} onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind: "workspace" }); }}>
    <aside class="mysql-tree" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}><header><strong>MySQL 对象</strong><button title="新建数据库" onClick={() => void showCreateDatabase()}><Icon name="plus" />数据库</button><button class="icon-only" title="刷新数据库" onClick={() => void refreshDatabases()}><Icon name="refresh" /></button></header><div class="mysql-filter-wrap"><Icon name="search" /><input class="mysql-filter" placeholder="搜索数据库或表" value={filter()} onInput={event => setFilter(event.currentTarget.value)} /></div>
      <For each={filteredDatabases()}>{db => <section><div class={`mysql-tree-row database ${activeDatabase() === db.name ? "active" : ""}`} onClick={() => void activateDatabase(db.name)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, kind: "database", database: db.name }) }}><button class={`mysql-tree-toggle ${expanded().has(db.name) ? "expanded" : ""}`} onClick={event => { event.stopPropagation(); toggleDatabase(db.name) }}><Icon name="chevronRight" /></button><span><Icon name="database" /></span><b>{db.name}</b></div>
        <Show when={expanded().has(db.name)}><div class="mysql-tree-children">
          <div class="mysql-object-group collapsible" onClick={() => toggleGroup(db.name, "tables")}><span class={`mysql-group-arrow ${expandedGroups().has(`${db.name}:tables`) ? "expanded" : ""}`}><Icon name="chevronRight" /></span><span class="mysql-object-type-icon"><Icon name="table" /></span><b>表</b><em>{(tables()[db.name] || []).filter(item => item.kind === "BASE TABLE").length}</em></div>
          <Show when={expandedGroups().has(`${db.name}:tables`)}><For each={(tables()[db.name] || []).filter(item => item.kind === "BASE TABLE" && item.name.toLowerCase().includes(filter().toLowerCase()))}>{item => <div class={`mysql-tree-row object ${activeTab()?.kind === "table" && activeTab()?.database === db.name && (activeTab() as TableTab).table === item.name ? "active" : ""}`} onDblClick={() => void loadTable(db.name, item.name)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, kind: "table", database: db.name, table: item.name }) }}><span class="mysql-table-icon"><Icon name="table" /></span><span class="mysql-object-name">{item.name}</span></div>}</For></Show>
          <div class="mysql-object-group collapsible" onClick={() => toggleGroup(db.name, "views")}><span class={`mysql-group-arrow ${expandedGroups().has(`${db.name}:views`) ? "expanded" : ""}`}><Icon name="chevronRight" /></span><span class="mysql-object-type-icon"><Icon name="view" /></span><b>视图</b><em>{(tables()[db.name] || []).filter(item => item.kind === "VIEW").length}</em></div>
          <div class="mysql-object-group disabled" title="暂未支持"><span class="mysql-object-type-icon"><Icon name="query" /></span><b>查询</b><em>0</em></div>
          <div class="mysql-object-group disabled" title="暂未支持"><span class="mysql-object-type-icon"><Icon name="assets" /></span><b>ER 图</b><em>0</em></div>
          <div class="mysql-object-group disabled" title="暂未支持"><span class="mysql-object-type-icon"><Icon name="settings" /></span><b>存储过程/函数</b><em>0</em></div>
        </div></Show></section>}</For>
    </aside>
    <main class="mysql-main" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, kind: "workspace" }) }}>
      <div class="mysql-inner-tabs"><For each={tabs()}>{item => <button class={activeId() === item.id ? "active" : ""} onClick={() => setActiveId(item.id)}><span><Icon name={item.kind === "database" ? "database" : item.kind === "table" ? "table" : "query"} /></span><strong>{item.title}</strong><i onClick={event => { event.stopPropagation(); void closeTab(item.id) }}><Icon name="close" /></i></button>}</For><button class="mysql-new-query" title="新建查询" onClick={() => newQuery()}><Icon name="plus" /></button></div>
      <Show when={error()}><div class="mysql-error">{error()} <button onClick={() => setError("")}>×</button></div></Show><Show when={loading()}><div class="mysql-loading">正在执行…</div></Show>
      <Show when={!activeTab()}><div class="mysql-empty"><span class="mysql-empty-icon"><Icon name="database" /></span><h3>选择数据库、表或新建查询</h3><p>对象将在此处以可关闭标签打开。</p><button onClick={() => newQuery()}><Icon name="query" />新建 SQL 查询</button></div></Show>
      <Show keyed when={activeTab()?.kind === "database" ? activeId() : null}>{() => { const target = activeTab() as DatabaseTab; const current = (tables()[target.database] || []).filter(item => item.kind === "BASE TABLE"); const views = (tables()[target.database] || []).filter(item => item.kind === "VIEW"); return <div class="mysql-panel mysql-table-list"><div class="mysql-panel-actions"><button onClick={() => newQuery(target.database)}>⌕ 新建查询</button><button onClick={() => newTable(target.database)}>＋ 新建表</button><button onClick={() => void refreshTables(target.database)}>↻ 刷新</button><span>共 {current.length} 张表，{views.length} 个视图</span><div class="mysql-view-switch"><button class={target.view === "list" ? "active" : ""} onClick={() => patchTab(target.id, { view: "list" })}>☷</button><button class={target.view === "icons" ? "active" : ""} onClick={() => patchTab(target.id, { view: "icons" })}>▦</button></div></div><Show when={target.view === "list"}><table><thead><tr><th>名称</th><th>注释</th><th>预估行数</th><th>数据长度</th><th>索引长度</th><th>自增</th><th>引擎</th><th>编码</th><th>更新时间</th><th>创建时间</th></tr></thead><tbody><For each={current}>{item => <tr onDblClick={() => void loadTable(target.database, item.name)}><td class="object-name">▦ {item.name}</td><td>{item.comment}</td><td>{item.rows ?? 0}</td><td>{formatBytes(item.data_length)}</td><td>{formatBytes(item.index_length)}</td><td>{item.auto_increment ?? "—"}</td><td>{item.engine ?? "—"}</td><td>{item.collation?.split("_")[0] ?? "—"}</td><td>{item.updated_at ?? "—"}</td><td>{item.created_at ?? "—"}</td></tr>}</For></tbody></table></Show><Show when={target.view === "icons"}><div class="mysql-object-grid"><For each={current}>{item => <button class="mysql-object-card" onDblClick={() => void loadTable(target.database, item.name)}><span class="mysql-object-card-icon">▦</span><strong>{item.name}</strong><small>{item.comment || "数据表"}</small><em>{item.rows ?? 0} 行 · {formatBytes(item.data_length)}</em></button>}</For></div></Show></div> }}</Show>
      <Show keyed when={activeTab()?.kind === "query" ? activeId() : null}>{() => <QueryPanel tab={activeTab() as QueryTab} connectionId={props.connection.id} readOnly={readOnly()} onToggleReadOnly={() => setReadOnly(value => { const next = !value; localStorage.setItem("portnest.mysql.readOnly", next ? "1" : "0"); return next; })} databases={databases()} onPatch={patch => patchTab(activeId(), patch)} onExecute={sql => void executeQuery(activeTab() as QueryTab, sql)} onStop={() => void stopQuery()} running={runningQueryId() === activeId()} />}</Show>
      <Show keyed when={activeTab()?.kind === "table" ? activeId() : null}>{() => { const target = activeTab() as TableTab; return <><header class="mysql-toolbar"><div><strong>{target.table}</strong><small>{target.database} / {target.table}</small></div><nav><button class={target.section === "data" ? "active" : ""} disabled={target.isNew} onClick={() => patchTab(target.id, { section: "data" })}>数据</button><button class={target.section === "structure" ? "active" : ""} disabled={target.isNew} onClick={() => patchTab(target.id, { section: "structure" })}>结构</button><button class={target.section === "design" ? "active" : ""} onClick={() => target.designer ? patchTab(target.id, { section: "design" }) : startDesign(target)}>设计表</button><button class={target.section === "transfer" ? "active" : ""} disabled={target.isNew} onClick={() => patchTab(target.id, { section: "transfer" })}>导入/导出</button></nav></header><Show when={target.section === "data"}><div class="mysql-data-shell"><div class="mysql-panel-actions"><button onClick={() => exportCsv(target)}>导出当前页 CSV</button><span>第 {target.page} 页</span><button disabled={target.page <= 1} onClick={() => void loadPage(target, target.page - 1)}>上一页</button><button disabled={!target.rows?.truncated} onClick={() => void loadPage(target, target.page + 1)}>下一页</button></div><Show when={target.rows} fallback={<div class="mysql-panel">正在加载数据…</div>}><TableDataPanel result={target.rows!} tableName={target.table} running={runningQueryId() === target.id} onRefresh={() => void loadPage(target, target.page)} onStop={() => void stopQuery()} onApply={changes => applyTableChanges(target, changes)} /></Show></div></Show><Show when={target.section === "structure"}><StructureView columns={target.columns} indexes={target.indexes} /></Show><Show when={target.section === "transfer"}><div class="mysql-empty"><h3>数据导入 / 导出</h3><label class="mysql-file-button">选择 CSV 导入<input type="file" accept=".csv,text/csv" onChange={event => void importCsv(target, event.currentTarget.files?.[0])} /></label> <button onClick={() => exportCsv(target)}>导出当前页 CSV</button></div></Show><Show when={target.section === "design" && target.designer}><DesignerView definition={target.designer!} preview={target.preview} onChange={value => updateDesigner(target, value)} onPreview={() => void previewDesign(target)} onApply={() => void applyDesign(target)} /></Show></> }}</Show>
    </main>
    <Show when={menu()}>{() => { const item = menu()!; return <div class="mysql-context" style={{ left: `${item.x}px`, top: `${item.y}px` }} onClick={event => event.stopPropagation()}><Show when={item.kind === "workspace"}><button onClick={() => void showCreateDatabase()}>新建数据库</button><button onClick={() => { newQuery(); setMenu(null) }}>新建查询</button><button onClick={() => void chooseImport()}>导入 SQL</button><button onClick={() => { void refreshDatabases(); setMenu(null) }}>刷新数据库</button><button class="danger" onClick={() => { setMenu(null); props.onCloseConnection() }}>关闭 MySQL 连接</button></Show><Show when={item.kind === "database"}><button onClick={() => { void activateDatabase(item.database!); setMenu(null) }}>打开数据库</button><button onClick={() => { newTable(item.database!); setMenu(null) }}>新建表</button><button onClick={() => { newQuery(item.database!); setMenu(null) }}>新建查询</button><button onClick={() => void chooseImport(item.database)}>导入 SQL</button><button onClick={() => void exportSql(item.database!)}>导出 SQL</button><button onClick={() => { void refreshTables(item.database!); setMenu(null) }}>刷新</button><button onClick={() => void navigator.clipboard.writeText(item.database!)}>复制名称</button><button class="danger" onClick={() => void removeDatabase(item.database!)}>删除数据库</button></Show><Show when={item.kind === "table"}><button onClick={() => { void loadTable(item.database!, item.table!); setMenu(null) }}>打开数据</button><button onClick={() => { void loadTable(item.database!, item.table!, "design"); setMenu(null) }}>设计表</button><button onClick={() => void tableAction("clone", item.database!, item.table!)}>新建相似表</button><button onClick={() => void tableAction("rename", item.database!, item.table!)}>重命名</button><button onClick={() => void copyCreate(item.database!, item.table!)}>复制建表 SQL</button><button class="danger" onClick={() => void tableAction("truncate", item.database!, item.table!)}>清空表</button><button class="danger" onClick={() => void tableAction("drop", item.database!, item.table!)}>删除表</button></Show></div> }}</Show>
    <Show when={createDialog()}>{() => { const value = createDialog()!; const selected = charsets().find(item => item.name === value.charset); return <div class="mysql-dialog-backdrop"><div class="mysql-dialog"><h2>新建数据库</h2><label>数据库名称<input autofocus value={value.name} onInput={event => setCreateDialog({ ...value, name: event.currentTarget.value, error: "" })} /></label><label>字符集<select value={value.charset} onChange={event => { const charset = charsets().find(item => item.name === event.currentTarget.value)!; setCreateDialog({ ...value, charset: charset.name, collation: charset.default_collation, error: "" }) }}><For each={charsets()}>{item => <option value={item.name}>{item.name} — {item.description}</option>}</For></select></label><label>排序规则<select value={value.collation} onChange={event => setCreateDialog({ ...value, collation: event.currentTarget.value, error: "" })}><For each={selected?.collations || []}>{item => <option value={item}>{item}</option>}</For></select></label><Show when={value.error}><p class="mysql-dialog-error">{value.error}</p></Show><footer><button onClick={() => setCreateDialog(null)}>取消</button><button class="primary" disabled={loading()} onClick={() => void submitCreateDatabase()}>{loading() ? "创建中…" : "创建"}</button></footer></div></div> }}</Show>
    <Show when={importDialog()}>{() => { const value = importDialog()!; return <div class="mysql-dialog-backdrop"><div class="mysql-dialog"><h2>导入 SQL 文件</h2><label>文件<input value={value.path} readOnly /></label><label>默认数据库<select value={value.database} onChange={event => setImportDialog({ ...value, database: event.currentTarget.value })}><option value="">由 SQL 文件指定</option><For each={databases()}>{item => <option value={item.name}>{item.name}</option>}</For></select></label><label class="mysql-checkbox"><input type="checkbox" checked={value.continueOnError} onChange={event => setImportDialog({ ...value, continueOnError: event.currentTarget.checked })} /> 遇到错误后继续执行</label><p>MySQL DDL 可能隐式提交，导入无法整体回滚。</p><footer><button onClick={() => setImportDialog(null)}>取消</button><button class="primary" disabled={loading()} onClick={() => void importSql()}>{loading() ? "导入中…" : "开始导入"}</button></footer></div></div> }}</Show>
  </div>;
};

const StructureView: Component<{ columns: MysqlColumnInfo[]; indexes: MysqlIndexInfo[] }> = props => <div class="mysql-panel"><h3>字段</h3><table><thead><tr><th>名称</th><th>类型</th><th>NULL</th><th>键</th><th>默认值</th><th>附加</th><th>注释</th></tr></thead><tbody><For each={props.columns}>{item => <tr><td>{item.name}</td><td>{item.column_type}</td><td>{item.nullable ? "YES" : "NO"}</td><td>{item.key}</td><td>{item.default_value ?? "NULL"}</td><td>{item.extra}</td><td>{item.comment}</td></tr>}</For></tbody></table><h3>索引</h3><table><thead><tr><th>名称</th><th>唯一</th><th>字段</th><th>顺序</th></tr></thead><tbody><For each={props.indexes}>{item => <tr><td>{item.name}</td><td>{item.unique ? "YES" : "NO"}</td><td>{item.column}</td><td>{item.sequence}</td></tr>}</For></tbody></table></div>;

const DesignerView: Component<{ definition: MysqlTableDefinition; preview: string[]; onChange: (value: MysqlTableDefinition) => void; onPreview: () => void; onApply: () => void }> = props => { const column = (index: number, patch: Partial<MysqlColumnDefinition>) => props.onChange({ ...props.definition, columns: props.definition.columns.map((item, i) => i === index ? { ...item, ...patch } : item) }); return <div class="mysql-designer"><div class="designer-options"><label>表名<input value={props.definition.name} onInput={event => props.onChange({ ...props.definition, name: event.currentTarget.value })} /></label><label>引擎<input value={props.definition.engine || "InnoDB"} onInput={event => props.onChange({ ...props.definition, engine: event.currentTarget.value })} /></label><label>字符集<input value={props.definition.charset || "utf8mb4"} onInput={event => props.onChange({ ...props.definition, charset: event.currentTarget.value })} /></label></div><div class="mysql-panel-actions"><button onClick={() => props.onChange({ ...props.definition, columns: [...props.definition.columns, { name: `column_${props.definition.columns.length + 1}`, column_type: "VARCHAR(255)", nullable: true, auto_increment: false, comment: "" }] })}>＋字段</button><button onClick={() => props.onChange({ ...props.definition, indexes: [...props.definition.indexes, { name: `idx_${props.definition.indexes.length + 1}`, kind: "INDEX", columns: [] }] })}>＋索引</button><button onClick={props.onPreview}>预览 SQL</button><button class="primary" onClick={props.onApply}>应用设计</button></div><table><thead><tr><th>字段</th><th>类型</th><th>NULL</th><th>默认值</th><th>自增</th><th>注释</th><th /></tr></thead><tbody><For each={props.definition.columns}>{(item, index) => <tr><td><input value={item.name} onInput={event => column(index(), { name: event.currentTarget.value })} /></td><td><input value={item.column_type} onInput={event => column(index(), { column_type: event.currentTarget.value })} /></td><td><input type="checkbox" checked={item.nullable} onChange={event => column(index(), { nullable: event.currentTarget.checked })} /></td><td><input value={item.default_value || ""} onInput={event => column(index(), { default_value: event.currentTarget.value || undefined })} /></td><td><input type="checkbox" checked={item.auto_increment} onChange={event => column(index(), { auto_increment: event.currentTarget.checked })} /></td><td><input value={item.comment} onInput={event => column(index(), { comment: event.currentTarget.value })} /></td><td><button onClick={() => props.onChange({ ...props.definition, columns: props.definition.columns.filter((_, i) => i !== index()) })}>删除</button></td></tr>}</For></tbody></table><h3>索引</h3><table><thead><tr><th>名称</th><th>类型</th><th>字段（逗号分隔）</th><th /></tr></thead><tbody><For each={props.definition.indexes}>{(item, index) => <tr><td><input value={item.name} disabled={item.kind === "PRIMARY"} onInput={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((v, i) => i === index() ? { ...v, name: event.currentTarget.value } : v) })} /></td><td><select value={item.kind} onChange={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((v, i) => i === index() ? { ...v, kind: event.currentTarget.value as MysqlIndexDefinition["kind"], name: event.currentTarget.value === "PRIMARY" ? "PRIMARY" : v.name } : v) })}><option value="PRIMARY">主键</option><option value="UNIQUE">唯一</option><option value="INDEX">普通</option></select></td><td><input value={item.columns.map(v => v.name).join(",")} onInput={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((v, i) => i === index() ? { ...v, columns: event.currentTarget.value.split(",").map(name => ({ name: name.trim(), direction: "ASC" })).filter(v => v.name) } : v) })} /></td><td><button onClick={() => props.onChange({ ...props.definition, indexes: props.definition.indexes.filter((_, i) => i !== index()) })}>删除</button></td></tr>}</For></tbody></table><Show when={props.preview.length}><h3>DDL 预览</h3><pre>{props.preview.join(";\n\n")}</pre></Show></div> };

type SavedQuery = { sql: string; database: string; savedAt: number };
const HISTORY_KEY = "portnest.mysql.queryHistory";
const FAVORITES_KEY = "portnest.mysql.queryFavorites";
const SQL_KEYWORDS = ["SELECT","FROM","WHERE","GROUP BY","ORDER BY","HAVING","LIMIT","OFFSET","INSERT INTO","VALUES","UPDATE","SET","DELETE FROM","JOIN","LEFT JOIN","RIGHT JOIN","INNER JOIN","ON","AND","OR","UNION","UNION ALL","CREATE TABLE","ALTER TABLE","DROP TABLE","EXPLAIN","DESCRIBE","SHOW TABLES","COUNT","SUM","AVG","MAX","MIN"];

const loadSavedQueries = (key: string): SavedQuery[] => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as SavedQuery[] : []; } catch { return []; }
};
const persistSavedQueries = (key: string, items: SavedQuery[]) => {
  try { localStorage.setItem(key, JSON.stringify(items.slice(0, 100))); } catch { /* ignore quota errors */ }
};
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, " ");
const isReadOnlySql = (sql: string) => {
  const value = stripSqlComments(sql).trim().toUpperCase();
  if (/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/.test(value)) return true;
  if (value.startsWith("WITH ")) return !/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/.test(value);
  return false;
};
const isDangerousSql = (sql: string) => {
  const value = stripSqlComments(sql).trim().toUpperCase();
  if (/^(DROP|TRUNCATE|ALTER|RENAME|GRANT|REVOKE|CREATE)\b/.test(value)) return true;
  if (/^DELETE\b/.test(value) && !/\bWHERE\b/.test(value)) return true;
  if (/^UPDATE\b/.test(value) && !/\bWHERE\b/.test(value)) return true;
  return false;
};

const JsonTree: Component<{ name?: string; value: unknown; depth?: number }> = props => {
  const entries = () => props.value !== null && typeof props.value === "object" ? Object.entries(props.value as Record<string, unknown>) : [];
  return <div class="mysql-json-node" style={{ "padding-left": ((props.depth ?? 0) * 12) + "px" }}>
    <Show when={props.name}><span class="mysql-json-key">{props.name}: </span></Show>
    <Show when={entries().length > 0} fallback={<span class="mysql-json-value">{String(props.value)}</span>}>
      <For each={entries()}>{([key, value]) => <JsonTree name={key} value={value} depth={(props.depth ?? 0) + 1} />}</For>
    </Show>
  </div>;
};

const QueryPanel: Component<{
  tab: QueryTab;
  connectionId: string;
  databases: Array<{ name: string }>;
  readOnly: boolean;
  onPatch: (patch: Partial<QueryTab>) => void;
  onExecute: (sql?: string) => void;
  onStop: () => void;
  onToggleReadOnly: () => void;
  running: boolean;
}> = props => {
  let textarea: HTMLTextAreaElement | undefined;
  let loadedDatabase = "";
  const [selectedSql, setSelectedSql] = createSignal("");
  const [autocomplete, setAutocomplete] = createSignal<MysqlAutocompleteItem[]>([]);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  const [showSuggestions, setShowSuggestions] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [favoritesOpen, setFavoritesOpen] = createSignal(false);
  const [history, setHistory] = createSignal<SavedQuery[]>(loadSavedQueries(HISTORY_KEY));
  const [favorites, setFavorites] = createSignal<SavedQuery[]>(loadSavedQueries(FAVORITES_KEY));
  const [explainOpen, setExplainOpen] = createSignal(false);
  const [explainLoading, setExplainLoading] = createSignal(false);
  const [explainResult, setExplainResult] = createSignal<MysqlExplainResult | null>(null);

  createEffect(() => {
    const database = props.tab.database;
    if (database === loadedDatabase) return;
    loadedDatabase = database;
    if (!database) { setAutocomplete([]); return; }
    void api.mysqlAutocomplete(props.connectionId, database).then(setAutocomplete).catch(() => setAutocomplete([]));
  });

  const updateSelection = () => {
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    setSelectedSql(end > start ? textarea.value.slice(start, end) : "");
  };
  const currentSql = () => selectedSql().trim() ? selectedSql() : props.tab.sql;
  const recordHistory = (sql: string) => {
    const entry: SavedQuery = { sql, database: props.tab.database, savedAt: Date.now() };
    const next = [entry, ...history().filter(item => item.sql !== sql)].slice(0, 100);
    setHistory(next);
    persistSavedQueries(HISTORY_KEY, next);
  };
  const execute = async () => {
    const sql = currentSql().trim();
    if (!sql) { feedback.info("请输入 SQL"); return; }
    if (props.readOnly && !isReadOnlySql(sql)) {
      feedback.error("当前处于只读模式，只允许执行 SELECT / SHOW / DESCRIBE / EXPLAIN");
      return;
    }
    if (isDangerousSql(sql)) {
      const confirmed = await feedback.confirm("检测到高风险 SQL，可能修改或删除表结构/数据。确定继续执行吗？", "高风险 SQL");
      if (!confirmed) return;
    }
    recordHistory(sql);
    props.onExecute(selectedSql().trim() ? selectedSql() : undefined);
  };
  const beautify = () => props.onPatch({ sql: formatSql(props.tab.sql), dirty: true });
  const saveSql = async () => {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await save({ title: "保存 SQL", defaultPath: "query-" + stamp + ".sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (typeof path !== "string") return;
    try { await api.mysqlSaveSql(path, props.tab.sql); feedback.success("SQL 已保存"); }
    catch (cause) { feedback.error("保存 SQL 失败：" + String(cause)); }
  };
  const applySaved = (sql: string) => {
    props.onPatch({ sql, dirty: true });
    setHistoryOpen(false);
    setFavoritesOpen(false);
    requestAnimationFrame(() => textarea?.focus());
  };
  const toggleFavorite = () => {
    const sql = currentSql().trim();
    if (!sql) { feedback.info("当前没有可收藏的 SQL"); return; }
    const existing = favorites().find(item => item.sql === sql);
    const next = existing ? favorites().filter(item => item.sql !== sql) : [{ sql, database: props.tab.database, savedAt: Date.now() }, ...favorites()];
    setFavorites(next);
    persistSavedQueries(FAVORITES_KEY, next);
    feedback.success(existing ? "已取消收藏" : "已收藏当前 SQL");
  };
  const runExplain = async () => {
    const sql = currentSql().trim();
    if (!sql) { feedback.info("请输入 SQL"); return; }
    setExplainLoading(true);
    try {
      const result = await api.mysqlExplainSql(props.connectionId, sql, props.tab.database || undefined);
      setExplainResult(result);
      setExplainOpen(true);
    } catch (cause) { feedback.error("获取执行计划失败：" + String(cause)); }
    finally { setExplainLoading(false); }
  };
  const hideSuggestions = () => setShowSuggestions(false);
  const updateSuggestions = () => {
    if (!textarea) return;
    const position = textarea.selectionStart ?? 0;
    const before = textarea.value.slice(0, position);
    const prefix = (before.match(/[A-Za-z0-9_]*$/) || [""])[0];
    if (!prefix && !before.endsWith(".")) { hideSuggestions(); return; }
    const tableMatch = before.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]*)$/);
    let candidates: string[] = [];
    if (tableMatch) {
      const table = tableMatch[1].toLowerCase();
      candidates = autocomplete().filter(item => item.table.toLowerCase() === table).map(item => item.column);
    } else {
      const tables = Array.from(new Set(autocomplete().map(item => item.table)));
      const columns = Array.from(new Set(autocomplete().map(item => item.column)));
      candidates = [...tables, ...columns, ...SQL_KEYWORDS];
    }
    candidates = Array.from(new Set(candidates.filter(item => item.toLowerCase().startsWith(prefix.toLowerCase())))).slice(0, 20);
    setSuggestions(candidates);
    setSuggestionIndex(0);
    setShowSuggestions(candidates.length > 0);
  };
  const insertSuggestion = (value: string) => {
    if (!textarea) return;
    const position = textarea.selectionStart ?? 0;
    const before = textarea.value.slice(0, position);
    const after = textarea.value.slice(position);
    const prefixLength = (before.match(/[A-Za-z0-9_]*$/) || [""])[0].length;
    const next = before.slice(0, before.length - prefixLength) + value + " " + after;
    const nextPosition = before.length - prefixLength + value.length + 1;
    props.onPatch({ sql: next, dirty: true });
    setShowSuggestions(false);
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(nextPosition, nextPosition); });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (showSuggestions() && suggestions().length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex(index => (index + 1) % suggestions().length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex(index => (index - 1 + suggestions().length) % suggestions().length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertSuggestion(suggestions()[suggestionIndex()]); return; }
      if (event.key === "Escape") { hideSuggestions(); return; }
    }
    if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void execute(); }
  };

  return <div class="mysql-query">
    <div class="mysql-query-options">
      <label>默认数据库<select value={props.tab.database} onChange={event => props.onPatch({ database: event.currentTarget.value, dirty: true })}><option value="">未选择</option><For each={props.databases}>{item => <option value={item.name}>{item.name}</option>}</For></select></label>
      <button onClick={() => void execute()}>{selectedSql().trim() ? "运行已选择的" : "运行"}</button>
      <button onClick={beautify}>美化 SQL</button>
      <button onClick={() => void saveSql()}>保存 SQL</button>
      <button onClick={() => void runExplain()} disabled={explainLoading()}>{explainLoading() ? "生成计划中..." : "执行计划"}</button>
      <button onClick={props.onToggleReadOnly} class={props.readOnly ? "mysql-readonly" : ""}>{props.readOnly ? "只读模式" : "可写模式"}</button>
      <button onClick={() => { setHistoryOpen(value => !value); setFavoritesOpen(false); }}>历史</button>
      <button onClick={() => { setFavoritesOpen(value => !value); setHistoryOpen(false); }}>收藏</button>
      <button onClick={toggleFavorite}>★ 收藏当前</button>
      <button onClick={props.onStop} disabled={!props.running}>停止</button>
      <span class="mysql-query-mode">{props.readOnly ? "只读" : "可写"} · 自动提交</span>
    </div>
    <Show when={historyOpen()}>
      <div class="mysql-query-list">
        <header><strong>查询历史</strong><button onClick={() => setHistoryOpen(false)}>关闭</button></header>
        <Show when={history().length > 0} fallback={<p>暂无查询历史</p>}>
          <For each={history()}>{item => <button onClick={() => applySaved(item.sql)}><span>{item.sql.slice(0, 160)}</span><small>{item.database || "未选择数据库"} · {new Date(item.savedAt).toLocaleString()}</small></button>}</For>
        </Show>
      </div>
    </Show>
    <Show when={favoritesOpen()}>
      <div class="mysql-query-list">
        <header><strong>收藏的 SQL</strong><button onClick={() => setFavoritesOpen(false)}>关闭</button></header>
        <Show when={favorites().length > 0} fallback={<p>暂无收藏</p>}>
          <For each={favorites()}>{item => <button onClick={() => applySaved(item.sql)}><span>{item.sql.slice(0, 160)}</span><small>{item.database || "未选择数据库"}</small></button>}</For>
        </Show>
      </div>
    </Show>
    <div class="mysql-query-editor">
      <textarea
        ref={element => { textarea = element as HTMLTextAreaElement; }}
        value={props.tab.sql}
        onInput={event => { props.onPatch({ sql: event.currentTarget.value, dirty: true }); updateSelection(); updateSuggestions(); }}
        onSelect={updateSelection}
        onClick={updateSuggestions}
        onKeyUp={updateSuggestions}
        onMouseUp={updateSelection}
        onBlur={() => setTimeout(hideSuggestions, 120)}
        onKeyDown={handleKeyDown}
      />
      <Show when={showSuggestions()}>
        <div class="mysql-autocomplete">
          <For each={suggestions()}>{(item, index) => <button class={suggestionIndex() === index() ? "active" : ""} onMouseDown={event => { event.preventDefault(); insertSuggestion(item); }}>{item}</button>}</For>
        </div>
      </Show>
    </div>
    <Show when={explainOpen() && explainResult()}>
      <div class="mysql-explain">
        <header><strong>执行计划</strong><button onClick={() => setExplainOpen(false)}>关闭</button></header>
        <Show when={explainResult()!.message}><p class="mysql-explain-message">{explainResult()!.message}</p></Show>
        <Show when={explainResult()!.json_plan} fallback={<table><thead><tr><For each={explainResult()!.columns}>{name => <th>{name}</th>}</For></tr></thead><tbody><For each={explainResult()!.rows}>{row => <tr><For each={row}>{value => <td>{cellText(value)}</td>}</For></tr>}</For></tbody></table>}>
          <JsonTree value={explainResult()!.json_plan} />
        </Show>
      </div>
    </Show>
    <ResultTable result={props.tab.result} />
  </div>;
};

const cellInputText = (value: unknown) => value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);

const parseCellValue = (raw: string, original: unknown): unknown => {
  if (raw.trim().toUpperCase() === "NULL") return null;
  if (typeof original === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (typeof original === "boolean") return raw.trim().toLowerCase() === "true";
  if (original !== null && typeof original === "object") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
};

const TableDataPanel: Component<{
  result: QueryResult;
  tableName: string;
  running: boolean;
  onRefresh: () => void;
  onStop: () => void;
  onApply: (changes: MysqlTableChangeSet) => Promise<void>;
}> = props => {
  const [rows, setRows] = createSignal<unknown[][]>([]);
  const [inserted, setInserted] = createSignal<Array<{ id: number; values: Record<string, unknown> }>>([]);
  const [updates, setUpdates] = createSignal<Map<number, { values: Record<string, unknown>; original: Record<string, unknown> }>>(new Map());
  const [deletes, setDeletes] = createSignal<Set<number>>(new Set());
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [filterColumn, setFilterColumn] = createSignal("");
  const [filterText, setFilterText] = createSignal("");
  const [sortColumn, setSortColumn] = createSignal<number | null>(null);
  const [sortDirection, setSortDirection] = createSignal<"asc" | "desc">("asc");
  const pendingCount = () => inserted().length + updates().size + deletes().size;
  const compareValues = (left: unknown, right: unknown) => {
    if (left === right) return 0;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
  };
  const displayRowIndexes = createMemo(() => {
    let indexes = rows().map((_row, index) => index).filter(index => !deletes().has(index));
    const search = filterText().trim().toLowerCase();
    if (search) {
      const columnIndex = filterColumn() ? props.result.columns.indexOf(filterColumn()) : -1;
      indexes = indexes.filter(index => {
        const cells = columnIndex >= 0 ? [rows()[index][columnIndex]] : rows()[index];
        return cells.some(value => cellInputText(value).toLowerCase().includes(search));
      });
    }
    const sortIndex = sortColumn();
    if (sortIndex !== null) {
      const direction = sortDirection() === "asc" ? 1 : -1;
      indexes = [...indexes].sort((left, right) => compareValues(rows()[left][sortIndex], rows()[right][sortIndex]) * direction);
    }
    return indexes;
  });
  const toggleSort = (index: number) => {
    if (sortColumn() === index) setSortDirection(direction => direction === "asc" ? "desc" : "asc");
    else { setSortColumn(index); setSortDirection("asc"); }
  };
  let nextInsertId = 1;

  const reset = () => {
    setRows(props.result.rows.map(row => [...row.values]));
    setInserted([]);
    setUpdates(new Map());
    setDeletes(new Set<number>());
    setSelected(new Set<string>());
  };
  createEffect(() => {
    props.result;
    reset();
  });

  const rowObject = (values: unknown[]) => Object.fromEntries(props.result.columns.map((name, index) => [name, values[index]]));
  const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const editCell = (rowIndex: number, columnIndex: number, raw: string) => {
    const original = [...props.result.rows[rowIndex].values];
    const next = rows().map((row, index) => index === rowIndex ? row.map((value, cellIndex) => cellIndex === columnIndex ? parseCellValue(raw, original[columnIndex]) : value) : row);
    setRows(next);
    const changed: Record<string, unknown> = {};
    props.result.columns.forEach((name, index) => {
      if (!sameValue(next[rowIndex][index], original[index])) changed[name] = next[rowIndex][index];
    });
    const map = new Map(updates());
    if (Object.keys(changed).length > 0) map.set(rowIndex, { values: changed, original: rowObject(original) });
    else map.delete(rowIndex);
    setUpdates(map);
  };
  const addRecord = () => {
    setInserted([...inserted(), { id: nextInsertId++, values: {} }]);
  };
  const editInserted = (id: number, name: string, raw: string) => {
    setInserted(items => items.map(item => item.id === id ? { ...item, values: { ...item.values, [name]: parseCellValue(raw, undefined) } } : item));
  };
  const toggleSelected = (key: string) => {
    const next = new Set(selected());
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected().size > 0) { setSelected(new Set<string>()); return; }
    const next = new Set<string>();
    rows().forEach((_row, index) => { if (!deletes().has(index)) next.add("row:" + index); });
    inserted().forEach(item => next.add("new:" + item.id));
    setSelected(next);
  };
  const deleteSelected = () => {
    if (selected().size === 0) { feedback.info("请先勾选要删除的记录"); return; }
    const selectedNow = selected();
    const removedInsertIds = new Set<number>();
    const removedRowIndexes = new Set<number>();
    selectedNow.forEach(key => {
      if (key.startsWith("new:")) removedInsertIds.add(Number(key.slice(4)));
      if (key.startsWith("row:")) removedRowIndexes.add(Number(key.slice(4)));
    });
    setInserted(items => items.filter(item => !removedInsertIds.has(item.id)));
    const nextUpdates = new Map(updates());
    removedRowIndexes.forEach(index => nextUpdates.delete(index));
    setUpdates(nextUpdates);
    const nextDeletes = new Set(deletes());
    removedRowIndexes.forEach(index => nextDeletes.add(index));
    setDeletes(nextDeletes);
    setSelected(new Set<string>());
  };
  const discard = () => { reset(); };
  const apply = async () => {
    const changes: MysqlTableChangeSet = {
      inserts: inserted().map(item => item.values).filter(values => Object.keys(values).length > 0),
      updates: [...updates().values()],
      deletes: [...deletes()].map(index => rowObject(props.result.rows[index].values)),
    };
    if (changes.inserts.length + changes.updates.length + changes.deletes.length === 0) {
      feedback.info("没有需要应用的修改");
      return;
    }
    await props.onApply(changes);
  };

  const selectedRowValues = () => {
    const result: unknown[][] = [];
    selected().forEach(key => {
      if (key.startsWith("row:")) {
        const index = Number(key.slice(4));
        if (!deletes().has(index)) result.push(rows()[index]);
      }
      if (key.startsWith("new:")) {
        const id = Number(key.slice(4));
        const item = inserted().find(entry => entry.id === id);
        if (item) result.push(props.result.columns.map(name => item.values[name] ?? null));
      }
    });
    return result;
  };
  const copySelected = async () => {
    const data = selectedRowValues();
    if (data.length === 0) { feedback.info("请先勾选要复制的记录"); return; }
    const text = [props.result.columns.join("\t"), ...data.map(row => row.map(value => cellInputText(value)).join("\t"))].join("\n");
    try { await navigator.clipboard.writeText(text); feedback.success("已复制选中记录"); }
    catch (cause) { feedback.error("复制失败：" + String(cause)); }
  };
  const exportSelected = () => {
    const data = selectedRowValues();
    if (data.length === 0) { feedback.info("请先勾选要导出的记录"); return; }
    const content = [props.result.columns.map(csvCell).join(","), ...data.map(row => row.map(csvCell).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = props.tableName + "-selected.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return <div class="mysql-panel mysql-data-panel">
    <div class="mysql-data-filters">
      <select value={filterColumn()} onChange={event => setFilterColumn(event.currentTarget.value)}>
        <option value="">全部列</option>
        <For each={props.result.columns}>{name => <option value={name}>{name}</option>}</For>
      </select>
      <input value={filterText()} placeholder="筛选当前页..." onInput={event => setFilterText(event.currentTarget.value)} />
      <button onClick={() => void copySelected()}>复制选中</button>
      <button onClick={exportSelected}>导出选中</button>
      <span>显示 {displayRowIndexes().length} / {rows().length} 行</span>
    </div>
    <div class="mysql-table-wrap">
      <table>
        <thead><tr><th class="row-number"><input type="checkbox" checked={selected().size > 0} onChange={toggleAll} /></th><For each={props.result.columns}>{(name, columnIndex) => <th class="mysql-sortable" onClick={() => toggleSort(columnIndex())}>{name}<Show when={sortColumn() === columnIndex()}> {sortDirection() === "asc" ? "▲" : "▼"}</Show></th>}</For></tr></thead>
        <tbody>
          <For each={displayRowIndexes()}>{rowIndex => <tr>
            <td class="row-number"><input type="checkbox" checked={selected().has("row:" + rowIndex)} onChange={() => toggleSelected("row:" + rowIndex)} /></td>
            <Index each={rows()[rowIndex]}>{(cell, cellIndex) => <td><input class="mysql-cell-input" value={cellInputText(cell())} onInput={event => editCell(rowIndex, cellIndex, event.currentTarget.value)} /></td>}</Index>
          </tr>}</For>
          <Index each={inserted()}>{(item) => <tr class="mysql-insert-row">
            <td class="row-number"><input type="checkbox" checked={selected().has("new:" + item().id)} onChange={() => toggleSelected("new:" + item().id)} /></td>
            <Index each={props.result.columns}>{(name) => <td><input class="mysql-cell-input" value={item().values[name()] === undefined ? "" : cellInputText(item().values[name()])} onInput={event => editInserted(item().id, name(), event.currentTarget.value)} /></td>}</Index>
          </tr>}</Index>
        </tbody>
      </table>
    </div>
    <div class="mysql-panel-actions mysql-data-actions">
      <button onClick={addRecord}>添加记录</button>
      <button onClick={deleteSelected}>删除记录</button>
      <button class="primary" onClick={() => void apply()} disabled={pendingCount() === 0}>应用修改</button>
      <button onClick={discard} disabled={pendingCount() === 0}>放弃更改</button>
      <button onClick={props.onRefresh}>刷新</button>
      <button onClick={props.onStop} disabled={!props.running}>停止</button>
      <span class="mysql-tx-status">未提交修改 {pendingCount()} 条 · 事务待提交</span>
    </div>
  </div>;
};

const ResultTable: Component<{ result: QueryResult | null; editable?: boolean; onEdit?: (values: unknown[]) => void; onDelete?: (values: unknown[]) => void }> = props => <Show when={props.result}>{(result: () => QueryResult) => <div class="mysql-result"><table><thead><tr><th class="row-number">#</th><Show when={props.editable}><th>操作</th></Show><For each={result().columns}>{name => <th>{name}</th>}</For></tr></thead><tbody><For each={result().rows}>{(row, index) => <tr><td class="row-number">{index() + 1}</td><Show when={props.editable}><td><button onClick={() => props.onEdit?.(row.values)}>编辑</button> <button onClick={() => props.onDelete?.(row.values)}>删除</button></td></Show><For each={row.values}>{value => <td class={value === null ? "null" : ""}>{cellText(value)}</td>}</For></tr>}</For></tbody></table><div class="mysql-result-meta">返回 {result().rows.length} 行 · 影响 {result().affected_rows} 行 · 耗时 {result().execution_time_ms} ms<Show when={result().truncated}> · 结果已截断，请增加 LIMIT 或使用更精确的查询</Show></div></div>}</Show>;
