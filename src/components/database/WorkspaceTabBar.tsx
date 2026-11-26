import { Component, For, createSignal } from "solid-js";
import { Icon } from "../Icon";
import { ColorIcon } from "../ColorIcon";
import type { WorkspaceTab } from "./types";
import { databaseSettings } from "../../stores/databaseSettings";

type Props = {
  tabs: WorkspaceTab[];
  /** 「数据库标签显示信息」选择“显示数据库 + 连接名称”时使用 */
  connectionName?: string;
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
};

const iconFor = (tab: WorkspaceTab) => tab.kind === "database" ? "database" : tab.kind === "table" ? "table" : "query";

/** 标签文案按设置里的「数据库标签显示信息」生成，默认保持原有“表名 / 库名” */
const labelFor = (tab: WorkspaceTab, connectionName?: string) => {
  const mode = databaseSettings().tabLabelMode;
  if (tab.kind === "table") {
    if (mode === "database") return tab.database;
    if (mode === "table") return tab.table;
    return connectionName ? `${tab.table} · ${tab.database}` : tab.title;
  }
  if (tab.kind === "database" && mode === "database-connection" && connectionName) return `${tab.database} · ${connectionName}`;
  return tab.kind === "database" ? tab.database : tab.title;
};

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
            <span class="db-tab-icon"><ColorIcon name={iconFor(tab)} size={14} /></span>
            <span class="db-tab-label">{labelFor(tab, props.connectionName)}</span>
            {tab.kind !== "database" && tab.dirty && <span class="db-tab-dirty" aria-label="有未保存修改" />}
            <span
              class="db-tab-close"
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.title}`}
              onClick={event => { event.stopPropagation(); props.onClose(tab.id); }}
            >
              <Icon name="close" size={12} class={hovered() === tab.id ? "is-visible" : ""} />
            </span>
          </button>
        )}</For>
      </div>
      {/* 新建查询：常用命令，做成主按钮并钉在标签栏右侧，标签再多也不会被挤走 */}
      <button class="db-new-query" title="新建查询（Ctrl+T）" aria-label="新建查询" onClick={() => props.onNewQuery()}>
        <Icon name="plus" size={14} />
        <span class="db-btn-label">新建查询</span>
      </button>
    </div>
  );
};
