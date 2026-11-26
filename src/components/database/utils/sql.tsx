import { For } from "solid-js";

/**
 * 轻量 SQL 着色：只区分关键字 / 字符串 / 引号标识符 / 数字 / 注释，
 * 不做语法分析。设计器的「SQL 预览」用它把生成的 DDL 显示得像代码，
 * 真正的编辑器（查询页）另有实现。
 */

type TokenKind = "kw" | "str" | "ident" | "num" | "cmt" | "plain";

type Token = { text: string; kind: TokenKind };

const KEYWORDS = new Set([
  "ADD", "AFTER", "ALWAYS", "ALTER", "AND", "AS", "ASC", "AUTO_INCREMENT",
  "BIGINT", "BLOB", "BOOLEAN", "BOOL", "BY", "CASCADE", "CHANGE", "CHAR", "CHARSET",
  "COLLATE", "COLUMN", "COMMENT", "CONSTRAINT", "CREATE", "CURRENT_TIMESTAMP",
  "DATABASE", "DATE", "DATETIME", "DECIMAL", "DEFAULT", "DELETE", "DESC", "DOUBLE",
  "DROP", "ENGINE", "ENUM", "EXISTS", "FLOAT", "FOREIGN", "FROM", "FULLTEXT",
  "GENERATED", "IDENTITY", "IF", "INCREMENT", "INDEX", "INSERT", "INT", "INTEGER",
  "INTO", "JSON", "KEY", "LONG", "MEDIUMINT", "MEDIUMTEXT", "MODIFY", "NO", "NOT",
  "NULL", "NUMERIC", "OFFSET", "ON", "OPTIONS", "OR", "PRIMARY", "REFERENCES",
  "RENAME", "RESTRICT", "SCHEMA", "SERIAL", "SET", "SMALLINT", "START", "STORED",
  "TABLE", "TEXT", "TIME", "TIMESTAMP", "TINYINT", "TO", "TRIGGER", "TRUNCATE",
  "UNIQUE", "UNSIGNED", "UPDATE", "USING", "UUID", "VALUES", "VARBINARY",
  "VARCHAR", "VIEW", "VIRTUAL", "WITH", "YEAR", "ZEROFILL",
]);

const WORD_START = /[A-Za-z_@$]/;
const WORD_PART = /[A-Za-z0-9_$]/;

const tokenize = (sql: string): Token[] => {
  const tokens: Token[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      tokens.push({ text: buffer, kind: "plain" });
      buffer = "";
    }
  };

  while (i < sql.length) {
    const char = sql[i];

    // -- 行注释
    if (char === "-" && sql[i + 1] === "-") {
      flush();
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      tokens.push({ text: sql.slice(i, stop), kind: "cmt" });
      i = stop;
      continue;
    }

    // /* 块注释 */
    if (char === "/" && sql[i + 1] === "*") {
      flush();
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      tokens.push({ text: sql.slice(i, stop), kind: "cmt" });
      i = stop;
      continue;
    }

    // '文字' 与 "标识符"，两者都按引号包起来整体跳过
    if (char === "'" || char === '"') {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === char) {
          if (sql[j + 1] === char) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      const stop = Math.min(j, sql.length);
      tokens.push({ text: sql.slice(i, stop), kind: char === "'" ? "str" : "ident" });
      i = stop;
      continue;
    }

    // `反引号标识符`
    if (char === "`") {
      flush();
      const end = sql.indexOf("`", i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      tokens.push({ text: sql.slice(i, stop), kind: "ident" });
      i = stop;
      continue;
    }

    // 数字
    if (/[0-9]/.test(char)) {
      flush();
      let j = i;
      while (j < sql.length && /[0-9.eE]/.test(sql[j])) j += 1;
      tokens.push({ text: sql.slice(i, j), kind: "num" });
      i = j;
      continue;
    }

    // 单词 → 关键字或普通标识符
    if (WORD_START.test(char)) {
      flush();
      let j = i;
      while (j < sql.length && WORD_PART.test(sql[j])) j += 1;
      const word = sql.slice(i, j);
      tokens.push({ text: word, kind: KEYWORDS.has(word.toUpperCase()) ? "kw" : "plain" });
      i = j;
      continue;
    }

    buffer += char;
    i += 1;
  }

  flush();
  return tokens;
};

export const SqlCode = (props: { sql: string }) => (
  <For each={tokenize(props.sql)}>
    {token => (token.kind === "plain" ? <>{token.text}</> : <span class={`sql-${token.kind}`}>{token.text}</span>)}
  </For>
);
