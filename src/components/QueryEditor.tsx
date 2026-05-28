import { Component, createSignal, For, Show } from "solid-js";
import { api, ConnectionRecord, QueryResult } from "../utils/api";

interface QueryEditorProps {
  connection: ConnectionRecord;
}

export const QueryEditor: Component<QueryEditorProps> = (props) => {
  const [sql, setSql] = createSignal("SELECT 1");
  const [result, setResult] = createSignal<QueryResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);

  const executeQuery = async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await api.executeQuery(props.connection.id, sql());
      setResult(res);
    } catch (e) {
      setError("查询失败: " + e);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div class="query-editor">
      <div class="query-toolbar">
        <span class="query-title">
          {props.connection.name} ({props.connection.protocol})
        </span>
        <button class="btn-execute" onClick={executeQuery} disabled={isLoading()}>
          {isLoading() ? "执行中..." : "执行 (Ctrl+Enter)"}
        </button>
      </div>

      <div class="query-input-container">
        <textarea
          class="query-input"
          value={sql()}
          onInput={(e) => setSql(e.currentTarget.value)}
          placeholder="输入 SQL 查询语句..."
          rows={5}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "Enter") {
              executeQuery();
            }
          }}
        />
      </div>

      <Show when={error()}>
        <div class="query-error">{error()}</div>
      </Show>

      <Show when={result()}>
        <div class="query-result-info">
          <span>查询耗时: {result()!.execution_time_ms}ms</span>
          <span>返回 {result()!.rows.length} 行</span>
        </div>

        <div class="query-result-table-container">
          <table class="query-result-table">
            <thead>
              <tr>
                <For each={result()!.columns}>
                  {(col) => <th>{col}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={result()!.rows}>
                {(row) => (
                  <tr>
                    <For each={row.values}>
                      {(cell) => <td>{cell === null ? "NULL" : String(cell)}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={!result() && !error() && !isLoading()}>
        <div class="query-placeholder">
          点击"执行"按钮运行查询
        </div>
      </Show>
    </div>
  );
};