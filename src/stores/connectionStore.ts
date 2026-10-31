import { createStore } from "solid-js/store";
import { api, ConnectionRecord, ConnectionConfig, FolderRecord } from "../utils/api";
export type { ConnectionRecord, ConnectionConfig } from "../utils/api";

export interface ConnectionFolder {
  id: string;
  name: string;
  parentId: string | null;
  children: (ConnectionFolder | ConnectionRecord)[];
  expanded: boolean;
  sort_order: number;
}

interface ConnectionState {
  connections: ConnectionRecord[];
  folders: ConnectionFolder[];
  loading: boolean;
  error: string | null;
  selectedConnection: ConnectionRecord | null;
}

export const sortAssetsByTreeOrder = <T extends { sort_order: number; name: string }>(items: readonly T[]) =>
  [...items].sort((left, right) =>
    left.sort_order - right.sort_order || left.name.localeCompare(right.name)
  );

export const countFolderConnections = (
  folderId: string,
  connections: readonly ConnectionRecord[],
  folders: readonly ConnectionFolder[],
  include: (connection: ConnectionRecord) => boolean = () => true,
  visited = new Set<string>(),
): number => {
  if (visited.has(folderId)) return 0;
  const nextVisited = new Set(visited);
  nextVisited.add(folderId);
  const directCount = connections.filter(connection =>
    connection.folder_id === folderId && include(connection)
  ).length;
  return folders
    .filter(folder => folder.parentId === folderId)
    .reduce(
      (total, folder) => total + countFolderConnections(
        folder.id,
        connections,
        folders,
        include,
        nextVisited,
      ),
      directCount,
    );
};

export const folderTrail = (
  folders: readonly ConnectionFolder[],
  folderId: string | null,
): Array<{ id: string; name: string }> => {
  const trail: Array<{ id: string; name: string }> = [];
  const visited = new Set<string>();
  let current = folderId ? folders.find(folder => folder.id === folderId) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    trail.unshift({ id: current.id, name: current.name });
    current = current.parentId
      ? folders.find(folder => folder.id === current!.parentId)
      : undefined;
  }
  return trail;
};

export const folderPathLabel = (
  folders: readonly ConnectionFolder[],
  folderId: string | null,
) => ["资产列表", ...folderTrail(folders, folderId).map(folder => folder.name)].join(" / ");

export const flattenFolders = (folders: readonly ConnectionFolder[]) => {
  const byParent = new Map<string | null, ConnectionFolder[]>();
  for (const folder of folders) {
    const list = byParent.get(folder.parentId) ?? [];
    list.push(folder);
    byParent.set(folder.parentId, list);
  }
  const result: Array<{ folder: ConnectionFolder; depth: number }> = [];
  const visited = new Set<string>();
  const append = (parentId: string | null, depth: number) => {
    for (const folder of sortAssetsByTreeOrder(byParent.get(parentId) ?? [])) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      result.push({ folder, depth });
      append(folder.id, depth + 1);
    }
  };
  append(null, 0);
  for (const folder of sortAssetsByTreeOrder(folders)) {
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    result.push({ folder, depth: 0 });
  }
  return result;
};

const [state, setState] = createStore<ConnectionState>({
  connections: [],
  folders: [],
  loading: false,
  error: null,
  selectedConnection: null,
});

export const connectionStore = {
  state,

  async loadConnections() {
    setState("loading", true);
    setState("error", null);
    try {
      const [connections, folders] = await Promise.all([
        api.getConnections(),
        api.getFolders(),
      ]);
      setState("connections", connections);

      // Convert FolderRecord to ConnectionFolder format
      const connectionFolders: ConnectionFolder[] = folders.map((f: FolderRecord) => ({
        id: f.id,
        name: f.name,
        parentId: f.parent_id,
        children: [],
        expanded: false,
        sort_order: f.sort_order,
      }));
      setState("folders", connectionFolders);
    } catch (e) {
      setState("error", String(e));
    } finally {
      setState("loading", false);
    }
  },

  async saveConnection(config: ConnectionConfig) {
    setState("loading", true);
    setState("error", null);
    try {
      await api.saveConnection(config);
      await this.loadConnections();
    } catch (e) {
      setState("error", String(e));
      throw e;
    } finally {
      setState("loading", false);
    }
  },

  async deleteConnection(id: string) {
    setState("loading", true);
    setState("error", null);
    try {
      await api.deleteConnection(id);
      setState("connections", state.connections.filter(c => c.id !== id));
    } catch (e) {
      setState("error", String(e));
      throw e;
    } finally {
      setState("loading", false);
    }
  },

  selectConnection(conn: ConnectionRecord | null) {
    setState("selectedConnection", conn);
  },

  async addFolder(name: string, parentId: string | null = null) {
    try {
      const id = crypto.randomUUID();
      await api.saveFolder(id, name, parentId ?? undefined);
      await this.loadConnections();
    } catch (e) {
      setState("error", String(e));
      throw e;
    }
  },

  async deleteFolder(folderId: string) {
    try {
      const deletedFolder = state.folders.find(folder => folder.id === folderId);
      const parentId = deletedFolder?.parentId ?? null;
      await api.deleteFolder(folderId);
      setState(
        "connections",
        connection => connection.folder_id === folderId,
        "folder_id",
        parentId ?? undefined,
      );
      setState(
        "folders",
        folder => folder.parentId === folderId,
        "parentId",
        parentId,
      );
      setState("folders", state.folders.filter(f => f.id !== folderId));
    } catch (e) {
      setState("error", String(e));
      throw e;
    }
  },

  toggleFolder(folderId: string) {
    setState("folders", (f) => f.id === folderId, "expanded", (prev) => !prev);
  },

  async moveConnectionToFolder(connectionId: string, folderId: string | null) {
    const connection = state.connections.find(c => c.id === connectionId);
    const previousFolderId = connection?.folder_id;
    setState("connections", (c) => c.id === connectionId, "folder_id", folderId ?? undefined);
    try {
      await api.moveConnectionToFolder(connectionId, folderId ?? undefined);
    } catch (e) {
      setState("connections", (c) => c.id === connectionId, "folder_id", previousFolderId);
      setState("error", String(e));
      throw e;
    }
  },

  async renameFolder(folderId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    await api.renameFolder(folderId, trimmed);
    setState("folders", folder => folder.id === folderId, "name", trimmed);
  },

  async saveAssetOrder(
    connections: ConnectionRecord[],
    folders: ConnectionFolder[],
  ) {
    const previousConnections = [...state.connections];
    const previousFolders = [...state.folders];
    setState("connections", connections);
    setState("folders", folders);
    try {
      await api.updateAssetOrder(
        connections.map(connection => ({
          id: connection.id,
          parent_id: connection.folder_id ?? null,
          sort_order: connection.sort_order,
        })),
        folders.map(folder => ({
          id: folder.id,
          parent_id: folder.parentId,
          sort_order: folder.sort_order,
        })),
      );
    } catch (e) {
      setState("connections", previousConnections);
      setState("folders", previousFolders);
      setState("error", String(e));
      throw e;
    }
  },
};
