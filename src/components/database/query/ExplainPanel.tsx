import { Component, For, Show, createMemo, createSignal } from "solid-js";

type Props = {
  explain: { json_plan?: unknown; columns: string[]; rows: unknown[][]; message?: string } | null;
  loading: boolean;
};

type PlanNode = { label: string; detail: string; weight: number; warning?: boolean };

const FORMATS = [
  { key: "visual", label: "可视化" },
  { key: "text", label: "文本" },
  { key: "json", label: "JSON" },
] as const;

export const ExplainPanel: Component<Props> = props => {
  const [format, setFormat] = createSignal<typeof FORMATS[number]["key"]>("visual");

  const nodes = createMemo<PlanNode[]>(() => {
    const explain = props.explain;
    if (!explain) return [];
    if (explain.json_plan) return flattenJson(explain.json_plan);
    const header = explain.columns.map(item => item.toLowerCase());
    const tableIndex = header.findIndex(item => item === "table" || item.endsWith(".table"));
    const typeIndex = header.findIndex(item => item === "type" || item === "select_type");
    const rowsIndex = header.findIndex(item => item === "rows" || item.includes("rows"));
    const extraIndex = header.findIndex(item => item === "extra");
    return explain.rows.map(row => {
      const rows = rowsIndex >= 0 ? Number(row[rowsIndex]) : 0;
      const extra = extraIndex >= 0 ? String(row[extraIndex] ?? "") : "";
      const accessType = typeIndex >= 0 ? String(row[typeIndex] ?? "") : "";
      return {
        label: tableIndex >= 0 ? String(row[tableIndex] ?? "?") : "step",
        detail: [accessType, rowsIndex >= 0 ? `${rows} 行` : "", extra].filter(Boolean).join(" · "),
        weight: Number.isFinite(rows) ? rows : 0,
        // MySQL 的 type=ALL 与 PG 的 Seq Scan 都是全表扫描，需要显式标出
        warning: accessType.toUpperCase() === "ALL" || /seq scan|temporary|filesort/i.test(`${accessType} ${extra}`),
      };
    });
  });

  const maxWeight = () => Math.max(1, ...nodes().map(item => item.weight));

  const text = () => {
    const explain = props.explain;
    if (!explain) return "";
    if (explain.json_plan) return JSON.stringify(explain.json_plan, null, 2);
    const header = explain.columns.join("\t");
    const body = explain.rows.map(row => row.map(value => value === null ? "NULL" : String(value)).join("\t")).join("\n");
    return `${header}\n${body}`;
  };

  return (
    <div class="db-plan">
      <div class="db-plan-bar">
        <div class="db-seg" role="group" aria-label="执行计划格式">
          <For each={FORMATS}>{item => (
            <button class={format() === item.key ? "is-active" : ""} aria-pressed={format() === item.key} onClick={() => setFormat(item.key)}>{item.label}</button>
          )}</For>
        </div>
        <span class="db-toolbar-spacer" />
        <span class="db-status-item is-muted">{nodes().length} 个节点</span>
      </div>

      <Show when={!props.loading} fallback={<div class="db-grid-empty"><p>正在生成执行计划…</p></div>}>
        <Show when={props.explain} fallback={<div class="db-grid-empty"><p>还没有执行计划</p><small>点工具栏的「执行计划」查看优化器怎么跑这条 SQL</small></div>}>
          <Show when={!props.explain!.message} fallback={<p class="db-plan-message">{props.explain!.message}</p>}>
            <Show when={format() === "visual"}>
              <Show when={nodes().length > 0} fallback={<div class="db-grid-empty"><p>这份执行计划没有可可视化的节点</p><small>切到「文本」或「JSON」查看原始输出</small></div>}>
                <div class="db-plan-list">
                  <For each={nodes()}>{node => (
                    <div class={`db-plan-node ${node.warning ? "is-warning" : ""}`}>
                      <div class="db-plan-node-head">
                        <strong>{node.label}</strong>
                        <Show when={node.warning}><span class="db-plan-flag">全表扫描</span></Show>
                      </div>
                      <small>{node.detail}</small>
                      <div class="db-plan-track">
                        <span class="db-plan-fill" style={{ width: `${Math.max(4, Math.round((node.weight / maxWeight()) * 100))}%` }} />
                      </div>
                    </div>
                  )}</For>
                </div>
              </Show>
            </Show>
            <Show when={format() === "text"}><pre class="db-ddl is-inline">{text()}</pre></Show>
            <Show when={format() === "json"}><pre class="db-ddl is-inline">{JSON.stringify(props.explain!.json_plan ?? props.explain, null, 2)}</pre></Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

/** 把 PostgreSQL 的 JSON 计划压平成节点列表：顶层 Plan 递归，节点权重取 Total Cost */
const flattenJson = (value: unknown): PlanNode[] => {
  const nodes: PlanNode[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const plan = (record.Plan ?? record) as Record<string, unknown>;
    if (plan && typeof plan === "object" && "Node Type" in plan) {
      const cost = Number(plan["Total Cost"] ?? 0);
      const rows = Number(plan["Plan Rows"] ?? 0);
      nodes.push({
        label: String(plan["Node Type"] ?? "Node"),
        detail: [
          plan["Relation Name"] ? `表 ${plan["Relation Name"]}` : "",
          `${rows} 行`,
          `代价 ${cost}`,
          plan["Filter"] ? `过滤 ${plan["Filter"]}` : "",
          plan["Index Name"] ? `索引 ${plan["Index Name"]}` : "",
        ].filter(Boolean).join(" · "),
        weight: Number.isFinite(cost) ? cost : rows,
        warning: String(plan["Node Type"] ?? "").toLowerCase().includes("seq scan"),
      });
      const children = plan.Plans;
      if (Array.isArray(children)) children.forEach(walk);
    } else {
      for (const child of Object.values(record)) if (child && typeof child === "object") walk(child);
    }
  };
  walk(value);
  return nodes;
};
