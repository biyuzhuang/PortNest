import { Component, Show } from "solid-js";
import { Icon } from "../Icon";
import type { WorkspaceTab } from "./types";

type Props = {
  tab: WorkspaceTab | null;
  connectionInfo: { protocol: string; host: string; port: number; database: string } | null;
  onClose: () => void;
};

export const InfoPane: Component<Props> = props => (
  <aside class="db-info" aria-label="信息窗格">
    <header class="db-info-head">
      <strong>信息</strong>
      <span class="db-toolbar-spacer" />
      <button class="db-icon-btn" aria-label="关闭信息窗格" title="关闭（F6）" onClick={() => props.onClose()}>
        <Icon name="close" size={12} />
      </button>
    </header>

    <Show when={props.tab} fallback={<p class="db-info-empty">没有打开的标签</p>}>
      <div class="db-info-body">
        <h4>连接</h4>
        <dl class="db-props is-compact">
          <dt>协议</dt><dd>{props.connectionInfo?.protocol ?? "—"}</dd>
          <dt>主机</dt><dd class="is-mono">{props.connectionInfo ? `${props.connectionInfo.host}:${props.connectionInfo.port}` : "—"}</dd>
          <dt>数据库</dt><dd>{props.tab?.database || "—"}</dd>
        </dl>

        <h4>当前对象</h4>
        <dl class="db-props is-compact">
          <dt>类型</dt><dd>{props.tab?.kind === "table" ? "表" : props.tab?.kind === "query" ? "查询" : "数据库"}</dd>
          <dt>名称</dt><dd>{props.tab?.title}</dd>
          <Show when={props.tab?.kind === "table"}>
            <dt>字段</dt><dd class="is-numeric">{(props.tab as any).columns?.length ?? 0}</dd>
            <dt>索引</dt><dd class="is-numeric">{(props.tab as any).indexes?.length ?? 0}</dd>
            <dt>本页行</dt><dd class="is-numeric">{(props.tab as any).rows?.rows?.length ?? 0}</dd>
          </Show>
          <Show when={props.tab?.kind === "query"}>
            <dt>结果行</dt><dd class="is-numeric">{(props.tab as any).result?.rows?.length ?? 0}</dd>
            <dt>耗时</dt><dd class="is-numeric">{(props.tab as any).result?.execution_time_ms ?? 0} ms</dd>
          </Show>
        </dl>

        <Show when={props.tab?.kind === "query" && (props.tab as any).result?.statement}>
          <h4>最近执行的语句</h4>
          <pre class="db-ddl is-inline">{(props.tab as any).result.statement}</pre>
        </Show>

        <h4>快捷键</h4>
        <ul class="db-shortcuts">
          <li><kbd>F9</kbd><span>执行 SQL</span></li>
          <li><kbd>Ctrl</kbd><kbd>Enter</kbd><span>执行当前语句</span></li>
          <li><kbd>F6</kbd><span>显示 / 隐藏信息窗格</span></li>
          <li><kbd>Ctrl</kbd><kbd>T</kbd><span>新建查询</span></li>
        </ul>
      </div>
    </Show>
  </aside>
);
