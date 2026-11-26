import { Component, For, Show } from "solid-js";
import { Icon } from "../../Icon";
import { operatorLabel, type FilterSpec, type SortOrder } from "../types";

type Props = {
  filters: FilterSpec;
  orders: SortOrder[];
  filterOpen: boolean;
  dataView: "grid" | "form";
  onCopySelected: () => void;
  onExportSelected: () => void;
  onExportPage: () => void;
  onOpenDdl: () => void;
  onToggleFilter: () => void;
  onViewChange: (view: "grid" | "form") => void;
  onRemoveCondition: (index: number) => void;
  onClearSort: () => void;
};

/**
 * 数据页顶部工具条：只管「看」与「取」——复制、筛选排序、导出、切视图。
 * 增删改提交这组写操作在网格下方的 DataEditBar 里，别重复。
 */
export const DataToolbar: Component<Props> = props => (
  <div class="db-toolbar">
    {/* 左侧「筛选 / 条件 chip」可滚动，右侧复制/导出/视图切换固定可见 */}
    <div class="db-toolbar-scroll">
    <button
      class={`db-btn ${props.filterOpen ? "is-on" : ""} ${props.filters.conditions.length + props.orders.length > 0 ? "is-filtered" : ""}`}
      onClick={() => props.onToggleFilter()}
      title="筛选与排序（可多条件）"
    >
      <Icon name="sort" size={14} />
      <span class="db-btn-label">筛选与排序</span>
      <Show when={props.filters.conditions.length + props.orders.length > 0}>
        <em class="db-count">{props.filters.conditions.length + props.orders.length}</em>
      </Show>
    </button>

    <div class="db-chips">
      <For each={props.filters.conditions}>{(condition, index) => (
        <span class="db-chip">
          {condition.column} {operatorLabel(condition.operator)}{condition.value ? ` ${condition.value}` : ""}
          <button aria-label="移除条件" onClick={() => props.onRemoveCondition(index())}><Icon name="close" size={12} /></button>
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

    </div>
    <div class="db-toolbar-side">
    <div class="db-toolbar-group">
      <button class="db-icon-btn" title="复制选中记录（制表符）" aria-label="复制选中记录" onClick={() => props.onCopySelected()}>
        <Icon name="copy" size={16} />
      </button>
      <button class="db-text-btn" data-label-only title="导出选中" aria-label="导出选中" onClick={() => props.onExportSelected()}><span class="db-btn-label">导出选中</span></button>
      <button class="db-text-btn" data-label-only title="导出本页" aria-label="导出本页" onClick={() => props.onExportPage()}><span class="db-btn-label">导出本页</span></button>
      <button class="db-text-btn" data-label-only title="查看 DDL" aria-label="查看 DDL" onClick={() => props.onOpenDdl()}><span class="db-btn-label">DDL</span></button>
    </div>
    <span class="db-toolbar-divider" />
    <div class="db-seg" role="group" aria-label="数据视图">
      <button class={props.dataView === "grid" ? "is-active" : ""} title="网格视图" aria-label="网格视图" onClick={() => props.onViewChange("grid")}>
        <Icon name="grid" size={16} />
      </button>
      <button class={props.dataView === "form" ? "is-active" : ""} title="表单视图" aria-label="表单视图" onClick={() => props.onViewChange("form")}>
        <Icon name="edit" size={16} />
      </button>
    </div>
    </div>
  </div>
);
