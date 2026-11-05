import { Component, For, Show } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseColumnInfo, DatabaseIndexInfo } from "../../../utils/api";

type Props = {
  columns: DatabaseColumnInfo[];
  indexes: DatabaseIndexInfo[];
  onShowDdl: () => void;
};

export const StructureView: Component<Props> = props => (
  <div class="db-structure">
    <div class="db-structure-head">
      <strong>字段</strong>
      <em>{props.columns.length}</em>
      <span class="db-toolbar-spacer" />
      <button class="db-text-btn" onClick={() => props.onShowDdl()}>
        <Icon name="query" size={12} />查看 DDL
      </button>
    </div>
    <div class="db-grid-wrap">
      <table class="db-grid is-compact">
        <thead>
          <tr>
            <th class="db-col-index">#</th>
            <th>名称</th>
            <th>类型</th>
            <th>NULL</th>
            <th>键</th>
            <th>默认值</th>
            <th>附加</th>
            <th>注释</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.columns}>{(column, index) => (
            <tr class="db-row">
              <td class="db-col-index db-index">{index() + 1}</td>
              <td class="db-cell is-object-name">
                <Show when={column.key === "PRI"}><Icon name="key" size={11} class="db-key-icon" /></Show>
                {column.name}
              </td>
              <td class="db-cell is-mono">{column.column_type}</td>
              <td class="db-cell">{column.nullable ? "YES" : "NO"}</td>
              <td class="db-cell">{column.key || <span class="db-cell-dim">—</span>}</td>
              <td class="db-cell">{column.default_value ?? <span class="db-cell-dim">NULL</span>}</td>
              <td class="db-cell">{column.extra || <span class="db-cell-dim">—</span>}</td>
              <td class="db-cell">{column.comment || <span class="db-cell-dim">—</span>}</td>
            </tr>
          )}</For>
        </tbody>
      </table>
    </div>

    <div class="db-structure-head">
      <strong>索引</strong>
      <em>{new Set(props.indexes.map(item => item.name)).size}</em>
    </div>
    <div class="db-grid-wrap">
      <table class="db-grid is-compact">
        <thead>
          <tr><th>名称</th><th>类型</th><th>字段</th><th>顺序</th><th>前缀</th><th>唯一</th></tr>
        </thead>
        <tbody>
          <For each={props.indexes}>{item => (
            <tr class="db-row">
              <td class="db-cell is-object-name">{item.name}</td>
              <td class="db-cell">{item.index_type || "BTREE"}</td>
              <td class="db-cell">{item.column ?? "—"}</td>
              <td class="db-cell">{item.sequence}</td>
              <td class="db-cell is-numeric">{item.prefix_length ?? "—"}</td>
              <td class="db-cell">{item.unique ? "YES" : "NO"}</td>
            </tr>
          )}</For>
        </tbody>
      </table>
      <Show when={props.indexes.length === 0}>
        <div class="db-grid-empty"><p>这张表没有索引</p><small>在「设计表 → 索引」里添加</small></div>
      </Show>
    </div>
  </div>
);
