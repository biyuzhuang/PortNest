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
    <div class="db-toolbar-group">
      <button class="db-btn is-primary" onClick={() => props.onRun()} disabled={props.running} title="执行（F9 / Ctrl+Enter）">
        <Icon name="play" size={12} />运行
      </button>
      <button class="db-btn" onClick={() => props.onRun()} disabled={!props.hasSelection || props.running} title="只执行选中的语句">
        运行已选择
      </button>
      <button class="db-btn" onClick={() => props.onStop()} disabled={!props.running} title="停止当前查询">
        <Icon name="close" size={12} />停止
      </button>
    </div>

    <span class="db-toolbar-divider" />

    <div class="db-toolbar-group">
      <button class="db-text-btn" onClick={() => props.onBeautify()}><Icon name="sort" size={12} />美化</button>
      <button class="db-text-btn" onClick={() => props.onComment()} title="注释 / 取消注释选中行"><Icon name="edit" size={12} />注释</button>
      <button class="db-text-btn" onClick={() => props.onExplain()} disabled={props.explaining}>
        <Icon name="activity" size={12} />{props.explaining ? "生成中…" : "执行计划"}
      </button>
    </div>

    <span class="db-toolbar-divider" />

    <div class="db-toolbar-group">
      <button class="db-text-btn" onClick={() => props.onSave()}><Icon name="file" size={12} />保存</button>
      <button class={`db-text-btn ${props.historyOpen ? "is-on" : ""}`} onClick={() => props.onToggleHistory()}><Icon name="refresh" size={12} />历史</button>
      <button class={`db-text-btn ${props.favoritesOpen ? "is-on" : ""}`} onClick={() => props.onToggleFavorites()}><Icon name="check" size={12} />收藏</button>
    </div>

    <span class="db-toolbar-spacer" />

    <label class="db-query-db">
      <span>数据库</span>
      <select class="db-select" value={props.database} onChange={event => props.onDatabaseChange(event.currentTarget.value)}>
        <option value="">未选择</option>
        <For each={props.databases}>{item => <option value={item.name}>{item.name}</option>}</For>
      </select>
    </label>
    <button class={`db-text-btn ${props.readOnly ? "is-on" : ""}`} onClick={() => props.onToggleReadOnly()} title="只读模式只允许 SELECT / SHOW / DESCRIBE / EXPLAIN">
      <Icon name={props.readOnly ? "lock" : "shield"} size={12} />{props.readOnly ? "只读" : "可写"}
    </button>
    <button class="db-text-btn" onClick={() => props.onOpenAgent()} title="打开 SQL Agent">
      <Icon name="sparkles" size={12} />AI
    </button>
  </div>
);
