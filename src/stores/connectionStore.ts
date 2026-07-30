import { createStore } from "solid-js/store";
import { api, ConnectionRecord, ConnectionConfig, FolderRecord } from "../utils/api";

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
