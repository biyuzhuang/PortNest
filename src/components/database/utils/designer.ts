import type { DatabaseForeignKeyDefinition, DatabaseTableDefinition } from "../../../utils/api";

export type ChangeKind = "added" | "removed" | "changed";

export type FieldChange = {
  kind: ChangeKind;
  name: string;
  detail?: string;
};

export type TableDiff = {
  columns: FieldChange[];
  indexes: FieldChange[];
  foreignKeys: FieldChange[];
  total: number;
};

/**
 * 前端算 diff 只用于「变更」页的可读预览；真正执行仍以后端 `preview_table`
 * 返回的 DDL 为准，两边不一致时按后端算。
 */
export const computeTableDiff = (
  base: DatabaseTableDefinition | null | undefined,
  next: DatabaseTableDefinition,
): TableDiff => {
  if (!base) return { columns: [], indexes: [], foreignKeys: [], total: 0 };

  const columns: FieldChange[] = [];
  const beforeColumns = new Map(base.columns.map(item => [item.name, item]));
  for (const column of next.columns) {
    const previous = beforeColumns.get(column.name);
    if (!previous) { columns.push({ kind: "added", name: column.name, detail: column.column_type }); continue; }
    const differences: string[] = [];
    if (previous.column_type !== column.column_type) differences.push(`${previous.column_type} → ${column.column_type}`);
    if (previous.nullable !== column.nullable) differences.push(column.nullable ? "改为可空" : "改为非空");
    if ((previous.default_value ?? "") !== (column.default_value ?? "")) differences.push(`默认值 ${previous.default_value ?? "NULL"} → ${column.default_value ?? "NULL"}`);
    if (previous.auto_increment !== column.auto_increment) differences.push(column.auto_increment ? "加自增" : "去自增");
    if ((previous.comment || "") !== (column.comment || "")) differences.push("注释变更");
    if (differences.length > 0) columns.push({ kind: "changed", name: column.name, detail: differences.join("；") });
    beforeColumns.delete(column.name);
  }
  for (const name of beforeColumns.keys()) columns.push({ kind: "removed", name });

  const indexes: FieldChange[] = [];
  const beforeIndexes = new Map(base.indexes.map(item => [item.name, item]));
  for (const index of next.indexes) {
    const previous = beforeIndexes.get(index.name);
    const pattern = (value: typeof index) => value.columns.map(item => `${item.name}:${item.direction || "ASC"}`).join(",");
    if (!previous) { indexes.push({ kind: "added", name: index.name, detail: pattern(index) }); continue; }
    if (pattern(previous) !== pattern(index) || previous.kind !== index.kind) {
      indexes.push({ kind: "changed", name: index.name, detail: `${pattern(previous)} → ${pattern(index)}` });
    }
    beforeIndexes.delete(index.name);
  }
  for (const name of beforeIndexes.keys()) indexes.push({ kind: "removed", name });

  const foreignKeys: FieldChange[] = [];
  const beforeKeys = new Map((base.foreign_keys || []).map(item => [item.name, item]));
  // PostgreSQL 可以跨 schema 引用，比较时必须带上 schema
  const fkTarget = (value: DatabaseForeignKeyDefinition) =>
    (value.referenced_schema ? `${value.referenced_schema}.` : "") + value.referenced_table;
  for (const key of next.foreign_keys || []) {
    const previous = beforeKeys.get(key.name);
    if (!previous) { foreignKeys.push({ kind: "added", name: key.name, detail: `${key.columns.join(",")} → ${fkTarget(key)}(${key.referenced_columns.join(",")})` }); continue; }
    if (fkTarget(previous) !== fkTarget(key)
      || previous.columns.join(",") !== key.columns.join(",")
      || previous.referenced_columns.join(",") !== key.referenced_columns.join(",")
      || (previous.on_delete || "") !== (key.on_delete || "")) {
      foreignKeys.push({ kind: "changed", name: key.name, detail: `${fkTarget(previous)} → ${fkTarget(key)}` });
    }
    beforeKeys.delete(key.name);
  }
  for (const name of beforeKeys.keys()) foreignKeys.push({ kind: "removed", name });

  return {
    columns,
    indexes,
    foreignKeys,
    total: columns.length + indexes.length + foreignKeys.length,
  };
};

// ---------------------------------------------------------------------------
// 列类型拆分：设计器把 `varchar(128)`、`decimal(4,2)` 拆成「类型 / 长度 / 小数点」
// 三格编辑，写回时再拼回 column_type。enum / set 的括号里是取值列表，不能拆。
// ---------------------------------------------------------------------------

export type ColumnTypeParts = { base: string; length: string; scale: string };

const KEEP_WHOLE = /^(enum|set)\b/i;

export const parseColumnType = (columnType: string): ColumnTypeParts => {
  const raw = (columnType || "").trim();
  const match = /^([^(]+?)\s*\(([^)]*)\)\s*(.*)$/.exec(raw);
  if (!match) return { base: raw, length: "", scale: "" };
  const base = `${match[1].trim()}${match[3] ? ` ${match[3].trim()}` : ""}`;
  const inner = match[2].trim();
  if (KEEP_WHOLE.test(base) || inner.includes("'")) return { base: raw, length: "", scale: "" };
  const [length, scale] = inner.split(",").map(item => item.trim());
  return { base, length: length ?? "", scale: scale ?? "" };
};

export const composeColumnType = (parts: ColumnTypeParts): string => {
  const base = parts.base.trim() || "varchar";
  if (!parts.length.trim()) return base;
  const scale = parts.scale.trim();
  return `${base}(${parts.length.trim()}${scale ? `,${scale}` : ""})`;
};

/** 常用类型，给类型列的 datalist 用；与协议无关的通用子集 */
export const COMMON_COLUMN_TYPES = [
  "bigint", "int", "smallint", "tinyint", "mediumint",
  "decimal", "numeric", "float", "double",
  "varchar", "char", "text", "mediumtext", "longtext",
  "date", "datetime", "timestamp", "time", "year",
  "boolean", "json", "uuid", "bytea", "blob",
];
