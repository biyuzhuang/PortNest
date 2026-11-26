import { Component, For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { Icon } from "../../Icon";
import { ColorIcon } from "../../ColorIcon";
import type { WorkspaceState } from "../../../stores/databaseWorkspaceStore";
import { tableCount, type ContextMenuState, type ObjectScope } from "../types";
import { databaseSettings, databaseSettingsEpoch } from "../../../stores/databaseSettings";

const MIN_WIDTH = 208;
const MAX_WIDTH = 480;

type Props = {
  state: WorkspaceState;
  /** 连接名：对象树第一层（数据库连接）在窗格头部呈现 */
  connectionTitle: string;
  /** 连接地址，作为头部的次要信息 */
  connectionMeta: string;
  databaseLabel: string;
  activeObject: string;
  /** 当前内容区对应的数据库与展示范围，用于高亮「数据库 / 表 / 视图」节点 */
  activeScope: ObjectScope;
  /** 单选选中的对象（`库:表`）。只展示信息，不打开标签 */
  selectedObject: string;
  /** 单击数据库或「表 / 视图」分组：只更新右侧内容区，不改变展开状态 */
  onSelectScope: (database: string, scope: ObjectScope) => void;
  onSelectObject: (key: string) => void;
  onOpenTable: (database: string, table: string) => void;
  /** 首次展开数据库时按需加载对象列表 */
  onEnsureTables: (database: string) => void;
  onCreateDatabase: () => void;
  onRefresh: () => void;
  onContextMenu: (menu: ContextMenuState) => void;
};

export const ObjectTreePane: Component<Props> = props => {
  // 表注释开关：额外依赖设置变更计数，避免 HMR 下持有旧 signal 实例而不刷新
  const showTableComment = () => {
    databaseSettingsEpoch();
    return databaseSettings().showTableComment;
  };

  /** 库名右侧的字符集编码：默认不显示，避免窄树面板被编码挤掉库名 */
  const showDatabaseCharset = () => {
    databaseSettingsEpoch();
    return databaseSettings().showDatabaseCharset;
  };

  const [width, setWidth] = createSignal(readWidth());
  let pane: HTMLElement | undefined;

  const filtering = () => !!props.state.treeFilter().trim();

  const filtered = createMemo(() => {
    const query = props.state.treeFilter().trim().toLowerCase();
    if (!query) return props.state.databases();
    return props.state.databases().filter(database => {
      if (database.name.toLowerCase().includes(query)) return true;
      return (props.state.tables()[database.name] || []).some(item => item.name.toLowerCase().includes(query));
    });
  });

  /** 按分组取对象：搜索时只保留名称命中的项 */
  const objectsOf = (database: string, kind: "BASE TABLE" | "VIEW") => {
    const query = props.state.treeFilter().trim().toLowerCase();
    const all = (props.state.tables()[database] || []).filter(item => item.kind === kind);
    return query && !database.toLowerCase().includes(query)
      ? all.filter(item => item.name.toLowerCase().includes(query))
      : all;
  };

  // ---------------------------------------------------------------------------
  // 展开：只影响当前节点，且只展开它的直接子项
  // ---------------------------------------------------------------------------
  const isDatabaseOpen = (database: string) => !!props.state.expanded()[database];
  const isGroupOpen = (database: string, group: "tables" | "views") => !!props.state.expandedGroups()[`${database}:${group}`];

  /** 箭头 / 双击：切换数据库节点的直接子项（表 / 视图两个分组），不触碰更深的层级 */
  const toggleDatabase = (database: string, expandOnly = false) => {
    const open = isDatabaseOpen(database);
    if (expandOnly && open) return;
    if (expandOnly || !open) props.onEnsureTables(database);
    if (expandOnly) props.state.expandDatabase(database);
    else props.state.toggleExpanded(database);
  };

  /** 箭头 / 双击：切换「表 / 视图」分组的直接子项 */
  const toggleGroup = (database: string, group: "tables" | "views") => {
    const open = isGroupOpen(database, group);
    if (!open) props.onEnsureTables(database);
    props.state.toggleGroup(database, group);
  };

  const beginResize = (event: PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width();
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + moveEvent.clientX - startX));
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writeWidth(width());
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 双击分隔条复位
  const resetWidth = () => { setWidth(264); writeWidth(264); };
  onCleanup(() => { if (pane) pane.style.removeProperty("width"); });

  const menuFor = (event: MouseEvent, menu: Omit<ContextMenuState, "x" | "y">) => {
    event.preventDefault();
    event.stopPropagation();
    props.onContextMenu({ ...menu, x: event.clientX, y: event.clientY });
  };

  return (
    <aside class="db-nav" ref={element => { pane = element; }} style={{ width: `${width()}px` }}>
      <header class="db-nav-head" title={`${props.connectionTitle} · ${props.connectionMeta}`}>
        <span class="db-nav-conn-icon"><ColorIcon name="database" size={16} /></span>
        <div class="db-nav-conn">
          <strong>{props.connectionTitle}</strong>
          <small>{props.connectionMeta}</small>
        </div>
        <div class="db-nav-actions">
          <button class="db-icon-btn" title="新建数据库" aria-label="新建数据库" onClick={() => props.onCreateDatabase()}>
            <Icon name="plus" size={16} />
          </button>
          <button class="db-icon-btn" title="刷新" aria-label="刷新数据库列表" onClick={() => props.onRefresh()}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>

      <label class="db-search">
        <Icon name="search" size={14} />
        <input
          value={props.state.treeFilter()}
          placeholder="搜索数据库、表或视图"
          aria-label="搜索数据库、表或视图"
          onInput={event => props.state.setTreeFilter(event.currentTarget.value)}
        />
        <Show when={props.state.treeFilter()}>
          <button class="db-search-clear" aria-label="清除搜索" onClick={() => props.state.setTreeFilter("")}>
            <Icon name="close" size={12} />
          </button>
        </Show>
      </label>

      <div class="db-nav-scroll" role="tree" aria-label="数据库对象">
        <For each={filtered()}>{database => {
          const open = () => isDatabaseOpen(database.name) || filtering();
          const tablesOpen = () => isGroupOpen(database.name, "tables") || filtering();
          const viewsOpen = () => isGroupOpen(database.name, "views") || filtering();
          const databaseActive = () => props.activeObject === `database:${database.name}` && props.activeScope === "all";
          const tablesActive = () => props.activeObject === `database:${database.name}` && props.activeScope === "tables";
          const viewsActive = () => props.activeObject === `database:${database.name}` && props.activeScope === "views";
          /** 当前内容区停留在这个库里的某个对象上：给父节点留一道弱高亮，避免丢失位置感 */
          const containsActive = () => !databaseActive() && props.activeObject.startsWith(`${database.name}:`);
          return <div class="db-tree-section">
            {/* 第二层：数据库 */}
            <div
              class={`db-tree-row is-database ${databaseActive() ? "is-active" : ""} ${containsActive() ? "is-ancestor" : ""}`}
              role="treeitem"
              aria-expanded={open()}
              aria-level={1}
              tabIndex={0}
              title={`${database.name}（单击查看全部对象，双击展开）`}
              onClick={() => props.onSelectScope(database.name, "all")}
              onDblClick={() => toggleDatabase(database.name)}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelectScope(database.name, "all"); }
                if (event.key === "ArrowRight") { event.preventDefault(); toggleDatabase(database.name, true); }
                if (event.key === "ArrowLeft") { event.preventDefault(); if (isDatabaseOpen(database.name)) toggleDatabase(database.name); }
              }}
              onContextMenu={event => menuFor(event, { kind: "database", database: database.name })}
            >
              <button
                class={`db-tree-twisty ${open() ? "is-open" : ""}`}
                aria-label={open() ? "折叠" : "展开"}
                tabIndex={-1}
                onClick={event => { event.stopPropagation(); toggleDatabase(database.name); }}
              >
                <Icon name="chevronRight" size={12} />
              </button>
              <span class="db-tree-icon is-database"><ColorIcon name="database" size={16} /></span>
              <span class="db-tree-label">{database.name}</span>
              <Show when={showDatabaseCharset() && database.charset}><em class="db-tree-meta">{database.charset}</em></Show>
            </div>

            <Show when={open()}>
              <div class="db-tree-children">
                {/* 第三层：表 / 视图分组 */}
                <div
                  class={`db-group-row ${tablesActive() ? "is-active" : ""}`}
                  role="treeitem"
                  aria-expanded={tablesOpen()}
                  aria-level={2}
                  tabIndex={0}
                  title="单击查看全部表，双击展开表列表"
                  onClick={() => props.onSelectScope(database.name, "tables")}
                  onDblClick={() => toggleGroup(database.name, "tables")}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelectScope(database.name, "tables"); }
                    if (event.key === "ArrowRight") { event.preventDefault(); if (!isGroupOpen(database.name, "tables")) toggleGroup(database.name, "tables"); }
                    if (event.key === "ArrowLeft") { event.preventDefault(); if (isGroupOpen(database.name, "tables")) toggleGroup(database.name, "tables"); }
                  }}
                >
                  <button
                    class={`db-tree-twisty ${tablesOpen() ? "is-open" : ""}`}
                    aria-label={tablesOpen() ? "折叠表" : "展开表"}
                    tabIndex={-1}
                    onClick={event => { event.stopPropagation(); toggleGroup(database.name, "tables"); }}
                  >
                    <Icon name="chevronRight" size={12} />
                  </button>
                  <span class="db-tree-icon"><ColorIcon name="table" size={16} /></span>
                  <b>表</b>
                  <em>{tableCount(props.state.tables()[database.name], "BASE TABLE")}</em>
                </div>
                <Show when={tablesOpen()}>
                  <For each={objectsOf(database.name, "BASE TABLE")}>{table => (
                    <div
                      class={`db-tree-row is-object ${props.activeObject === `${database.name}:${table.name}` ? "is-active" : ""} ${props.selectedObject === `${database.name}:${table.name}` ? "is-selected" : ""}`}
                      role="treeitem"
                      aria-level={3}
                      tabIndex={0}
                      title={`${table.comment || table.name}（单击查看信息，双击打开）`}
                      onClick={() => props.onSelectObject(`${database.name}:${table.name}`)}
                      onDblClick={() => props.onOpenTable(database.name, table.name)}
                      onKeyDown={event => { if (event.key === "Enter") props.onOpenTable(database.name, table.name); }}
                      onContextMenu={event => menuFor(event, { kind: "table", database: database.name, table: table.name })}
                    >
                      <span class="db-tree-icon is-object"><ColorIcon name="table" size={16} /></span>
                      <span class="db-tree-label">{table.name}</span>
                      <Show when={showTableComment() && table.comment}><span class="db-tree-comment">{table.comment}</span></Show>
                    </div>
                  )}</For>
                  <Show when={objectsOf(database.name, "BASE TABLE").length === 0}>
                    <p class="db-tree-empty">{filtering() ? "没有匹配的表" : "还没有表"}</p>
                  </Show>
                </Show>

                <div
                  class={`db-group-row ${viewsActive() ? "is-active" : ""}`}
                  role="treeitem"
                  aria-expanded={viewsOpen()}
                  aria-level={2}
                  tabIndex={0}
                  title="单击查看全部视图，双击展开视图列表"
                  onClick={() => props.onSelectScope(database.name, "views")}
                  onDblClick={() => toggleGroup(database.name, "views")}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelectScope(database.name, "views"); }
                    if (event.key === "ArrowRight") { event.preventDefault(); if (!isGroupOpen(database.name, "views")) toggleGroup(database.name, "views"); }
                    if (event.key === "ArrowLeft") { event.preventDefault(); if (isGroupOpen(database.name, "views")) toggleGroup(database.name, "views"); }
                  }}
                >
                  <button
                    class={`db-tree-twisty ${viewsOpen() ? "is-open" : ""}`}
                    aria-label={viewsOpen() ? "折叠视图" : "展开视图"}
                    tabIndex={-1}
                    onClick={event => { event.stopPropagation(); toggleGroup(database.name, "views"); }}
                  >
                    <Icon name="chevronRight" size={12} />
                  </button>
                  <span class="db-tree-icon"><ColorIcon name="view" size={16} /></span>
                  <b>视图</b>
                  <em>{tableCount(props.state.tables()[database.name], "VIEW")}</em>
                </div>
                <Show when={viewsOpen()}>
                  <For each={objectsOf(database.name, "VIEW")}>{view => (
                    <div
                      class={`db-tree-row is-object ${props.activeObject === `${database.name}:${view.name}` ? "is-active" : ""} ${props.selectedObject === `${database.name}:${view.name}` ? "is-selected" : ""}`}
                      role="treeitem"
                      aria-level={3}
                      tabIndex={0}
                      title={`${view.name}（单击查看信息，双击打开）`}
                      onClick={() => props.onSelectObject(`${database.name}:${view.name}`)}
                      onDblClick={() => props.onOpenTable(database.name, view.name)}
                      onKeyDown={event => { if (event.key === "Enter") props.onOpenTable(database.name, view.name); }}
                      onContextMenu={event => menuFor(event, { kind: "table", database: database.name, table: view.name })}
                    >
                      <span class="db-tree-icon is-view"><ColorIcon name="view" size={16} /></span>
                      <span class="db-tree-label">{view.name}</span>
                      <Show when={showTableComment() && view.comment}><span class="db-tree-comment">{view.comment}</span></Show>
                    </div>
                  )}</For>
                  <Show when={objectsOf(database.name, "VIEW").length === 0}>
                    <p class="db-tree-empty">{filtering() ? "没有匹配的视图" : "还没有视图"}</p>
                  </Show>
                </Show>

                <div class="db-group-row is-disabled" title="暂未支持">
                  <span class="db-tree-twisty" aria-hidden="true" />
                  <span class="db-tree-icon"><ColorIcon name="query" size={16} /></span>
                  <b>查询</b><em>0</em>
                </div>
                <div class="db-group-row is-disabled" title="暂未支持">
                  <span class="db-tree-twisty" aria-hidden="true" />
                  <span class="db-tree-icon"><ColorIcon name="er" size={16} /></span>
                  <b>ER 图</b><em>0</em>
                </div>
                <div class="db-group-row is-disabled" title="暂未支持">
                  <span class="db-tree-twisty" aria-hidden="true" />
                  <span class="db-tree-icon"><ColorIcon name="fx" size={16} /></span>
                  <b>函数</b><em>0</em>
                </div>
              </div>
            </Show>
          </div>;
        }}</For>
      </div>

      <div
        class="db-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整对象树宽度"
        tabIndex={0}
        onPointerDown={beginResize}
        onDblClick={resetWidth}
        onKeyDown={event => {
          if (event.key === "ArrowLeft") { const next = Math.max(MIN_WIDTH, width() - 16); setWidth(next); writeWidth(next); }
          if (event.key === "ArrowRight") { const next = Math.min(MAX_WIDTH, width() + 16); setWidth(next); writeWidth(next); }
        }}
      />
    </aside>
  );
};

const STORAGE_KEY = "portnest.database.treeWidth";

const readWidth = () => {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? raw : 264;
};
const writeWidth = (value: number) => localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
