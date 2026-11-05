/**
 * 兼容入口。
 *
 * 数据库工作区已经拆到 ./database/ 下（nav / objects / table / query / designer）。
 * 这里保留一层 re-export，让 App.tsx 等既有引用不用改路径。
 */
export { DatabaseWorkspace } from "./database/DatabaseWorkspace";
