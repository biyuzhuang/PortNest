import { Component, For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import { isPostgresCompatibleProtocol, type DatabaseColumnDefinition, type DatabaseTableDefinition } from "../../../utils/api";
import { computeTableDiff } from "../utils/designer";

type TabKey = "columns" | "indexes" | "foreign" | "options" | "comments" | "sql" | "changes";

type Props = {
  protocol: string;
  definition: DatabaseTableDefinition;
  base: DatabaseTableDefinition | null;
  preview: string[];
  isNew: boolean;
  onChange: (value: DatabaseTableDefinition) => void;
  onPreview: () => void;
  onApply: () => void;
  onDiscard: () => void;
};

export const DesignerView: Component<Props> = props => {
  const [tab, setTab] = createSignal<TabKey>("columns");
  const [dragging, setDragging] = createSignal<number | null>(null);

  const diff = createMemo(() => computeTableDiff(props.base, props.definition));
  const mysql = () => !isPostgresCompatibleProtocol(props.protocol);

  const patchColumn = (index: number, patch: Partial<DatabaseColumnDefinition>) => props.onChange({
    ...props.definition,
    columns: props.definition.columns.map((item, i) => (i === index ? { ...item, ...patch } : item)),
  });

  const addColumn = () => props.onChange({
    ...props.definition,
    columns: [...props.definition.columns, {
      name: `column_${props.definition.columns.length + 1}`,
      column_type: "VARCHAR(255)",
      nullable: true,
      auto_increment: false,
      comment: "",
    }],
  });

  const removeColumn = (index: number) => props.onChange({
    ...props.definition,
    columns: props.definition.columns.filter((_item, i) => i !== index),
  });

  const moveColumn = (from: number, to: number) => {
    if (from === to || to < 0 || to >= props.definition.columns.length) return;
    const columns = [...props.definition.columns];
    const [moved] = columns.splice(from, 1);
    columns.splice(to, 0, moved);
    props.onChange({ ...props.definition, columns });
  };

  const tabs: Array<{ key: TabKey; label: string; badge?: () => number }> = [
    { key: "columns", label: "字段", badge: () => props.definition.columns.length },
    { key: "indexes", label: "索引", badge: () => props.definition.indexes.length },
    { key: "foreign", label: "外键", badge: () => (props.definition.foreign_keys || []).length },
    { key: "options", label: "选项" },
    { key: "comments", label: "注释" },
    { key: "sql", label: "SQL 预览", badge: () => props.preview.length },
    { key: "changes", label: "变更", badge: () => diff().total },
  ];

  return (
    <div class="db-designer">
      <div class="db-designer-tabs" role="tablist" aria-label="表设计器">
        <For each={tabs}>{item => (
          <button
            role="tab"
            aria-selected={tab() === item.key}
            class={tab() === item.key ? "is-active" : ""}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            <Show when={item.badge && item.badge!() > 0}><em>{item.badge!()}</em></Show>
          </button>
        )}</For>
      </div>

      <div class="db-designer-body">
        <Switch>
          <Match when={tab() === "columns"}>
            <div class="db-designer-toolbar">
              <button class="db-text-btn" onClick={addColumn}><Icon name="plus" size={12} />添加字段</button>
              <span class="db-toolbar-spacer" />
              <span class="db-status-item is-muted">拖动行首把手可调整字段顺序</span>
            </div>
            <div class="db-grid-wrap">
              <table class="db-grid is-designer">
                <thead>
                  <tr>
                    <th class="db-col-drag" aria-label="拖动排序" />
                    <th class="db-col-index">#</th>
                    <th>名称</th>
                    <th>类型</th>
                    <th>NULL</th>
                    <th>默认值</th>
                    <th>自增</th>
                    <th>注释</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={props.definition.columns}>{(column, index) => (
                    <tr
                      class={`db-row ${dragging() === index() ? "is-dragging" : ""}`}
                      draggable={true}
                      onDragStart={() => setDragging(index())}
                      onDragOver={event => event.preventDefault()}
                      onDrop={event => { event.preventDefault(); const from = dragging(); setDragging(null); if (from != null) moveColumn(from, index()); }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <td class="db-col-drag"><span class="db-drag-handle" aria-hidden="true">⋮⋮</span></td>
                      <td class="db-col-index db-index">{index() + 1}</td>
                      <td class="db-cell"><input class="db-input is-cell" value={column.name} onInput={event => patchColumn(index(), { name: event.currentTarget.value })} /></td>
                      <td class="db-cell"><input class="db-input is-cell is-mono" value={column.column_type} onInput={event => patchColumn(index(), { column_type: event.currentTarget.value })} /></td>
                      <td class="db-cell"><input type="checkbox" aria-label="允许为空" checked={column.nullable} onChange={event => patchColumn(index(), { nullable: event.currentTarget.checked })} /></td>
                      <td class="db-cell"><input class="db-input is-cell" value={column.default_value ?? ""} placeholder="NULL" onInput={event => patchColumn(index(), { default_value: event.currentTarget.value || undefined })} /></td>
                      <td class="db-cell"><input type="checkbox" aria-label="自增" title={mysql() ? "AUTO_INCREMENT" : "GENERATED BY DEFAULT AS IDENTITY（仅整数类型）"} checked={column.auto_increment} onChange={event => patchColumn(index(), { auto_increment: event.currentTarget.checked })} /></td>
                      <td class="db-cell"><input class="db-input is-cell" value={column.comment} onInput={event => patchColumn(index(), { comment: event.currentTarget.value })} /></td>
                      <td class="db-cell db-col-action">
                        <button class="db-icon-btn" aria-label="删除字段" title="删除字段" onClick={() => removeColumn(index())}>
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </div>
          </Match>

          <Match when={tab() === "indexes"}>
            <div class="db-designer-toolbar">
              <button
                class="db-text-btn"
                onClick={() => props.onChange({
                  ...props.definition,
                  indexes: [...props.definition.indexes, { name: `idx_${props.definition.indexes.length + 1}`, kind: "INDEX", columns: [] }],
                })}
              >
                <Icon name="plus" size={12} />添加索引
              </button>
              <span class="db-toolbar-spacer" />
              <Show when={!mysql()}>
                <span class="db-status-item is-muted">改索引会 DROP + CREATE 重建，大表建议低峰期执行</span>
              </Show>
            </div>
            <div class="db-grid-wrap">
              <table class="db-grid is-designer">
                <thead><tr><th>名称</th><th>类型</th><th>字段（逗号分隔，可加 DESC）</th><th /></tr></thead>
                <tbody>
                  <For each={props.definition.indexes}>{(index, position) => (
                    <tr class="db-row">
                      <td class="db-cell"><input class="db-input is-cell" value={index.name} onInput={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((item, i) => i === position() ? { ...item, name: event.currentTarget.value } : item) })} /></td>
                      <td class="db-cell">
                        <select class="db-select" value={index.kind} onChange={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((item, i) => i === position() ? { ...item, kind: event.currentTarget.value as typeof item.kind } : item) })}>
                          <option value="PRIMARY">PRIMARY</option>
                          <option value="UNIQUE">UNIQUE</option>
                          <option value="INDEX">INDEX</option>
                        </select>
                      </td>
                      <td class="db-cell">
                        <input
                          class="db-input is-cell is-mono"
                          value={index.columns.map(item => item.direction === "DESC" ? `${item.name} DESC` : item.name).join(", ")}
                          placeholder="film_id, title DESC"
                          onInput={event => {
                            const columns = event.currentTarget.value.split(",").map(part => part.trim()).filter(Boolean).map(part => {
                              const [name, direction] = part.split(/\s+/);
                              return { name, direction: direction?.toUpperCase() === "DESC" ? "DESC" : "ASC" };
                            });
                            props.onChange({ ...props.definition, indexes: props.definition.indexes.map((item, i) => i === position() ? { ...item, columns } : item) });
                          }}
                        />
                      </td>
                      <td class="db-cell db-col-action">
                        <button class="db-icon-btn" aria-label="删除索引" title="删除索引" onClick={() => props.onChange({ ...props.definition, indexes: props.definition.indexes.filter((_item, i) => i !== position()) })}>
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </div>
          </Match>

          <Match when={tab() === "foreign"}>
            <div class="db-designer-toolbar">
                <button
                  class="db-text-btn"
                  onClick={() => props.onChange({
                    ...props.definition,
                    foreign_keys: [...(props.definition.foreign_keys || []), { name: `fk_${(props.definition.foreign_keys || []).length + 1}`, columns: [], referenced_table: "", referenced_columns: [], on_delete: "RESTRICT", on_update: "RESTRICT" }],
                  })}
                >
                  <Icon name="plus" size={12} />添加外键
                </button>
              </div>
              <Show when={(props.definition.foreign_keys || []).length > 0} fallback={<div class="db-grid-empty"><Icon name="link" size={18} /><p>还没有外键约束</p><small>建表时写入 CREATE TABLE，改表时以 ALTER TABLE 追加</small></div>}>
                <div class="db-grid-wrap">
                  <table class="db-grid is-designer">
                    <thead><tr><th>名称</th><th>字段</th><th>引用表</th><th>引用字段</th><th>ON DELETE</th><th>ON UPDATE</th><th /></tr></thead>
                    <tbody>
                      <For each={props.definition.foreign_keys || []}>{(key, position) => {
                        const patch = (value: Partial<typeof key>) => props.onChange({
                          ...props.definition,
                          foreign_keys: (props.definition.foreign_keys || []).map((item, i) => i === position() ? { ...item, ...value } : item),
                        });
                        const target = key.referenced_schema ? `${key.referenced_schema}.${key.referenced_table}` : key.referenced_table;
                        const patchTarget = (raw: string) => {
                          // MySQL 的引用表不带 schema；PG 允许 schema.table，这里按第一个点拆开
                          const dot = raw.indexOf(".");
                          if (!mysql() && dot > 0) {
                            patch({ referenced_schema: raw.slice(0, dot), referenced_table: raw.slice(dot + 1) });
                          } else {
                            patch({ referenced_schema: null, referenced_table: raw });
                          }
                        };
                        return <tr class="db-row">
                          <td class="db-cell"><input class="db-input is-cell" value={key.name} onInput={event => patch({ name: event.currentTarget.value })} /></td>
                          <td class="db-cell"><input class="db-input is-cell is-mono" value={key.columns.join(", ")} onInput={event => patch({ columns: event.currentTarget.value.split(",").map(item => item.trim()).filter(Boolean) })} /></td>
                          <td class="db-cell"><input class="db-input is-cell" value={target} onInput={event => patchTarget(event.currentTarget.value)} /></td>
                          <td class="db-cell"><input class="db-input is-cell is-mono" value={key.referenced_columns.join(", ")} onInput={event => patch({ referenced_columns: event.currentTarget.value.split(",").map(item => item.trim()).filter(Boolean) })} /></td>
                          <td class="db-cell">
                            <select class="db-select" value={key.on_delete || "RESTRICT"} onChange={event => patch({ on_delete: event.currentTarget.value })}>
                              <option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option><option>NO ACTION</option>
                            </select>
                          </td>
                          <td class="db-cell">
                            <select class="db-select" value={key.on_update || "RESTRICT"} onChange={event => patch({ on_update: event.currentTarget.value })}>
                              <option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option><option>NO ACTION</option>
                            </select>
                          </td>
                          <td class="db-cell db-col-action">
                            <button class="db-icon-btn" aria-label="删除外键" title="删除外键" onClick={() => props.onChange({ ...props.definition, foreign_keys: (props.definition.foreign_keys || []).filter((_item, i) => i !== position()) })}>
                              <Icon name="trash" size={12} />
                            </button>
                          </td>
                        </tr>;
                      }}</For>
                    </tbody>
                  </table>
                </div>
              </Show>
          </Match>

          <Match when={tab() === "options"}>
            <div class="db-options">
              <label class="db-field-line">
                <span>表名</span>
                <input class="db-input" value={props.definition.name} disabled={!props.isNew && false} onInput={event => props.onChange({ ...props.definition, name: event.currentTarget.value })} />
              </label>
              <Show when={mysql()}>
                <label class="db-field-line">
                  <span>引擎</span>
                  <input class="db-input" value={props.definition.engine || "InnoDB"} onInput={event => props.onChange({ ...props.definition, engine: event.currentTarget.value })} />
                </label>
                <label class="db-field-line">
                  <span>字符集</span>
                  <input class="db-input" value={props.definition.charset || "utf8mb4"} onInput={event => props.onChange({ ...props.definition, charset: event.currentTarget.value })} />
                </label>
                <label class="db-field-line">
                  <span>排序规则</span>
                  <input class="db-input" value={props.definition.collation || ""} placeholder="跟随字符集" onInput={event => props.onChange({ ...props.definition, collation: event.currentTarget.value || undefined })} />
                </label>
              </Show>
              <p class="db-options-note">
                {mysql() ? "引擎与字符集变更会触发 ALTER TABLE，大表可能锁表。" : "PostgreSQL 的字符集由数据库决定，不能在表级修改；字段自增用 IDENTITY，注释用 COMMENT ON 写入。"}
              </p>
            </div>
          </Match>

          <Match when={tab() === "comments"}>
            <div class="db-options">
              <label class="db-field-line">
                <span>表注释</span>
                <input class="db-input" value={props.definition.comment} onInput={event => props.onChange({ ...props.definition, comment: event.currentTarget.value })} />
              </label>
              <div class="db-comment-list">
                <For each={props.definition.columns}>{(column, index) => (
                  <label class="db-field-line">
                    <span class="is-mono">{column.name}</span>
                    <input class="db-input" value={column.comment} onInput={event => patchColumn(index(), { comment: event.currentTarget.value })} />
                  </label>
                )}</For>
              </div>
            </div>
          </Match>

          <Match when={tab() === "sql"}>
            <Show when={props.preview.length > 0} fallback={<div class="db-grid-empty"><p>还没有生成 SQL</p><small>点「预览 SQL」按当前设计生成语句</small></div>}>
              <pre class="db-ddl is-inline">{props.preview.join("\n\n")}</pre>
            </Show>
          </Match>

          <Match when={tab() === "changes"}>
            <Show when={diff().total > 0} fallback={<div class="db-grid-empty"><p>没有变更</p><small>修改字段、索引或外键后这里会列出差异</small></div>}>
              <div class="db-changes">
                <For each={[
                  { label: "字段", items: diff().columns },
                  { label: "索引", items: diff().indexes },
                  { label: "外键", items: diff().foreignKeys },
                ]}>{group => (
                  <Show when={group.items.length > 0}>
                    <h4 class="db-detail-title">{group.label} <em>{group.items.length}</em></h4>
                    <ul class="db-change-list">
                      <For each={group.items}>{item => (
                        <li class={`db-change is-${item.kind}`}>
                          <span class="db-change-kind">{item.kind === "added" ? "新增" : item.kind === "removed" ? "删除" : "修改"}</span>
                          <strong>{item.name}</strong>
                          <Show when={item.detail}><small>{item.detail}</small></Show>
                        </li>
                      )}</For>
                    </ul>
                  </Show>
                )}</For>
                {props.isNew ? null : (
                  <p class="db-options-note">这是前端预估。点「应用设计」时以后端生成的 DDL 为准，执行前会再次展示。</p>
                )}
              </div>
            </Show>
          </Match>
        </Switch>
      </div>

      <footer class="db-designer-foot">
        <span class="db-status-item">{props.definition.columns.length} 字段 · {props.definition.indexes.length} 索引</span>
        <span class="db-toolbar-spacer" />
        <button class="db-text-btn" onClick={() => props.onDiscard()}>放弃修改</button>
        <button class="db-text-btn" onClick={() => props.onPreview()}>预览 SQL</button>
        <button class="db-btn is-primary" onClick={() => props.onApply()}>{props.isNew ? "创建表" : "应用设计"}</button>
      </footer>
    </div>
  );
};
