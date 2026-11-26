import { Component, For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { Icon } from "../../Icon";
import { isPostgresCompatibleProtocol, type DatabaseColumnDefinition, type DatabaseTableDefinition } from "../../../utils/api";
import {
  COMMON_COLUMN_TYPES,
  composeColumnType,
  computeTableDiff,
  parseColumnType,
} from "../utils/designer";
import { SqlCode } from "../utils/sql";

type TabKey = "columns" | "indexes" | "foreign" | "triggers" | "options" | "comments" | "sql";

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

/**
 * 表设计器（Navicat 式）：
 *   工具条（保存 / 字段操作 / 主键 / 上下移）→ 选项卡 → 字段网格 → 底部属性条。
 * 所有字段属性都在网格里直接改，右侧不再放属性栏；SQL 预览收进选项卡。
 */
export const DesignerView: Component<Props> = props => {
  const [tab, setTab] = createSignal<TabKey>("columns");
  const [selected, setSelected] = createSignal(0);

  const diff = createMemo(() => computeTableDiff(props.base, props.definition));
  const mysql = () => !isPostgresCompatibleProtocol(props.protocol);
  const columns = () => props.definition.columns;

  /** 选中行始终夹在有效范围内：删字段、切标签后都不会指向不存在的下标 */
  const current = createMemo(() => {
    const list = columns();
    if (list.length === 0) return null;
    return list[Math.min(selected(), list.length - 1)] ?? null;
  });
  const index = createMemo(() => Math.min(selected(), Math.max(0, columns().length - 1)));

  const patchColumn = (target: number, patch: Partial<DatabaseColumnDefinition>) => props.onChange({
    ...props.definition,
    columns: props.definition.columns.map((item, i) => (i === target ? { ...item, ...patch } : item)),
  });

  const patchPart = (target: number, part: "base" | "length" | "scale", value: string) => {
    const column = props.definition.columns[target];
    if (!column) return;
    const parts = parseColumnType(column.column_type);
    patchColumn(target, { column_type: composeColumnType({ ...parts, [part]: value }) });
  };

  const addColumn = (after: boolean) => {
    const list = columns();
    const at = after && list.length > 0 ? index() + 1 : list.length;
    const next: DatabaseColumnDefinition = {
      name: `column_${list.length + 1}`,
      column_type: "varchar(255)",
      nullable: true,
      auto_increment: false,
      comment: "",
    };
    const columnsNext = [...list.slice(0, at), next, ...list.slice(at)];
    props.onChange({ ...props.definition, columns: columnsNext });
    setSelected(at);
  };

  const removeColumn = () => {
    if (columns().length === 0) return;
    const at = index();
    props.onChange({ ...props.definition, columns: columns().filter((_item, i) => i !== at) });
    setSelected(Math.max(0, at - 1));
  };

  const moveColumn = (offset: number) => {
    const at = index();
    const to = at + offset;
    if (to < 0 || to >= columns().length) return;
    const list = [...columns()];
    const [moved] = list.splice(at, 1);
    list.splice(to, 0, moved);
    props.onChange({ ...props.definition, columns: list });
    setSelected(to);
  };

  // ---- 键标记：主键 / 唯一 / 外键都是从索引与外键定义倒推出来的 -------------
  const primaryKey = createMemo(() => new Set(
    (props.definition.indexes.find(item => item.kind === "PRIMARY")?.columns || []).map(item => item.name),
  ));
  const uniqueKeys = createMemo(() => new Set(
    props.definition.indexes
      .filter(item => item.kind === "UNIQUE" && item.columns.length === 1)
      .map(item => item.columns[0].name),
  ));
  const foreignKeys = createMemo(() => new Set(
    (props.definition.foreign_keys || []).flatMap(item => item.columns),
  ));

  const togglePrimaryKey = () => {
    const column = current();
    if (!column) return;
    const indexes = [...props.definition.indexes];
    const position = indexes.findIndex(item => item.kind === "PRIMARY");
    let adding = true;
    if (position < 0) {
      indexes.push({ name: "PRIMARY", kind: "PRIMARY", columns: [{ name: column.name, direction: "ASC" }] });
    } else {
      const existing = indexes[position].columns;
      const found = existing.some(item => item.name === column.name);
      adding = !found;
      const nextColumns = found
        ? existing.filter(item => item.name !== column.name)
        : [...existing, { name: column.name, direction: "ASC" }];
      if (nextColumns.length === 0) indexes.splice(position, 1);
      else indexes[position] = { ...indexes[position], columns: nextColumns };
    }
    // 主键列必须 NOT NULL：否则 MySQL 会静默改成 NOT NULL，界面和实际结构对不上
    props.onChange({
      ...props.definition,
      indexes,
      columns: adding
        ? props.definition.columns.map(item => (item.name === column.name ? { ...item, nullable: false } : item))
        : props.definition.columns,
    });
  };

  const tabs: Array<{ key: TabKey; label: string; badge?: () => number }> = [
    { key: "columns", label: "字段", badge: () => props.definition.columns.length },
    { key: "indexes", label: "索引", badge: () => props.definition.indexes.length },
    { key: "foreign", label: "外键", badge: () => (props.definition.foreign_keys || []).length },
    { key: "triggers", label: "触发器" },
    { key: "options", label: "选项" },
    { key: "comments", label: "注释" },
    { key: "sql", label: "SQL 预览" },
  ];

  const switchTab = (next: TabKey) => { setTab(next); setSelected(0); };

  const footParts = createMemo(() => (current() ? parseColumnType(current()!.column_type) : null));

  return (
    <div class="db-designer">
      {/* ① 工具条：左侧字段 / 索引 / 外键操作，右侧「变更数 + 生成预览 + 应用变更」 */}
      <div class="db-designer-toolbar">
        <Show when={tab() === "columns"}>
          <div class="db-toolbar-group">
            <button class="db-text-btn" title="在末尾添加字段" onClick={() => addColumn(false)}>
              <Icon name="plus" size={14} /><span class="db-btn-label">添加字段</span>
            </button>
            <button class="db-text-btn" title="在当前字段后插入" onClick={() => addColumn(true)}>
              <Icon name="copyPlus" size={14} /><span class="db-btn-label">插入字段</span>
            </button>
            <button class="db-text-btn" title="删除当前字段" disabled={!current()} onClick={removeColumn}>
              <Icon name="trash" size={14} /><span class="db-btn-label">删除字段</span>
            </button>
          </div>
          <span class="db-toolbar-divider" />
          <button
            class={current() && primaryKey().has(current()!.name) ? "db-text-btn is-on" : "db-text-btn"}
            title="把当前字段设为主键"
            disabled={!current()}
            onClick={togglePrimaryKey}
          >
            <Icon name="key" size={14} /><span class="db-btn-label">主键</span>
          </button>
          <span class="db-toolbar-divider" />
          <div class="db-toolbar-group">
            <button class="db-text-btn" title="上移" disabled={index() <= 0} onClick={() => moveColumn(-1)}>
              <Icon name="arrowUp" size={14} /><span class="db-btn-label">上移</span>
            </button>
            <button class="db-text-btn" title="下移" disabled={index() >= columns().length - 1} onClick={() => moveColumn(1)}>
              <Icon name="arrowDown" size={14} /><span class="db-btn-label">下移</span>
            </button>
          </div>
        </Show>

        <Show when={tab() === "indexes"}>
          <button
            class="db-text-btn"
            onClick={() => props.onChange({
              ...props.definition,
              indexes: [...props.definition.indexes, { name: `idx_${props.definition.indexes.length + 1}`, kind: "INDEX", columns: [] }],
            })}
          >
            <Icon name="plus" size={14} /><span class="db-btn-label">添加索引</span>
          </button>
          <button
            class="db-text-btn"
            disabled={props.definition.indexes.length === 0}
            onClick={() => props.onChange({
              ...props.definition,
              indexes: props.definition.indexes.filter((_item, i) => i !== Math.min(selected(), props.definition.indexes.length - 1)),
            })}
          >
            <Icon name="trash" size={14} /><span class="db-btn-label">删除索引</span>
          </button>
        </Show>

        <Show when={tab() === "foreign"}>
          <button
            class="db-text-btn"
            onClick={() => props.onChange({
              ...props.definition,
              foreign_keys: [...(props.definition.foreign_keys || []), { name: `fk_${(props.definition.foreign_keys || []).length + 1}`, columns: [], referenced_table: "", referenced_columns: [], on_delete: "RESTRICT", on_update: "RESTRICT" }],
            })}
          >
            <Icon name="plus" size={14} /><span class="db-btn-label">添加外键</span>
          </button>
          <button
            class="db-text-btn"
            disabled={(props.definition.foreign_keys || []).length === 0}
            onClick={() => props.onChange({
              ...props.definition,
              foreign_keys: (props.definition.foreign_keys || []).filter((_item, i) => i !== Math.min(selected(), (props.definition.foreign_keys || []).length - 1)),
            })}
          >
            <Icon name="trash" size={14} /><span class="db-btn-label">删除外键</span>
          </button>
        </Show>

        <span class="db-toolbar-spacer" />
        <Show when={diff().total > 0}>
          <span class="db-designer-dirty" title="字段 / 索引 / 外键的变更条数">
            <Icon name="alert" size={14} />{diff().total} 处变更
          </span>
        </Show>
        <button class="db-text-btn" title="按当前设计生成 DDL" onClick={() => props.onPreview()}>生成预览</button>
        <Show when={diff().total > 0 && !props.isNew}>
          <button class="db-text-btn" onClick={() => props.onDiscard()}>放弃</button>
        </Show>
        <button
          class="db-btn is-primary"
          title={props.isNew ? "创建表" : "应用变更"}
          disabled={!props.isNew && diff().total === 0}
          onClick={() => props.onApply()}
        >
          <Icon name="check" size={14} />{props.isNew ? "创建表" : "应用变更"}
        </button>
      </div>

      {/* ② 选项卡：字段 / 索引 / 外键 / 触发器 / 选项 / 注释 / SQL 预览 */}
      <div class="db-designer-tabs" role="tablist" aria-label="表设计器">
        <For each={tabs}>{item => (
          <button
            role="tab"
            aria-selected={tab() === item.key}
            class={tab() === item.key ? "is-active" : ""}
            onClick={() => switchTab(item.key)}
          >
            {item.label}
            <Show when={item.badge && item.badge!() > 0}><em>{item.badge!()}</em></Show>
          </button>
        )}</For>
      </div>

      <div class="db-designer-body">
        <Switch>
          {/* ③ 字段网格：列序与 Navicat 一致 */}
          <Match when={tab() === "columns"}>
            <div class="db-grid-wrap">
              <table class="db-grid is-designer">
                <colgroup>
                  <col style={{ width: "30px" }} />
                  <col style={{ width: "158px" }} />
                  <col style={{ width: "170px" }} />
                  <col style={{ width: "74px" }} />
                  <col style={{ width: "74px" }} />
                  <col style={{ width: "78px" }} />
                  <col style={{ width: "56px" }} />
                  <col style={{ width: "56px" }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th class="db-col-index" aria-label="序号">#</th>
                    <th>名</th>
                    <th>类型</th>
                    <th class="is-numeric">长度</th>
                    <th class="is-numeric">小数点</th>
                    <th class="is-center">不是 null</th>
                    <th class="is-center">虚拟</th>
                    <th class="is-center">键</th>
                    <th>注释</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={columns()}>{(column, position) => {
                    const parts = parseColumnType(column.column_type);
                    const isVirtual = !!column.generation_expression;
                    return (
                      <tr
                        class={`db-row ${position() === index() ? "is-selected" : ""} ${isVirtual ? "is-virtual" : ""}`}
                        onClick={() => setSelected(position())}
                      >
                        <td class="db-col-index db-index">{position() + 1}</td>
                        <td class="db-cell is-field-name">
                          <input
                            class="db-input is-cell"
                            value={column.name}
                            title={column.name}
                            aria-label="字段名"
                            onFocus={() => setSelected(position())}
                            onInput={event => patchColumn(position(), { name: event.currentTarget.value })}
                          />
                        </td>
                        <td class="db-cell is-field-type">
                          <input
                            class="db-input is-cell is-mono"
                            value={parts.base}
                            title={column.column_type}
                            aria-label="类型"
                            list="db-column-types"
                            onFocus={() => setSelected(position())}
                            onInput={event => patchPart(position(), "base", event.currentTarget.value)}
                          />
                        </td>
                        <td class="db-cell is-numeric">
                          <input
                            class="db-input is-cell is-num"
                            value={parts.length}
                            placeholder="—"
                            aria-label="长度"
                            inputMode="numeric"
                            onFocus={() => setSelected(position())}
                            onInput={event => patchPart(position(), "length", event.currentTarget.value.replace(/[^\d]/g, ""))}
                          />
                        </td>
                        <td class="db-cell is-numeric">
                          <input
                            class="db-input is-cell is-num"
                            value={parts.scale}
                            placeholder="—"
                            aria-label="小数点"
                            inputMode="numeric"
                            onFocus={() => setSelected(position())}
                            onInput={event => patchPart(position(), "scale", event.currentTarget.value.replace(/[^\d]/g, ""))}
                          />
                        </td>
                        <td class="db-cell is-center">
                          <input
                            type="checkbox"
                            aria-label="不是 null"
                            checked={!column.nullable}
                            onChange={event => patchColumn(position(), { nullable: !event.currentTarget.checked })}
                          />
                        </td>
                        <td class="db-cell is-center">
                          <input
                            type="checkbox"
                            aria-label="虚拟列"
                            title={mysql() ? "生成列（GENERATED ALWAYS AS …）" : "生成列（GENERATED ALWAYS AS … STORED）"}
                            checked={isVirtual}
                            onChange={event => patchColumn(position(), { generation_expression: event.currentTarget.checked ? "" : undefined })}
                          />
                        </td>
                        <td class="db-cell is-center is-keys">
                          <Show when={primaryKey().has(column.name)}><span class="db-key is-pk" title="主键">PK</span></Show>
                          <Show when={!primaryKey().has(column.name) && foreignKeys().has(column.name)}><span class="db-key is-fk" title="外键">FK</span></Show>
                          <Show when={!primaryKey().has(column.name) && !foreignKeys().has(column.name) && uniqueKeys().has(column.name)}><span class="db-key is-uni" title="唯一索引">U</span></Show>
                        </td>
                        <td class="db-cell is-field-comment">
                          <input
                            class="db-input is-cell"
                            value={column.comment}
                            aria-label="注释"
                            onFocus={() => setSelected(position())}
                            onInput={event => patchColumn(position(), { comment: event.currentTarget.value })}
                          />
                        </td>
                      </tr>
                    );
                  }}</For>
                  <Show when={columns().length === 0}>
                    <tr>
                      <td colspan="9">
                        <div class="db-designer-blank">还没有字段，点工具条「添加字段」开始</div>
                      </td>
                    </tr>
                  </Show>
                </tbody>
              </table>
              <datalist id="db-column-types">
                <For each={COMMON_COLUMN_TYPES}>{item => <option value={item} />}</For>
              </datalist>
            </div>
          </Match>

          <Match when={tab() === "indexes"}>
            <div class="db-grid-wrap">
              <table class="db-grid is-designer">
                <colgroup><col style={{ width: "30px" }} /><col style={{ width: "240px" }} /><col style={{ width: "120px" }} /><col style={{ width: "340px" }} /><col style={{ width: "72px" }} /><col /></colgroup>
                <thead><tr><th class="db-col-index">#</th><th>名称</th><th>类型</th><th>字段（逗号分隔，可加 DESC）</th><th class="is-center">唯一</th><th /></tr></thead>
                <tbody>
                  <For each={props.definition.indexes}>{(row, position) => (
                    <tr class={`db-row ${position() === index() ? "is-selected" : ""}`} onClick={() => setSelected(position())}>
                      <td class="db-col-index db-index">{position() + 1}</td>
                      <td class="db-cell">
                        <input class="db-input is-cell" value={row.name} onFocus={() => setSelected(position())} onInput={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((item, i) => i === position() ? { ...item, name: event.currentTarget.value } : item) })} />
                      </td>
                      <td class="db-cell">
                        <select class="db-select is-flush" value={row.kind} onChange={event => props.onChange({ ...props.definition, indexes: props.definition.indexes.map((item, i) => i === position() ? { ...item, kind: event.currentTarget.value as typeof item.kind } : item) })}>
                          <option value="PRIMARY">PRIMARY</option>
                          <option value="UNIQUE">UNIQUE</option>
                          <option value="INDEX">INDEX</option>
                        </select>
                      </td>
                      <td class="db-cell">
                        <input
                          class="db-input is-cell is-mono"
                          value={row.columns.map(item => item.direction === "DESC" ? `${item.name} DESC` : item.name).join(", ")}
                          placeholder="film_id, title DESC"
                          onFocus={() => setSelected(position())}
                          onInput={event => {
                            const next = event.currentTarget.value.split(",").map(part => part.trim()).filter(Boolean).map(part => {
                              const [name, direction] = part.split(/\s+/);
                              return { name, direction: direction?.toUpperCase() === "DESC" ? "DESC" : "ASC" };
                            });
                            props.onChange({ ...props.definition, indexes: props.definition.indexes.map((item, i) => i === position() ? { ...item, columns: next } : item) });
                          }}
                        />
                      </td>
                      <td class="db-cell is-center">{row.kind === "UNIQUE" || row.kind === "PRIMARY" ? "是" : "否"}</td>
                      <td class="db-cell" />
                    </tr>
                  )}</For>
                  <Show when={props.definition.indexes.length === 0}>
                    <tr><td colspan="6"><div class="db-designer-blank">这张表没有索引</div></td></tr>
                  </Show>
                </tbody>
              </table>
            </div>
          </Match>

          <Match when={tab() === "foreign"}>
            <Show when={(props.definition.foreign_keys || []).length > 0} fallback={<div class="db-grid-empty"><Icon name="link" size={18} /><p>还没有外键约束</p><small>建表时写入 CREATE TABLE，改表时以 ALTER TABLE 追加</small></div>}>
              <div class="db-grid-wrap">
                <table class="db-grid is-designer">
                  <colgroup><col style={{ width: "30px" }} /><col style={{ width: "210px" }} /><col style={{ width: "170px" }} /><col style={{ width: "150px" }} /><col style={{ width: "170px" }} /><col style={{ width: "116px" }} /><col style={{ width: "116px" }} /><col /></colgroup>
                  <thead><tr><th class="db-col-index">#</th><th>名称</th><th>字段</th><th>引用表</th><th>引用字段</th><th>ON DELETE</th><th>ON UPDATE</th><th /></tr></thead>
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
                        if (!mysql() && dot > 0) patch({ referenced_schema: raw.slice(0, dot), referenced_table: raw.slice(dot + 1) });
                        else patch({ referenced_schema: null, referenced_table: raw });
                      };
                      return (
                        <tr class={`db-row ${position() === index() ? "is-selected" : ""}`} onClick={() => setSelected(position())}>
                          <td class="db-col-index db-index">{position() + 1}</td>
                          <td class="db-cell"><input class="db-input is-cell" value={key.name} onFocus={() => setSelected(position())} onInput={event => patch({ name: event.currentTarget.value })} /></td>
                          <td class="db-cell"><input class="db-input is-cell is-mono" value={key.columns.join(", ")} onFocus={() => setSelected(position())} onInput={event => patch({ columns: event.currentTarget.value.split(",").map(item => item.trim()).filter(Boolean) })} /></td>
                          <td class="db-cell"><input class="db-input is-cell" value={target} onFocus={() => setSelected(position())} onInput={event => patchTarget(event.currentTarget.value)} /></td>
                          <td class="db-cell"><input class="db-input is-cell is-mono" value={key.referenced_columns.join(", ")} onFocus={() => setSelected(position())} onInput={event => patch({ referenced_columns: event.currentTarget.value.split(",").map(item => item.trim()).filter(Boolean) })} /></td>
                          <td class="db-cell">
                            <select class="db-select is-flush" value={key.on_delete || "RESTRICT"} onChange={event => patch({ on_delete: event.currentTarget.value })}>
                              <option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option><option>NO ACTION</option>
                            </select>
                          </td>
                          <td class="db-cell">
                            <select class="db-select is-flush" value={key.on_update || "RESTRICT"} onChange={event => patch({ on_update: event.currentTarget.value })}>
                              <option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option><option>NO ACTION</option>
                            </select>
                          </td>
                          <td class="db-cell" />
                        </tr>
                      );
                    }}</For>
                  </tbody>
                </table>
              </div>
            </Show>
          </Match>

          <Match when={tab() === "triggers"}>
            <div class="db-grid-empty">
              <Icon name="activity" size={18} />
              <p>触发器不在设计器里编辑</p>
              <small>触发器依附于表但属于独立对象，这里只做展示位；改触发器请用 SQL 查询（SHOW CREATE TRIGGER）。</small>
            </div>
          </Match>

          <Match when={tab() === "options"}>
            <div class="db-options">
              <label class="db-field-line">
                <span>表名</span>
                <input class="db-input" value={props.definition.name} onInput={event => props.onChange({ ...props.definition, name: event.currentTarget.value })} />
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
              <Show when={!mysql()}>
                <label class="db-field-line">
                  <span>表注释</span>
                  <input class="db-input" value={props.definition.comment} onInput={event => props.onChange({ ...props.definition, comment: event.currentTarget.value })} />
                </label>
              </Show>
              <p class="db-options-note">
                {mysql()
                  ? "引擎与字符集变更会触发 ALTER TABLE，大表可能锁表。"
                  : "PostgreSQL 的字符集由数据库决定，不能在表级修改；字段自增用 IDENTITY，注释用 COMMENT ON 写入。"}
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
                <For each={props.definition.columns}>{(column, position) => (
                  <label class="db-field-line">
                    <span class="is-mono">{column.name}</span>
                    <input class="db-input" value={column.comment} onInput={event => patchColumn(position(), { comment: event.currentTarget.value })} />
                  </label>
                )}</For>
              </div>
            </div>
          </Match>

          <Match when={tab() === "sql"}>
            <Show when={props.preview.length > 0} fallback={<div class="db-grid-empty"><p>还没有生成 SQL</p><small>点工具条「生成预览」按当前设计生成语句</small></div>}>
              <pre class="db-ddl is-inline"><SqlCode sql={props.preview.join("\n\n")} /></pre>
            </Show>
          </Match>
        </Switch>
      </div>

      {/* ④ 底部属性条：当前字段的默认值 / 自增 / 生成列表达式 */}
      <Show when={tab() === "columns"}>
        <div class="db-designer-foot">
          <span class="db-foot-label">默认值</span>
          <input
            class="db-input is-foot"
            value={current()?.default_value ?? ""}
            placeholder="NULL"
            aria-label="默认值"
            disabled={!current()}
            onInput={event => current() && patchColumn(index(), { default_value: event.currentTarget.value || undefined })}
          />
          <Show when={mysql()}>
            <label class="db-foot-check">
              <input
                type="checkbox"
                checked={!!current()?.auto_increment}
                disabled={!current()}
                onChange={event => current() && patchColumn(index(), { auto_increment: event.currentTarget.checked })}
              />
              自增
            </label>
          </Show>
          <Show when={current()?.generation_expression !== undefined}>
            <span class="db-foot-label">表达式</span>
            <input
              class="db-input is-foot is-mono"
              value={current()?.generation_expression ?? ""}
              placeholder="price * qty"
              aria-label="生成列表达式"
              onInput={event => current() && patchColumn(index(), { generation_expression: event.currentTarget.value })}
            />
          </Show>
          <span class="db-toolbar-spacer" />
          <span class="db-foot-meta">
            <Show when={current()} fallback="没有选中字段">
              {`第 ${index() + 1} 行 · ${current()!.nullable ? "允许 NULL" : "不是 NULL"}${footParts()?.base ? ` · ${current()!.collation || props.definition.collation || current()!.charset || ""}` : ""}`}
            </Show>
          </span>
        </div>
      </Show>
    </div>
  );
};
