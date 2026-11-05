import { Component, For, Index, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseColumnInfo, QueryResult } from "../../../utils/api";
import { formatCell, isNullValue, type PendingChanges } from "../types";

type Props = {
  result: QueryResult;
  columns: DatabaseColumnInfo[];
  pending: PendingChanges;
  primaryKey: string[];
  index: number;
  readOnly: boolean;
  onIndexChange: (index: number) => void;
  onCommit: (edit: { rowIndex: number; column: string; raw: string }) => void;
};

export const DataFormView: Component<Props> = props => {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");

  const columnMeta = (name: string) => props.columns.find(item => item.name === name);
  // rowKey 必须在 currentRow 之前定义：createMemo 会立刻求值，晚定义会落进 TDZ
  const rowKey = () => {
    const values = props.result.rows[props.index]?.values ?? [];
    if (props.primaryKey.length === 0) return `row:${props.index}`;
    return `pk:${props.primaryKey.map(name => String(values[props.result.columns.indexOf(name)])).join("\u0001")}`;
  };
  const currentRow = createMemo(() => {
    const values = props.result.rows[props.index]?.values ?? [];
    const updated = props.pending.updates[rowKey()]?.values;
    return values.map((value, cellIndex) => {
      const name = props.result.columns[cellIndex];
      return updated && name in updated ? updated[name] : value;
    });
  });
  const dirty = (name: string) => props.pending.updates[rowKey()]?.values?.[name] !== undefined;
  const editable = () => !props.readOnly && props.primaryKey.length > 0;

  const begin = (name: string, value: unknown) => {
    if (!editable()) return;
    setDraft(isNullValue(value) ? "" : formatCell(value));
    setEditing(name);
  };
  const commit = () => {
    const name = editing();
    if (!name) return;
    setEditing(null);
    const cellIndex = props.result.columns.indexOf(name);
    const original = props.result.rows[props.index]?.values[cellIndex];
    props.onCommit({ rowIndex: props.index, column: name, raw: draft() === "" && isNullValue(original) ? "NULL" : draft() });
  };

  return (
    <div class="db-formview">
      <div class="db-formview-main">
        <header class="db-formview-head">
          <div>
            <strong>{props.result.rows[props.index]?.values[0] ?? "—"}</strong>
            <small>
              记录 {props.index + 1} / {props.result.rows.length}
              <Show when={!!props.pending.updates[rowKey()]}><span class="db-formview-dirty">· 未提交</span></Show>
            </small>
          </div>
          <span class="db-toolbar-spacer" />
          <span class="db-status-item is-muted">{props.result.columns.length} 个字段</span>
        </header>

        <div class="db-formview-fields">
          <Index each={props.result.columns}>{(name, cellIndex) => {
            const meta = () => columnMeta(name());
            const value = () => currentRow()[cellIndex];
            return (
              <div class={`db-field ${dirty(name()) ? "is-dirty" : ""} ${isNullValue(value()) ? "is-null" : ""}`}>
                <label class="db-field-label">
                  <span>{name()}</span>
                  <small>{meta()?.column_type ?? ""}{props.primaryKey.includes(name()) ? " · PK" : ""}</small>
                </label>
                <div class="db-field-input">
                  <Show
                    when={editing() === name()}
                    fallback={
                      <button
                        class="db-field-value"
                        title={editable() ? "点击编辑" : "无主键或只读模式下不可编辑"}
                        onClick={() => begin(name(), value())}
                      >
                        {isNullValue(value()) ? <em class="db-cell-null">NULL</em> : formatCell(value())}
                      </button>
                    }
                  >
                    <input
                      class="db-input"
                      value={draft()}
                      ref={element => queueMicrotask(() => { element.focus(); element.select(); })}
                      onInput={event => setDraft(event.currentTarget.value)}
                      onBlur={commit}
                      onKeyDown={event => {
                        if (event.key === "Enter") { event.preventDefault(); commit(); }
                        else if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                      }}
                    />
                  </Show>
                </div>
              </div>
            );
          }}</Index>
        </div>
      </div>

      <aside class="db-record-nav">
        <div class="db-record-card">
          <h4>跳转记录</h4>
          <div class="db-record-jump">
            <button class="db-icon-btn" aria-label="上一条" title="上一条" disabled={props.index <= 0} onClick={() => props.onIndexChange(props.index - 1)}>
              <Icon name="chevronRight" size={13} class="db-flip" />
            </button>
            <input
              class="db-input"
              value={String(props.index + 1)}
              aria-label="记录序号"
              onKeyDown={event => {
                if (event.key !== "Enter") return;
                const next = Number(event.currentTarget.value);
                if (Number.isFinite(next)) props.onIndexChange(Math.min(props.result.rows.length - 1, Math.max(0, next - 1)));
              }}
            />
            <span class="db-record-total">/ {props.result.rows.length}</span>
            <button class="db-icon-btn" aria-label="下一条" title="下一条" disabled={props.index >= props.result.rows.length - 1} onClick={() => props.onIndexChange(props.index + 1)}>
              <Icon name="chevronRight" size={13} />
            </button>
          </div>
        </div>

        <div class="db-record-card">
          <h4>当前记录</h4>
          <dl class="db-props is-compact">
            <For each={props.primaryKey.length > 0 ? props.primaryKey : props.result.columns.slice(0, 3)}>{name => {
              const cellIndex = () => props.result.columns.indexOf(name);
              return <><dt>{name}</dt><dd>{isNullValue(currentRow()[cellIndex()]) ? "NULL" : formatCell(currentRow()[cellIndex()])}</dd></>;
            }}</For>
          </dl>
        </div>

        <Show when={props.primaryKey.length === 0}>
          <p class="db-record-warn">无主键，表单不可编辑。</p>
        </Show>
      </aside>
    </div>
  );
};
