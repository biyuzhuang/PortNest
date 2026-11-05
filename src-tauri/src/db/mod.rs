//! 数据库连接诊断（迭代 A）。
//!
//! 当前只包含「连接测试」相关的探测逻辑与结果结构。连接池、方言抽象、SSH 隧道
//! 会在后续迭代迁入本模块（见 docs/数据库连接模块开发方案.md 迭代 B / C）。

pub mod probe;
pub mod report;

pub use probe::probe;
pub use report::{DbConnectionInfo, DbTestReport, DbTestStage, DbTlsInfo, StageStatus};
