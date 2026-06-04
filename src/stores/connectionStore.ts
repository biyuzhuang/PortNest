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

  async removeFolder(folderId: string) {
    try {
      await api.deleteFolder(folderId);
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
    try {
      await api.moveConnectionToFolder(connectionId, folderId ?? undefined);
      // Update local state
      setState("connections", (c) => c.id === connectionId, "folder_id", folderId ?? undefined);
    } catch (e) {
      setState("error", String(e));
      throw e;
    }
  },
};
