import { invoke } from "@tauri-apps/api/core";

export type SshErrorCode = "AUTHENTICATION" | "HOST_KEY" | "ENCODING" | "PORT_IN_USE" | "FORWARD_REJECTED" | "PROXY" | "REMOTE_CLOSED" | "SSH_ERROR";

export class SshApiError extends Error {
  constructor(
    public readonly code: SshErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SshError";
  }
}

const normalizeSshError = (cause: unknown): SshApiError => {
  if (cause instanceof SshApiError) return cause;
  const structured = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : undefined;
  const message = typeof structured?.message === "string" ? structured.message : String(cause);
  if (/authentication|permission denied|认证|密码错误/i.test(message)) return new SshApiError("AUTHENTICATION", message, false, cause);
  if (/host key|主机密钥|known_hosts/i.test(message)) return new SshApiError("HOST_KEY", message, false, cause);
  if (/编码|encoding|无法使用.*字符/i.test(message)) return new SshApiError("ENCODING", message, false, cause);
  if (/address.*in use|端口.*占用|监听.*失败/i.test(message)) return new SshApiError("PORT_IN_USE", message, false, cause);
  if (/forward.*reject|转发.*拒绝|不支持.*转发/i.test(message)) return new SshApiError("FORWARD_REJECTED", message, false, cause);
  if (/proxy|代理/i.test(message)) return new SshApiError("PROXY", message, true, cause);
  if (/remote.*closed|远端.*关闭|connection.*closed|broken pipe|连接已关闭/i.test(message)) return new SshApiError("REMOTE_CLOSED", message, true, cause);
  return new SshApiError("SSH_ERROR", message, typeof structured?.retryable === "boolean" ? structured.retryable : true, cause);
};

const sshInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  try { return await invoke<T>(command, args); }
  catch (cause) { throw normalizeSshError(cause); }
};

// Connection types
export type TunnelType = "local" | "remote" | "dynamic";

export interface TunnelRule {
  id: string;
  name: string;
  tunnel_type: TunnelType;
  enabled: boolean;
  auto_start: boolean;
  bind_host: string;
  bind_port: number;
  target_host?: string;
  target_port?: number;
  allow_public_bind?: boolean;
}

export type TunnelStatus = "starting" | "running" | "stopping" | "stopped" | "error";

export interface TunnelRuntimeInfo {
  id: string;
  connection_id: string;
  rule_id: string;
  name: string;
  tunnel_type: TunnelType;
  bind_host: string;
  bind_port: number;
  target_host?: string;
  target_port?: number;
  status: TunnelStatus;
  active_connections: number;
  error?: string;
}

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
  key_id?: string;
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
  timeout_ms?: number;
  database?: string;
  shell_type?: string;
  cwd?: string;
  custom_command?: string;
  tunnel_rules?: TunnelRule[];
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
  encoding: string;
}

export interface LocalShellProfile {
  shellType?: string;
  cwd?: string;
  customCommand?: string;
  encoding?: string;
}

/** 解析连接 options JSON 中的本地终端配置 */
export const parseLocalProfile = (options?: string): { shell_type?: string; cwd?: string; custom_command?: string } => {
  try {
    const parsed = JSON.parse(options || "{}") as Record<string, unknown>;
    return {
      shell_type: typeof parsed.shell_type === "string" ? parsed.shell_type : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      custom_command: typeof parsed.custom_command === "string" ? parsed.custom_command : undefined,
    };
  } catch {
    return {};
  }
};

export const localShellDisplayName = (shellType?: string): string => {
  switch (shellType) {
    case "cmd": return "命令提示符 (cmd)";
    case "powershell":
    case "powershell5": return "PowerShell 5.1";
    case "powershell7":
    case "pwsh": return "PowerShell 7";
    case "bash": return "Git Bash";
    case "wsl": return "WSL";
    case "custom": return "自定义命令";
    default: return "本地终端";
  }
};

export interface SshKeyRecord {
  id: string;
  name: string;
  file_name: string;
  key_type: string;
  created_at: number;
  updated_at: number;
}

export interface AssetOrderItem {
  id: string;
  parent_id: string | null;
  sort_order: number;
}

export interface PingResult {
  reachable: boolean;
  latency_ms: number | null;
}

export interface QueryResult {
  columns: string[];
  rows: Array<{ values: any[] }>;
  affected_rows: number;
  execution_time_ms: number;
  last_insert_id?: number;
}

export interface MysqlDatabaseInfo { name: string; charset?: string; collation?: string }
export interface MysqlCharsetInfo { name: string; description: string; default_collation: string; collations: string[] }
export interface MysqlSqlImportResult { total: number; completed: number; failures: Array<{ statement: number; summary: string }> }
export interface MysqlSqlExportResult { tables: number; rows: number; bytes: number }
export interface MysqlTableInfo { name: string; kind: string; engine?: string; rows?: number; comment: string; data_length?: number; index_length?: number; auto_increment?: number; collation?: string; created_at?: string; updated_at?: string }
export interface MysqlColumnInfo { name: string; data_type: string; column_type: string; nullable: boolean; default_value?: string; extra: string; comment: string; key: string; charset?: string; collation?: string; ordinal: number }
export interface MysqlIndexInfo { name: string; unique: boolean; column: string; sequence: number; prefix_length?: number; direction?: string }
export interface MysqlColumnDefinition { name: string; column_type: string; nullable: boolean; default_value?: string; auto_increment: boolean; charset?: string; collation?: string; comment: string }
export interface MysqlIndexDefinition { name: string; kind: "PRIMARY" | "UNIQUE" | "INDEX"; columns: Array<{ name: string; prefix_length?: number; direction?: string }> }
export interface MysqlTableDefinition { database: string; name: string; original_name?: string; engine?: string; charset?: string; collation?: string; comment: string; columns: MysqlColumnDefinition[]; indexes: MysqlIndexDefinition[] }

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

  async getConnectionConfig(id: string): Promise<ConnectionConfig> {
    return invoke("get_connection_config", { id });
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

  async pingHost(host: string, port: number): Promise<PingResult> {
    return invoke("ping_host", { host, port });
  },

  // Shell operations
  async openShell(connectionId: string, cols: number, rows: number): Promise<ShellOpenResponse> {
    return sshInvoke("open_shell", { connectionId, cols, rows });
  },

  async openLocalShell(cols: number, rows: number, profile?: LocalShellProfile): Promise<ShellOpenResponse> {
    return invoke("open_local_shell", {
      cols,
      rows,
      shellType: profile?.shellType ?? null,
      cwd: profile?.cwd ?? null,
      customCommand: profile?.customCommand ?? null,
      encoding: profile?.encoding ?? null,
    });
  },

  async writeShell(shellId: string, data: string): Promise<void> {
    return sshInvoke("write_shell", { shellId, data });
  },

  async readShell(shellId: string): Promise<string> {
    return sshInvoke("read_shell", { shellId });
  },

  async setShellEncoding(shellId: string, encoding: string): Promise<string> {
    return sshInvoke("set_shell_encoding", { shellId, encoding });
  },

  async resizeShell(shellId: string, cols: number, rows: number): Promise<void> {
    return sshInvoke("resize_shell", { shellId, cols, rows });
  },

  async closeShell(shellId: string): Promise<void> {
    return sshInvoke("close_shell", { shellId });
  },

  async disconnectShell(shellId: string): Promise<void> {
    return sshInvoke("disconnect_shell", { shellId });
  },

  async startTunnel(connectionId: string, ruleId: string): Promise<TunnelRuntimeInfo> {
    return sshInvoke("start_tunnel", { connectionId, ruleId });
  },

  async stopTunnel(tunnelId: string): Promise<void> {
    return sshInvoke("stop_tunnel", { tunnelId });
  },

  async listTunnels(connectionId?: string): Promise<TunnelRuntimeInfo[]> {
    return sshInvoke("list_tunnels", { connectionId: connectionId ?? null });
  },

  async stopAllTunnels(connectionId?: string): Promise<void> {
    return sshInvoke("stop_all_tunnels", { connectionId: connectionId ?? null });
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
    return sshInvoke("open_sftp", { connectionId });
  },

  async openSftpForShell(shellId: string): Promise<{ sftp_id: string }> {
    return sshInvoke("open_sftp_for_shell", { shellId });
  },

  async listSftpDir(sftpId: string, path: string): Promise<FileInfo[]> {
    return sshInvoke("list_sftp_dir", { sftpId, path });
  },

  async sftpDownload(sftpId: string, remotePath: string, localPath: string): Promise<number> {
    return sshInvoke("sftp_download", { sftpId, remotePath, localPath });
  },

  async sftpUpload(sftpId: string, localPath: string, remotePath: string): Promise<number> {
    return sshInvoke("sftp_upload", { sftpId, localPath, remotePath });
  },

  async sftpCreateDir(sftpId: string, path: string): Promise<void> {
    return sshInvoke("sftp_create_dir", { sftpId, path });
  },
  async mysqlConnect(connectionId: string): Promise<void> { return invoke("mysql_connect", { connectionId }); },
  async mysqlDisconnect(connectionId: string): Promise<void> { return invoke("mysql_disconnect", { connectionId }); },
  async mysqlListDatabases(connectionId: string): Promise<MysqlDatabaseInfo[]> { return invoke("mysql_list_databases", { connectionId }); },
  async mysqlListCharsets(connectionId: string): Promise<MysqlCharsetInfo[]> { return invoke("mysql_list_charsets", { connectionId }); },
  async mysqlListTables(connectionId: string, database: string): Promise<MysqlTableInfo[]> { return invoke("mysql_list_tables", { connectionId, database }); },
  async mysqlListColumns(connectionId: string, database: string, table: string): Promise<MysqlColumnInfo[]> { return invoke("mysql_list_columns", { connectionId, database, table }); },
  async mysqlListIndexes(connectionId: string, database: string, table: string): Promise<MysqlIndexInfo[]> { return invoke("mysql_list_indexes", { connectionId, database, table }); },
  async mysqlExecuteSql(connectionId: string, sql: string, database?: string): Promise<QueryResult> { return invoke("mysql_execute_sql", { connectionId, sql, database: database || null }); },
  async mysqlFetchRows(connectionId: string, database: string, table: string, page = 1, pageSize = 100): Promise<QueryResult> { return invoke("mysql_fetch_rows", { connectionId, database, table, page, pageSize }); },
  async mysqlCreateDatabase(connectionId: string, name: string, charset = "utf8mb4", collation?: string): Promise<void> { return invoke("mysql_create_database", { connectionId, name, charset, collation: collation || null }); },
  async mysqlDropDatabase(connectionId: string, database: string): Promise<void> { return invoke("mysql_drop_database", { connectionId, database }); },
  async mysqlCreateTable(connectionId: string, definition: MysqlTableDefinition): Promise<{ statements: string[]; completed: number; error?: string }> { return invoke("mysql_create_table", { connectionId, definition }); },
  async mysqlPreviewTable(connectionId: string, definition: MysqlTableDefinition): Promise<string[]> { return invoke("mysql_preview_table", { connectionId, definition }); },
  async mysqlApplyTable(connectionId: string, definition: MysqlTableDefinition): Promise<{ statements: string[]; completed: number; error?: string }> { return invoke("mysql_apply_table", { connectionId, definition }); },
  async mysqlTableAction(connectionId: string, database: string, table: string, action: "truncate" | "drop" | "rename" | "clone", target?: string): Promise<void> { return invoke("mysql_table_action", { connectionId, database, table, action, target: target || null }); },
  async mysqlShowCreate(connectionId: string, database: string, table: string): Promise<string> { return invoke("mysql_show_create", { connectionId, database, table }); },
  async mysqlMutateRow(connectionId: string, database: string, table: string, action: "insert" | "update" | "delete", values: Record<string, unknown>, original: Record<string, unknown> = {}): Promise<number> { return invoke("mysql_mutate_row", { connectionId, database, table, action, mutation: { values, original } }); },
  async mysqlImportCsv(connectionId: string, database: string, table: string, csv: string): Promise<number> { return invoke("mysql_import_csv", { connectionId, database, table, csv }); },
  async mysqlImportSql(connectionId: string, path: string, database?: string, continueOnError = false): Promise<MysqlSqlImportResult> { return invoke("mysql_import_sql", { connectionId, options: { path, database: database || null, continue_on_error: continueOnError } }); },
  async mysqlExportSql(connectionId: string, path: string, database: string): Promise<MysqlSqlExportResult> { return invoke("mysql_export_sql", { connectionId, options: { path, database } }); },

  async sftpCreateFile(sftpId: string, path: string): Promise<void> {
    return sshInvoke("sftp_create_file", { sftpId, path });
  },

  async cancelSftpTransfer(sftpId: string, transferId: string): Promise<void> {
    return sshInvoke("sftp_cancel_transfer", { sftpId, transferId });
  },

  async sftpDeleteFile(sftpId: string, path: string): Promise<void> {
    return sshInvoke("sftp_delete_file", { sftpId, path });
  },

  async sftpDeleteDir(sftpId: string, path: string): Promise<void> {
    return sshInvoke("sftp_delete_dir", { sftpId, path });
  },

  async sftpRename(sftpId: string, oldPath: string, newPath: string): Promise<void> {
    return sshInvoke("sftp_rename", { sftpId, oldPath, newPath });
  },

  async closeSftp(sftpId: string): Promise<void> {
    return sshInvoke("close_sftp", { sftpId });
  },
  async closeSftpIndependent(sftpId: string): Promise<void> {
    return sshInvoke("close_sftp_independent", { sftpId });
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

  async renameFolder(id: string, name: string): Promise<void> {
    return invoke("rename_folder", { id, name });
  },

  async getSshKeys(): Promise<SshKeyRecord[]> {
    return invoke("get_ssh_keys");
  },

  async saveSshKey(name: string, fileName: string, privateKey: string): Promise<SshKeyRecord> {
    return invoke("save_ssh_key", { name, fileName, privateKey });
  },

  async deleteSshKey(id: string): Promise<void> {
    return invoke("delete_ssh_key", { id });
  },

  async exportSessions(includePasswords: boolean, includePrivateKeys: boolean): Promise<string> {
    return invoke("export_sessions", { includePasswords, includePrivateKeys });
  },

  async importSessions(json: string): Promise<{ folders: number; connections: number }> {
    return invoke("import_sessions", { json });
  },

  async updateAssetOrder(connections: AssetOrderItem[], folders: AssetOrderItem[]): Promise<void> {
    return invoke("update_asset_order", { connections, folders });
  },

  async readClipboardText(): Promise<string> {
    return invoke("read_clipboard_text");
  },

  async writeClipboardText(text: string): Promise<void> {
    return invoke("write_clipboard_text", { text });
  },

  // Test connection
  async testConnection(config: ConnectionConfig): Promise<string> {
    return sshInvoke("test_connection", { config });
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
  permissions?: string;
  owner_group?: string;
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
