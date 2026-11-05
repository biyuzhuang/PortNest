import { Component, For, Show, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseColumnInfo } from "../../../utils/api";
import {
  FILTER_OPERATORS,
  operatorArity,
  operatorLabel,
  type FilterCondition,
  type FilterOperator,
  type FilterSpec,
  type SortOrder,
} from "../types";

type Props = {
  columns: DatabaseColumnInfo[];
  filters: FilterSpec;
  orders: SortOrder[];
  onApply: (filters: FilterSpec, orders: SortOrder[]) => void;
  onClose: () => void;
};

const MAX_CONDITIONS = 12;
const MAX_ORDERS = 4;

export const FilterSortPanel: Component<Props> = props => {
  const [draft, setDraft] = createSignal<FilterSpec>({
    conjunction: props.filters.conjunction,
    conditions: props.filters.conditions.map(item => ({ ...item })),
  });
  const [orders, setOrders] = createSignal<SortOrder[]>(props.orders.map(item => ({ ...item })));

  const patch = (index: number, value: Partial<FilterCondition>) => setDraft(current => ({
    ...current,
    conditions: current.conditions.map((item, i) => (i === index ? { ...item, ...value } : item)),
  }));
  const addCondition = () => {
    if (draft().conditions.length >= MAX_CONDITIONS) return;
    const first = props.columns[0]?.name ?? "";
    setDraft(current => ({ ...current, conditions: [...current.conditions, { column: first, operator: "contains", value: "" }] }));
  };
  const removeCondition = (index: number) => setDraft(current => ({
    ...current,
    conditions: current.conditions.filter((_item, i) => i !== index),
  }));

  const addOrder = () => {
    if (orders().length >= MAX_ORDERS) return;
    const used = new Set(orders().map(item => item.column));
    const next = props.columns.find(item => !used.has(item.name));
    if (!next) return;
    setOrders(current => [...current, { column: next.name, direction: "asc" }]);
  };

  const describe = (condition: FilterCondition) => {
    const arity = operatorArity(condition.operator);
    if (arity === 0) return `${condition.column} ${operatorLabel(condition.operator)}`;
    if (arity === 2) return `${condition.column} ${operatorLabel(condition.operator)} ${condition.value || "?"} ~ ${condition.value2 || "?"}`;
    return `${condition.column} ${operatorLabel(condition.operator)} ${condition.value || "?"}`;
  };

  return (
    <div class="db-filters" role="dialog" aria-label="筛选与排序">
      <header class="db-filters-head">
        <strong>筛选与排序</strong>
        <span class="db-toolbar-spacer" />
        <button class="db-icon-btn" aria-label="关闭" title="关闭" onClick={() => props.onClose()}>
          <Icon name="close" size={13} />
        </button>
      </header>

      <div class="db-filters-body">
        <div class="db-filters-row">
          <span class="db-filters-label">匹配</span>
          <div class="db-seg" role="group" aria-label="条件组合方式">
            <button class={draft().conjunction === "and" ? "is-active" : ""} onClick={() => setDraft(current => ({ ...current, conjunction: "and" }))}>全部满足</button>
            <button class={draft().conjunction === "or" ? "is-active" : ""} onClick={() => setDraft(current => ({ ...current, conjunction: "or" }))}>任一满足</button>
          </div>
          <span class="db-toolbar-spacer" />
          <button class="db-text-btn" disabled={draft().conditions.length >= MAX_CONDITIONS} onClick={addCondition}>
            <Icon name="plus" size={12} />条件
          </button>
        </div>

        <Show when={draft().conditions.length > 0} fallback={<p class="db-filters-empty">还没有筛选条件。添加后按「应用」生效，条件之间会下推到 SQL。</p>}>
          <div class="db-filters-list">
            <For each={draft().conditions}>{(condition, index) => {
              const arity = () => operatorArity(condition.operator);
              return (
                <div class="db-cond">
                  <select
                    class="db-select"
                    value={condition.column}
                    aria-label="筛选列"
                    onChange={event => patch(index(), { column: event.currentTarget.value })}
                  >
                    <For each={props.columns}>{column => <option value={column.name}>{column.name}</option>}</For>
                  </select>
                  <select
                    class="db-select"
                    value={condition.operator}
                    aria-label="操作符"
                    onChange={event => patch(index(), { operator: event.currentTarget.value as FilterOperator })}
                  >
                    <For each={FILTER_OPERATORS}>{item => <option value={item.value}>{item.label}</option>}</For>
                  </select>
                  <Show when={arity() >= 1}>
                    <input
                      class="db-input"
                      value={condition.value}
                      placeholder="值"
                      aria-label="条件值"
                      onInput={event => patch(index(), { value: event.currentTarget.value })}
                    />
                  </Show>
                  <Show when={arity() === 2}>
                    <input
                      class="db-input"
                      value={condition.value2 ?? ""}
                      placeholder="上限"
                      aria-label="条件上限"
                      onInput={event => patch(index(), { value2: event.currentTarget.value })}
                    />
                  </Show>
                  <button class="db-icon-btn" aria-label="移除条件" title="移除" onClick={() => removeCondition(index())}>
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              );
            }}</For>
          </div>
        </Show>

        <div class="db-filters-row">
          <span class="db-filters-label">排序</span>
          <span class="db-filters-note">最多 4 列，跨页生效</span>
          <span class="db-toolbar-spacer" />
          <button class="db-text-btn" disabled={orders().length >= MAX_ORDERS} onClick={addOrder}>
            <Icon name="plus" size={12} />排序列
          </button>
        </div>

        <Show when={orders().length > 0} fallback={<p class="db-filters-empty">当前按主键顺序返回。</p>}>
          <div class="db-filters-list">
            <For each={orders()}>{(order, index) => (
              <div class="db-cond">
                <select
                  class="db-select"
                  value={order.column}
                  aria-label="排序列"
                  onChange={event => setOrders(current => current.map((item, i) => i === index() ? { ...item, column: event.currentTarget.value } : item))}
                >
                  <For each={props.columns}>{column => <option value={column.name}>{column.name}</option>}</For>
                </select>
                <select
                  class="db-select"
                  value={order.direction}
                  aria-label="排序方向"
                  onChange={event => setOrders(current => current.map((item, i) => i === index() ? { ...item, direction: event.currentTarget.value as "asc" | "desc" } : item))}
                >
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                </select>
                <span class="db-cond-priority">第 {index() + 1} 优先</span>
                <button class="db-icon-btn" aria-label="移除排序" title="移除" onClick={() => setOrders(current => current.filter((_item, i) => i !== index()))}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )}</For>
          </div>
        </Show>

        <Show when={draft().conditions.length > 0}>
          <p class="db-filters-preview">
            WHERE {draft().conditions.map(describe).join(draft().conjunction === "and" ? " AND " : " OR ")}
          </p>
        </Show>
      </div>

      <footer class="db-filters-foot">
        <button class="db-text-btn" onClick={() => { setDraft({ conjunction: "and", conditions: [] }); setOrders([]); }}>重置</button>
        <span class="db-toolbar-spacer" />
        <button class="db-text-btn" onClick={() => props.onClose()}>取消</button>
        <button
          class="db-btn is-primary"
          onClick={() => {
            props.onApply(
              { conjunction: draft().conjunction, conditions: draft().conditions.filter(item => operatorArity(item.operator) === 0 || item.value.trim() !== "") },
              orders(),
            );
          }}
        >
          应用
        </button>
      </footer>
    </div>
  );
};
