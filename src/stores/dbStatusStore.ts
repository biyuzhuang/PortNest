import { createStore, produce } from "solid-js/store";
import { api, type DbConnectionInfo } from "../utils/api";

/**
 * 数据库连接运行状态。
 *
 * 会话本身（sessionStore）只记录「有没有连上」；这里额外记录服务器版本、往返
 * 耗时和降级状态，供底部状态栏与「重试」使用。状态只在内存里，不落盘。
 */

export type DbConnectionState = "unknown" | "connected" | "degraded";

interface DbStatusEntry {
  state: DbConnectionState;
  info?: DbConnectionInfo;
  error?: string;
  updatedAt: number;
}

const [state, setState] = createStore<Record<string, DbStatusEntry>>({});

export const dbStatusStore = {
  state,

  entry: (connectionId: string): DbStatusEntry | undefined => state[connectionId],

  info: (connectionId: string): DbConnectionInfo | undefined => state[connectionId]?.info,

  status: (connectionId: string): DbConnectionState =>
    state[connectionId]?.state ?? "unknown",

  /** 拉一次服务器信息；失败即判定为降级（连接池/长连接已不可用） */
  async refresh(connectionId: string): Promise<void> {
    try {
      const info = await api.databaseConnectionInfo(connectionId);
      setState(connectionId, {
        state: "connected",
        info,
        error: undefined,
        updatedAt: Date.now(),
      });
    } catch (error) {
      setState(connectionId, {
        state: "degraded",
        error: String(error),
        updatedAt: Date.now(),
      });
    }
  },

  markFailed(connectionId: string, error?: string): void {
    setState(connectionId, {
      state: "degraded",
      error,
      updatedAt: Date.now(),
    });
  },

  markConnecting(connectionId: string): void {
    setState(connectionId, {
      state: "unknown",
      error: undefined,
      updatedAt: Date.now(),
    });
  },

  clear(connectionId: string): void {
    setState(produce(entries => {
      delete entries[connectionId];
    }));
  },
};
