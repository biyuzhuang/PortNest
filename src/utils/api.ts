import { invoke } from "@tauri-apps/api/core";

// Connection types
export interface ConnectionConfig {
  id?: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password?: string;
  private_key?: string;
  passphrase?: string;
  options?: string;
  tags?: string;
  color?: string;
  folder_id?: string;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;
  encoding?: string;
}

export interface ConnectionRecord {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  credential_id: string;
  options?: string;
  tags?: string;
  color?: string;
  folder_id?: string;
  sort_order: number;
  created_at: number;
  last_connected_at?: number;
}

export interface ConnectionResponse {
  id: string;
  name: string;
  protocol: string;
  status: string;
}

export interface ProtocolInfo {
  id: string;
  name: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: number;
}

export interface AIAnalyzeResult {
  summary: string;
  issues: Array<{
    severity: "Info" | "Warning" | "Error" | "Critical";
    title: string;
    description: string;
    suggestion?: string;
  }>;
  recommendations: string[];
  health_score: number;
}

export interface ShellOpenResponse {
  shell_id: string;
}

export interface QueryResult {
  columns: string[];
  rows: Array<{ values: any[] }>;
  affected_rows: number;
  execution_time_ms: number;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatResponse {
  message: ChatMessage;
  analysis?: AIAnalyzeResult;
}

// Tauri API wrapper
export const api = {
  // Connection management
  async saveConnection(config: ConnectionConfig): Promise<ConnectionResponse> {
    return invoke("save_connection", { config });
  },

  async getConnections(): Promise<ConnectionRecord[]> {
    return invoke("get_connections");
  },

  async deleteConnection(id: string): Promise<void> {
    return invoke("delete_connection", { id });
  },

  async analyzeConnection(connectionId: string): Promise<AIAnalyzeResult> {
    return invoke("analyze_connection", { connectionId });
  },

  async getProtocols(): Promise<ProtocolInfo[]> {
    return invoke("get_protocols");
  },

  // Shell operations
  async openShell(connectionId: string, cols: number, rows: number): Promise<ShellOpenResponse> {
    return invoke("open_shell", { connectionId, cols, rows });
  },

  async writeShell(shellId: string, data: string): Promise<void> {
    return invoke("write_shell", { shellId, data });
  },

  async readShell(shellId: string): Promise<string> {
    return invoke("read_shell", { shellId });
  },

  async resizeShell(shellId: string, cols: number, rows: number): Promise<void> {
    return invoke("resize_shell", { shellId, cols, rows });
  },

  async closeShell(shellId: string): Promise<void> {
    return invoke("close_shell", { shellId });
  },

  async disconnectShell(shellId: string): Promise<void> {
    return invoke("disconnect_shell", { shellId });
  },

  // Query operations
  async executeQuery(connectionId: string, sql: string): Promise<QueryResult> {
    return invoke("execute_query", { connectionId, sql });
  },

  // AI chat operations
  async chatWithAI(connectionId: string, message: string): Promise<ChatResponse> {
    return invoke("chat_with_ai", { connectionId, message });
  },

  // SFTP operations
  async openSftp(connectionId: string): Promise<{ sftp_id: string }> {
    return invoke("open_sftp", { connectionId });
  },

  async openSftpForShell(shellId: string): Promise<{ sftp_id: string }> {
    return invoke("open_sftp_for_shell", { shellId });
  },

  async listSftpDir(sftpId: string, path: string): Promise<FileInfo[]> {
    return invoke("list_sftp_dir", { sftpId, path });
  },

  async sftpDownload(sftpId: string, remotePath: string, localPath: string): Promise<number> {
    return invoke("sftp_download", { sftpId, remotePath, localPath });
  },

  async sftpUpload(sftpId: string, localPath: string, remotePath: string): Promise<number> {
    return invoke("sftp_upload", { sftpId, localPath, remotePath });
  },

  async sftpCreateDir(sftpId: string, path: string): Promise<void> {
    return invoke("sftp_create_dir", { sftpId, path });
  },

  async sftpDeleteFile(sftpId: string, path: string): Promise<void> {
    return invoke("sftp_delete_file", { sftpId, path });
  },

  async sftpDeleteDir(sftpId: string, path: string): Promise<void> {
    return invoke("sftp_delete_dir", { sftpId, path });
  },

  async sftpRename(sftpId: string, oldPath: string, newPath: string): Promise<void> {
    return invoke("sftp_rename", { sftpId, oldPath, newPath });
  },

  async closeSftp(sftpId: string): Promise<void> {
    return invoke("close_sftp", { sftpId });
  },
  async closeSftpIndependent(sftpId: string): Promise<void> {
    return invoke("close_sftp_independent", { sftpId });
  },

  // Folder operations
  async getFolders(): Promise<FolderRecord[]> {
    return invoke("get_folders");
  },

  async saveFolder(id: string, name: string, parentId?: string): Promise<void> {
    return invoke("save_folder", { id, name, parentId: parentId ?? null });
  },

  async deleteFolder(id: string): Promise<void> {
    return invoke("delete_folder", { id });
  },

  async moveConnectionToFolder(connectionId: string, folderId?: string): Promise<void> {
    return invoke("move_connection_to_folder", { connectionId, folderId: folderId ?? null });
  },

  // Test connection
  async testConnection(config: ConnectionConfig): Promise<string> {
    return invoke("test_connection", { config });
  },
};

// File info type
export interface FileInfo {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_link: boolean;
  modified: number | null;
}

// Docker types
export interface DockerContainerInfo {
  id: string;
  names: string[];
  image: string;
  image_id: string;
  command: string;
  created: number;
  state: string;
  status: string;
  ports: PortBinding[];
  labels: Record<string, string>;
}

export interface PortBinding {
  private_port: number;
  public_port: number | null;
  ip: string | null;
  protocol: string;
}

export interface ContainerStats {
  id: string;
  name: string;
  cpu_percent: number;
  memory_usage: number;
  memory_limit: number;
  memory_percent: number;
  network_rx: number;
  network_tx: number;
}

export interface DockerImageInfo {
  id: string;
  repo_tags: string[];
  size: number;
  created: number;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

export interface DockerSystemInfo {
  containers: number;
  containers_running: number;
  images: number;
  server_version: string;
  operating_system: string;
  architecture: string;
}

export interface DockerContainerCreateConfig {
  image: string;
  name?: string;
  cmd?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMount[];
  network?: string;
}

export interface PortMapping {
  container_port: number;
  host_port: number;
  protocol: string;
}

export interface VolumeMount {
  source: string;
  target: string;
  read_only: boolean;
}

// Docker API wrapper
export const dockerApi = {
  async connect(connectionId: string): Promise<void> {
    return invoke("docker_connect", { connectionId });
  },

  async listContainers(connectionId: string, all: boolean = true): Promise<DockerContainerInfo[]> {
    return invoke("docker_list_containers", { connectionId, all });
  },

  async createContainer(connectionId: string, config: DockerContainerCreateConfig): Promise<string> {
    return invoke("docker_create_container", { connectionId, config });
  },

  async startContainer(connectionId: string, containerId: string): Promise<void> {
    return invoke("docker_start_container", { connectionId, containerId });
  },

  async stopContainer(connectionId: string, containerId: string, timeout?: number): Promise<void> {
    return invoke("docker_stop_container", { connectionId, containerId, timeout });
  },

  async restartContainer(connectionId: string, containerId: string, timeout?: number): Promise<void> {
    return invoke("docker_restart_container", { connectionId, containerId, timeout });
  },

  async killContainer(connectionId: string, containerId: string, signal?: string): Promise<void> {
    return invoke("docker_kill_container", { connectionId, containerId, signal });
  },

  async removeContainer(connectionId: string, containerId: string, force: boolean = false): Promise<void> {
    return invoke("docker_remove_container", { connectionId, containerId, force });
  },

  async logs(connectionId: string, containerId: string, tail?: number, follow: boolean = false): Promise<string> {
    return invoke("docker_logs", { connectionId, containerId, tail, follow });
  },

  async stats(connectionId: string, containerId: string): Promise<ContainerStats> {
    return invoke("docker_stats", { connectionId, containerId });
  },

  async listImages(connectionId: string): Promise<DockerImageInfo[]> {
    return invoke("docker_list_images", { connectionId });
  },

  async pullImage(connectionId: string, image: string, tag?: string): Promise<string> {
    return invoke("docker_pull_image", { connectionId, image, tag });
  },

  async removeImage(connectionId: string, imageId: string, force: boolean = false): Promise<void> {
    return invoke("docker_remove_image", { connectionId, imageId, force });
  },

  async listVolumes(connectionId: string): Promise<VolumeInfo[]> {
    return invoke("docker_list_volumes", { connectionId });
  },

  async createVolume(connectionId: string, name: string, driver: string = "local"): Promise<string> {
    return invoke("docker_create_volume", { connectionId, name, driver });
  },

  async removeVolume(connectionId: string, volumeName: string): Promise<void> {
    return invoke("docker_remove_volume", { connectionId, volumeName });
  },

  async listNetworks(connectionId: string): Promise<NetworkInfo[]> {
    return invoke("docker_list_networks", { connectionId });
  },

  async createNetwork(connectionId: string, name: string, driver: string = "bridge"): Promise<string> {
    return invoke("docker_create_network", { connectionId, name, driver });
  },

  async removeNetwork(connectionId: string, networkId: string): Promise<void> {
    return invoke("docker_remove_network", { connectionId, networkId });
  },

  async ping(connectionId: string): Promise<string> {
    return invoke("docker_ping", { connectionId });
  },

  async info(connectionId: string): Promise<DockerSystemInfo> {
    return invoke("docker_info", { connectionId });
  },

  async disconnect(connectionId: string): Promise<void> {
    return invoke("docker_disconnect", { connectionId });
  },
};
