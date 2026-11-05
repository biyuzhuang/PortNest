import { Component, For, Index, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseColumnInfo, QueryResult } from "../../../utils/api";
import { formatCell, isNullValue, type PendingChanges, type SortOrder } from "../types";

export type CellEdit = { rowIndex: number; column: string; raw: string };

type Props = {
  result: QueryResult;
  columns: DatabaseColumnInfo[];
  pending: PendingChanges;
  orders: SortOrder[];
  primaryKey: string[];
  columnWidths: Record<string, number>;
  readOnly: boolean;
  onSort: (column: string) => void;
  onToggleRow: (key: string) => void;
  onToggleAll: () => void;
  onCommit: (edit: CellEdit) => void;
  onInsertedEdit: (id: number, column: string, raw: string) => void;
  onResize: (column: string, width: number) => void;
  onRowFocus: (rowIndex: number) => void;
};

const FROZEN_KEY = "portnest.database.frozenColumns";

export const DataGrid: Component<Props> = props => {
  const [editing, setEditing] = createSignal<{ rowIndex: number; column: string } | null>(null);
  const [draft, setDraft] = createSignal("");
  const [frozen, setFrozen] = createSignal<Record<string, true>>(readFrozen());

  const columns = createMemo(() => props.result.columns);
  const columnType = (name: string) => props.columns.find(item => item.name === name)?.column_type ?? "";
  const isNumericColumn = (name: string) => props.columns.find(item => item.name === name)?.data_type?.match(/int|decimal|numeric|float|double|real/i) != null;
  const orderFor = (name: string) => props.orders.find(item => item.column === name)?.direction ?? null;
  const rowKey = (rowIndex: number) => {
    if (props.primaryKey.length === 0) return `row:${rowIndex}`;
    const values = props.result.rows[rowIndex]?.values ?? [];
    const parts = props.primaryKey.map(name => String(values[columns().indexOf(name)]));
    return `pk:${parts.join("\u0001")}`;
  };
  const isDeleted = (rowIndex: number) => !!props.pending.deletes[rowKey(rowIndex)];
  const isUpdated = (rowIndex: number) => !!props.pending.updates[rowKey(rowIndex)];
  const effectiveRow = (rowIndex: number) => {
    const base = props.result.rows[rowIndex]?.values ?? [];
    const updated = props.pending.updates[rowKey(rowIndex)]?.values;
    if (!updated) return base;
    return base.map((value, index) => (columns()[index] in updated ? updated[columns()[index]] : value));
  };

  const editable = () => !props.readOnly && props.primaryKey.length > 0;

  const beginEdit = (rowIndex: number, column: string) => {
    if (!editable()) return;
    const index = columns().indexOf(column);
    const value = effectiveRow(rowIndex)[index];
    setDraft(isNullValue(value) ? "" : formatCell(value));
    setEditing({ rowIndex, column });
  };
  const commitEdit = () => {
    const target = editing();
    if (!target) return;
    setEditing(null);
    const index = columns().indexOf(target.column);
    const original = props.result.rows[target.rowIndex]?.values[index];
    // 原本是 NULL 且用户没输入 → 保持 NULL，而不是空字符串
    props.onCommit({ rowIndex: target.rowIndex, column: target.column, raw: draft() === "" && isNullValue(original) ? "NULL" : draft() });
  };

  const toggleFrozen = (name: string) => {
    const next = { ...frozen() };
    if (next[name]) delete next[name]; else next[name] = true;
    setFrozen(next);
    localStorage.setItem(FROZEN_KEY, JSON.stringify(Object.keys(next)));
  };

  const visibleRows = createMemo(() => props.result.rows.map((_row, index) => index).filter(index => !isDeleted(index)));

  return (
    <div class="db-grid-wrap">
      <table class="db-grid is-data">
        <thead>
          <tr>
            <th class="db-col-check is-frozen">
              <input
                type="checkbox"
                aria-label="全选"
                checked={Object.keys(props.pending.selected).length > 0}
                onChange={() => props.onToggleAll()}
              />
            </th>
            <th class="db-col-index is-frozen">#</th>
            <For each={columns()}>{name => (
              <th
                class={`db-th ${isNumericColumn(name) ? "is-numeric" : ""} ${orderFor(name) ? "is-sorted" : ""} ${frozen()[name] ? "is-frozen" : ""}`}
                style={props.columnWidths[name] ? { width: `${props.columnWidths[name]}px` } : undefined}
                onClick={() => props.onSort(name)}
                title={`按 ${name} 排序`}
              >
                <span class="db-th-name">{name}</span>
                <span class="db-th-type">{columnType(name) || "\u00a0"}</span>
                <span class="db-sort" aria-hidden="true">
                  <Icon name="chevronUp" size={9} class={orderFor(name) === "asc" ? "is-on" : ""} />
                  <Icon name="chevronDown" size={9} class={orderFor(name) === "desc" ? "is-on" : ""} />
                </span>
                <button
                  class={`db-th-pin ${frozen()[name] ? "is-on" : ""}`}
                  title={frozen()[name] ? "取消冻结" : "冻结此列"}
                  aria-label={frozen()[name] ? "取消冻结" : "冻结此列"}
                  onClick={event => { event.stopPropagation(); toggleFrozen(name); }}
                >
                  <Icon name="pin" size={10} />
                </button>
                <ResizeHandle
                  onResize={width => props.onResize(name, width)}
                  current={() => props.columnWidths[name] ?? 0}
                />
              </th>
            )}</For>
          </tr>
        </thead>
        <tbody>
          <For each={visibleRows()}>{rowIndex => {
            const key = () => rowKey(rowIndex);
            return (
              <tr
                class={`db-row ${isUpdated(rowIndex) ? "is-dirty" : ""} ${props.pending.selected[key()] ? "is-selected" : ""}`}
                onClick={() => props.onRowFocus(rowIndex)}
              >
                <td class="db-col-check is-frozen">
                  <input
                    type="checkbox"
                    checked={!!props.pending.selected[key()]}
                    aria-label={`选择第 ${rowIndex + 1} 行`}
                    onChange={() => props.onToggleRow(key())}
                  />
                </td>
                <td class="db-col-index is-frozen">{rowIndex + 1}</td>
                <Index each={effectiveRow(rowIndex)}>{(cell, cellIndex) => {
                  const name = () => columns()[cellIndex];
                  const editingHere = () => editing()?.rowIndex === rowIndex && editing()?.column === name();
                  return (
                    <td
                      class={`db-cell ${isNullValue(cell()) ? "is-null" : ""} ${isNumericColumn(name()) ? "is-numeric" : ""} ${frozen()[name()] ? "is-frozen" : ""} ${props.pending.updates[key()]?.values?.[name()] !== undefined ? "is-dirty" : ""}`}
                      style={props.columnWidths[name()] ? { width: `${props.columnWidths[name()]}px` } : undefined}
                      onDblClick={() => beginEdit(rowIndex, name())}
                    >
                      <Show
                        when={editingHere()}
                        fallback={
                          <span class="db-cell-text" title={formatCell(cell())}>
                            {isNullValue(cell()) ? <em class="db-cell-null">NULL</em> : formatCell(cell())}
                          </span>
                        }
                      >
                        <input
                          class="db-cell-input"
                          value={draft()}
                          ref={element => queueMicrotask(() => { element.focus(); element.select(); })}
                          onInput={event => setDraft(event.currentTarget.value)}
                          onBlur={commitEdit}
                          onKeyDown={event => {
                            if (event.key === "Enter") { event.preventDefault(); commitEdit(); }
                            else if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                          }}
                        />
                      </Show>
                    </td>
                  );
                }}</Index>
              </tr>
            );
          }}</For>

          <Index each={props.pending.inserted}>{item => (
            <tr class="db-row is-insert">
              <td class="db-col-check is-frozen">
                <input
                  type="checkbox"
                  checked={!!props.pending.selected[`new:${item().id}`]}
                  aria-label="选择新增行"
                  onChange={() => props.onToggleRow(`new:${item().id}`)}
                />
              </td>
              <td class="db-col-index is-frozen">＋</td>
              <Index each={columns()}>{name => (
                <td class="db-cell is-dirty">
                  <input
                    class="db-cell-input"
                    value={item().values[name()] === undefined ? "" : formatCell(item().values[name()])}
                    onInput={event => props.onInsertedEdit(item().id, name(), event.currentTarget.value)}
                  />
                </td>
              )}</Index>
            </tr>
          )}</Index>
        </tbody>
      </table>

      <Show when={!props.readOnly && props.primaryKey.length === 0}>
        <div class="db-grid-hint">
          <Icon name="alert" size={13} />
          这张表没有主键，无法安全定位行，编辑已禁用。可用「复制为 INSERT」导出后在 SQL 里修改。
        </div>
      </Show>

      <Show when={visibleRows().length === 0 && props.pending.inserted.length === 0}>
        <div class="db-grid-empty">
          <Icon name="table" size={18} />
          <p>{props.result.rows.length === 0 ? "没有匹配的数据" : "本页数据都已标记删除"}</p>
          <small>{props.result.rows.length === 0 ? "清空筛选条件，或换一个关键词试试" : "点「放弃」可以撤销标记"}</small>
        </div>
      </Show>
    </div>
  );
};

const ResizeHandle: Component<{ current: () => number; onResize: (width: number) => void }> = props => (
  <span
    class="db-col-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="调整列宽"
    onPointerDown={event => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = props.current() || (event.currentTarget.parentElement as HTMLElement).offsetWidth;
      const move = (moveEvent: PointerEvent) => props.onResize(Math.max(64, startWidth + moveEvent.clientX - startX));
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "col-resize";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }}
  />
);

const readFrozen = (): Record<string, true> => {
  try {
    const raw = localStorage.getItem(FROZEN_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Object.fromEntries(list.map(name => [name, true as const]));
  } catch {
    return {};
  }
};
