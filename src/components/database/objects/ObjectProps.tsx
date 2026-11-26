import { For, type Component } from "solid-js";
import type { DatabaseTableInfo } from "../../../utils/api";
import { formatBytesExact } from "../types";

/** 属性行：标签在上、值在下，缺失一律 `--`（对齐 Navicat 属性面板） */
export type PropRow = [label: string, value: string];

export const tableProps = (item: DatabaseTableInfo): PropRow[] => [
  ["行", item.rows == null ? "--" : item.rows.toLocaleString("en-US")],
  ["引擎", item.engine || "--"],
  ["自动递增", item.auto_increment == null ? "--" : String(item.auto_increment)],
  ["行格式", item.row_format || "--"],
  ["修改日期", item.updated_at || "--"],
  ["创建日期", item.created_at || "--"],
  ["检查时间", item.checked_at || "--"],
  ["索引长度", formatBytesExact(item.index_length)],
  ["数据长度", formatBytesExact(item.data_length)],
  ["最大数据长度", formatBytesExact(item.max_data_length)],
  ["数据可用空间", formatBytesExact(item.data_free)],
  ["排序规则", item.collation || "--"],
  ["创建选项", item.create_options || "--"],
  ["注释", item.comment || "--"],
];

/** 属性栈：列表页右侧信息页与整页信息视图共用，保证两处视觉一致 */
export const PropRows: Component<{ rows: PropRow[]; class?: string }> = props => (
  <dl class={`db-props-stack ${props.class ?? ""}`}>
    <For each={props.rows}>{row => (
      <div class="db-prop">
        <dt>{row[0]}</dt>
        <dd title={row[1]}>{row[1]}</dd>
      </div>
    )}</For>
  </dl>
);
