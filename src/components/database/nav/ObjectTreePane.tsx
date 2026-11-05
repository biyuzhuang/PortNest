import { Component, For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { Icon } from "../../Icon";
import type { WorkspaceState } from "../../../stores/databaseWorkspaceStore";
import { tableCount, type ContextMenuState } from "../types";

const MIN_WIDTH = 208;
const MAX_WIDTH = 480;

type Props = {
  state: WorkspaceState;
  databaseLabel: string;
  activeObject: string;
  onActivateDatabase: (database: string) => void;
  onOpenTable: (database: string, table: string) => void;
  onCreateDatabase: () => void;
  onRefresh: () => void;
  onContextMenu: (menu: ContextMenuState) => void;
};

export const ObjectTreePane: Component<Props> = props => {
  const [width, setWidth] = createSignal(readWidth());
  let pane: HTMLElement | undefined;

  const filtered = createMemo(() => {
    const query = props.state.treeFilter().trim().toLowerCase();
    if (!query) return props.state.databases();
    return props.state.databases().filter(database => {
      if (database.name.toLowerCase().includes(query)) return true;
      return (props.state.tables()[database.name] || []).some(item => item.name.toLowerCase().includes(query));
    });
  });

  const tablesFor = (database: string) => {
    const query = props.state.treeFilter().trim().toLowerCase();
    const all = (props.state.tables()[database] || []).filter(item => item.kind === "BASE TABLE");
    return query ? all.filter(item => item.name.toLowerCase().includes(query)) : all;
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
      <header class="db-nav-head">
        <strong title={props.databaseLabel}>{props.databaseLabel}</strong>
        <div class="db-nav-actions">
          <button class="db-icon-btn" title="新建数据库" aria-label="新建数据库" onClick={() => props.onCreateDatabase()}>
            <Icon name="plus" size={14} />
          </button>
          <button class="db-icon-btn" title="刷新" aria-label="刷新数据库列表" onClick={() => props.onRefresh()}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </header>

      <label class="db-search">
        <Icon name="search" size={13} />
        <input
          value={props.state.treeFilter()}
          placeholder="搜索数据库或表"
          aria-label="搜索数据库或表"
          onInput={event => props.state.setTreeFilter(event.currentTarget.value)}
        />
        <Show when={props.state.treeFilter()}>
          <button class="db-search-clear" aria-label="清除搜索" onClick={() => props.state.setTreeFilter("")}>
            <Icon name="close" size={11} />
          </button>
        </Show>
      </label>

      <div class="db-nav-scroll" role="tree" aria-label="数据库对象">
        <For each={filtered()}>{database => {
          const open = () => !!props.state.expanded()[database.name];
          const tablesOpen = () => !!props.state.expandedGroups()[`${database.name}:tables`];
          const viewsOpen = () => !!props.state.expandedGroups()[`${database.name}:views`];
          return <div class="db-tree-section">
            <div
              class={`db-tree-row is-database ${props.activeObject.startsWith(`database:${database.name}`) ? "is-active" : ""}`}
              role="treeitem"
              aria-expanded={open()}
              tabIndex={0}
              onClick={() => props.onActivateDatabase(database.name)}
              onKeyDown={event => { if (event.key === "Enter") props.onActivateDatabase(database.name); }}
              onContextMenu={event => menuFor(event, { kind: "database", database: database.name })}
            >
              <button
                class={`db-tree-twisty ${open() ? "is-open" : ""}`}
                aria-label={open() ? "折叠" : "展开"}
                onClick={event => {
                  event.stopPropagation();
                  const nowOpen = props.state.toggleExpanded(database.name);
                  if (nowOpen) props.onActivateDatabase(database.name);
                }}
              >
                <Icon name="chevronRight" size={11} />
              </button>
              <span class="db-tree-icon is-database"><Icon name="database" size={14} /></span>
              <span class="db-tree-label">{database.name}</span>
              <Show when={database.charset}><em class="db-tree-meta">{database.charset}</em></Show>
            </div>

            <Show when={open()}>
              <div class="db-tree-children">
                <div
                  class="db-group-row"
                  role="treeitem"
                  aria-expanded={tablesOpen()}
                  tabIndex={0}
                  onClick={() => props.state.toggleGroup(database.name, "tables")}
                >
                  <span class={`db-tree-twisty ${tablesOpen() ? "is-open" : ""}`} aria-hidden="true"><Icon name="chevronRight" size={11} /></span>
                  <span class="db-tree-icon"><Icon name="table" size={13} /></span>
                  <b>表</b>
                  <em>{tableCount(props.state.tables()[database.name], "BASE TABLE")}</em>
                </div>
                <Show when={tablesOpen()}>
                  <For each={tablesFor(database.name)}>{table => (
                    <div
                      class={`db-tree-row is-object ${props.activeObject === `${database.name}:${table.name}` ? "is-active" : ""}`}
                      role="treeitem"
                      tabIndex={0}
                      title={table.comment || table.name}
                      onDblClick={() => props.onOpenTable(database.name, table.name)}
                      onKeyDown={event => { if (event.key === "Enter") props.onOpenTable(database.name, table.name); }}
                      onContextMenu={event => menuFor(event, { kind: "table", database: database.name, table: table.name })}
                    >
                      <span class="db-tree-icon is-object"><Icon name="table" size={13} /></span>
                      <span class="db-tree-label">{table.name}</span>
                      <Show when={table.comment}><span class="db-tree-comment">{table.comment}</span></Show>
                    </div>
                  )}</For>
                  <Show when={tablesFor(database.name).length === 0}>
                    <p class="db-tree-empty">{props.state.treeFilter() ? "没有匹配的表" : "还没有表"}</p>
                  </Show>
                </Show>

                <div
                  class="db-group-row"
                  role="treeitem"
                  aria-expanded={viewsOpen()}
                  tabIndex={0}
                  onClick={() => props.state.toggleGroup(database.name, "views")}
                >
                  <span class={`db-tree-twisty ${viewsOpen() ? "is-open" : ""}`} aria-hidden="true"><Icon name="chevronRight" size={11} /></span>
                  <span class="db-tree-icon"><Icon name="view" size={13} /></span>
                  <b>视图</b>
                  <em>{tableCount(props.state.tables()[database.name], "VIEW")}</em>
                </div>
                <Show when={viewsOpen()}>
                  <For each={(props.state.tables()[database.name] || []).filter(item => item.kind === "VIEW")}>{view => (
                    <div class="db-tree-row is-object" role="treeitem" tabIndex={0} onDblClick={() => props.onOpenTable(database.name, view.name)}>
                      <span class="db-tree-icon is-view"><Icon name="view" size={13} /></span>
                      <span class="db-tree-label">{view.name}</span>
                    </div>
                  )}</For>
                </Show>

                <div class="db-group-row is-disabled" title="暂未支持">
                  <span class="db-tree-twisty" aria-hidden="true" />
                  <span class="db-tree-icon"><Icon name="query" size={13} /></span>
                  <b>查询</b><em>0</em>
                </div>
                <div class="db-group-row is-disabled" title="暂未支持">
                  <span class="db-tree-twisty" aria-hidden="true" />
                  <span class="db-tree-icon"><Icon name="assets" size={13} /></span>
                  <b>ER 图</b><em>0</em>
                </div>
                <div class="db-group-row is-disabled" title="暂未支持">
                  <span class="db-tree-twisty" aria-hidden="true" />
                  <span class="db-tree-icon"><Icon name="settings" size={13} /></span>
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
