import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import { ColorIcon } from "../../ColorIcon";
import {
  api,
  type DatabaseColumnInfo,
  type DatabaseForeignKeyDefinition,
  type DatabaseIndexInfo,
  type DatabaseTableInfo,
} from "../../../utils/api";
import type { WorkspaceState } from "../../../stores/databaseWorkspaceStore";
import { formatBytes, type DatabaseTab, type ObjectView } from "../types";
import { PropRows, tableProps } from "./ObjectProps";

type Props = {
  state: WorkspaceState;
  connectionId: string;
  tab: DatabaseTab;
  tables: DatabaseTableInfo[];
  viewCount: number;
  /** 当前选中的表名（由工作区统一持有，右侧信息页与树共用） */
  selectedTable: string | null;
  onSelectTable: (database: string, table: string) => void;
  onOpenTable: (database: string, table: string) => void;
  onDesignTable: (database: string, table: string) => void;
  onDropTable: (database: string, table: string) => void;
  onImportTable: (database: string, table: string) => void;
  onNewTable: (database: string) => void;
  onNewQuery: (database: string) => void;
  onRefresh: (database: string) => void;
  onExportSql: (database: string) => void;
  onShowDdl: (database: string, table: string) => void;
};

const VIEWS: Array<{ value: ObjectView; label: string; icon: "objectList" | "objectTable" | "assets" | "grid" }> = [
  { value: "list", label: "详情视图", icon: "objectList" },
  { value: "detail", label: "表信息", icon: "assets" },
  { value: "icons", label: "图标视图", icon: "grid" },
];

type ObjectSortKey = "name" | "comment" | "rows" | "data_length" | "index_length" | "auto_increment" | "engine" | "collation" | "updated_at" | "created_at";

/** 表头定义集中在这里：列名、排序键、数值列一一对应，避免标题和取值错位 */
const COLUMNS: Array<{ key: ObjectSortKey; label: string; numeric?: boolean }> = [
  { key: "name", label: "名称" },
  { key: "comment", label: "注释" },
  { key: "rows", label: "预估行数", numeric: true },
  { key: "data_length", label: "数据长度", numeric: true },
  { key: "index_length", label: "索引长度", numeric: true },
  { key: "auto_increment", label: "自动递增", numeric: true },
  { key: "engine", label: "引擎" },
  { key: "collation", label: "编码" },
  { key: "updated_at", label: "更新时间" },
  { key: "created_at", label: "创建时间" },
];

const valueOf = (item: DatabaseTableInfo, key: ObjectSortKey): string | number | null => {
  const raw = item[key];
  if (raw === undefined || raw === null || raw === "") return null;
  return raw as string | number;
};

/**
 * 详情页的类型列只有一格宽，enum('G','PG','PG-13',…) 这种长取值会把名字挤掉。
 * 取值列表本身在「结构」页和 DDL 里都能看全，这里压缩成 enum(5)，完整值挂 title。
 */
const shortType = (raw: string): string => {
  const match = /^(enum|set)\s*\((.+)\)$/i.exec(raw.trim());
  if (!match) return raw;
  const count = match[2].split(",").filter(item => item.trim()).length;
  return `${match[1].toLowerCase()}(${count})`;
};

export const ObjectPanel: Component<Props> = props => {
  const [detailColumns, setDetailColumns] = createSignal<DatabaseColumnInfo[]>([]);
  const [detailIndexes, setDetailIndexes] = createSignal<DatabaseIndexInfo[]>([]);
  const [detailForeignKeys, setDetailForeignKeys] = createSignal<DatabaseForeignKeyDefinition[]>([]);
  const [detailLoading, setDetailLoading] = createSignal(false);

  const query = () => props.state.objectQuery(props.tab.database);

  /** 展示范围由对象树里单击的节点决定：数据库 = 全部，表组 = 仅表，视图组 = 仅视图 */
  const scope = () => props.tab.objectScope ?? "all";
  const scopeLabel = () => (scope() === "tables" ? "表" : scope() === "views" ? "视图" : "表 / 视图");

  const scopedObjects = createMemo(() => {
    const current = scope();
    if (current === "tables") return props.tables.filter(item => item.kind === "BASE TABLE");
    if (current === "views") return props.tables.filter(item => item.kind === "VIEW");
    return props.tables.filter(item => item.kind === "BASE TABLE" || item.kind === "VIEW");
  });

  const sortOrder = () => props.state.objectSort(props.tab.database);

  const list = createMemo(() => {
    const text = query().trim().toLowerCase();
    const filtered = text
      ? scopedObjects().filter(item => item.name.toLowerCase().includes(text) || (item.comment || "").toLowerCase().includes(text))
      : scopedObjects();
    const order = sortOrder();
    if (!order) return filtered;
    const direction = order.direction === "asc" ? 1 : -1;
    return [...filtered].sort((left, right) => {
      const a = valueOf(left, order.column as ObjectSortKey);
      const b = valueOf(right, order.column as ObjectSortKey);
      // 空值永远垫底：升序降序都不该把「—」排到最前面
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return String(a).localeCompare(String(b), "zh-CN", { numeric: true, sensitivity: "base" }) * direction;
    });
  });

  const toggleSort = (key: ObjectSortKey) => {
    const current = sortOrder();
    if (!current || current.column !== key) {
      props.state.setObjectSort(props.tab.database, { column: key, direction: "asc" });
    } else if (current.direction === "asc") {
      props.state.setObjectSort(props.tab.database, { column: key, direction: "desc" });
    } else {
      props.state.setObjectSort(props.tab.database, null);
    }
  };

  const isView = (item: DatabaseTableInfo) => item.kind === "VIEW";
  const emptyText = () => (scope() === "views" ? "这个数据库还没有视图" : scope() === "tables" ? "这个数据库还没有表" : "这个数据库还没有表或视图");
  const emptyHint = () => (query() ? "换个关键词试试" : scope() === "views" ? "视图会在数据库里定义后出现" : "点上方「新建表」开始设计");

  const currentItem = createMemo(() => list().find(item => item.name === props.selectedTable) ?? null);
  /** 细节页在看什么：选中项，否则第一张表 */
  const detailTarget = () => currentItem() ?? list()[0] ?? null;

  const primaryKeyNames = createMemo(() => detailIndexes().filter(item => item.primary || item.name === "PRIMARY").map(item => item.column).filter(Boolean));

  // 详情视图：只在该视图下按需拉一次字段 / 索引 / 外键
  createEffect(() => {
    const target = props.tab.view === "detail" ? detailTarget() : null;
    if (!target) { setDetailColumns([]); setDetailIndexes([]); setDetailForeignKeys([]); return; }
    setDetailLoading(true);
    let cancelled = false;
    void props.state.schemaVersion();
    Promise.all([
      api.databaseListColumns(props.connectionId, props.tab.database, target.name),
      api.databaseListIndexes(props.connectionId, props.tab.database, target.name),
      api.databaseListForeignKeys(props.connectionId, props.tab.database, target.name).catch(() => [] as DatabaseForeignKeyDefinition[]),
    ])
      .then(([columns, indexes, foreignKeys]) => {
        if (cancelled) return;
        setDetailColumns(columns);
        setDetailIndexes(indexes);
        setDetailForeignKeys(foreignKeys);
      })
      .catch(() => { if (!cancelled) { setDetailColumns([]); setDetailIndexes([]); setDetailForeignKeys([]); } })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  });

  const openCurrent = () => { const item = currentItem(); if (item) props.onOpenTable(props.tab.database, item.name); };

  /** 行交互：单击选中并出信息栏，双击打开表；回车等价双击、空格等价单击 */
  const rowHandlers = (item: DatabaseTableInfo) => ({
    title: `${item.comment || item.name}（单击查看信息，双击打开）`,
    onClick: () => props.onSelectTable(props.tab.database, item.name),
    onDblClick: () => props.onOpenTable(props.tab.database, item.name),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter") props.onOpenTable(props.tab.database, item.name);
      if (event.key === " ") { event.preventDefault(); props.onSelectTable(props.tab.database, item.name); }
    },
  });

  return (
    <section class="db-objects">
      {/* ④ 对象工具栏 */}
      <div class="db-objectbar">
        {/* 左侧操作组可横向滚动，右侧的搜索/刷新/视图切换固定可见：
            窄窗口下右侧按钮不再被挤出可视区 */}
        <div class="db-objectbar-scroll">
          <span class="db-scope-chip" title="展示范围由对象树中单击的节点决定">{scopeLabel()}</span>
          <span class="db-toolbar-divider" />
          <div class="db-toolbar-group">
            <button class="db-text-btn" title="打开表" aria-label="打开表" disabled={!currentItem()} onClick={openCurrent}>
              <Icon name="table" size={14} /><span class="db-btn-label">打开表</span>
            </button>
            <button class="db-text-btn" title="设计表" aria-label="设计表" disabled={!currentItem()} onClick={() => currentItem() && props.onDesignTable(props.tab.database, currentItem()!.name)}>
              <Icon name="edit" size={14} /><span class="db-btn-label">设计表</span>
            </button>
            <button class="db-text-btn" title="新建表" aria-label="新建表" onClick={() => props.onNewTable(props.tab.database)}>
              <Icon name="plus" size={14} /><span class="db-btn-label">新建表</span>
            </button>
            <button class="db-text-btn" title="删除表" aria-label="删除表" disabled={!currentItem()} onClick={() => currentItem() && props.onDropTable(props.tab.database, currentItem()!.name)}>
              <Icon name="trash" size={14} /><span class="db-btn-label">删除表</span>
            </button>
          </div>
          <span class="db-toolbar-divider" />
          <div class="db-toolbar-group">
            <button class="db-text-btn" title="导入" aria-label="导入" disabled={!currentItem()} onClick={() => currentItem() && props.onImportTable(props.tab.database, currentItem()!.name)}>
              <Icon name="import" size={14} /><span class="db-btn-label">导入</span>
            </button>
            <button class="db-text-btn" title="导出 SQL" aria-label="导出 SQL" onClick={() => props.onExportSql(props.tab.database)}>
              <Icon name="export" size={14} /><span class="db-btn-label">导出 SQL</span>
            </button>
          </div>
        </div>
        <div class="db-objectbar-side">
          <label class="db-search db-search--inline">
            <Icon name="search" size={14} />
            <input
              value={query()}
              placeholder="名称 / 注释"
              aria-label="搜索表名或注释"
              onInput={event => props.state.setObjectQuery(props.tab.database, event.currentTarget.value)}
            />
          </label>
          <button class="db-icon-btn" title="刷新" aria-label="刷新表列表" onClick={() => props.onRefresh(props.tab.database)}>
            <Icon name="refresh" size={14} />
          </button>
          <div class="db-seg" role="group" aria-label="对象视图">
            <For each={VIEWS}>{item => (
              <button
                class={props.tab.view === item.value ? "is-active" : ""}
                aria-pressed={props.tab.view === item.value}
                title={item.label}
                aria-label={item.label}
                onClick={() => props.state.patchTab(props.tab.id, { view: item.value })}
              >
                <Icon name={item.icon} size={16} />
              </button>
            )}</For>
          </div>
        </div>
      </div>

      {/* 名称列表：一行一张表，列宽按内容排；放不下时整块左右滚动。
          "table" 是上一版多出来的视图，已合并到这里，历史 tab 存着它也能正常渲染。 */}
      <Show when={props.tab.view === "list" || props.tab.view === "table"}>
        <div class="db-grid-wrap">
          <table class="db-grid is-objects">
            <thead>
              <tr>
                <For each={COLUMNS}>{column => {
                  const active = () => sortOrder()?.column === column.key ? sortOrder()!.direction : null;
                  return (
                    <th
                      class={`db-th ${column.numeric ? "is-numeric" : ""} ${active() ? "is-sorted" : ""}`}
                      aria-sort={active() === "asc" ? "ascending" : active() === "desc" ? "descending" : "none"}
                      title={`按${column.label}排序`}
                      onClick={() => toggleSort(column.key)}
                    >
                      <span class="db-th-inner">
                        <span class="db-th-label">{column.label}</span>
                        <span class="db-sort" aria-hidden="true">
                          <Icon name="chevronUp" size={12} class={active() === "asc" ? "is-on" : ""} />
                          <Icon name="chevronDown" size={12} class={active() === "desc" ? "is-on" : ""} />
                        </span>
                      </span>
                    </th>
                  );
                }}</For>
              </tr>
            </thead>
            <tbody>
              <For each={list()}>{item => (
                <tr
                  class={`db-row ${props.selectedTable === item.name ? "is-selected" : ""}`}
                  tabIndex={0}
                  {...rowHandlers(item)}
                >
                  <td class="db-cell is-object-name" data-sort="name">
                    <span class="db-object-icon"><ColorIcon name={isView(item) ? "view" : "table"} size={16} /></span>
                    {item.name}
                  </td>
                  <td class="db-cell">{item.comment || <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell is-numeric">{item.rows ?? <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell is-numeric">{formatBytes(item.data_length)}</td>
                  <td class="db-cell is-numeric">{formatBytes(item.index_length)}</td>
                  <td class="db-cell is-numeric">{item.auto_increment ?? <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell">{item.engine ?? <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell">{item.collation ?? <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell">{item.updated_at ?? <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell">{item.created_at ?? <span class="db-cell-dim">—</span>}</td>
                </tr>
              )}</For>
            </tbody>
          </table>
          <Show when={list().length === 0}>
            <div class="db-grid-empty">
              <Icon name="table" size={18} />
              <p>{query() ? `没有匹配的${scopeLabel()}` : emptyText()}</p>
              <small>{emptyHint()}</small>
            </div>
          </Show>
        </div>
      </Show>

      {/* 表信息页：左侧字段，右侧索引 / 外键 / 属性，一页看全 */}
      <Show when={props.tab.view === "detail"}>
        <div class="db-detail">
          <Show when={detailTarget()} fallback={<div class="db-grid-empty"><Icon name="table" size={18} /><p>选中一张表查看信息</p></div>}>
            {target => (
              <div class="db-detail-body">
                <header class="db-detail-head">
                  <span class="db-detail-icon"><ColorIcon name={target().kind === "VIEW" ? "view" : "table"} size={26} /></span>
                  <div class="db-table-title">
                    <strong>{target().name}</strong>
                    <span>{target().kind === "VIEW" ? "视图" : "表"} · {props.tab.database}</span>
                  </div>
                  <span class="db-detail-badges">
                    <Show when={primaryKeyNames().length > 0}>
                      <span class="db-badge is-key"><Icon name="key" size={11} />{primaryKeyNames()[0]} 主键</span>
                    </Show>
                    <span class="db-badge">{detailColumns().length} 字段</span>
                    <span class="db-badge">{detailIndexes().length} 索引</span>
                  </span>
                  <span class="db-toolbar-spacer" />
                  <button class="db-text-btn" onClick={() => props.onOpenTable(props.tab.database, target().name)}>
                    <Icon name="table" size={14} />打开数据
                  </button>
                  <button class="db-text-btn" onClick={() => props.onShowDdl(props.tab.database, target().name)}>
                    <Icon name="query" size={14} />DDL
                  </button>
                </header>

                <div class="db-detail-cols">
                  <section class="db-detail-main">
                    <h4 class="db-detail-title">字段 <em>{detailColumns().length}</em></h4>
                    <Show when={!detailLoading()} fallback={<p class="db-detail-loading">正在读取字段…</p>}>
                      <div class="db-field-cols" aria-hidden="true">
                        <span class="is-idx">#</span>
                        <span class="is-name">名称 / 类型</span>
                        <span class="is-null">允许空</span>
                        <span class="is-rest">默认值 · 注释</span>
                      </div>
                      <div class="db-field-rows">
                        <For each={detailColumns()}>{(column, position) => (
                          <div class="db-field-row">
                            <span class="is-idx">{position() + 1}</span>
                            <span class="is-name">
                              {column.name}
                              <Show when={primaryKeyNames().includes(column.name)}><b class="db-key is-pk">PK</b></Show>
                              <em title={column.column_type}>{shortType(column.column_type)}</em>
                            </span>
                            <span class="is-null">{column.nullable ? "是" : "否"}</span>
                            <span class="is-rest">
                              <Show when={column.default_value != null && column.default_value !== ""}><code>{column.default_value}</code></Show>
                              <Show when={column.comment}>{column.comment}</Show>
                              <Show when={!column.comment && (column.default_value == null || column.default_value === "")}><span class="db-cell-dim">—</span></Show>
                            </span>
                          </div>
                        )}</For>
                      </div>
                    </Show>
                  </section>

                  <aside class="db-detail-side">
                    <section class="db-side-block">
                      <h4 class="db-detail-title">索引 <em>{detailIndexes().length}</em></h4>
                      <Show when={detailIndexes().length > 0} fallback={<p class="db-side-empty">没有索引</p>}>
                        <ul class="db-side-list">
                          <For each={detailIndexes()}>{item => (
                            <li>
                              <strong title={item.name}>{item.name}</strong>
                              <span>{item.column || "—"}{item.unique || item.primary ? " · 唯一" : ""}</span>
                            </li>
                          )}</For>
                        </ul>
                      </Show>
                    </section>

                    <section class="db-side-block">
                      <h4 class="db-detail-title">外键 <em>{detailForeignKeys().length}</em></h4>
                      <Show when={detailForeignKeys().length > 0} fallback={<p class="db-side-empty">没有外键</p>}>
                        <ul class="db-side-list">
                          <For each={detailForeignKeys()}>{item => (
                            <li>
                              <strong title={item.name}>{item.name}</strong>
                              <span>{item.columns.join(", ")} → {item.referenced_table}.{item.referenced_columns.join(", ")}</span>
                            </li>
                          )}</For>
                        </ul>
                      </Show>
                    </section>

                    <section class="db-side-block">
                      <h4 class="db-detail-title">属性</h4>
                      <PropRows rows={tableProps(target()).slice(1, 9)} class="is-detail" />
                    </section>
                  </aside>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Show when={props.tab.view === "icons"}>
        <div class="db-object-icons">
          <For each={list()}>{item => (
            <button
              class={`db-object-card ${props.selectedTable === item.name ? "is-selected" : ""}`}
              onClick={() => props.onSelectTable(props.tab.database, item.name)}
              onDblClick={() => props.onOpenTable(props.tab.database, item.name)}
            >
              <span class="db-object-card-top">
                <ColorIcon name={isView(item) ? "view" : "table"} size={16} />
                <strong>{item.name}</strong>
              </span>
              <span class="db-object-card-comment">{item.comment || "—"}</span>
              <span class="db-object-card-meta">
                <span>{isView(item) ? "视图" : item.rows == null ? "—" : `${item.rows.toLocaleString("en-US")} 行`}</span>
                <span>{formatBytes(item.data_length)}</span>
              </span>
            </button>
          )}</For>
        </div>
      </Show>

    </section>
  );
};
