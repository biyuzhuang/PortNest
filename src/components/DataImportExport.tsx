import { Component, createSignal, Show } from "solid-js";
import { api, ConnectionRecord } from "../utils/api";
import "./DataImportExport.css";

interface DataImportExportProps {
  connection: ConnectionRecord;
  onClose?: () => void;
}

export const DataImportExport: Component<DataImportExportProps> = (props) => {
  const [mode, setMode] = createSignal<"import" | "export">("import");
  const [tableName, setTableName] = createSignal("");
  const [sqlPreview, setSqlPreview] = createSignal("");
  const [importData, setImportData] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [result, setResult] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const handleImport = async () => {
    const table = tableName();
    const data = importData();

    if (!table.trim()) {
      setError("请输入表名");
      return;
    }

    if (!data.trim()) {
      setError("请输入要导入的数据");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Parse CSV data
      const lines = data.trim().split("\n");
      if (lines.length < 2) {
        throw new Error("数据格式错误，需要包含表头和至少一行数据");
      }

      const headers = lines[0].split(",").map(h => h.trim());
      const values = lines.slice(1).map(line => {
        return line.split(",").map(v => v.trim());
      });

      // Build INSERT statement
      const columns = headers.join(", ");
      const placeholders = headers.map(() => "?").join(", ");
      const sql = `INSERT INTO ${table} (${columns}) VALUES \n${values.map(v => `(${placeholders})`).join(", \n")}`;

      setSqlPreview(sql);

      // Execute the insert
      const result = await api.executeQuery(props.connection.id, sql);
      setResult(`成功导入 ${result.affected_rows} 行数据`);
    } catch (e) {
      setError("导入失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    const table = tableName();

    if (!table.trim()) {
      setError("请输入表名");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const queryResult = await api.executeQuery(props.connection.id, `SELECT * FROM ${table} LIMIT 1000`);

      // Convert to CSV
      const headers = queryResult.columns.join(", ");
      const rows = queryResult.rows.map(row =>
        row.values.map(v => {
          if (v === null) return "";
          if (typeof v === "string" && v.includes(",")) {
            return `"${v.replace(/"/g, '""')}"`;
          }
          return String(v);
        }).join(", ")
      );

      const csv = [headers, ...rows].join("\n");
      setImportData(csv);
      setResult(`成功导出 ${queryResult.rows.length} 行数据`);
    } catch (e) {
      setError("导出失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    const data = importData();
    if (!data) return;

    const blob = new Blob([data], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tableName() || "export"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="data-import-export">
      <div class="import-export-header">
        <h3>数据导入导出</h3>
        <div class="mode-tabs">
          <button
            class={`mode-tab ${mode() === "import" ? "active" : ""}`}
            onClick={() => setMode("import")}
          >
            导入
          </button>
          <button
            class={`mode-tab ${mode() === "export" ? "active" : ""}`}
            onClick={() => setMode("export")}
          >
            导出
          </button>
        </div>
      </div>

      <div class="import-export-content">
        <div class="form-group">
          <label>表名</label>
          <input
            type="text"
            placeholder="输入表名"
            value={tableName()}
            onInput={(e) => setTableName(e.currentTarget.value)}
          />
        </div>

        <Show when={mode() === "import"}>
          <div class="form-group">
            <label>CSV 数据格式：每行一条记录，逗号分隔</label>
            <textarea
              class="data-textarea"
              placeholder={`name,email,age\n张三,zhangsan@example.com,25\n李四,lisi@example.com,30`}
              value={importData()}
              onInput={(e) => setImportData(e.currentTarget.value)}
              rows={10}
            />
          </div>

          <Show when={sqlPreview()}>
            <div class="form-group">
              <label>生成的 SQL 预览</label>
              <pre class="sql-preview">{sqlPreview()}</pre>
            </div>
          </Show>

          <button
            class="btn-primary"
            onClick={handleImport}
            disabled={loading()}
          >
            {loading() ? "导入中..." : "执行导入"}
          </button>
        </Show>

        <Show when={mode() === "export"}>
          <div class="form-group">
            <label>导出数据预览</label>
            <textarea
              class="data-textarea"
              readonly
              value={importData()}
              placeholder="点击“导出数据”按钮获取数据"
              rows={10}
            />
          </div>

          <div class="export-actions">
            <button
              class="btn-primary"
              onClick={handleExport}
              disabled={loading()}
            >
              {loading() ? "导出中..." : "导出数据"}
            </button>
            <Show when={importData()}>
              <button class="btn-secondary" onClick={downloadCsv}>
                下载 CSV
              </button>
            </Show>
          </div>
        </Show>

        <Show when={error()}>
          <div class="error-message">{error()}</div>
        </Show>

        <Show when={result()}>
          <div class="success-message">{result()}</div>
        </Show>
      </div>
    </div>
  );
};
