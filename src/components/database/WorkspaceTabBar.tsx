import { Component, For, createSignal } from "solid-js";
import { Icon } from "../Icon";
import type { WorkspaceTab } from "./types";

type Props = {
  tabs: WorkspaceTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
};

const iconFor = (tab: WorkspaceTab) => tab.kind === "database" ? "database" : tab.kind === "table" ? "table" : "query";

export const WorkspaceTabBar: Component<Props> = props => {
  // 中键关闭：Navicat / 浏览器的通用手势
  const [hovered, setHovered] = createSignal("");

  return (
    <div class="db-tabs" role="tablist" aria-label="工作区标签">
      <div
        class="db-tabs-scroll"
        onWheel={event => {
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        <For each={props.tabs}>{tab => (
          <button
            class={`db-tab ${props.activeId === tab.id ? "is-active" : ""}`}
            role="tab"
            aria-selected={props.activeId === tab.id}
            title={tab.kind === "table" ? `${tab.database} / ${tab.table}` : tab.title}
            onMouseEnter={() => setHovered(tab.id)}
            onMouseLeave={() => setHovered(current => current === tab.id ? "" : current)}
            onClick={() => props.onSelect(tab.id)}
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); props.onClose(tab.id); } }}
          >
            <span class="db-tab-icon"><Icon name={iconFor(tab)} size={13} /></span>
            <span class="db-tab-label">{tab.title}</span>
            {tab.kind !== "database" && tab.dirty && <span class="db-tab-dirty" aria-label="有未保存修改" />}
            <span
              class="db-tab-close"
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.title}`}
              onClick={event => { event.stopPropagation(); props.onClose(tab.id); }}
            >
              <Icon name="close" size={11} class={hovered() === tab.id ? "is-visible" : ""} />
            </span>
          </button>
        )}</For>
      </div>
      <button class="db-tab-new" title="新建查询（Ctrl+T）" aria-label="新建查询" onClick={() => props.onNewQuery()}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
};
