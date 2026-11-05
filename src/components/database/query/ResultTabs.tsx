import { Component, For, Show, createMemo } from "solid-js";
import { Icon } from "../../Icon";
import type { StatementOutcome } from "../../../utils/api";
import type { QueryStats } from "../types";
import { csvCell, formatCell, isNullValue } from "../types";
import { ExplainPanel } from "./ExplainPanel";

type Pane = "result" | "messages" | "profile" | "plan";

type Props = {
  active: Pane;
  onActive: (pane: Pane) => void;
  results: StatementOutcome[];
  batch?: { transaction: string; partial: boolean; error: string | null } | null;
  activeResult: number;
  onActiveResult: (index: number) => void;
  stats: QueryStats | null;
  messages: string[];
  running: boolean;
  explain: { json_plan?: unknown; columns: string[]; rows: unknown[][]; message?: string } | null;
  explaining: boolean;
  onExplain: () => void;
};

export const ResultTabs: Component<Props> = props => {
  /** 只有真正带结果集的语句才占一个「结果 N」页签，纯 DML 走消息页 */
  const resultPanes = createMemo(() => props.results
    .filter(item => item.result && (item.result.columns.length > 0 || item.result.rows.length > 0))
    .map(item => ({ index: item.index, label: `结果 ${item.index}`, badge: item.result!.rows.length })));

  const result = createMemo(() => {
    const exact = props.results.find(item => item.index === props.activeResult)?.result;
    if (exact) return exact;
    return props.results.find(item => item.result && item.result.columns.length > 0)?.result
      ?? props.results[props.results.length - 1]?.result
      ?? null;
  });

  const failure = createMemo(() => props.results.find(item => item.error) ?? null);

  /** 回滚提示：一定要说清「执行成功」的语句是否真的落库了 */
  const rollbackNotice = createMemo(() => {
    const batch = props.batch;
    if (!batch) return "";
    if (batch.transaction === "rollback_failed") return "批次执行失败，回滚也失败 —— 请立即人工检查数据";
    if (batch.transaction !== "rolled_back") return "";
    return batch.partial
      ? "批次已回滚，但其中包含 DDL（隐式提交），那部分已生效"
      : "批次执行失败，已回滚，前面的语句均未生效";
  });

  const copyResult = () => {
    const current = result();
    if (!current) return;
    const text = [current.columns.join("\t"), ...current.rows.map(row => row.values.map(value => isNullValue(value) ? "NULL" : formatCell(value)).join("\t"))].join("\n");
    void navigator.clipboard.writeText(text);
  };
  const exportCsv = () => {
    const current = result();
    if (!current) return;
    const content = [current.columns.map(csvCell).join(","), ...current.rows.map(row => row.values.map(csvCell).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="db-result">
      <div class="db-result-tabs" role="tablist" aria-label="查询结果">
        <For each={resultPanes()}>{pane => (
          <button
            role="tab"
            aria-selected={props.active === "result" && props.activeResult === pane.index}
            class={props.active === "result" && props.activeResult === pane.index ? "is-active" : ""}
            onClick={() => { props.onActive("result"); props.onActiveResult(pane.index); }}
          >
            {pane.label}
            <Show when={pane.badge > 0}><em>{pane.badge}</em></Show>
          </button>
        )}</For>
        {/* 还没结果时保留一个占位页签，让空状态有落点 */}
        <Show when={resultPanes().length === 0}>
          <button role="tab" aria-selected={props.active === "result"} class={props.active === "result" ? "is-active" : ""} onClick={() => props.onActive("result")}>结果 1</button>
        </Show>
        <button
          role="tab"
          aria-selected={props.active === "messages"}
          class={`${props.active === "messages" ? "is-active" : ""} ${failure() ? "is-error" : ""}`.trim()}
          onClick={() => props.onActive("messages")}
        >
          消息
          <Show when={failure()}><em class="is-error">!</em></Show>
        </button>
        <button role="tab" aria-selected={props.active === "profile"} class={props.active === "profile" ? "is-active" : ""} onClick={() => props.onActive("profile")}>概况</button>
        <button role="tab" aria-selected={props.active === "plan"} class={props.active === "plan" ? "is-active" : ""} onClick={() => props.onActive("plan")}>执行计划</button>
        <span class="db-toolbar-spacer" />
        <Show when={props.active === "result" && result()}>
          <button class="db-text-btn" onClick={copyResult}><Icon name="copy" size={12} />复制</button>
          <button class="db-text-btn" onClick={exportCsv}><Icon name="export" size={12} />CSV</button>
        </Show>
        <Show when={props.active === "plan"}>
          <button class="db-text-btn" onClick={() => props.onExplain()} disabled={props.explaining}>
            <Icon name="refresh" size={12} />{props.explaining ? "生成中…" : "重新生成"}
          </button>
        </Show>
      </div>

      <div class="db-result-body">
        <Show when={rollbackNotice()}>
          <div class={`db-batch-notice ${props.batch?.transaction === "rollback_failed" ? "is-danger" : ""}`.trim()} role="status">
            <Icon name="info" size={12} />
            <span>{rollbackNotice()}</span>
          </div>
        </Show>
        <Show when={props.active === "result"}>
          <Show when={result()} fallback={<div class="db-grid-empty"><Icon name="query" size={18} /><p>{props.running ? "正在执行…" : "还没有结果"}</p><small>{props.running ? "查询返回后会显示在这里" : "按 F9 或点「运行」执行当前 SQL"}</small></div>}>
            {(current) => (<>
              <div class="db-grid-wrap">
                <table class="db-grid is-data">
                  <thead>
                    <tr>
                      <th class="db-col-index is-frozen">#</th>
                      <For each={current().columns}>{name => <th class="db-th"><span class="db-th-name">{name}</span></th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={current().rows}>{(row, index) => (
                      <tr class="db-row">
                        <td class="db-col-index is-frozen">{index() + 1}</td>
                        <For each={row.values}>{value => (
                          <td class={`db-cell ${isNullValue(value) ? "is-null" : ""}`} title={formatCell(value)}>
                            {isNullValue(value) ? <em class="db-cell-null">NULL</em> : formatCell(value)}
                          </td>
                        )}</For>
                      </tr>
                    )}</For>
                  </tbody>
                </table>
              </div>
              <div class="db-statusbar">
                <span class="db-status-item">{current().rows.length} 行 · 影响 {current().affected_rows} 行 · {current().execution_time_ms} ms</span>
                <Show when={current().truncated}><span class="db-status-item is-muted">结果已截断，请加 LIMIT</span></Show>
                <Show when={props.results.length > 1}><span class="db-status-item is-muted">本次共 {props.results.length} 条语句</span></Show>
              </div>
            </>)}
          </Show>
        </Show>

        <Show when={props.active === "messages"}>
          <Show when={props.messages.length > 0} fallback={<div class="db-grid-empty"><p>没有消息</p><small>执行后会记录成功、警告与错误</small></div>}>
            <ul class="db-messages">
              <For each={props.messages}>{message => (
                <li class={message.startsWith("错误") ? "is-error" : (message.startsWith("警告") || message.startsWith("已回滚")) ? "is-warn" : "is-ok"}>
                  <span class="db-message-time">{new Date().toLocaleTimeString()}</span>
                  <span>{message}</span>
                </li>
              )}</For>
            </ul>
          </Show>
        </Show>

        <Show when={props.active === "profile"}>
          <Show when={props.stats} fallback={<div class="db-grid-empty"><p>还没有执行统计</p><small>执行一次查询后这里会显示耗时与行数</small></div>}>
            <div class="db-profile">
              <div class="db-profile-card"><small>总耗时</small><strong>{props.stats!.elapsedMs} <em>ms</em></strong></div>
              <div class="db-profile-card"><small>返回行数</small><strong>{props.stats!.rows}</strong></div>
              <div class="db-profile-card"><small>影响行数</small><strong>{props.stats!.affectedRows}</strong></div>
              <div class="db-profile-card"><small>完成时间</small><strong>{new Date(props.stats!.finishedAt).toLocaleTimeString()}</strong></div>
              <div class="db-profile-statement">
                <small>执行的语句</small>
                <pre class="db-ddl is-inline">{props.stats!.statement}</pre>
              </div>
            </div>
          </Show>
        </Show>

        <Show when={props.active === "plan"}>
          <ExplainPanel explain={props.explain} loading={props.explaining} />
        </Show>
      </div>
    </div>
  );
};
