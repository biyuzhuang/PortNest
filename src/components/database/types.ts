import type {
  DatabaseColumnInfo,
  DatabaseIndexInfo,
  DatabaseTableDefinition,
  DatabaseTableInfo,
  QueryResult,
  StatementOutcome,
} from "../../utils/api";

/** 表页的四段视图：数据 / 结构 / 设计 / 导入导出 */
export type TableSection = "data" | "structure" | "design" | "transfer";

/** 对象面板的三种显示方式，对齐 Navicat 的 List / Detail / Icons */
export type ObjectView = "list" | "detail" | "icons";

/** 表数据区的两种呈现：网格 / 单记录表单 */
export type DataView = "grid" | "form";

export type SortDirection = "asc" | "desc";
export type SortOrder = { column: string; direction: SortDirection };

/**
 * 筛选操作符。后端按同一份白名单做 match，两边必须同步改动。
 */
export type FilterOperator =
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "is_null"
  | "is_not_null";

export type FilterCondition = {
  column: string;
  operator: FilterOperator;
  value: string;
  /** 仅 between 使用 */
  value2?: string;
};

export type FilterSpec = {
  conjunction: "and" | "or";
  conditions: FilterCondition[];
};

export const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string; arity: 0 | 1 | 2 }> = [
  { value: "contains", label: "包含", arity: 1 },
  { value: "not_contains", label: "不包含", arity: 1 },
  { value: "starts_with", label: "开头是", arity: 1 },
  { value: "ends_with", label: "结尾是", arity: 1 },
  { value: "eq", label: "等于", arity: 1 },
  { value: "ne", label: "不等于", arity: 1 },
  { value: "gt", label: "大于", arity: 1 },
  { value: "gte", label: "大于等于", arity: 1 },
  { value: "lt", label: "小于", arity: 1 },
  { value: "lte", label: "小于等于", arity: 1 },
  { value: "between", label: "介于", arity: 2 },
  { value: "is_null", label: "为 NULL", arity: 0 },
  { value: "is_not_null", label: "不为 NULL", arity: 0 },
];

export const operatorLabel = (operator: FilterOperator) =>
  FILTER_OPERATORS.find(item => item.value === operator)?.label ?? operator;

export const operatorArity = (operator: FilterOperator) =>
  FILTER_OPERATORS.find(item => item.value === operator)?.arity ?? 1;

export const emptyFilterSpec = (): FilterSpec => ({ conjunction: "and", conditions: [] });

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------

export type DatabaseTab = {
  id: string;
  kind: "database";
  title: string;
  database: string;
  view: ObjectView;
  /** 详情视图下正在查看的表 */
  detailTable?: string;
};

export type QueryResultPane = {
  id: string;
  label: string;
  sql: string;
  result: QueryResult | null;
};

export type QueryTab = {
  id: string;
  kind: "query";
  title: string;
  database: string;
  sql: string;
  result: QueryResult | null;
  /** 批量执行的逐条结果；单条语句时长度也是 1 */
  results?: StatementOutcome[];
  /** 当前选中的结果序号（对应 StatementOutcome.index） */
  activeResult?: number;
  /** 上一次批量执行的事务结果，用于提示是否已回滚 */
  batch?: { transaction: string; partial: boolean; error: string | null } | null;
  dirty: boolean;
  /** 编辑器高度，切标签不丢 */
  editorHeight?: number;
  /** 上一次执行的统计，供「概况」页使用 */
  stats?: QueryStats;
};

export type QueryStats = {
  elapsedMs: number;
  rows: number;
  affectedRows: number;
  statement: string;
  finishedAt: number;
  error?: string;
};

/** 待提交变更集：提到标签上，切走再切回不丢 */
export type PendingChanges = {
  inserted: Array<{ id: number; values: Record<string, unknown> }>;
  /** key 为行标识（主键值或行索引字符串） */
  updates: Record<string, { values: Record<string, unknown>; original: Record<string, unknown> }>;
  deletes: Record<string, true>;
  selected: Record<string, true>;
};

export const emptyPending = (): PendingChanges => ({ inserted: [], updates: {}, deletes: {}, selected: {} });

export type TableTab = {
  id: string;
  kind: "table";
  title: string;
  database: string;
  table: string;
  section: TableSection;
  dataView: DataView;
  page: number;
  pageSize: number;
  orders: SortOrder[];
  filters: FilterSpec;
  columns: DatabaseColumnInfo[];
  indexes: DatabaseIndexInfo[];
  rows: QueryResult | null;
  designer: DatabaseTableDefinition | null;
  /** 进入设计器时的快照，用于「变更」页算 diff */
  designerBase?: DatabaseTableDefinition | null;
  preview: string[];
  dirty: boolean;
  isNew?: boolean;
  pending: PendingChanges;
  /** 主键列名，空数组表示无主键（编辑需禁用） */
  primaryKey: string[];
  /** 列宽，按表持久化到 localStorage */
  columnWidths: Record<string, number>;
};

export type WorkspaceTab = DatabaseTab | QueryTab | TableTab;

export type ContextMenuState = {
  x: number;
  y: number;
  kind: "workspace" | "database" | "table";
  database?: string;
  table?: string;
};

export type DdlView = { database: string; table: string; sql: string } | null;

export const DB_PAGE_SIZES = [50, 100, 200, 500];

/** 对象列表面板的列定义；数字列由 .is-numeric 决定右对齐与等宽数字 */
export const objectListColumns: Array<{ key: string; label: string; numeric?: boolean }> = [
  { key: "name", label: "名称" },
  { key: "comment", label: "注释" },
  { key: "rows", label: "预估行数", numeric: true },
  { key: "data_length", label: "数据长度", numeric: true },
  { key: "index_length", label: "索引长度", numeric: true },
  { key: "auto_increment", label: "自增", numeric: true },
  { key: "engine", label: "引擎" },
  { key: "collation", label: "编码" },
  { key: "updated_at", label: "更新时间" },
  { key: "created_at", label: "创建时间" },
];

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export const cellText = (value: unknown) =>
  value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);

export const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

export const cellInputText = (value: unknown) =>
  value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);

export const isNullValue = (value: unknown) => value === null || value === undefined;

/** 把输入框文本按原值类型还原；"NULL" 一律还原成 null */
export const parseCellValue = (raw: string, original: unknown): unknown => {
  if (raw.trim().toUpperCase() === "NULL") return null;
  if (typeof original === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (typeof original === "boolean") return raw.trim().toLowerCase() === "true";
  if (original !== null && typeof original === "object") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
};

/** CSV 转义；同时防止 Excel 公式注入（= + - @ 开头加单引号） */
export const csvCell = (value: unknown) => {
  if (value === null) return "\\N";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};

const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "object") return quoteSql(JSON.stringify(value));
  return quoteSql(String(value));
};

const quoteSql = (text: string) => "'" + text.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";

const identifier = (name: string) => "`" + name.replace(/`/g, "``") + "`";

/** 复制为 INSERT：NULL 输出 NULL 而不是字符串 'NULL' */
export const rowToInsertSql = (table: string, columns: string[], values: unknown[]) =>
  `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")});`;

/** 复制为 UPDATE：以主键或首列作为 WHERE 条件 */
export const rowToUpdateSql = (
  table: string,
  columns: string[],
  values: unknown[],
  keyColumns: string[],
) => {
  const keys = keyColumns.length > 0 ? keyColumns : columns.slice(0, 1);
  const assignments = columns
    .filter(name => !keys.includes(name))
    .map(name => `${identifier(name)} = ${sqlLiteral(values[columns.indexOf(name)])}`);
  const where = keys.map(name => `${identifier(name)} = ${sqlLiteral(values[columns.indexOf(name)])}`);
  return `UPDATE ${identifier(table)} SET ${assignments.join(", ")} WHERE ${where.join(" AND ")};`;
};

export const rowToJson = (columns: string[], values: unknown[]) => {
  const record: Record<string, unknown> = {};
  columns.forEach((name, index) => { record[name] = values[index]; });
  return JSON.stringify(record, null, 2);
};

export const formatBytes = (value?: number | null) =>
  value == null ? "—" : value < 1024 ? `${value}B` : value < 1048576 ? `${(value / 1024).toFixed(1)}KB` : `${(value / 1048576).toFixed(1)}MB`;

export const tableCount = (tables: DatabaseTableInfo[] | undefined, kind: "BASE TABLE" | "VIEW") =>
  (tables || []).filter(item => item.kind === kind).length;

export const blankDesigner = (database: string): DatabaseTableDefinition => ({
  database,
  name: "new_table",
  engine: "InnoDB",
  charset: "utf8mb4",
  comment: "",
  columns: [{ name: "id", column_type: "BIGINT", nullable: false, auto_increment: true, comment: "" }],
  indexes: [{ name: "PRIMARY", kind: "PRIMARY", columns: [{ name: "id", direction: "ASC" }] }],
});

/** 从列信息推断主键列（key === "PRI"） */
export const primaryKeyColumns = (columns: DatabaseColumnInfo[]) =>
  columns.filter(item => item.key === "PRI").map(item => item.name);
