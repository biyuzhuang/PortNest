import { createSignal, type Setter } from "solid-js";
import { api, type ConnectionRecord } from "../utils/api";

export type SessionStatus = "restored" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export interface SessionTab {
  id: string;
  connection: ConnectionRecord;
  viewMode: "terminal";
  activeTab: "query" | "structure" | "security" | "monitor" | "ai";
  displayName?: string;
  shellId?: string;
  pinned?: boolean;
  status: SessionStatus;
  error?: string;
  reconnectAttempt?: number;
  encoding?: string;
  encodingOverride?: string;
}

interface SessionSnapshotV1 {
  version: 1;
  activeConnectionId: string | null;
  tabs: Array<{
    connectionId: string;
    displayName?: string;
    pinned?: boolean;
  }>;
}

const STORAGE_KEY = "portnest-session-snapshot-v1";
const [sessions, setSessions] = createSignal<SessionTab[]>([]);
const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
const [hydrated, setHydrated] = createSignal(false);
const closedSessions: SessionTab[] = [];
const writeQueues = new Map<string, Promise<void>>();

const newId = (connectionId: string) =>
  `${connectionId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

const find = (sessionId: string) => sessions().find(session => session.id === sessionId);

const update = (sessionId: string, patch: Partial<SessionTab>) => {
  setSessions(previous => previous.map(session => session.id === sessionId ? { ...session, ...patch } : session));
};

const sendText = (sessionId: string, data: string): Promise<void> => {
  const previous = writeQueues.get(sessionId) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const session = find(sessionId);
    if (!session?.shellId || session.status !== "connected") {
      throw new Error(`会话 ${session?.displayName || session?.connection.name || sessionId} 当前不可写入`);
    }
    await api.writeShell(session.shellId, data);
  });
  writeQueues.set(sessionId, pending);
  void pending.finally(() => {
    if (writeQueues.get(sessionId) === pending) writeQueues.delete(sessionId);
  }).catch(() => undefined);
  return pending;
};

const create = (connection: ConnectionRecord, status: SessionStatus = "connecting") => {
  const session: SessionTab = {
    id: newId(connection.id),
    connection,
    viewMode: "terminal",
    activeTab: "query",
    status,
  };
  setSessions(previous => [...previous, session]);
  setActiveSessionId(session.id);
  return session;
};

const persist = () => {
  // The connection list is loaded asynchronously. Avoid replacing a valid
  // snapshot with an empty one before hydrate() has had a chance to read it.
  if (!hydrated()) return;
  const active = find(activeSessionId() || "");
  const snapshot: SessionSnapshotV1 = {
    version: 1,
    activeConnectionId: active?.connection.id ?? null,
    tabs: sessions().map(session => ({
      connectionId: session.connection.id,
      displayName: session.displayName,
      pinned: session.pinned,
    })),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
};

const hydrate = (connections: ConnectionRecord[]) => {
  if (sessions().length > 0) {
    setHydrated(true);
    return;
  }
  let snapshot: SessionSnapshotV1 | undefined;
  try {
    snapshot = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || undefined;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  if (!snapshot || snapshot.version !== 1) {
    setHydrated(true);
    return;
  }
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const restored = snapshot.tabs.flatMap(tab => {
    const connection = byId.get(tab.connectionId);
    if (!connection) return [];
    return [{
      id: newId(connection.id),
      connection,
      viewMode: "terminal" as const,
      activeTab: "query" as const,
      status: "restored" as const,
      displayName: tab.displayName,
      pinned: tab.pinned,
    }];
  });
  setSessions(restored);
  const active = restored.find(session => session.connection.id === snapshot?.activeConnectionId) ?? restored[0];
  setActiveSessionId(active?.id ?? null);
  setHydrated(true);
};

const pushClosed = (session: SessionTab) => {
  closedSessions.push({ ...session, shellId: undefined, status: "restored", error: undefined });
  if (closedSessions.length > 20) closedSessions.shift();
  writeQueues.delete(session.id);
};

const restoreClosed = () => {
  const closed = closedSessions.pop();
  if (!closed) return undefined;
  const restored = { ...closed, id: newId(closed.connection.id) };
  setSessions(previous => [...previous, restored]);
  setActiveSessionId(restored.id);
  return restored;
};

export const sessionStore: {
  sessions: typeof sessions;
  setSessions: Setter<SessionTab[]>;
  activeSessionId: typeof activeSessionId;
  setActiveSessionId: Setter<string | null>;
  find: typeof find;
  create: typeof create;
  update: typeof update;
  sendText: typeof sendText;
  persist: typeof persist;
  hydrate: typeof hydrate;
  pushClosed: typeof pushClosed;
  restoreClosed: typeof restoreClosed;
} = {
  sessions,
  setSessions,
  activeSessionId,
  setActiveSessionId,
  find,
  create,
  update,
  sendText,
  persist,
  hydrate,
  pushClosed,
  restoreClosed,
};
