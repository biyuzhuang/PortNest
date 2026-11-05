import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import { api, type DatabaseColumnInfo, type DatabaseTableInfo } from "../../../utils/api";
import type { WorkspaceState } from "../../../stores/databaseWorkspaceStore";
import {
  formatBytes,
  objectListColumns,
  type DatabaseTab,
  type ObjectView,
  type SortOrder,
} from "../types";

type Props = {
  state: WorkspaceState;
  connectionId: string;
  tab: DatabaseTab;
  tables: DatabaseTableInfo[];
  viewCount: number;
  onOpenTable: (database: string, table: string) => void;
  onNewTable: (database: string) => void;
  onNewQuery: (database: string) => void;
  onRefresh: (database: string) => void;
  onExportSql: (database: string) => void;
  onShowDdl: (database: string, table: string) => void;
};

const VIEWS: Array<{ value: ObjectView; label: string; icon: "list" | "assets" | "grid" }> = [
  { value: "list", label: "列表视图", icon: "list" },
  { value: "detail", label: "详情视图", icon: "assets" },
  { value: "icons", label: "图标视图", icon: "grid" },
];

export const ObjectPanel: Component<Props> = props => {
  const [selected, setSelected] = createSignal<Record<string, true>>({});
  const [detailColumns, setDetailColumns] = createSignal<DatabaseColumnInfo[]>([]);
  const [detailLoading, setDetailLoading] = createSignal(false);

  const query = () => props.state.objectQuery(props.tab.database);
  const sort = () => props.state.objectSort(props.tab.database);

  const baseTables = createMemo(() => props.tables.filter(item => item.kind === "BASE TABLE"));

  const list = createMemo(() => {
    const text = query().trim().toLowerCase();
    const filtered = text
      ? baseTables().filter(item => item.name.toLowerCase().includes(text) || (item.comment || "").toLowerCase().includes(text))
      : baseTables();
    const order = sort();
    if (!order) return filtered;
    const direction = order.direction === "asc" ? 1 : -1;
    return [...filtered].sort((left, right) => {
      const a = (left as unknown as Record<string, unknown>)[order.column];
      const b = (right as unknown as Record<string, unknown>)[order.column];
      if (a == null) return 1;
      if (b == null) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return String(a).localeCompare(String(b), "zh-CN", { numeric: true }) * direction;
    });
  });

  const selectedNames = () => Object.keys(selected());
  const detailTarget = () => {
    const chosen = selectedNames()[0];
    if (chosen) return list().find(item => item.name === chosen) ?? null;
    return list()[0] ?? null;
  };

  // 详情视图：只在该视图下按需拉一次字段，不额外占用列表请求
  createEffect(() => {
    const target = props.tab.view === "detail" ? detailTarget() : null;
    if (!target) { setDetailColumns([]); return; }
    setDetailLoading(true);
    let cancelled = false;
    api.databaseListColumns(props.connectionId, props.tab.database, target.name)
      .then(columns => { if (!cancelled) setDetailColumns(columns); })
      .catch(() => { if (!cancelled) setDetailColumns([]); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    void props.state.schemaVersion();
    return () => { cancelled = true; };
  });

  const toggleSort = (column: string) => {
    const current = sort();
    const next: SortOrder | null = current?.column !== column
      ? { column, direction: "asc" }
      : current.direction === "asc" ? { column, direction: "desc" } : null;
    props.state.setObjectSort(props.tab.database, next);
  };
  const toggleSelected = (name: string) => setSelected(current => {
    const next = { ...current };
    if (next[name]) delete next[name]; else next[name] = true;
    return next;
  });
  const allSelected = () => list().length > 0 && selectedNames().length >= list().length;

  return (
    <section class="db-objects">
      {/* ④ 对象工具栏 */}
      <div class="db-objectbar">
        <div class="db-toolbar-group">
          <button class="db-text-btn" onClick={() => props.onNewQuery(props.tab.database)}>
            <Icon name="query" size={13} />新建查询
          </button>
          <button class="db-text-btn" onClick={() => props.onNewTable(props.tab.database)}>
            <Icon name="plus" size={13} />新建表
          </button>
          <button class="db-text-btn" onClick={() => props.onRefresh(props.tab.database)}>
            <Icon name="refresh" size={13} />刷新
          </button>
        </div>
        <span class="db-toolbar-divider" />
        <button class="db-text-btn" onClick={() => props.onExportSql(props.tab.database)}>
          <Icon name="export" size={13} />导出 SQL
        </button>
        <span class="db-toolbar-spacer" />
        <label class="db-search db-search--inline">
          <Icon name="search" size={13} />
          <input
            value={query()}
            placeholder="名称 / 注释"
            aria-label="搜索表名或注释"
            onInput={event => props.state.setObjectQuery(props.tab.database, event.currentTarget.value)}
          />
        </label>
        <div class="db-seg" role="group" aria-label="对象视图">
          <For each={VIEWS}>{item => (
            <button
              class={props.tab.view === item.value ? "is-active" : ""}
              aria-pressed={props.tab.view === item.value}
              title={item.label}
              aria-label={item.label}
              onClick={() => props.state.patchTab(props.tab.id, { view: item.value })}
            >
              <Icon name={item.icon} size={14} />
            </button>
          )}</For>
        </div>
      </div>

      <Show when={props.tab.view === "list"}>
        <div class="db-grid-wrap">
          <table class="db-grid is-objects">
            <thead>
              <tr>
                <th class="db-col-check">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={allSelected()}
                    onChange={() => setSelected(allSelected() ? {} : Object.fromEntries(list().map(item => [item.name, true as const])))}
                  />
                </th>
                <For each={objectListColumns}>{column => {
                  const direction = () => sort()?.column === column.key ? sort()!.direction : null;
                  return (
                    <th
                      class={`db-th ${column.numeric ? "is-numeric" : ""} ${direction() ? "is-sorted" : ""}`}
                      onClick={() => toggleSort(column.key)}
                    >
                      <span class="db-th-label">{column.label}</span>
                      <span class="db-sort" aria-hidden="true">
                        <Icon name="chevronUp" size={9} class={direction() === "asc" ? "is-on" : ""} />
                        <Icon name="chevronDown" size={9} class={direction() === "desc" ? "is-on" : ""} />
                      </span>
                    </th>
                  );
                }}</For>
              </tr>
            </thead>
            <tbody>
              <For each={list()}>{item => (
                <tr
                  class={`db-row ${selected()[item.name] ? "is-selected" : ""}`}
                  onClick={() => toggleSelected(item.name)}
                  onDblClick={() => props.onOpenTable(props.tab.database, item.name)}
                >
                  <td class="db-col-check">
                    <input
                      type="checkbox"
                      checked={!!selected()[item.name]}
                      aria-label={`选择 ${item.name}`}
                      onClick={event => event.stopPropagation()}
                      onChange={() => toggleSelected(item.name)}
                    />
                  </td>
                  <td class="db-cell is-object-name">
                    <span class="db-object-icon"><Icon name="table" size={13} /></span>
                    {item.name}
                  </td>
                  <td class="db-cell">{item.comment || <span class="db-cell-dim">—</span>}</td>
                  <td class="db-cell is-numeric">{item.rows ?? "—"}</td>
                  <td class="db-cell is-numeric">{formatBytes(item.data_length)}</td>
                  <td class="db-cell is-numeric">{formatBytes(item.index_length)}</td>
                  <td class="db-cell is-numeric">{item.auto_increment ?? "—"}</td>
                  <td class="db-cell">{item.engine ?? "—"}</td>
                  <td class="db-cell">{item.collation?.split("_")[0] ?? "—"}</td>
                  <td class="db-cell">{item.updated_at ?? "—"}</td>
                  <td class="db-cell">{item.created_at ?? "—"}</td>
                </tr>
              )}</For>
            </tbody>
          </table>
          <Show when={list().length === 0}>
            <div class="db-grid-empty">
              <Icon name="table" size={18} />
              <p>{query() ? "没有匹配的表" : "这个数据库还没有表"}</p>
              <small>{query() ? "换个关键词试试" : "点上方「新建表」开始设计"}</small>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.tab.view === "detail"}>
        <div class="db-detail">
          <Show when={detailTarget()} fallback={<div class="db-grid-empty"><Icon name="table" size={18} /><p>选中一张表查看属性</p></div>}>
            {target => (
              <div class="db-detail-body">
                <header class="db-detail-head">
                  <span class="db-object-icon"><Icon name="table" size={14} /></span>
                  <div>
                    <strong>{target().name}</strong>
                    <small>{target().comment || "无注释"}</small>
                  </div>
                  <span class="db-toolbar-spacer" />
                  <button class="db-text-btn" onClick={() => props.onOpenTable(props.tab.database, target().name)}>打开数据</button>
                  <button class="db-text-btn" onClick={() => props.onShowDdl(props.tab.database, target().name)}>DDL</button>
                </header>

                <dl class="db-props">
                  <dt>类型</dt><dd>{target().kind === "VIEW" ? "视图" : "基表"}</dd>
                  <dt>引擎</dt><dd>{target().engine ?? "—"}</dd>
                  <dt>编码</dt><dd>{target().collation ?? "—"}</dd>
                  <dt>预估行数</dt><dd class="is-numeric">{target().rows ?? "—"}</dd>
                  <dt>数据长度</dt><dd class="is-numeric">{formatBytes(target().data_length)}</dd>
                  <dt>索引长度</dt><dd class="is-numeric">{formatBytes(target().index_length)}</dd>
                  <dt>自增</dt><dd class="is-numeric">{target().auto_increment ?? "—"}</dd>
                  <dt>创建时间</dt><dd>{target().created_at ?? "—"}</dd>
                  <dt>更新时间</dt><dd>{target().updated_at ?? "—"}</dd>
                </dl>

                <h4 class="db-detail-title">字段 <em>{detailColumns().length}</em></h4>
                <Show when={!detailLoading()} fallback={<p class="db-detail-loading">正在读取字段…</p>}>
                  <table class="db-grid is-compact">
                    <thead>
                      <tr><th>名称</th><th>类型</th><th>NULL</th><th>键</th><th>默认值</th><th>注释</th></tr>
                    </thead>
                    <tbody>
                      <For each={detailColumns()}>{column => (
                        <tr>
                          <td class="db-cell">{column.name}</td>
                          <td class="db-cell is-mono">{column.column_type}</td>
                          <td class="db-cell">{column.nullable ? "YES" : "NO"}</td>
                          <td class="db-cell">{column.key || "—"}</td>
                          <td class="db-cell">{column.default_value ?? <span class="db-cell-dim">NULL</span>}</td>
                          <td class="db-cell">{column.comment || <span class="db-cell-dim">—</span>}</td>
                        </tr>
                      )}</For>
                    </tbody>
                  </table>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Show when={props.tab.view === "icons"}>
        <div class="db-object-icons">
          <For each={list()}>{item => (
            <button class="db-object-card" onDblClick={() => props.onOpenTable(props.tab.database, item.name)}>
              <span class="db-object-card-icon"><Icon name="table" size={22} /></span>
              <strong>{item.name}</strong>
              <em>{formatBytes(item.data_length)}</em>
            </button>
          )}</For>
        </div>
      </Show>

      <div class="db-statusbar">
        <span class="db-status-item">{list().length} 张表 · {props.viewCount} 个视图</span>
        <Show when={selectedNames().length > 0}><span class="db-status-item">已选 {selectedNames().length} 项</span></Show>
        <span class="db-toolbar-spacer" />
        <span class="db-status-item is-muted">双击行打开数据</span>
      </div>
    </section>
  );
};
