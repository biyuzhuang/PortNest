import { Component, For, Show } from "solid-js";
import { Icon } from "../../Icon";
import { DB_PAGE_SIZES } from "../types";

type Props = {
  statement?: string | null;
  tableName: string;
  page: number;
  pageSize: number;
  rowCount: number;
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

export const DataStatusBar: Component<Props> = props => (
  <div class="db-statusbar">
    <button class="db-sql" title="点击复制 SQL" onClick={() => props.onCopySql()}>
      <Icon name="query" size={12} />
      <span>{props.statement || `SELECT * FROM ${props.tableName}`}</span>
    </button>
    <span class="db-toolbar-spacer" />
    <span class="db-status-item">已选 {props.selectedCount}</span>
    <span class="db-status-item">未提交 {props.pendingCount}</span>
    <span class="db-status-item is-mono">{props.rowCount} 行 · {props.elapsedMs}ms</span>
    <div class="db-pager">
      <button class="db-icon-btn" disabled={props.page <= 1} aria-label="上一页" title="上一页" onClick={() => props.onPageChange(props.page - 1)}>
        <Icon name="chevronRight" size={13} class="db-flip" />
      </button>
      <span class="db-page-label is-mono">第 {props.page} 页</span>
      <button class="db-icon-btn" disabled={!props.truncated} aria-label="下一页" title="下一页" onClick={() => props.onPageChange(props.page + 1)}>
        <Icon name="chevronRight" size={13} />
      </button>
    </div>
    <select class="db-page-size" value={String(props.pageSize)} aria-label="每页条数" onChange={event => props.onPageSizeChange(Number(event.currentTarget.value))}>
      <For each={DB_PAGE_SIZES}>{size => <option value={String(size)}>{size} 条/页</option>}</For>
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
