import { Component, Show } from "solid-js";
import { Icon } from "../../Icon";

type Props = {
  readOnly: boolean;
  hasPrimaryKey: boolean;
  pendingCount: number;
  selectedCount: number;
  running: boolean;
  onAdd: () => void;
  onDelete: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onRefresh: () => void;
  onStop: () => void;
};

/**
 * 数据网格底部的记录操作条（对齐 Navicat：新增 / 删除 / 提交 / 撤销 / 刷新 / 停止）。
 * 放在网格正下方，紧邻 SQL 行——操作的是「当前这张表的数据」，不是整个工作区。
 */
export const DataEditBar: Component<Props> = props => {
  // 删除与提交都要靠主键定位到具体行，没有主键只能看
  const canMutate = () => !props.readOnly && props.hasPrimaryKey;
  const hint = () => {
    if (props.readOnly) return "只读模式：在状态栏关闭「只读」后可编辑";
    if (!props.hasPrimaryKey) return "该表没有主键，无法定位行，只能查看";
    if (props.pendingCount > 0) return `双击单元格继续修改，Enter 提交单元格，Esc 取消；${props.pendingCount} 处更改待提交`;
    return "双击单元格修改，Enter 提交单元格，Esc 取消";
  };

  return (
    <div class="db-editbar">
      <div class="db-editbar-group">
        <button
          class="db-editbar-btn"
          title="新增记录"
          aria-label="新增记录"
          disabled={props.readOnly}
          onClick={() => props.onAdd()}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          class="db-editbar-btn"
          title="删除选中记录"
          aria-label="删除选中记录"
          disabled={!canMutate() || props.selectedCount === 0}
          onClick={() => props.onDelete()}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>

      <span class="db-editbar-divider" />

      <div class="db-editbar-group">
        <button
          class="db-editbar-btn is-commit"
          title={props.pendingCount > 0 ? `提交 ${props.pendingCount} 处更改` : "提交更改"}
          aria-label="提交更改"
          disabled={props.pendingCount === 0}
          onClick={() => props.onApply()}
        >
          <Icon name="check" size={14} />
        </button>
        <button
          class="db-editbar-btn is-discard"
          title="撤销全部未提交更改"
          aria-label="撤销更改"
          disabled={props.pendingCount === 0}
          onClick={() => props.onDiscard()}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <span class="db-editbar-divider" />

      <div class="db-editbar-group">
        <button class="db-editbar-btn" title="刷新数据" aria-label="刷新数据" onClick={() => props.onRefresh()}>
          <Icon name="refresh" size={14} />
        </button>
        <button
          class="db-editbar-btn is-stop"
          title="停止当前查询"
          aria-label="停止当前查询"
          disabled={!props.running}
          onClick={() => props.onStop()}
        >
          <Icon name="stop" size={14} />
        </button>
      </div>

      <Show when={props.pendingCount > 0}>
        <span class="db-editbar-pending">未提交 {props.pendingCount}</span>
      </Show>

      <span class="db-editbar-spacer" />
      <span class="db-editbar-hint" title={hint()}>{hint()}</span>
    </div>
  );
};
