import { Component, For, Index, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseColumnInfo, QueryResult } from "../../../utils/api";
import { formatCell, isNullValue, type PendingChanges, type SortOrder } from "../types";
import { databaseSettings, databaseSettingsEpoch } from "../../../stores/databaseSettings";

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
  // 设置读取统一走这里：多读一次变更计数，HMR 下换过 store 实例也能刷新
  const settings = () => {
    databaseSettingsEpoch();
    return databaseSettings();
  };

  const [editing, setEditing] = createSignal<{ rowIndex: number; column: string } | null>(null);
  const [draft, setDraft] = createSignal("");
  const [frozen, setFrozen] = createSignal<Record<string, true>>(readFrozen());
  /** 「固定主键列」开启时，主键列始终固定在左侧（优先于用户手动 pin） */
  const frozenSet = () => {
    if (!settings().fixedPrimaryKey) return frozen();
    const pinned = Object.fromEntries(props.primaryKey.map(name => [name, true as const]));
    return { ...frozen(), ...pinned };
  };
  /** 冻结列的 left 偏移；按表头实测宽度累加，避免写死像素 */
  const [frozenLeft, setFrozenLeft] = createSignal<Record<string, number>>({});
  let headRow: HTMLTableRowElement | undefined;

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

  /**
   * 冻结列必须给出具体 left 才真的「贴住」左边，否则 position: sticky 没有参照点。
   * 列宽是自动的，只能量：按表头顺序把前面各列的宽度累加起来。
   */
  const measureFrozen = () => {
    const row = headRow;
    if (!row) return;
    const offsets: Record<string, number> = {};
    let left = 0;
    // 只累加「已冻结」列的宽度：未冻结的列会随横向滚动移走，把它们的宽度算进来
    // 会让第二个冻结列（例如主键列）凭空多出一段偏移，贴在错误的位置。
    for (const cell of Array.from(row.children) as HTMLElement[]) {
      const name = cell.dataset.column;
      const pinned = name ? !!frozenSet()[name] : cell.classList.contains("is-frozen");
      if (!pinned) continue;
      if (name) offsets[name] = left;
      left += cell.offsetWidth;
    }
    setFrozenLeft(offsets);
  };

  createEffect(() => {
    // 依赖：冻结集合 / 列宽 / 列集合，任一变化都要重新量
    frozenSet();
    props.columnWidths;
    props.result.columns;
    requestAnimationFrame(measureFrozen);
  });

  const cellStyle = (name: string) => {
    const style: Record<string, string> = {};
    if (props.columnWidths[name]) style.width = `${props.columnWidths[name]}px`;
    const left = frozenLeft()[name];
    if (left !== undefined) style.left = `${left}px`;
    return style;
  };

  const visibleRows = createMemo(() => props.result.rows.map((_row, index) => index).filter(index => !isDeleted(index)));

  /** 「自然滚动」保留浏览器默认；开启平滑或调整速度时改为手动滚动 */
  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return; // Ctrl+滚轮是整体缩放，交给全局处理
    const wheel = databaseSettings();
    const speed = wheel.wheelSpeed;
    if (wheel.scrollMode === "natural" && speed === 1) return;
    const wrap = event.currentTarget as HTMLElement;
    if (wrap.scrollHeight <= wrap.clientHeight && wrap.scrollWidth <= wrap.clientWidth) return;
    event.preventDefault();
    wrap.scrollBy({
      top: event.deltaY * speed,
      left: event.deltaX * speed,
      behavior: wheel.scrollMode === "smooth" ? "smooth" : "auto",
    });
  };

  return (
    <div class="db-grid-wrap" onWheel={handleWheel}>
      <table class="db-grid is-data" data-align={settings().textAlign}>
        <thead>
          <tr ref={element => { headRow = element; }}>
            <th class="db-col-check is-frozen">
              <input
                type="checkbox"
                aria-label="全选"
                checked={Object.keys(props.pending.selected).length > 0}
                onChange={() => props.onToggleAll()}
              />
            </th>
            <For each={columns()}>{name => (
              <th
                class={`db-th ${isNumericColumn(name) ? "is-numeric" : ""} ${orderFor(name) ? "is-sorted" : ""} ${frozenSet()[name] ? "is-frozen" : ""}`}
                data-column={name}
                style={cellStyle(name)}
                onClick={() => props.onSort(name)}
                title={`按 ${name} 排序`}
              >
                <span class="db-th-inner">
                  <span class="db-th-main">
                    <span class="db-th-name">{name}</span>
                    <Show when={settings().compositeHeader}>
                      <span class="db-th-type">{columnType(name) || "\u00a0"}</span>
                    </Show>
                  </span>
                  <span class="db-th-tools">
                    <span class="db-sort" aria-hidden="true">
                      <Icon name="chevronUp" size={12} class={orderFor(name) === "asc" ? "is-on" : ""} />
                      <Icon name="chevronDown" size={12} class={orderFor(name) === "desc" ? "is-on" : ""} />
                    </span>
                    <button
                      class={`db-th-pin ${frozenSet()[name] ? "is-on" : ""}`}
                      disabled={settings().fixedPrimaryKey && props.primaryKey.includes(name)}
                      title={settings().fixedPrimaryKey && props.primaryKey.includes(name) ? "主键列已在设置中固定" : frozen()[name] ? "取消冻结" : "冻结此列"}
                      aria-label={frozenSet()[name] ? "取消冻结" : "冻结此列"}
                      onClick={event => { event.stopPropagation(); toggleFrozen(name); }}
                    >
                      <Icon name="pin" size={12} />
                    </button>
                  </span>
                </span>
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
                <Index each={effectiveRow(rowIndex)}>{(cell, cellIndex) => {
                  const name = () => columns()[cellIndex];
                  const editingHere = () => editing()?.rowIndex === rowIndex && editing()?.column === name();
                  return (
                    <td
                      class={`db-cell ${isNullValue(cell()) ? "is-null" : ""} ${isNumericColumn(name()) ? "is-numeric" : ""} ${frozenSet()[name()] ? "is-frozen" : ""} ${editable() ? "is-editable" : ""} ${props.pending.updates[key()]?.values?.[name()] !== undefined ? "is-dirty" : ""}`}
                      style={cellStyle(name())}
                      title={editable() ? "双击编辑" : undefined}
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
              <Index each={columns()}>{name => (
                <td class={`db-cell is-dirty ${frozenSet()[name()] ? "is-frozen" : ""}`} style={cellStyle(name())}>
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
          <Icon name="alert" size={14} />
          这张表没有主键，无法安全定位行，编辑已禁用。可用「导出选中」导出成 CSV 后在 SQL 里修改。
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
