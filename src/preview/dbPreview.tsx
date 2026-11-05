/**
 * 数据库工作区的浏览器预览入口（仅开发用，不进生产构建）。
 *
 * 目的：在不开 Tauri 的前提下，用假数据把真实组件渲染出来，做视觉回归与截图。
 * 用法：npm run dev 后打开 /db-preview.html#table
 */
import "../styles/tokens.css";
import { render } from "solid-js/web";
import { DatabaseWorkspace } from "../components/database/DatabaseWorkspace";
import type { ConnectionRecord } from "../utils/api";

const COLUMNS = [
  { name: "film_id", data_type: "smallint", column_type: "smallint unsigned", nullable: false, default_value: undefined, extra: "auto_increment", comment: "", key: "PRI", ordinal: 1 },
  { name: "title", data_type: "varchar", column_type: "varchar(255)", nullable: false, default_value: undefined, extra: "", comment: "片名", key: "MUL", ordinal: 2 },
  { name: "description", data_type: "text", column_type: "text", nullable: true, default_value: undefined, extra: "", comment: "", key: "", ordinal: 3 },
  { name: "release_year", data_type: "year", column_type: "year", nullable: true, default_value: undefined, extra: "", comment: "", key: "", ordinal: 4 },
  { name: "rental_rate", data_type: "decimal", column_type: "decimal(4,2)", nullable: false, default_value: "4.99", extra: "", comment: "", key: "", ordinal: 5 },
  { name: "length", data_type: "smallint", column_type: "smallint unsigned", nullable: true, default_value: undefined, extra: "", comment: "时长（分钟）", key: "", ordinal: 6 },
  { name: "rating", data_type: "enum", column_type: "enum('G','PG','PG-13','R','NC-17')", nullable: true, default_value: "G", extra: "", comment: "", key: "", ordinal: 7 },
  { name: "last_update", data_type: "timestamp", column_type: "timestamp", nullable: false, default_value: "CURRENT_TIMESTAMP", extra: "on update CURRENT_TIMESTAMP", comment: "", key: "", ordinal: 8 },
];

const TITLES: Array<[string, string, number, number, number, string]> = [
  ["ACADEMY DINOSAUR", "A Epic Drama of a Feminist And a Mad Scientist", 2006, 0.99, 86, "PG"],
  ["ACE GOLDFINGER", "A Astounding Epistle of a Database Administrator", 2006, 4.99, 48, "G"],
  ["ADAPTATION HOLES", "A Astounding Reflection of a Lumberjack And a Car", 2006, 2.99, 50, "NC-17"],
  ["AFFAIR PREJUDICE", "A Fanciful Documentary of a Frisbee And a Lumberjack", 2006, 2.99, 117, "G"],
  ["AFRICAN EGG", "A Fast-Paced Documentary of a Pastry Chef", 2006, 2.99, 130, "G"],
  ["AGENT TRUMAN", "A Intrepid Panorama of a Robot And a Boy", 2006, 2.99, 169, "PG"],
  ["AIRPLANE SIERRA", "A Touching Saga of a Hunter And a Butler", 2006, 4.99, 62, "PG-13"],
  ["AIRPORT POLLOCK", "A Epic Tale of a Moose And a Girl", 2006, 4.99, 54, "R"],
  ["ALABAMA DEVIL", "A Thoughtful Panorama of a Database Administrator", 2006, 2.99, 114, "PG-13"],
  ["ALADDIN CALENDAR", "A Action-Packed Tale of a Man And a Lush Bride", 2006, 4.99, 63, "NC-17"],
  ["ALAMO VIDEOTAPE", "A Boring Epistle of a Butler And a Cat", 2006, 0.99, 126, "G"],
  ["ALASKA PHANTOM", "A Fanciful Saga of a Hunter And a Pastry Chef", 2006, 0.99, 136, "PG"],
  ["ALIEN CENTER", "A Brilliant Drama of a Cat And a Mad Scientist", 2006, 0.99, 46, "NC-17"],
  ["ALLEY EVOLUTION", "A Fast-Paced Drama of a Robot And a Composer", 2006, 4.99, 146, "NC-17"],
  ["ALONE TRIP", "A Fast-Paced Character Study of a Composer", 2006, 0.99, 82, "R"],
  ["ALTER VICTORY", "A Thoughtful Drama of a Composer And a Mad Scientist", 2006, 0.99, 114, "PG-13"],
  ["AMADEUS HOLY", "A Emotional Display of a Pioneer And a Technical Writer", 2006, 0.99, 113, "PG"],
  ["AMELIE HELLFIGHTERS", "A Boring Drama of a Woman And a Squirrel", 2006, 4.99, 79, "R"],
  ["AMERICAN CIRCUS", "A Insightful Drama of a Girl And a Astronaut", 2006, 4.99, 129, "R"],
  ["AMISTAD MIDSUMMER", "A Emotional Character Study of a Dentist", 2006, 2.99, 85, "G"],
  ["ANALYZE HOOSIERS", "A Thoughtful Display of a Explorer And a Pastry Chef", 2006, 2.99, 181, "PG-13"],
  ["ANGELS LIFE", "A Thoughtful Display of a Woman And a Astronaut", 2006, 2.99, 74, "G"],
  ["ANONYMOUS HUMAN", "A Amazing Panorama of a Accountant And a Student", 2006, 4.99, 96, "PG-13"],
  ["ANTHEM LUKE", "A Touching Panorama of a Waitress And a Woman", 2006, 4.99, 91, "PG-13"],
  ["ANTITRUST TOMATOES", "A Fateful Yarn of a Womanizer And a Feminist", 2006, 0.99, 168, "NC-17"],
  ["ANYTHING SAVANNAH", "A Epic Story of a Pastry Chef And a Woman", 2006, 2.99, 82, "R"],
];

const ROWS = TITLES.map((item, index) => ({
  values: [
    index + 1,
    item[0],
    item[1],
    item[2],
    item[3],
    item[4],
    item[5],
    "2006-02-15 05:03:42",
  ],
}));

const TABLES = [
  { name: "film", kind: "BASE TABLE", engine: "InnoDB", rows: 1000, comment: "影片目录", data_length: 196608, index_length: 65536, auto_increment: 1001, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-11-03 18:40" },
  { name: "actor", kind: "BASE TABLE", engine: "InnoDB", rows: 200, comment: "演员", data_length: 16384, index_length: 16384, auto_increment: 201, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-10-28 11:02" },
  { name: "customer", kind: "BASE TABLE", engine: "InnoDB", rows: 599, comment: "客户", data_length: 98304, index_length: 49152, auto_increment: 600, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-11-02 20:15" },
  { name: "rental", kind: "BASE TABLE", engine: "InnoDB", rows: 16044, comment: "租赁记录", data_length: 1179648, index_length: 557056, auto_increment: 16050, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-11-04 08:01" },
  { name: "payment", kind: "BASE TABLE", engine: "InnoDB", rows: 16049, comment: "付款", data_length: 1441792, index_length: 393216, auto_increment: 16050, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-11-04 08:01" },
  { name: "category", kind: "BASE TABLE", engine: "InnoDB", rows: 16, comment: "分类", data_length: 16384, index_length: 0, auto_increment: 17, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-10-01 09:12" },
  { name: "inventory", kind: "BASE TABLE", engine: "InnoDB", rows: 4581, comment: "库存", data_length: 262144, index_length: 163840, auto_increment: 4582, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-11-01 16:33" },
  { name: "film_actor", kind: "BASE TABLE", engine: "InnoDB", rows: 5462, comment: "", data_length: 245760, index_length: 196608, auto_increment: undefined, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-10-01 09:12" },
  { name: "store", kind: "BASE TABLE", engine: "InnoDB", rows: 2, comment: "门店", data_length: 16384, index_length: 16384, auto_increment: 3, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-10-01 09:12" },
  { name: "staff", kind: "BASE TABLE", engine: "InnoDB", rows: 2, comment: "员工", data_length: 16384, index_length: 32768, auto_increment: 3, collation: "utf8mb4_0900_ai_ci", created_at: "2026-10-01 09:12", updated_at: "2026-10-01 09:12" },
  { name: "film_list", kind: "VIEW", engine: undefined, rows: 997, comment: "影片清单视图", data_length: undefined, index_length: undefined, auto_increment: undefined, collation: undefined, created_at: undefined, updated_at: undefined },
  { name: "customer_list", kind: "VIEW", engine: undefined, rows: 599, comment: "客户清单视图", data_length: undefined, index_length: undefined, auto_increment: undefined, collation: undefined, created_at: undefined, updated_at: undefined },
];

const INDEXES = [
  { name: "PRIMARY", unique: true, primary: true, column: "film_id", sequence: 1, prefix_length: undefined, direction: "A", index_type: "BTREE" },
  { name: "idx_title", unique: false, column: "title", sequence: 1, prefix_length: undefined, direction: "A", index_type: "BTREE" },
  { name: "idx_fk_language_id", unique: false, column: "language_id", sequence: 1, prefix_length: undefined, direction: "A", index_type: "BTREE" },
  { name: "idx_fk_original_language_id", unique: false, column: "original_language_id", sequence: 1, prefix_length: undefined, direction: "A", index_type: "BTREE" },
];

// PostgreSQL 的主键索引名是 <表名>_pkey，behavior 靠 primary 标记而不是名字识别
const PG_INDEXES = [
  { name: "film_pkey", unique: true, primary: true, column: "film_id", sequence: 1, prefix_length: undefined, direction: "ASC", index_type: "btree" },
  { name: "idx_title", unique: false, primary: false, column: "title", sequence: 1, prefix_length: undefined, direction: "ASC", index_type: "btree" },
];

const FOREIGN_KEYS = [
  { name: "fk_film_language", columns: ["language_id"], referenced_table: "language", referenced_columns: ["language_id"], on_delete: "RESTRICT", on_update: "CASCADE" },
  { name: "fk_film_original_language", columns: ["original_language_id"], referenced_table: "language", referenced_columns: ["language_id"], on_delete: "SET NULL", on_update: "CASCADE" },
];

const result = (columns: string[], rows: Array<{ values: unknown[] }>, statement: string) => ({
  columns,
  rows,
  affected_rows: 0,
  execution_time_ms: 12,
  truncated: rows.length >= 100,
  statement,
});

const FILM_COLUMNS = ["film_id", "title", "description", "release_year", "rental_rate", "length", "rating", "last_update"];

const handlers: Record<string, (args: Record<string, any>) => unknown> = {
  database_list_databases: () => [
    { name: "sakila", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
    { name: "analytics", charset: "utf8mb4" },
    { name: "scratch", charset: "utf8mb4" },
  ],
  database_list_tables: () => TABLES,
  database_list_columns: () => COLUMNS,
  database_list_indexes: () => (location.hash.includes("pg") ? PG_INDEXES : INDEXES),
  database_list_foreign_keys: () => FOREIGN_KEYS,
  database_list_charsets: () => [{ name: "utf8mb4", description: "UTF-8 Unicode", default_collation: "utf8mb4_0900_ai_ci", collations: ["utf8mb4_0900_ai_ci", "utf8mb4_general_ci"] }],
  database_fetch_rows: args => {
    if (args.table === "actor") {
      return result(["actor_id", "first_name", "last_name", "last_update"], TITLES.slice(0, 12).map((item, index) => ({ values: [index + 1, item[0].split(" ")[0], item[0].split(" ")[1], "2006-02-15 04:34:33"] })), `SELECT * FROM \`sakila\`.\`actor\` LIMIT 101`);
    }
    return result(FILM_COLUMNS, ROWS, `SELECT * FROM \`sakila\`.\`film\` ORDER BY \`film_id\` LIMIT 101 OFFSET 0`);
  },
  database_autocomplete: () => COLUMNS.map(column => ({ table: "film", column: column.name })),
  database_show_create: () => "CREATE TABLE `film` (\n  `film_id` smallint unsigned NOT NULL AUTO_INCREMENT,\n  `title` varchar(255) NOT NULL,\n  `description` text,\n  `release_year` year DEFAULT NULL,\n  `rental_rate` decimal(4,2) NOT NULL DEFAULT '4.99',\n  `length` smallint unsigned DEFAULT NULL,\n  `rating` enum('G','PG','PG-13','R','NC-17') DEFAULT 'G',\n  `last_update` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`film_id`),\n  KEY `idx_title` (`title`)\n) ENGINE=InnoDB AUTO_INCREMENT=1001 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  database_preview_table: () => ["ALTER TABLE `film` MODIFY COLUMN `length` smallint unsigned DEFAULT NULL COMMENT '时长（分钟）'"],
  database_explain_sql: () => ({
    columns: ["id", "select_type", "table", "type", "possible_keys", "key", "rows", "Extra"],
    rows: [
      [1, "SIMPLE", "f", "ALL", null, null, 1000, "Using where"],
      [1, "SIMPLE", "fa", "ref", "idx_fk_film_id", "idx_fk_film_id", 5, "Using index"],
    ],
  }),
  database_ping: () => 8,
  database_connection_info: () => ({ server_version: "8.0.36", current_database: "sakila" }),
  database_execute_sql: () => result(FILM_COLUMNS, ROWS.slice(0, 12), "SELECT film_id, title FROM film ORDER BY title LIMIT 100"),
  database_execute_sql_batch: (args: Record<string, any>) => {
    if (String(args.sql || "").includes("BAD")) {
      const failed = "Data truncated for column 'rating' at row 1";
      return {
        statements: [
          { index: 1, statement: "UPDATE film SET rental_rate = 4.99 WHERE film_id = 1", result: result([], [], "UPDATE film SET rental_rate = 4.99 WHERE film_id = 1"), error: null, duration_ms: 4 },
          { index: 2, statement: "UPDATE film SET rating = 'BAD' WHERE film_id = 2", result: null, error: failed, duration_ms: 2 },
        ],
        transaction: "rolled_back",
        partial: false,
        error: failed,
      };
    }
    return {
      statements: [
        { index: 1, statement: "SELECT film_id, title FROM film ORDER BY title LIMIT 100", result: result(FILM_COLUMNS, ROWS.slice(0, 12), "SELECT film_id, title FROM film ORDER BY title LIMIT 100"), error: null, duration_ms: 12 },
        { index: 2, statement: "SELECT rating, COUNT(*) FROM film GROUP BY rating", result: result(["rating", "COUNT(*)"], [{ values: ["G", 178] }, { values: ["PG", 194] }, { values: ["PG-13", 223] }, { values: ["R", 195] }, { values: ["NC-17", 210] }], "SELECT rating, COUNT(*) FROM film GROUP BY rating"), error: null, duration_ms: 8 },
        { index: 3, statement: "UPDATE film SET rental_rate = 4.99 WHERE film_id = 1", result: result([], [], "UPDATE film SET rental_rate = 4.99 WHERE film_id = 1"), error: null, duration_ms: 4 },
      ],
      transaction: "committed",
      partial: false,
      error: null,
    };
  },
};

(window as any).__mockInvoke = async (command: string, args: Record<string, any>) => {
  const handler = handlers[command];
  if (!handler) return null;
  return handler(args);
};

// 地址里带 -pg 就用 PostgreSQL，便于检查方言差异（设计器外键页、自增禁用等）
const previewProtocol = location.hash.includes("pg") ? "postgresql" : "mysql";

const connection: ConnectionRecord = {
  id: "preview",
  name: previewProtocol === "mysql" ? "本地测试库" : "本地 PG",
  protocol: previewProtocol,
  host: "127.0.0.1",
  port: previewProtocol === "mysql" ? 3306 : 5432,
  username: "root",
  options: {},
  tags: [],
  color: "#5a4be0",
  folder_id: null,
} as unknown as ConnectionRecord;

const errors: string[] = [];
window.addEventListener("error", event => errors.push(String(event.message)));
window.addEventListener("unhandledrejection", event => errors.push(String((event as PromiseRejectionEvent).reason)));
(window as any).__errors = errors;

const host = document.getElementById("root")!;
const bar = document.createElement("div");
bar.className = "preview-bar";
bar.innerHTML = `
  <strong style="font-weight:600">数据库工作区预览</strong>
  <button data-act="objects">对象列表</button>
  <button data-act="detail">对象详情</button>
  <button data-act="table">表数据</button>
  <button data-act="form">记录表单</button>
  <button data-act="designer">表设计器</button>
  <button data-act="query">SQL 查询</button>
  <button data-act="plan">执行计划</button>
  <span class="spacer"></span>
  <button data-act="theme">切换明暗</button>
`;
const mount = document.createElement("div");
mount.className = "preview-host";
host.append(bar, mount);

render(() => <DatabaseWorkspace connection={connection} visible={true} onCloseConnection={() => undefined} />, mount);

const click = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  element?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  element?.click();
};

const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

const openDatabase = async () => {
  const row = document.querySelector<HTMLElement>(".db-tree-row.is-database");
  row?.click();
  await wait(500);
};

const waitFor = async (selector: string, timeout = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
    await wait(60);
  }
  return null;
};

const openFilm = async () => {
  await openDatabase();
  const row = [...document.querySelectorAll<HTMLElement>(".db-tree-row.is-object")]
    .find(item => item.textContent?.trim().startsWith("film") && !item.textContent?.includes("film_"));
  row?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await wait(500);
};

const runAction = async (action: string) => {
  if (action === "objects") {
    await openDatabase();
    return;
  }
  if (action === "detail") {
    await openDatabase();
    await wait(200);
    click('.db-seg button[aria-label="详情视图"]');
    return;
  }
  if (action === "table" || action === "form" || action === "designer") {
    await openFilm();
    if (action === "form") {
      const segs = document.querySelectorAll(".db-toolbar .db-seg button");
      const target = [...segs].find(item => item.getAttribute("aria-label") === "表单视图") as HTMLElement | undefined;
      target?.click();
      await wait(400);
    }
    if (action === "designer") {
      const target = await waitFor(".db-section-nav nav button:nth-child(3)");
      target?.click();
      await wait(300);
      if (initial.includes("foreign")) {
        const tabs = [...document.querySelectorAll<HTMLElement>(".db-designer-tabs button[role=\"tab\"]")];
        tabs.find(item => item.textContent?.trim().startsWith("外键"))?.click();
      }
    }
    return;
  }
  if (action === "query") {
    click(".db-tab-new");
    return;
  }
  if (action === "results") {
    click(".db-tab-new");
    await waitFor(".db-query-toolbar");
    await wait(200);
    if (initial.includes("fail")) {
      const textarea = document.querySelector<HTMLTextAreaElement>(".db-query textarea");
      if (textarea) {
        textarea.value = "UPDATE film SET rental_rate = 4.99 WHERE film_id = 1;\nUPDATE film SET rating = 'BAD' WHERE film_id = 2;";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(250);
      }
    }
    const runner = [...document.querySelectorAll<HTMLElement>(".db-query-toolbar button")]
      .find(item => item.getAttribute("title")?.startsWith("执行"));
    runner?.click();
    await wait(700);
    return;
  }
  if (action === "plan") {
    click(".db-tab-new");
    await wait(200);
    const explain = [...document.querySelectorAll<HTMLElement>(".db-query-toolbar button")]
      .find(item => item.textContent?.includes("执行计划"));
    explain?.click();
    return;
  }
};

bar.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) return;
  const action = button.dataset.act!;
  if (action === "theme") {
    const current = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = current;
    return;
  }
  runAction(action);
});

const initial = (location.hash.slice(1) || "table").split("-");
if (initial.includes("dark")) document.documentElement.dataset.theme = "dark";

window.setTimeout(async () => {
  await runAction(initial[0] || "table");
  if (initial.includes("second") || initial.includes("messages")) {
    await wait(300);
    const tabs = [...document.querySelectorAll<HTMLElement>(".db-result-tabs button[role=\"tab\"]")];
    const target = initial.includes("messages")
      ? tabs.find(item => item.textContent?.trim().startsWith("消息"))
      : tabs.filter(item => item.textContent?.trim().startsWith("结果"))[1];
    target?.click();
    await wait(300);
  }
  if (initial.includes("zoom")) {
    await wait(300);
    const body = document.querySelector<HTMLElement>(".db-result");
    if (body) body.style.zoom = "1.8";
  }
  if (initial.includes("second") || initial.includes("messages")) {
    await wait(300);
    const tabs = [...document.querySelectorAll<HTMLElement>(".db-result-tabs button[role=\"tab\"]")];
    const target = initial.includes("messages")
      ? tabs.find(item => item.textContent?.trim().startsWith("消息"))
      : tabs.filter(item => item.textContent?.trim().startsWith("结果"))[1];
    target?.click();
    await wait(300);
  }
}, 500);

