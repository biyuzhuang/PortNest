import { Component, For, Show } from "solid-js";
import { Icon } from "./Icon";
import type { DbTestReport, DbTestStage, DbTestStageStatus } from "../utils/api";

/**
 * 数据库「测试连接」结果面板。
 *
 * 一次探测拆成 DNS → TCP → TLS → 认证 → 服务器信息 五个阶段，逐行展示耗时与
 * 建议。失败时保留已完成阶段，方便直接看出是哪一跳断了。
 */

const STAGE_ICON: Record<DbTestStageStatus, "check" | "alert" | "close" | "chevronRight"> = {
  ok: "check",
  warn: "alert",
  failed: "close",
  skipped: "chevronRight",
};

const stageClass = (status: DbTestStageStatus) => `db-report-stage is-${status}`;

const summarize = (report: DbTestReport): string => {
  if (report.ok) {
    const latency = report.rtt_ms > 0 ? ` · ${report.rtt_ms}ms` : "";
    return `可用${latency}`;
  }
  const failed = report.stages.find(stage => stage.status === "failed");
  return failed ? `${failed.label}失败` : "不可用";
};

interface Props {
  report: DbTestReport;
}

export const TestReportPanel: Component<Props> = props => (
  <section class={`db-report ${props.report.ok ? "is-ok" : "is-failed"}`}>
    <header class="db-report-head">
      <span class="db-report-status">
        <Icon name={props.report.ok ? "check" : "close"} size={14} />
        <span>{summarize(props.report)}</span>
      </span>
      <Show when={props.report.server_version}>
        <span class="db-report-version mono">{props.report.server_version}</span>
      </Show>
    </header>

    <ol class="db-report-stages">
      <For each={props.report.stages}>
        {(stage: DbTestStage) => (
          <li class={stageClass(stage.status)}>
            <span class="db-report-stage-icon">
              <Icon name={STAGE_ICON[stage.status]} size={13} />
            </span>
            <span class="db-report-stage-label">{stage.label}</span>
            <span class="db-report-stage-detail mono">
              {stage.detail || (stage.status === "skipped" ? "未执行" : "")}
            </span>
            <span class="db-report-stage-time mono">
              {stage.duration_ms > 0 ? `${stage.duration_ms}ms` : ""}
            </span>
            <Show when={stage.hint}>
              <p class="db-report-stage-hint">{stage.hint}</p>
            </Show>
          </li>
        )}
      </For>
    </ol>

    <Show when={props.report.warnings.length > 0}>
      <ul class="db-report-warnings">
        <For each={props.report.warnings}>
          {warning => (
            <li>
              <Icon name="alert" size={13} />
              <span>{warning}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>

    <Show when={props.report.error_message}>
      <div class="db-report-error">
        <p class="db-report-error-message">{props.report.error_message}</p>
        <Show when={props.report.error_hint}>
          <p class="db-report-error-hint">{props.report.error_hint}</p>
        </Show>
        <Show when={props.report.error_code}>
          <code class="db-report-error-code">{props.report.error_code}</code>
        </Show>
      </div>
    </Show>
  </section>
);
