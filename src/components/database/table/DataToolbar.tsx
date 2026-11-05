import { Component, For, Show } from "solid-js";
import { Icon } from "../../Icon";
import { operatorLabel, type FilterSpec, type SortOrder } from "../types";

type Props = {
  pendingCount: number;
  running: boolean;
  filters: FilterSpec;
  orders: SortOrder[];
  filterOpen: boolean;
  dataView: "grid" | "form";
  onRefresh: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onStop: () => void;
  onAddRecord: () => void;
  onDeleteSelected: () => void;
  onCopySelected: () => void;
  onCopyAs: (kind: "insert" | "update" | "json") => void;
  onExportSelected: () => void;
  onExportPage: () => void;
  onOpenDdl: () => void;
  onToggleFilter: () => void;
  onViewChange: (view: "grid" | "form") => void;
  onRemoveCondition: (index: number) => void;
  onClearSort: () => void;
};

export const DataToolbar: Component<Props> = props => (
  <div class="db-toolbar">
    <div class="db-toolbar-group">
      <span class={`db-tx-badge ${props.pendingCount > 0 ? "is-dirty" : ""}`}>
        {props.pendingCount > 0 ? `未提交 ${props.pendingCount}` : "无待提交更改"}
      </span>
      <button class="db-icon-btn" title="刷新" aria-label="刷新" onClick={() => props.onRefresh()}>
        <Icon name="refresh" size={14} />
      </button>
      <button class="db-btn" disabled={props.pendingCount === 0} onClick={() => props.onApply()}>应用</button>
      <button class="db-btn" disabled={props.pendingCount === 0} onClick={() => props.onDiscard()}>放弃</button>
      <button class="db-btn" disabled={!props.running} onClick={() => props.onStop()}>
        <Icon name="close" size={12} />停止
      </button>
    </div>

    <span class="db-toolbar-divider" />

    <div class="db-toolbar-group">
      <button class="db-icon-btn" title="添加记录" aria-label="添加记录" onClick={() => props.onAddRecord()}>
        <Icon name="plus" size={14} />
      </button>
      <button class="db-icon-btn" title="删除选中记录" aria-label="删除选中记录" onClick={() => props.onDeleteSelected()}>
        <Icon name="trash" size={14} />
      </button>
      <button class="db-icon-btn" title="复制选中记录（制表符）" aria-label="复制选中记录" onClick={() => props.onCopySelected()}>
        <Icon name="copy" size={14} />
      </button>
      <div class="db-menu-group">
        <button class="db-btn" title="复制为 SQL / JSON">复制为…</button>
        <div class="db-menu">
          <button onClick={() => props.onCopyAs("insert")}>INSERT 语句</button>
          <button onClick={() => props.onCopyAs("update")}>UPDATE 语句</button>
          <button onClick={() => props.onCopyAs("json")}>JSON</button>
        </div>
      </div>
    </div>

    <span class="db-toolbar-divider" />

    <button
      class={`db-btn ${props.filterOpen ? "is-on" : ""} ${props.filters.conditions.length + props.orders.length > 0 ? "is-filtered" : ""}`}
      onClick={() => props.onToggleFilter()}
      title="筛选与排序（可多条件）"
    >
      <Icon name="sort" size={13} />
      筛选与排序
      <Show when={props.filters.conditions.length + props.orders.length > 0}>
        <em class="db-count">{props.filters.conditions.length + props.orders.length}</em>
      </Show>
    </button>

    <div class="db-chips">
      <For each={props.filters.conditions}>{(condition, index) => (
        <span class="db-chip">
          {condition.column} {operatorLabel(condition.operator)}{condition.value ? ` ${condition.value}` : ""}
          <button aria-label="移除条件" onClick={() => props.onRemoveCondition(index())}><Icon name="close" size={10} /></button>
        </span>
      )}</For>
      <For each={props.orders}>{order => (
        <span class="db-chip is-sort">
          {order.column} {order.direction === "asc" ? "升序" : "降序"}
        </span>
      )}</For>
      <Show when={props.orders.length > 0}>
        <button class="db-chip-clear" onClick={() => props.onClearSort()}>清除排序</button>
      </Show>
    </div>

    <span class="db-toolbar-spacer" />

    <div class="db-toolbar-group">
      <button class="db-text-btn" onClick={() => props.onExportSelected()}>导出选中</button>
      <button class="db-text-btn" onClick={() => props.onExportPage()}>导出本页</button>
      <button class="db-text-btn" onClick={() => props.onOpenDdl()}>DDL</button>
    </div>
    <span class="db-toolbar-divider" />
    <div class="db-seg" role="group" aria-label="数据视图">
      <button class={props.dataView === "grid" ? "is-active" : ""} title="网格视图" aria-label="网格视图" onClick={() => props.onViewChange("grid")}>
        <Icon name="grid" size={14} />
      </button>
      <button class={props.dataView === "form" ? "is-active" : ""} title="表单视图" aria-label="表单视图" onClick={() => props.onViewChange("form")}>
        <Icon name="edit" size={14} />
      </button>
    </div>
  </div>
);
