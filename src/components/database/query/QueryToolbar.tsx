import { Component, For } from "solid-js";
import { Icon } from "../../Icon";

type Props = {
  database: string;
  databases: Array<{ name: string }>;
  hasSelection: boolean;
  running: boolean;
  readOnly: boolean;
  historyOpen: boolean;
  favoritesOpen: boolean;
  onDatabaseChange: (database: string) => void;
  onRun: () => void;
  onStop: () => void;
  onBeautify: () => void;
  onComment: () => void;
  onExplain: () => void;
  onSave: () => void;
  onToggleHistory: () => void;
  onToggleFavorites: () => void;
  onToggleReadOnly: () => void;
  onOpenAgent: () => void;
  explaining: boolean;
};

export const QueryToolbar: Component<Props> = props => (
  <div class="db-query-toolbar">
    {/* 左侧执行/编辑/保存三组可滚动，右侧「数据库 + 权限 + AI」固定可见 */}
    <div class="db-toolbar-scroll">
    <div class="db-toolbar-group">
      <button class="db-btn is-primary" onClick={() => props.onRun()} disabled={props.running} title="执行（F9 / Ctrl+Enter）">
        <Icon name="play" size={14} /><span class="db-btn-label">运行</span>
      </button>
      <button class="db-btn" data-label-only onClick={() => props.onRun()} disabled={!props.hasSelection || props.running} title="只执行选中的语句">
        <span class="db-btn-label">运行已选择</span>
      </button>
      <button class="db-btn" onClick={() => props.onStop()} disabled={!props.running} title="停止当前查询">
        <Icon name="close" size={14} /><span class="db-btn-label">停止</span>
      </button>
    </div>

    <span class="db-toolbar-divider" />

    <div class="db-toolbar-group">
      <button class="db-text-btn" onClick={() => props.onBeautify()}><Icon name="sort" size={14} /><span class="db-btn-label">美化</span></button>
      <button class="db-text-btn" onClick={() => props.onComment()} title="注释 / 取消注释选中行"><Icon name="edit" size={14} /><span class="db-btn-label">注释</span></button>
      <button class="db-text-btn" onClick={() => props.onExplain()} disabled={props.explaining}>
        <Icon name="activity" size={14} /><span class="db-btn-label">{props.explaining ? "生成中…" : "执行计划"}</span>
      </button>
    </div>

    <span class="db-toolbar-divider" />

    <div class="db-toolbar-group">
      <button class="db-text-btn" onClick={() => props.onSave()}><Icon name="file" size={14} /><span class="db-btn-label">保存</span></button>
      <button class={`db-text-btn ${props.historyOpen ? "is-on" : ""}`} onClick={() => props.onToggleHistory()}><Icon name="refresh" size={14} /><span class="db-btn-label">历史</span></button>
      <button class={`db-text-btn ${props.favoritesOpen ? "is-on" : ""}`} onClick={() => props.onToggleFavorites()}><Icon name="check" size={14} /><span class="db-btn-label">收藏</span></button>
    </div>

    </div>
    <div class="db-toolbar-side">
    <label class="db-query-db">
      <span>数据库</span>
      <select class="db-select" value={props.database} onChange={event => props.onDatabaseChange(event.currentTarget.value)}>
        <option value="">未选择</option>
        <For each={props.databases}>{item => <option value={item.name}>{item.name}</option>}</For>
      </select>
    </label>
    <button class={`db-text-btn ${props.readOnly ? "is-on" : ""}`} onClick={() => props.onToggleReadOnly()} title="只读模式只允许 SELECT / SHOW / DESCRIBE / EXPLAIN">
      <Icon name={props.readOnly ? "lock" : "shield"} size={14} /><span class="db-btn-label">{props.readOnly ? "只读" : "可写"}</span>
    </button>
    <button class="db-text-btn" onClick={() => props.onOpenAgent()} title="打开 SQL Agent">
      <Icon name="sparkles" size={14} /><span class="db-btn-label">AI</span>
    </button>
    </div>
  </div>
);
