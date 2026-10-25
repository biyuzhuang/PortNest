/**
 * 轻量 SQL 美化工具。
 *
 * 只调整关键字大小写、换行和缩进，不改写字符串、注释和引号标识符中的内容。
 */

const MASK_PATTERN = /'(?:''|\\[\s\S]|[^'\\])*'|"(?:""|\\[\s\S]|[^"\\])*"|`(?:``|[^`])*`|--(?=\s|$)[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\//g;

const KEYWORDS = [
  "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN", "NATURAL JOIN",
  "GROUP BY", "ORDER BY", "UNION ALL", "INSERT INTO", "DELETE FROM", "REPLACE INTO",
  "SELECT", "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "UNION", "INSERT",
  "UPDATE", "DELETE", "REPLACE", "VALUES", "SET", "RETURNING", "WITH", "CREATE",
  "ALTER", "DROP", "TRUNCATE", "JOIN", "STRAIGHT_JOIN", "ON", "USING", "AND",
  "OR", "NOT", "IS", "NULL", "IN", "LIKE", "BETWEEN", "EXISTS", "CASE", "WHEN",
  "THEN", "ELSE", "END", "AS", "ASC", "DESC", "DISTINCT", "GROUP", "ORDER", "BY",
  "INTO", "TABLE", "TABLES", "VIEW", "INDEX", "KEY", "PRIMARY", "FOREIGN",
  "REFERENCES", "UNIQUE", "CHECK", "DEFAULT", "CONSTRAINT", "ADD", "COLUMN",
  "DATABASE", "DATABASES", "SHOW", "DESCRIBE", "EXPLAIN", "USE", "START",
  "TRANSACTION", "COMMIT", "ROLLBACK", "TRUE", "FALSE", "FIRST", "LAST",
  "IGNORE", "AUTO_INCREMENT", "IF",
];

const BREAK_BEFORE = [
  "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN", "NATURAL JOIN",
  "GROUP BY", "ORDER BY", "UNION ALL", "INSERT INTO", "DELETE FROM", "REPLACE INTO",
  "SELECT", "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "UNION", "INSERT",
  "UPDATE", "DELETE", "REPLACE", "VALUES", "SET", "RETURNING", "WITH", "CREATE",
  "ALTER", "DROP", "TRUNCATE", "JOIN", "STRAIGHT_JOIN", "ON", "USING", "AND", "OR",
];

const INDENTED_KEYWORDS = new Set(["JOIN", "STRAIGHT_JOIN", "ON", "USING", "AND", "OR"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(keyword: string): string {
  return keyword.split(/\s+/).map(escapeRegExp).join("\\s+");
}

function formatKeywords(text: string): string {
  const pattern = KEYWORDS.map(keywordPattern).join("|");
  return text.replace(new RegExp(`\\b(?:${pattern})\\b`, "gi"), value => value.toUpperCase());
}

function breakClauses(text: string, indent: string): string {
  const pattern = BREAK_BEFORE.map(keywordPattern).join("|");
  return text.replace(new RegExp(`\\s+(${pattern})\\b`, "g"), (_match, value: string) => {
    const keyword = value.replace(/\s+/g, " ");
    const prefix = INDENTED_KEYWORDS.has(keyword) ? indent : "";
    return `\n${prefix}${keyword}`;
  });
}

function maskSegments(sql: string): { masked: string; segments: string[] } {
  const segments: string[] = [];
  const masked = sql.replace(MASK_PATTERN, segment => {
    const index = segments.length;
    segments.push(segment);
    return `\uE000${index}\uE001`;
  });
  return { masked, segments };
}

/**
 * 将 SQL 格式化为易读的多行文本。
 *
 * @param sql 原始 SQL
 * @param indent 每级缩进字符串，默认两个空格
 */
export function formatSql(sql: string, indent = "  "): string {
  if (!sql.trim()) return "";

  const { masked, segments } = maskSegments(sql);
  let text = masked.replace(/\s+/g, " ").trim();

  // 统一逗号、点和括号周围的空白。
  text = text.replace(/\s*,\s*/g, ", ");
  text = text.replace(/\s*\.\s*/g, ".");
  text = text.replace(/\s*\(\s*/g, "(");
  text = text.replace(/\s+\)/g, ")");

  text = formatKeywords(text);
  text = breakClauses(text, indent);
  text = text.replace(/\s*;\s*/g, ";\n");

  // 恢复字符串、注释和反引号标识符。行注释后强制换行，避免吞掉后续 SQL。
  text = text.replace(/\uE000(\d+)\uE001/g, (_match, value: string) => {
    const segment = segments[Number(value)] ?? "";
    return segment.startsWith("--") || segment.startsWith("#") ? `${segment}\n` : segment;
  });

  return text
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}