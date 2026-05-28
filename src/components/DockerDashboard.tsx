import { Component, createSignal, For, Show } from "solid-js";
import { dockerApi, DockerContainerInfo, DockerImageInfo, VolumeInfo, NetworkInfo, DockerSystemInfo, ContainerStats } from "../utils/api";
import "./DockerDashboard.css";

type DockerTab = "containers" | "images" | "volumes" | "networks" | "system";

interface DockerDashboardProps {
  connectionId: string;
}

export const DockerDashboard: Component<DockerDashboardProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<DockerTab>("containers");
  const [containers, setContainers] = createSignal<DockerContainerInfo[]>([]);
  const [images, setImages] = createSignal<DockerImageInfo[]>([]);
  const [volumes, setVolumes] = createSignal<VolumeInfo[]>([]);
  const [networks, setNetworks] = createSignal<NetworkInfo[]>([]);
  const [systemInfo, setSystemInfo] = createSignal<DockerSystemInfo | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedContainer, setSelectedContainer] = createSignal<string | null>(null);
  const [containerStats, setContainerStats] = createSignal<ContainerStats | null>(null);
  const [containerLogs, setContainerLogs] = createSignal("");
  const [showLogs, setShowLogs] = createSignal(false);

  const loadContainers = async (showAll: boolean = true) => {
    setLoading(true);
    setError(null);
    try {
      const result = await dockerApi.listContainers(props.connectionId, showAll);
      setContainers(result);
    } catch (e) {
      setError("加载容器失败: " + e);
    }
    setLoading(false);
  };

  const loadImages = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dockerApi.listImages(props.connectionId);
      setImages(result);
    } catch (e) {
      setError("加载镜像失败: " + e);
    }
    setLoading(false);
  };

  const loadVolumes = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dockerApi.listVolumes(props.connectionId);
      setVolumes(result);
    } catch (e) {
      setError("加载卷失败: " + e);
    }
    setLoading(false);
  };

  const loadNetworks = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dockerApi.listNetworks(props.connectionId);
      setNetworks(result);
    } catch (e) {
      setError("加载网络失败: " + e);
    }
    setLoading(false);
  };

  const loadSystemInfo = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dockerApi.info(props.connectionId);
      setSystemInfo(result);
    } catch (e) {
      setError("加载系统信息失败: " + e);
    }
    setLoading(false);
  };

  const loadTab = async (tab: DockerTab) => {
    setActiveTab(tab);
    setShowLogs(false);
    switch (tab) {
      case "containers":
        await loadContainers();
        break;
      case "images":
        await loadImages();
        break;
      case "volumes":
        await loadVolumes();
        break;
      case "networks":
        await loadNetworks();
        break;
      case "system":
        await loadSystemInfo();
        break;
    }
  };

  const handleContainerAction = async (action: string, containerId: string) => {
    try {
      switch (action) {
        case "start":
          await dockerApi.startContainer(props.connectionId, containerId);
          break;
        case "stop":
          await dockerApi.stopContainer(props.connectionId, containerId);
          break;
        case "restart":
          await dockerApi.restartContainer(props.connectionId, containerId);
          break;
        case "kill":
          await dockerApi.killContainer(props.connectionId, containerId);
          break;
        case "remove":
          if (confirm("确定删除此容器？")) {
            await dockerApi.removeContainer(props.connectionId, containerId, true);
          }
          break;
      }
      await loadContainers();
    } catch (e) {
      setError(`操作失败: ${e}`);
    }
  };

  const handleViewLogs = async (containerId: string) => {
    setSelectedContainer(containerId);
    setShowLogs(true);
    try {
      const logs = await dockerApi.logs(props.connectionId, containerId, 100, false);
      setContainerLogs(logs);
    } catch (e) {
      setContainerLogs("获取日志失败: " + e);
    }
  };

  const handleViewStats = async (containerId: string) => {
    setSelectedContainer(containerId);
    try {
      const stats = await dockerApi.stats(props.connectionId, containerId);
      setContainerStats(stats);
    } catch (e) {
      setError("获取统计信息失败: " + e);
    }
  };

  const handleImageAction = async (action: string, imageId: string) => {
    try {
      if (action === "remove") {
        if (confirm("确定删除此镜像？")) {
          await dockerApi.removeImage(props.connectionId, imageId, true);
        }
      }
      await loadImages();
    } catch (e) {
      setError(`操作失败: ${e}`);
    }
  };

  const handleVolumeAction = async (action: string, volumeName: string) => {
    try {
      if (action === "remove") {
        if (confirm("确定删除此卷？")) {
          await dockerApi.removeVolume(props.connectionId, volumeName);
        }
      }
      await loadVolumes();
    } catch (e) {
      setError(`操作失败: ${e}`);
    }
  };

  const handleNetworkAction = async (action: string, networkId: string) => {
    try {
      if (action === "remove") {
        if (confirm("确定删除此网络？")) {
          await dockerApi.removeNetwork(props.connectionId, networkId);
        }
      }
      await loadNetworks();
    } catch (e) {
      setError(`操作失败: ${e}`);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getContainerStateColor = (state: string): string => {
    switch (state.toLowerCase()) {
      case "running": return "#4caf50";
      case "exited": return "#9e9e9e";
      case "paused": return "#ff9800";
      case "restarting": return "#2196f3";
      case "dead": return "#f44336";
      default: return "#757575";
    }
  };

  // Load containers on mount
  loadContainers();

  return (
    <div class="docker-dashboard">
      <div class="docker-tabs">
        <button class={`docker-tab ${activeTab() === "containers" ? "active" : ""}`} onClick={() => loadTab("containers")}>
          容器
        </button>
        <button class={`docker-tab ${activeTab() === "images" ? "active" : ""}`} onClick={() => loadTab("images")}>
          镜像
        </button>
        <button class={`docker-tab ${activeTab() === "volumes" ? "active" : ""}`} onClick={() => loadTab("volumes")}>
          卷
        </button>
        <button class={`docker-tab ${activeTab() === "networks" ? "active" : ""}`} onClick={() => loadTab("networks")}>
          网络
        </button>
        <button class={`docker-tab ${activeTab() === "system" ? "active" : ""}`} onClick={() => loadTab("system")}>
          系统
        </button>
      </div>

      <Show when={error()}>
        <div class="error-message">{error()}</div>
      </Show>

      <Show when={loading()}>
        <div class="loading-message">加载中...</div>
      </Show>

      {/* Containers Tab */}
      <Show when={activeTab() === "containers" && !loading() && !showLogs()}>
        <div class="docker-content">
          <div class="docker-toolbar">
            <button class="btn-refresh" onClick={() => loadContainers()}>刷新</button>
            <label>
              <input type="checkbox" onChange={(e) => loadContainers(e.currentTarget.checked)} />
              显示已停止
            </label>
          </div>
          <table class="docker-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>镜像</th>
                <th>状态</th>
                <th>端口</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <For each={containers()}>
                {(container) => (
                  <tr>
                    <td class="cell-name">
                      <span class="container-id">{container.id.slice(0, 12)}</span>
                      <span class="container-names">{container.names.join(", ")}</span>
                    </td>
                    <td>{container.image}</td>
                    <td>
                      <span class="state-badge" style={{ "background-color": getContainerStateColor(container.state) }}>
                        {container.state}
                      </span>
                    </td>
                    <td class="cell-ports">
                      {container.ports.filter(p => p.public_port).map(p => `${p.public_port}:${p.private_port}`).join(", ") || "-"}
                    </td>
                    <td class="cell-actions">
                      <Show when={container.state !== "running"}>
                        <button class="btn-action btn-start" onClick={() => handleContainerAction("start", container.id)}>启动</button>
                      </Show>
                      <Show when={container.state === "running"}>
                        <button class="btn-action btn-stop" onClick={() => handleContainerAction("stop", container.id)}>停止</button>
                      </Show>
                      <button class="btn-action btn-restart" onClick={() => handleContainerAction("restart", container.id)}>重启</button>
                      <button class="btn-action btn-logs" onClick={() => handleViewLogs(container.id)}>日志</button>
                      <button class="btn-action btn-stats" onClick={() => handleViewStats(container.id)}>统计</button>
                      <button class="btn-action btn-kill" onClick={() => handleContainerAction("kill", container.id)}>杀死</button>
                      <button class="btn-action btn-remove" onClick={() => handleContainerAction("remove", container.id)}>删除</button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* Container Logs */}
      <Show when={showLogs()}>
        <div class="docker-content">
          <div class="docker-toolbar">
            <button class="btn-back" onClick={() => setShowLogs(false)}>返回</button>
            <span class="logs-title">容器日志: {selectedContainer()?.slice(0, 12)}</span>
          </div>
          <pre class="logs-output">{containerLogs()}</pre>
        </div>
      </Show>

      {/* Container Stats Modal */}
      <Show when={containerStats()}>
        <div class="stats-modal">
          <div class="stats-header">
            <h3>容器统计: {containerStats()?.name}</h3>
            <button onClick={() => setContainerStats(null)}>关闭</button>
          </div>
          <div class="stats-body">
            <div class="stat-item">
              <span class="stat-label">CPU</span>
              <span class="stat-value">{containerStats()?.cpu_percent.toFixed(2)}%</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">内存</span>
              <span class="stat-value">{formatBytes(containerStats()?.memory_usage || 0)} / {formatBytes(containerStats()?.memory_limit || 0)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">内存使用率</span>
              <span class="stat-value">{containerStats()?.memory_percent.toFixed(2)}%</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">网络接收</span>
              <span class="stat-value">{formatBytes(containerStats()?.network_rx || 0)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">网络发送</span>
              <span class="stat-value">{formatBytes(containerStats()?.network_tx || 0)}</span>
            </div>
          </div>
        </div>
      </Show>

      {/* Images Tab */}
      <Show when={activeTab() === "images" && !loading()}>
        <div class="docker-content">
          <div class="docker-toolbar">
            <button class="btn-refresh" onClick={() => loadImages()}>刷新</button>
          </div>
          <table class="docker-table">
            <thead>
              <tr>
                <th>镜像 ID</th>
                <th>标签</th>
                <th>大小</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <For each={images()}>
                {(image) => (
                  <tr>
                    <td class="cell-name">{image.id.slice(0, 12)}</td>
                    <td>{image.repo_tags.join(", ")}</td>
                    <td>{formatBytes(image.size)}</td>
                    <td class="cell-actions">
                      <button class="btn-action btn-remove" onClick={() => handleImageAction("remove", image.id)}>删除</button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* Volumes Tab */}
      <Show when={activeTab() === "volumes" && !loading()}>
        <div class="docker-content">
          <div class="docker-toolbar">
            <button class="btn-refresh" onClick={() => loadVolumes()}>刷新</button>
          </div>
          <table class="docker-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>驱动</th>
                <th>挂载点</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <For each={volumes()}>
                {(volume) => (
                  <tr>
                    <td class="cell-name">{volume.name}</td>
                    <td>{volume.driver}</td>
                    <td class="cell-mountpoint">{volume.mountpoint}</td>
                    <td class="cell-actions">
                      <button class="btn-action btn-remove" onClick={() => handleVolumeAction("remove", volume.name)}>删除</button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* Networks Tab */}
      <Show when={activeTab() === "networks" && !loading()}>
        <div class="docker-content">
          <div class="docker-toolbar">
            <button class="btn-refresh" onClick={() => loadNetworks()}>刷新</button>
          </div>
          <table class="docker-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>驱动</th>
                <th>作用域</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <For each={networks()}>
                {(network) => (
                  <tr>
                    <td class="cell-name">{network.id.slice(0, 12)}</td>
                    <td>{network.name}</td>
                    <td>{network.driver}</td>
                    <td>{network.scope}</td>
                    <td class="cell-actions">
                      <button class="btn-action btn-remove" onClick={() => handleNetworkAction("remove", network.id)}>删除</button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* System Tab */}
      <Show when={activeTab() === "system" && !loading() && systemInfo()}>
        <div class="docker-content">
          <div class="system-info">
            <h3>Docker 系统信息</h3>
            <div class="info-grid">
              <div class="info-item">
                <span class="info-label">服务器版本</span>
                <span class="info-value">{systemInfo()?.server_version}</span>
              </div>
              <div class="info-item">
                <span class="info-label">操作系统</span>
                <span class="info-value">{systemInfo()?.operating_system}</span>
              </div>
              <div class="info-item">
                <span class="info-label">架构</span>
                <span class="info-value">{systemInfo()?.architecture}</span>
              </div>
              <div class="info-item">
                <span class="info-label">容器总数</span>
                <span class="info-value">{systemInfo()?.containers}</span>
              </div>
              <div class="info-item">
                <span class="info-label">运行中容器</span>
                <span class="info-value">{systemInfo()?.containers_running}</span>
              </div>
              <div class="info-item">
                <span class="info-label">镜像总数</span>
                <span class="info-value">{systemInfo()?.images}</span>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};