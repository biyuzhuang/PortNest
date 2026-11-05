import { Component, Show } from "solid-js";
import { Icon } from "../Icon";

type Props = {
  databaseLabel: string;
  database: string;
  /** 当前对象的描述，例如「表 film · 994 行」 */
  objectText: string;
  running: boolean;
  activity: string;
  readOnly: boolean;
  onToggleReadOnly: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
};

export const StatusBar: Component<Props> = props => (
  <footer class="db-status" role="status">
    <span class="db-status-dot" data-state={props.running ? "busy" : "ready"} />
    <span class="db-status-item">{props.running ? "执行中…" : "就绪"}</span>
    <Show when={props.database}><span class="db-status-sep" /></Show>
    <Show when={props.database}><span class="db-status-item">{props.database}</span></Show>
    <Show when={props.objectText}><span class="db-status-sep" /><span class="db-status-item">{props.objectText}</span></Show>
    <span class="db-status-spacer" />
    <Show when={props.activity}><span class="db-status-item is-muted">{props.activity}</span></Show>
    <span class="db-status-item is-muted">{props.databaseLabel}</span>
    <button
      class={`db-status-btn ${props.readOnly ? "is-on" : ""}`}
      title={props.readOnly ? "只读模式：仅允许 SELECT / SHOW / EXPLAIN" : "可写模式：允许修改数据"}
      onClick={() => props.onToggleReadOnly()}
    >
      <Icon name={props.readOnly ? "lock" : "shield"} size={12} />
      {props.readOnly ? "只读" : "可写"}
    </button>
    <button class={`db-status-btn ${props.infoOpen ? "is-on" : ""}`} title="信息窗格（F6）" onClick={() => props.onToggleInfo()}>
      <Icon name="info" size={12} />
      信息
    </button>
  </footer>
);
