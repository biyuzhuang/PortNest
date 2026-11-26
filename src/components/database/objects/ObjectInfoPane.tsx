import { Component, Show } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseTableInfo } from "../../../utils/api";
import { PropRows, tableProps } from "./ObjectProps";

type Props = {
  database: string;
  table: DatabaseTableInfo | null;
  onClose: () => void;
};

/**
 * 右侧「表信息」页：对象树或列表里单击任意一张表都落到这里，
 * 是全应用唯一的表属性入口；关闭后单击表名会重新打开。
 */
export const ObjectInfoPane: Component<Props> = props => (
  <aside class="db-object-props" aria-label="表信息">
    <header class="db-object-props-head">
      <span class="db-detail-icon"><Icon name="table" size={24} /></span>
      <span class="db-table-title">
        <strong title={props.table?.name ?? "表信息"}>{props.table?.name ?? "表信息"}</strong>
        <span>{props.table ? (props.table.kind === "VIEW" ? "视图" : "表") : props.database}</span>
      </span>
      <button class="db-icon-btn" aria-label="关闭表信息" title="关闭" onClick={() => props.onClose()}>
        <Icon name="close" size={14} />
      </button>
    </header>

    <Show
      when={props.table}
      fallback={
        <div class="db-object-props-empty">
          <Icon name="info" size={18} />
          <p>选中一张表查看信息</p>
        </div>
      }
    >
      {item => <PropRows rows={tableProps(item())} class="is-detail" />}
    </Show>
  </aside>
);
