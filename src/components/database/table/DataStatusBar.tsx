import { Component, For, Show } from "solid-js";
import { Icon } from "../../Icon";
import { DB_PAGE_SIZES } from "../types";

type Props = {
  statement?: string | null;
  tableName: string;
  page: number;
  pageSize: number;
  rowCount: number;
  /** 设置开启时的全表总行数：undefined=未统计，null=统计不可用 */
  totalRows?: number | null;
  totalLoading?: boolean;
  elapsedMs: number;
  truncated?: boolean;
  selectedCount: number;
  pendingCount: number;
  autoRefresh: boolean;
  onCopySql: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onToggleAutoRefresh: (value: boolean) => void;
};

const pageSizes = (current: number) => DB_PAGE_SIZES.includes(current) ? DB_PAGE_SIZES : [...DB_PAGE_SIZES, current].sort((left, right) => left - right);

export const DataStatusBar: Component<Props> = props => (
  <div class="db-statusbar">
    <button class="db-sql" title="点击复制 SQL" onClick={() => props.onCopySql()}>
      <Icon name="query" size={14} />
      <span>{props.statement || `SELECT * FROM ${props.tableName}`}</span>
    </button>
    <span class="db-toolbar-spacer" />
    <span class="db-status-item">已选 {props.selectedCount}</span>
    <span class="db-status-item">未提交 {props.pendingCount}</span>
    <Show when={props.totalRows !== undefined}>
      <span class="db-status-item is-mono" title={props.totalRows === null ? "带筛选条件或统计失败时不显示总数" : "全表总行数"}>
        {props.totalLoading ? "统计中…" : props.totalRows === null ? "总数未知" : `共 ${(props.totalRows ?? 0).toLocaleString("zh-CN")} 行`}
      </span>
    </Show>
    <span class="db-status-item is-mono">{props.rowCount} 行 · {props.elapsedMs}ms</span>
    <div class="db-pager">
      <button class="db-icon-btn" disabled={props.page <= 1} aria-label="上一页" title="上一页" onClick={() => props.onPageChange(props.page - 1)}>
        <Icon name="chevronRight" size={14} class="db-flip" />
      </button>
      <span class="db-page-label is-mono">第 {props.page} 页</span>
      <button class="db-icon-btn" disabled={!props.truncated} aria-label="下一页" title="下一页" onClick={() => props.onPageChange(props.page + 1)}>
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
    <select class="db-page-size" value={String(props.pageSize)} aria-label="每页条数" onChange={event => props.onPageSizeChange(Number(event.currentTarget.value))}>
      {/* 设置里允许 10–10000 的任意值：不在预设档位时补一个当前值，避免下拉显示空白 */}
      <For each={pageSizes(props.pageSize)}>{size => <option value={String(size)}>{size} 条/页</option>}</For>
    </select>
    <label class="db-autorefresh">
      <input type="checkbox" checked={props.autoRefresh} onChange={event => props.onToggleAutoRefresh(event.currentTarget.checked)} />
      自动刷新
    </label>
    <Show when={props.truncated}>
      <span class="db-status-item is-muted">还有更多数据</span>
    </Show>
  </div>
);
