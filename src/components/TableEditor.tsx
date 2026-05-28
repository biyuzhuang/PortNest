import { Component, createSignal, For, Show } from "solid-js";
import { api, ConnectionRecord } from "../utils/api";
import "./TableEditor.css";

interface TableEditorProps {
  connection: ConnectionRecord;
  tableName: string;
}

export const TableEditor: Component<TableEditorProps> = (props) => {
  const [data, setData] = createSignal<{ columns: string[]; rows: Array<{ values: any[] }> }>({
    columns: [],
    rows: [],
  });
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [editRowIndex, setEditRowIndex] = createSignal<number | null>(null);
  const [editValues, setEditValues] = createSignal<any[]>([]);
  const [hasChanges, setHasChanges] = createSignal(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.executeQuery(props.connection.id, `SELECT * FROM ${props.tableName}`);
      setData(result);
      setHasChanges(false);
    } catch (e) {
      setError("加载数据失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (rowIndex: number) => {
    const row = data().rows[rowIndex];
    setEditRowIndex(rowIndex);
    setEditValues([...row.values]);
  };

  const cancelEdit = () => {
    setEditRowIndex(null);
    setEditValues([]);
  };

  const saveEdit = async () => {
    const rowIndex = editRowIndex();
    if (rowIndex === null) return;

    const row = data().rows[rowIndex];
    const columns = data().columns;

    // Build UPDATE statement
    const sets = columns.map((col, i) => `${col} = ?`).join(", ");
    const sql = `UPDATE ${props.tableName} SET ${sets} WHERE ${columns[0]} = ?`;

    const values = [...editValues];
    const primaryValue = row.values[0];

    setLoading(true);
    try {
      await api.executeQuery(props.connection.id, sql);
      setEditRowIndex(null);
      setEditValues([]);
      await loadData();
    } catch (e) {
      setError("保存失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const deleteRow = async (rowIndex: number) => {
    if (!confirm("确定删除这条记录吗？")) return;

    const row = data().rows[rowIndex];
    const columns = data().columns;
    const primaryColumn = columns[0];
    const primaryValue = row.values[0];

    const sql = `DELETE FROM ${props.tableName} WHERE ${primaryColumn} = '${primaryValue}'`;

    setLoading(true);
    try {
      await api.executeQuery(props.connection.id, sql);
      await loadData();
    } catch (e) {
      setError("删除失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const insertRow = async () => {
    const columns = data().columns;
    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${props.tableName} (${columns.join(", ")}) VALUES (${placeholders})`;

    setLoading(true);
    try {
      await api.executeQuery(props.connection.id, sql);
      await loadData();
    } catch (e) {
      setError("插入失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const formatValue = (value: any): string => {
    if (value === null) return "NULL";
    if (value === undefined) return "";
    return String(value);
  };

  return (
    <div class="table-editor">
      <div class="table-editor-header">
        <h3>编辑表: {props.tableName}</h3>
        <div class="table-actions">
          <button class="btn-reload" onClick={loadData}>刷新</button>
          <button class="btn-insert" onClick={insertRow}>插入行</button>
        </div>
      </div>

      <Show when={error()}>
        <div class="error-banner">{error()}</div>
      </Show>

      <div class="table-wrapper">
        <Show when={loading()}>
          <div class="loading-overlay">
            <span>加载中...</span>
          </div>
        </Show>

        <table class="data-table">
          <thead>
            <tr>
              <th class="row-actions">操作</th>
              <For each={data().columns}>
                {(col) => <th>{col}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={data().rows}>
              {(row, rowIndex) => (
                <Show
                  when={editRowIndex() === rowIndex()}
                  fallback={
                    <tr>
                      <td class="row-actions">
                        <button class="btn-edit" onClick={() => startEdit(rowIndex())}>编辑</button>
                        <button class="btn-delete" onClick={() => deleteRow(rowIndex())}>删除</button>
                      </td>
                      <For each={row.values}>
                        {(value) => (
                          <td class={value === null ? "null-value" : ""}>
                            {formatValue(value)}
                          </td>
                        )}
                      </For>
                    </tr>
                  }
                >
                  <tr class="editing-row">
                    <td class="row-actions">
                      <button class="btn-save" onClick={saveEdit}>保存</button>
                      <button class="btn-cancel" onClick={cancelEdit}>取消</button>
                    </td>
                    <For each={row.values}>
                      {(value, colIndex) => (
                        <td>
                          <input
                            type="text"
                            class="edit-input"
                            value={editValues()[colIndex()] ?? ""}
                            onInput={(e) => {
                              const newValues = [...editValues()];
                              newValues[colIndex()] = e.currentTarget.value;
                              setEditValues(newValues);
                            }}
                          />
                        </td>
                      )}
                    </For>
                  </tr>
                </Show>
              )}
            </For>
          </tbody>
        </table>

        <Show when={data().rows.length === 0 && !loading()}>
          <div class="empty-table">表中暂无数据</div>
        </Show>
      </div>
    </div>
  );
};