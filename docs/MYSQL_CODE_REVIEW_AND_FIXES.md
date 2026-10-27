# MySQL 功能代码审查与修复计划

> 审查对象：PortNest 0.4.0 的 MySQL 管理功能
> 审查范围：Rust 后端（mysql_async）、Tauri 命令、SolidJS MySQL 工作区、导入导出流程
> 目标：记录问题、风险、优化建议和修复状态。

## 状态说明

- [ ] 未开始
- [x] 已完成
- [~] 已完成，但存在兼容性/功能限制

---
## 一、数据正确性

### 1. 表设计 DDL 不应全量重建索引
- [~] 已修复：已改为索引 diff，并对函数/FULLTEXT/SPATIAL/HASH 索引做安全拒绝

位置：src-tauri/src/commands/mysql_admin.rs 的 alter_table_plan、mysql_apply_table，以及 src/components/MysqlWorkspace.tsx 的 makeDesigner。

问题：
- 当前先删除全部索引，再重建。
- 对只有主键索引的 AUTO_INCREMENT 表，先执行 DROP PRIMARY KEY 通常直接失败。
- 后续 DDL 失败会留下缺少主键/索引的中间状态。
- 索引类型、函数索引、索引注释、可见性等信息可能丢失。
- 预览和实际执行会分别生成计划，存在结构变化导致执行内容不一致的风险。

修复方向：
- 只 diff 发生变化的索引。
- 未变化的索引不删除重建。
- 主键变更使用单条 ALTER TABLE ... DROP PRIMARY KEY, ADD PRIMARY KEY (...)。
- 函数索引、FULLTEXT/SPATIAL 等无法安全表达的结构拒绝可视化修改。
- 预览计划保存后直接执行同一份计划。

### 2. 分页必须有稳定排序
- [~] 已修复：有主键时稳定排序并返回 truncated；无主键表仍无法保证稳定顺序

位置：mysql_fetch_rows、MysqlWorkspace.tsx 分页按钮。

问题：
- SELECT * ... LIMIT ? OFFSET ? 没有 ORDER BY，翻页可能重复或漏行。
- page.saturating_sub(1) * page_size 存在溢出风险。
- 大 OFFSET 性能差。
- 前端以当前页恰好 100 行判断是否有下一页，不准确。

修复方向：
- 有主键时按主键排序；无主键时提示限制。
- 使用 checked_mul 和页码上限。
- 返回 has_more/truncated 元数据。
- 中长期改为 keyset pagination。

### 3. SQL 工作台限制结果规模和执行时间
- [x] 已完成：结果最多 5000 行，60 秒超时，前端提示截断

位置：mysql_execute_sql、MySQL 查询结果表格。

问题：
- 全部结果一次性 collect 再序列化到前端。
- 没有最大行数、超时或取消。
- 大结果可能造成内存暴涨、IPC 卡死或 WebView 崩溃。

修复方向：
- 默认限制返回行数并返回 truncated 标志。
- 增加查询超时。
- 后续支持 KILL QUERY 取消。
- 超大结果使用分页或流式输出。

### 4. 保证 MySQL 类型往返不失真
- [~] 已修复：列元数据、BIGINT 字符串、TIME/DATE、二进制反向解码已处理；复杂类型仍需集成测试

位置：value_to_json、json_to_value、sql_literal。

问题：
- 超过 JavaScript 安全整数范围的 BIGINT 会丢精度。
- TIME 的 days/hours 拼接错误，例如 1 02:03:04 应为 26:03:04。
- DATE 和 DATETIME 未区分。
- binary 标记对象输出后无法反向恢复。
- 查询结果没有列类型元数据。

修复方向：
- 查询结果增加列类型、字符集、标志元数据。
- 大整数超过 2^53-1 时以字符串传输。
- 正确格式化 DATE/DATETIME/TIME。
- 写入二进制时解码 binary 标记对象。
- 增加类型往返测试。

### 5. 更新 0 行不应一律视为并发冲突
- [x] 已完成：连接启用 client_found_rows

位置：mysql_mutate_row。

问题：
- mysql_async 默认 CLIENT_FOUND_ROWS=false，更新值未变化时 affected_rows=0。
- 当前代码会误报为数据已被其他操作修改。

修复方向：
- 连接开启 client_found_rows(true)。
- 或区分 matched rows 和 changed rows。
- 真正乐观锁应使用版本号或 updated_at 条件。


## 二、连接与可靠性

### 6. 用户配置的连接超时必须生效
- [x] 已完成：连接、验证查询和 health_check 均加超时

位置：build_pool、test_connection。

问题：
- MySQL 连接和验证查询没有使用配置中的 timeout_ms。
- 测试连接时只对 plugin.connect 做了 timeout，真正的 health_check 在 timeout 范围外。

修复方向：
- 对 get_conn、验证查询和 health_check 全部加超时。
- 统一返回连接超时错误。

### 7. 连接池参数需要收敛
- [x] 已完成：1..4 连接池、语句缓存、并发首次建池锁

位置：mysql_admin::build_pool、protocol::mysql::MysqlPlugin::connect。

问题：
- mysql_async 默认连接池约束为 min=10, max=100。
- 多个 MySQL 资产可能叠加大量服务器连接。
- pool_for 在并发首次访问时可能重复建池。
- 通用 execute_query 每次查询都创建新 pool。

修复方向：
- 明确设置小规模连接池，例如 min=1, max=4。
- 配置空闲 TTL 和语句缓存。
- 统一复用 MysqlManager 缓存池。
- 消除首次建池竞态。

### 8. 重复打开同一 MySQL 连接不应强制重连
- [x] 已完成：mysql_connect 幂等复用健康连接池

位置：mysql_connect、App.tsx 重复会话逻辑。

问题：
- 同一连接打开多个会话时会重复执行 mysql_connect。
- 当前实现会先断开旧 pool，可能影响已有查询或阻塞新连接。

修复方向：
- mysql_connect 幂等化。
- 已存在健康 pool 时直接复用。
- 使用引用计数，最后一个会话关闭时才真正断开。

### 9. 增加 MySQL TLS 支持
- [x] 已完成：支持 disabled/required/skip_verify SSL 模式

位置：MysqlPlugin::connect、build_pool、连接表单。

问题：
- 当前没有设置 ssl_opts，密码、SQL 和结果可能明文传输。
- 无法连接要求 SSL 的实例。

修复方向：
- 增加 SSL 模式、CA 证书、客户端证书和私钥配置。
- 默认对公网连接提示风险。
- 支持 required 和 verify_identity。


## 三、DDL 与元数据

### 10. 函数索引会导致索引列表查询失败
- [~] 已修复：COLUMN_NAME 可空并返回 INDEX_TYPE，高级索引禁止可视化修改

位置：mysql_list_indexes、MysqlIndexInfo、makeDesigner。

问题：
- MySQL 8 函数索引的 STATISTICS.COLUMN_NAME 可能为 NULL。
- 当前使用 String 解码，遇到函数索引会失败。
- 没有读取 EXPRESSION、INDEX_TYPE、IS_VISIBLE。

修复方向：
- COLUMN_NAME 改为可空。
- 增加表达式和索引类型字段。
- 可视化设计器无法安全修改时明确拒绝。

### 11. 表设计器要保留字符集、排序规则和高级字段属性
- [~] 已修复：表 collation、生成列、ON UPDATE 等信息已尽量保留

位置：makeDesigner、build_column、alter_table_plan。

问题：
- 表级字符集取自第一个字符字段，可能改变原表字符集。
- 未保留表级 collation。
- 生成列、ON UPDATE CURRENT_TIMESTAMP、可见性等属性可能丢失。

修复方向：
- 从 information_schema.TABLES 读取表和默认 collation。
- 完整读取 GENERATION_EXPRESSION、EXTRA、IS_VISIBLE。
- 无法表达的结构禁止可视化修改。

### 12. DDL 类型和默认值校验不足
- [x] 已完成：拒绝注释/非法字符/非括号逗号，并严格校验 DEFAULT 表达式

位置：validated_column_type、build_column。

问题：
- 字段类型字符串允许逗号、注释和任意尾部内容。
- CURRENT_TIMESTAMP(...) 默认值原样拼接，缺乏严格校验。

修复方向：
- 使用结构化类型定义。
- 至少拒绝逗号、注释、换行和控制字符。
- 默认值使用严格白名单或安全 literal 生成器。

## 四、导入导出

### 13. SQL 导出必须保证完整性和一致性
- [~] 已修复：一致性快照、流式读取、显式列、批量 INSERT、视图/例程/触发器/事件导出

位置：mysql_export_sql。

问题：
- 只导出 BASE TABLE，遗漏视图、触发器、存储过程、函数、事件。
- 使用 LIMIT/OFFSET 且无稳定排序，可能重复/漏数据，性能 O(n²)。
- 没有一致性快照，导出期间并发写入会产生不一致结果。
- INSERT INTO table VALUES (...) 对 generated/invisible columns 不安全。
- 文件写入失败会留下不完整文件。

修复方向：
- 使用一致性快照。
- 按主键 keyset 分页或流式读取。
- 显式列名并排除 generated columns。
- 补全其他数据库对象。
- 临时文件成功后原子替换。

### 14. SQL/CSV 导入需要流式和批量处理
- [~] 已修复：CSV 批量插入和 BOM，SQL 使用异步读取和大小限制；仍未完全流式拆分

位置：mysql_import_sql、mysql_import_csv、MysqlWorkspace.tsx。

问题：
- SQL 文件整体读入内存并拆成数组。
- CSV 由前端整体读取后通过 IPC 发送。
- CSV 每行一次网络往返。
- async 命令内使用同步文件 IO。
- 缺少进度、取消和大小限制。

修复方向：
- 后端按路径流式读取。
- CSV 批量插入或使用 LOAD DATA LOCAL INFILE。
- 使用 tokio::fs 或 spawn_blocking。
- 增加进度事件和取消。

### 15. CSV 导出安全与兼容性
- [x] 已完成：公式注入防护、UTF-8 BOM、标准 CSV 转义

位置：csvCell、exportCsv。

问题：
- 未防护 Excel/WPS 公式注入。
- 没有 UTF-8 BOM，中文可能乱码。
- NULL 使用反斜杠 N，普通表格软件显示不友好。

修复方向：
- 对等号、加号、减号、at 符号开头的值做转义。
- 增加 BOM。
- 使用标准 CSV 编码器并保持 NULL 语义。

## 五、前端交互与死代码

### 16. 新增行不应默认写入全 NULL
- [x] 已完成：默认空对象、JSON 解析错误提示、排除默认 NULL 覆盖

位置：MysqlWorkspace.tsx 的 insertRow。

问题：
- 默认 JSON 包含所有字段且值全为 null。
- 会覆盖 NOT NULL DEFAULT、生成列和 ON UPDATE 语义。
- 非法 JSON 解析没有捕获。

修复方向：
- 默认只生成空对象，由用户填写要插入的字段。
- 排除 generated/auto_increment 字段。
- 捕获 JSON 解析错误并提示。

### 17. 统一前端异步错误处理
- [x] 已完成：错误捕获、请求序号、分页乱序保护

位置：MysqlWorkspace.tsx 的 run 和所有异步事件。

问题：
- run 已设置错误提示后再次 throw，调用方大量使用 void，造成 unhandled rejection。
- 全局 loading 在并发操作时可能提前结束。
- 快速翻页时响应乱序可能覆盖新页面。

修复方向：
- 统一错误边界。
- 使用 pending counter 或 per-tab loading。
- 为分页和查询增加请求序号，丢弃过期响应。

### 18. 清理遗留导入导出与通用查询路径
- [x] 已完成：删除未使用组件和通用 execute_query 路径

位置：DataImportExport.tsx、QueryEditor.tsx、TableEditor.tsx、commands::execute_query、protocol::mysql。

问题：
- DataImportExport.tsx 当前未挂载，且生成带占位符的 SQL 却没有传参数。
- 通用 execute_query 每次查询新建 pool。
- 通用查询空结果没有列名，DML 的 affected_rows 固定为 0，日期时间使用 Debug 格式，二进制使用 lossy 转换。

修复方向：
- 删除未使用组件或重写为复用 MySQL 管理命令。
- 移除重复查询实现。
- 统一到 MysqlManager 和 QueryResult。


## 六、工程与优化

### 19. 移除未使用的 sqlx 依赖
- [x] 已完成：从 Cargo.toml 删除 sqlx

问题：
- Cargo.toml 启用了 sqlx 的 mysql/postgres/sqlite feature，但源码未使用 sqlx。
- 增加编译时间和二进制体积。

修复方向：
- 删除 sqlx，或统一技术栈后只保留一个 MySQL 驱动。

### 20. 增加 MySQL 集成测试
- [~] 已完成：新增 3 个 MySQL 单元测试；仍需 Docker/Testcontainers 集成测试

需要覆盖：
- 连接、认证、超时
- 事务提交与回滚
- CRUD 和 affected_rows
- BIGINT/DECIMAL/JSON/BLOB/DATE/TIME 往返
- 分页稳定性
- generated column
- 函数索引
- DDL diff
- SQL/CSV 导出后再导入 round-trip
- 大结果集截断和超时

建议：
- 使用 Docker/Testcontainers 启动 MySQL 8。
- 将集成测试放在 src-tauri/tests/，通过环境变量控制是否运行。


## 七、建议落地顺序

1. 数据正确性：分页排序、类型转换、affected_rows、DDL diff。
2. 稳定性：查询上限、超时、取消、连接池、重复会话。
3. 导入导出：一致性快照、流式处理、generated columns、完整对象导出。
4. 安全与体验：TLS、CSV 注入、前端行编辑、错误处理。
5. 工程优化：删死代码、删无用依赖、补集成测试。


## 修复记录

| 日期 | 项目 | 说明 |
| --- | --- | --- |
| 2026-10-22 | 查询正确性 | 分页稳定排序、结果截断、查询超时、类型转换、client_found_rows |
| 2026-10-22 | 连接池与 TLS | 连接池 1..4、并发建池锁、幂等连接、连接超时、SSL 模式 |
| 2026-10-22 | DDL | 索引 diff、生成列/ON UPDATE 保留、DDL 校验、执行预览计划 |
| 2026-10-22 | 导入导出 | 一致性快照、流式读取、显式列、批量 INSERT、视图/例程/触发器/事件 |
| 2026-10-22 | 前端 | 行编辑、JSON 错误提示、分页竞态、CSV 注入和 BOM、SSL 配置 |
| 2026-10-22 | 清理 | 删除死组件、通用 execute_query、sqlx 依赖 |



## 本次验证结果

- cargo check：通过
- cargo test --lib：57 个测试通过
- npm run typecheck：通过
- npm run build：通过

## 剩余限制

- 尚无真实 MySQL 集成测试环境，导出/导入、DDL diff、TLS 和类型往返需要在 MySQL 8 实例上做端到端验证。
- 无主键表的分页仍无法保证稳定顺序，需要业务指定排序字段或增加主键。
- SQL 导入仍会整体读入内存，当前只增加异步读取和 128MB 限制。
- 可视化表设计不支持函数索引、FULLTEXT/SPATIAL/HASH 索引的修改，会安全拒绝并提示使用 SQL 工作台。
- 导出目前支持系统根证书校验的 required 模式，以及 skip_verify 模式；自定义 CA 文件配置仍可后续增加。


## 追加修复

- SQL 查询输入框输入一个字符后失去焦点：将查询面板拆分为稳定的 QueryPanel 组件，避免 tabs 信号更新时重建 textarea。
- 查询编辑、数据库选择和执行按钮现在通过响应式 props 更新，不再在 Show 子渲染函数中直接读取 activeTab。

## MySQL 产品功能规划（Navicat / DBeaver / DataGrip 参考）

- P0：数据网格筛选、排序、复制、导出选中行。
- P0：SQL 表名/字段补全、查询历史与收藏。
- P0：EXPLAIN 可视化执行计划。
- P0：危险 SQL 确认、只读模式和事务状态提示。
- P1：导入导出向导、完整对象管理、结构对比、ER 图、服务器监控、用户权限、备份恢复。
- P2：查询结果图表、数据对比、AI SQL 助手、数据质量分析、团队 SQL 模板。
