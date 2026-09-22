//! SSH 主机状态仪表盘采集器（阶段三，0.4.0）。
//!
//! 设计要点：
//! - 仅面向 Linux 主机，全部使用只读命令与 `/proc`、`/sys` 虚拟文件。
//! - 通过 `SshSessionPool` 与终端共享同一条 SSH transport，每个探测组使用
//!   独立的临时 Exec Channel，绝不写入用户 PTY。
//! - 每个探测组有独立超时；单组失败只降级该组，不影响其它指标继续展示。
//! - 保留每组上次成功结果：本轮失败时回退为旧值并标记 `stale`。
//! - 支持取消令牌：面板关闭或切换连接时在探测间隙快速放弃本轮采集。
//! - 命令缺失（能力探测失败）时该组标记为不可用，而不是整体报错。

use crate::protocol::ssh_backend::{
    session_pool_key, CancellationToken, ExecResult, SshSession,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::time::timeout;

use super::{credential_from_data, parse_connection_options, resolve_ssh_options, AppState};

/// 单个探测组的超时上限。
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
/// 获取 SSH 会话的超时上限。
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(12);
/// 探测组之间的分隔标记，保证输出可稳定切分。
const SPLIT: &str = "__PORTNEST_SPLIT__";
/// 网络速率计算所用的最小采样间隔，低于该值视为无法可靠计算。
const MIN_RATE_INTERVAL: Duration = Duration::from_millis(700);
/// 探测命令自标识标记（shell 空操作 `: ` 前缀），采集进程列表时排除自身。
const PROBE_MARK: &str = "__PORTNEST_PROBE";

#[derive(Debug, Clone, Serialize)]
pub struct SectionIssue {
    pub section: String,
    pub reason: String,
    /// 本轮失败但回退展示了上次成功结果。
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub uptime_secs: u64,
    pub load: [f64; 3],
    pub users: u32,
    pub cores: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreUsage {
    pub index: u32,
    pub percent: f64,
    pub user: f64,
    pub system: f64,
    pub iowait: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CpuInfo {
    /// 平均使用率（0-100）。
    pub total: f64,
    pub user: f64,
    pub system: f64,
    pub iowait: f64,
    pub steal: f64,
    pub cores: Vec<CoreUsage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryInfo {
    pub total_b: u64,
    pub used_b: u64,
    pub available_b: u64,
    pub percent: f64,
    pub swap_total_b: u64,
    pub swap_used_b: u64,
    pub swap_percent: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MountInfo {
    pub fs: String,
    pub mount: String,
    pub total_b: u64,
    pub used_b: u64,
    pub avail_b: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskInfo {
    pub root_percent: Option<f64>,
    pub root_total_b: u64,
    pub root_used_b: u64,
    pub mounts: Vec<MountInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InterfaceTraffic {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkInfo {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// 字节/秒；首轮采样或间隔过短时为 None。
    pub rx_rate: Option<f64>,
    pub tx_rate: Option<f64>,
    pub interfaces: Vec<InterfaceTraffic>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub cpu: f64,
    pub mem_percent: f64,
    pub rss_b: u64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub utilization: f64,
    pub temperature: f64,
    pub mem_used_b: u64,
    pub mem_total_b: u64,
    pub power_watts: Option<f64>,
}

/// 一次仪表盘采集的完整快照。
#[derive(Debug, Clone, Serialize, Default)]
pub struct DashboardSnapshot {
    pub connection_id: String,
    /// 采集完成时间（毫秒时间戳）。
    pub collected_at: u64,
    pub duration_ms: u64,
    /// 当前 SSH 后端是否支持 exec 采集（ssh2 兼容后端不支持）。
    pub backend_supported: bool,
    /// 整体性提示（例如后端不支持）。
    pub message: Option<String>,
    /// 各组失败/降级说明。
    pub issues: Vec<SectionIssue>,
    pub system: Option<SystemInfo>,
    pub cpu: Option<CpuInfo>,
    pub memory: Option<MemoryInfo>,
    pub disk: Option<DiskInfo>,
    pub network: Option<NetworkInfo>,
    pub processes: Option<Vec<ProcessInfo>>,
    pub gpu: Option<Vec<GpuInfo>>,
}

impl DashboardSnapshot {
    fn empty(connection_id: &str) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            backend_supported: true,
            ..Default::default()
        }
    }

    fn set_issue(&mut self, section: &str, reason: String, stale: bool) {
        self.issues
            .retain(|item| item.section != section);
        self.issues.push(SectionIssue {
            section: section.to_string(),
            reason,
            stale,
        });
    }

    fn clear_issue(&mut self, section: &str) {
        self.issues.retain(|item| item.section != section);
    }
}

struct CollectorState {
    /// 每个 connection_id 上次完整快照，用于本轮失败时回退展示。
    cache: Mutex<HashMap<String, DashboardSnapshot>>,
    /// 网络速率所需的上次计数 (rx, tx, 采样时刻)。
    net_prev: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// 每个 connection_id 的活动取消令牌（新采集轮替换旧令牌）。
    tokens: Mutex<HashMap<String, CancellationToken>>,
    /// 持有的会话租约 (pool key, owner)，面板关闭时释放。
    leases: Mutex<HashMap<String, (String, String)>>,
    /// GPU 能力探测结果缓存：true=有 nvidia-smi。
    gpu_support: Mutex<HashMap<String, bool>>,
}

/// 仪表盘采集管理器。
pub struct DashboardManager {
    state: CollectorState,
}

impl Default for DashboardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DashboardManager {
    pub fn new() -> Self {
        Self {
            state: CollectorState {
                cache: Mutex::new(HashMap::new()),
                net_prev: Mutex::new(HashMap::new()),
                tokens: Mutex::new(HashMap::new()),
                leases: Mutex::new(HashMap::new()),
                gpu_support: Mutex::new(HashMap::new()),
            },
        }
    }
}

/// 取消指定连接的进行中采集，并释放其持有的 SSH 会话租约。
#[tauri::command]
pub async fn dashboard_cancel(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    if let Some(token) = state
        .dashboard_manager
        .state
        .tokens
        .lock()
        .get(&connection_id)
        .cloned()
    {
        token.cancel();
    }
    let lease = state
        .dashboard_manager
        .state
        .leases
        .lock()
        .remove(connection_id.as_str());
    if let Some((key, owner)) = lease {
        state.ssh_session_pool.release(&key, &owner).await;
    }
    Ok(())
}

/// 采集一次主机状态快照。
///
/// 调用方（前端）按设置的刷新频率轮询；面板关闭时必须调用 `dashboard_cancel`。
#[tauri::command]
pub async fn dashboard_collect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DashboardSnapshot, String> {
    let started = Instant::now();
    let connections = state.db.get_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "连接未找到".to_string())?
        .clone();

    if conn.protocol != "ssh" {
        return Err("仪表盘仅支持 SSH 连接".to_string());
    }

    // 会话健康门控：只在终端 SSH 会话正常时采集；会话异常时不得收集，
    // 并释放此前持有的会话租约（避免让断开的 transport 挂在池里）。
    if !state.shell_manager.has_live_shell(&connection_id) {
        if let Some(token) = state
            .dashboard_manager
            .state
            .tokens
            .lock()
            .get(&connection_id)
            .cloned()
        {
            token.cancel();
        }
        let lease = state
            .dashboard_manager
            .state
            .leases
            .lock()
            .remove(connection_id.as_str());
        if let Some((key, owner)) = lease {
            state.ssh_session_pool.release(&key, &owner).await;
        }
        return Err("SSH 会话未连接，已暂停采集".to_string());
    }

    let cred_data = state
        .db
        .get_credential_structured(&conn.credential_id)
        .map_err(|e| e.to_string())?;
    let credential = credential_from_data(&cred_data)?;
    let options = resolve_ssh_options(
        state.inner(),
        &connection_id,
        parse_connection_options(conn.options.as_deref())?,
        &cred_data,
    )?;
    let target = crate::protocol::ssh_backend::ConnectionTarget {
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone().unwrap_or_default(),
    };

    let mut snapshot = DashboardSnapshot::empty(&connection_id);

    // ssh2 兼容后端没有 exec 能力，直接返回明确的不可用说明。
    if !backend_supports_exec(&options) {
        snapshot.backend_supported = false;
        snapshot.message = Some(
            "当前 SSH 后端为 ssh2 兼容模式，不支持仪表盘采集。请在连接高级选项中切换为 russh 后端。"
                .to_string(),
        );
        return Ok(snapshot);
    }

    let lease_key = session_pool_key(&connection_id, &target, &credential, &options);
    let lease_owner = format!("dashboard:{connection_id}");
    let backend = state.ssh_backend(&options);
    let session = match timeout(
        ACQUIRE_TIMEOUT,
        state.ssh_session_pool.acquire(
            lease_key.clone(),
            lease_owner.clone(),
            backend,
            &target,
            &credential,
            &options,
        ),
    )
    .await
    {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => return Err("建立 SSH 连接超时".to_string()),
    };

    state
        .dashboard_manager
        .state
        .leases
        .lock()
        .insert(connection_id.clone(), (lease_key, lease_owner));

    let token = CancellationToken::default();
    state
        .dashboard_manager
        .state
        .tokens
        .lock()
        .insert(connection_id.clone(), token.clone());

    // 探测结果先落袋，再统一合并：读取上次成功快照用于失败回退。
    let (system, cpu, memory, disk, network, processes, gpu) = tokio::join!(
        probe_system(&session, &token),
        probe_cpu(&session, &token),
        probe_memory(&session, &token),
        probe_disk(&session, &token),
        probe_network(&session, &token),
        probe_processes(&session, &token),
        probe_gpu(&state, &connection_id, &session, &token),
    );

    if token.is_cancelled() {
        // 本轮取消：直接返回，不写缓存。
        snapshot.message = Some("采集已取消".to_string());
        return Ok(snapshot);
    }

    let previous = state
        .dashboard_manager
        .state
        .cache
        .lock()
        .get(&connection_id)
        .cloned();

    merge_probe(&mut snapshot, "system", system, previous.as_ref());
    merge_probe(&mut snapshot, "cpu", cpu, previous.as_ref());
    merge_probe(&mut snapshot, "memory", memory, previous.as_ref());
    merge_probe(&mut snapshot, "disk", disk, previous.as_ref());
    merge_probe(&mut snapshot, "network", network, previous.as_ref());
    if let Some(mut info) = snapshot.network.take() {
        compute_rates(
            &state.dashboard_manager.state.net_prev,
            &connection_id,
            &mut info,
        );
        snapshot.network = Some(info);
    }
    merge_probe(&mut snapshot, "processes", processes, previous.as_ref());
    merge_probe(&mut snapshot, "gpu", gpu, previous.as_ref());

    // CPU 解析成功后补齐核心数到系统信息。
    if let (Some(cpu_info), Some(system_info)) = (snapshot.cpu.as_ref(), snapshot.system.as_mut()) {
        system_info.cores = cpu_info.cores.len() as u32;
    }

    snapshot.duration_ms = started.elapsed().as_millis() as u64;
    snapshot.collected_at = unix_millis();

    state
        .dashboard_manager
        .state
        .cache
        .lock()
        .insert(connection_id.clone(), snapshot.clone());

    Ok(snapshot)
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn backend_supports_exec(options: &crate::protocol::ConnectionOptions) -> bool {
    options
        .protocol_options
        .get("ssh_backend")
        .map(String::as_str)
        != Some("ssh2")
}

/// 探测组结果：成功携带原始输出；失败携带原因；None 表示采集被取消/跳过。
type ProbeResult = std::result::Result<Option<String>, String>;

/// 合并一个探测组的结果到快照：
/// - 成功 → 解析写入，清除该组 issue；
/// - 失败 → 若上次成功则回退旧值并标记 stale，否则标记不可用；
/// - 取消/超时中断 → 不改动该组。
fn merge_probe(
    snapshot: &mut DashboardSnapshot,
    section: &str,
    result: ProbeResult,
    previous: Option<&DashboardSnapshot>,
) {
    match result {
        Ok(Some(raw)) => match parse_into(snapshot, section, &raw) {
            Ok(true) => snapshot.clear_issue(section),
            Ok(false) => {
                // 稳定性的能力缺失（命令不存在等）：不回退旧值。
                snapshot.set_issue(section, "命令或数据源不可用，已跳过".to_string(), false);
            }
            Err(reason) => {
                snapshot.set_issue(section, reason, false);
            }
        },
        Ok(None) => {}
        Err(reason) => {
            let restored = previous
                .map(|prev| copy_section(prev, section, snapshot))
                .unwrap_or(false);
            if restored {
                snapshot.set_issue(section, format!("{reason}；展示上次结果"), true);
            } else {
                snapshot.set_issue(section, reason, false);
            }
        }
    }
}

/// 解析指定组的原始输出并直接写入快照字段。返回 Ok(true) 表示解析成功。
fn parse_into(snapshot: &mut DashboardSnapshot, section: &str, raw: &str) -> Result<bool, String> {
    match section {
        "system" => match parse_system(raw)? {
            Some(value) => {
                snapshot.system = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        "cpu" => match parse_cpu(raw)? {
            Some(value) => {
                snapshot.cpu = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        "memory" => match parse_memory(raw)? {
            Some(value) => {
                snapshot.memory = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        "disk" => match parse_disk(raw)? {
            Some(value) => {
                snapshot.disk = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        "network" => match parse_network(raw)? {
            Some(value) => {
                snapshot.network = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        "processes" => match parse_processes(raw)? {
            Some(value) => {
                snapshot.processes = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        "gpu" => match parse_gpu(raw)? {
            Some(value) => {
                snapshot.gpu = Some(value);
                Ok(true)
            }
            None => Ok(false),
        },
        _ => Ok(false),
    }
}

/// 把旧快照中某组的数据回退到新快照（失败降级用）。
fn copy_section(previous: &DashboardSnapshot, section: &str, snapshot: &mut DashboardSnapshot) -> bool {
    match section {
        "system" if previous.system.is_some() => {
            snapshot.system = previous.system.clone();
            true
        }
        "cpu" if previous.cpu.is_some() => {
            snapshot.cpu = previous.cpu.clone();
            true
        }
        "memory" if previous.memory.is_some() => {
            snapshot.memory = previous.memory.clone();
            true
        }
        "disk" if previous.disk.is_some() => {
            snapshot.disk = previous.disk.clone();
            true
        }
        "network" if previous.network.is_some() => {
            snapshot.network = previous.network.clone();
            true
        }
        "processes" if previous.processes.is_some() => {
            snapshot.processes = previous.processes.clone();
            true
        }
        "gpu" if previous.gpu.is_some() => {
            snapshot.gpu = previous.gpu.clone();
            true
        }
        _ => false,
    }
}

/// 用上次网络计数计算速率；上一轮采样过旧或计数回退（重连）时置 None。
fn compute_rates(
    net_prev: &Mutex<HashMap<String, (u64, u64, Instant)>>,
    connection_id: &str,
    info: &mut NetworkInfo,
) {
    let mut prevs = net_prev.lock();
    let now = Instant::now();
    match prevs.get(connection_id) {
        Some((prev_rx, prev_tx, at))
            if now.duration_since(*at) >= MIN_RATE_INTERVAL
                && info.rx_bytes >= *prev_rx
                && info.tx_bytes >= *prev_tx =>
        {
            let dt = now.duration_since(*at).as_secs_f64();
            info.rx_rate = Some((info.rx_bytes - prev_rx) as f64 / dt);
            info.tx_rate = Some((info.tx_bytes - prev_tx) as f64 / dt);
        }
        _ => {
            info.rx_rate = None;
            info.tx_rate = None;
        }
    }
    prevs.insert(connection_id.to_string(), (info.rx_bytes, info.tx_bytes, now));
}

/// 执行单个探测命令：独立 Exec Channel + 超时 + 取消。
///
/// exec 放入独立任务执行：超时或取消时放弃的是「等待结果」，而不是把
/// russh Channel 的 future 从 await 点上撕下来。后台任务会把该通道自然
/// 读到 EOF，避免在共享 transport 上遗留半开通道干扰 Shell 等其它 Channel。
///
/// 命令统一带 `: __PORTNEST_PROBE;` 前缀（`: ` 为 shell 空操作），进程
/// 采集据此用 `grep -v` 排除采集器自身的 bash 进程。
async fn run_probe(
    session: &Arc<dyn SshSession>,
    token: &CancellationToken,
    command: &str,
) -> ProbeResult {
    let marked_command = format!(": {PROBE_MARK}; {command}");
    let exec_task = tokio::spawn({
        let session = session.clone();
        async move {
            // 硬性上限：超时再翻倍，防止远端命令挂死导致通道永不释放。
            match timeout(PROBE_TIMEOUT * 2, session.exec(&marked_command)).await {
                Ok(result) => result,
                Err(_) => Err(crate::error::Error::Timeout(format!(
                    "探测命令硬超时（{}s）",
                    (PROBE_TIMEOUT.as_secs() * 2)
                ))),
            }
        }
    });

    tokio::select! {
        _ = token.cancelled() => Ok(None),
        result = timeout(PROBE_TIMEOUT, exec_task) => {
            match result {
                // 超时：任务继续在后台跑完并释放通道，本轮按失败降级。
                Err(_) => Err(format!("命令执行超时（{}s）", PROBE_TIMEOUT.as_secs())),
                Ok(Err(join_error)) => Err(format!("探测任务失败: {join_error}")),
                Ok(Ok(Err(error))) => Err(error.to_string()),
                Ok(Ok(Ok(result))) => finish_exec(result),
            }
        }
    }
}

fn finish_exec(result: ExecResult) -> ProbeResult {
    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    if result.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim().lines().last().unwrap_or("").to_string();
        if detail.is_empty() {
            Err(format!("命令退出码 {}，视为不可用", result.exit_code))
        } else {
            Err(format!("命令退出码 {}：{}", result.exit_code, detail))
        }
    } else if stdout.trim().is_empty() {
        Err("命令无输出，视为不可用".to_string())
    } else {
        Ok(Some(stdout))
    }
}

/// 把一条命令的输出按分隔符切分为多段。
fn segments(raw: &str) -> Vec<String> {
    raw.split(SPLIT).map(|s| s.trim().to_string()).collect()
}

// ---------------------------------------------------------------------------
// 探测命令定义（独立函数便于测试断言命令字符串）
// ---------------------------------------------------------------------------

fn probe_system_command() -> String {
    format!(
        "cat /proc/uptime; echo {SPLIT}; cat /proc/loadavg; echo {SPLIT}; \
         uname -s -r -m 2>/dev/null; echo {SPLIT}; \
         (grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null || true); echo {SPLIT}; \
         hostname 2>/dev/null; echo {SPLIT}; \
         (who 2>/dev/null | grep -c . || echo 0)"
    )
}

fn probe_cpu_command() -> String {
    // 单通道内两次采样：先取计数，停顿后取第二次，避免多次往返。
    format!(
        "awk '/^cpu[0-9]* /{{print}}' /proc/stat; echo {SPLIT}; \
         (sleep 0.5 2>/dev/null || sleep 1); \
         awk '/^cpu[0-9]* /{{print}}' /proc/stat"
    )
}

fn probe_memory_command() -> String {
    "cat /proc/meminfo".to_string()
}

fn probe_disk_command() -> String {
    // POSIX 输出格式，列固定：Filesystem 1024-blocks Used Available Capacity Mounted-on。
    "df -kP 2>/dev/null".to_string()
}

fn probe_network_command() -> String {
    "cat /proc/net/dev".to_string()
}

fn probe_processes_command() -> String {
    // 采集 pid/ppid/pcpu/pmem/rss/args：
    // - CPU Top 段取前 60 行（保证高占用进程可见）；
    // - sshd 段用 `grep '[s]shd:'`（字符类自避）抓取全部 sshd 行，用于把
    //   `sshd: user [priv]` 与其子进程 `sshd: user@pts/N` 归组合并成单行
    //   `sshd: user@pts/0,pts/1` 展示；
    // - `grep -v __PORTNEST_PROBE` 排除采集器自身（所有探测命令带该前缀，
    //   见 run_probe），并发探测的 bash 进程不会出现在快照里。
    //
    // 命令字符串不含字面 "ssh" 子串（sshd 段写作 [s]shd:），手动执行
    // `ps -ef | grep ssh` 的用户撞不到采集命令本身。
    // 解析端按 pid 去重，因此两段重复行无害。
    concat!(
        "(ps axo pid=,ppid=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n 60; ",
        "ps axo pid=,ppid=,pcpu=,pmem=,rss=,args= 2>/dev/null | grep '[s]shd:') ",
        "| grep -v '__PORTNEST_PROBE'"
    ).to_string()
}

fn probe_fallback_command() -> String {
    "ps axo pid,ppid,pcpu,pmem,rss,args 2>/dev/null | head -n 80".to_string()
}

fn gpu_capability_command() -> String {
    "command -v nvidia-smi 2>/dev/null".to_string()
}

fn gpu_query_command() -> String {
    "nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits 2>/dev/null".to_string()
}

// ---------------------------------------------------------------------------
// 各探测组
// ---------------------------------------------------------------------------

async fn probe_system(session: &Arc<dyn SshSession>, token: &CancellationToken) -> ProbeResult {
    run_probe(session, token, &probe_system_command()).await
}

async fn probe_cpu(session: &Arc<dyn SshSession>, token: &CancellationToken) -> ProbeResult {
    run_probe(session, token, &probe_cpu_command()).await
}

async fn probe_memory(session: &Arc<dyn SshSession>, token: &CancellationToken) -> ProbeResult {
    run_probe(session, token, &probe_memory_command()).await
}

async fn probe_disk(session: &Arc<dyn SshSession>, token: &CancellationToken) -> ProbeResult {
    run_probe(session, token, &probe_disk_command()).await
}

async fn probe_network(session: &Arc<dyn SshSession>, token: &CancellationToken) -> ProbeResult {
    run_probe(session, token, &probe_network_command()).await
}

async fn probe_processes(session: &Arc<dyn SshSession>, token: &CancellationToken) -> ProbeResult {
    if let result @ Ok(Some(_)) = run_probe(session, token, &probe_processes_command()).await {
        return result;
    }
    run_probe(session, token, &probe_fallback_command()).await
}

async fn probe_gpu(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
    session: &Arc<dyn SshSession>,
    token: &CancellationToken,
) -> ProbeResult {
    let known = state
        .dashboard_manager
        .state
        .gpu_support
        .lock()
        .get(connection_id)
        .copied()
        .unwrap_or(false);
    if !known {
        // 能力探测：nvidia-smi 是否存在；结果按连接缓存。
        match run_probe(session, token, &gpu_capability_command()).await {
            Ok(Some(raw)) => {
                let present = raw.trim().contains("nvidia-smi");
                state
                    .dashboard_manager
                    .state
                    .gpu_support
                    .lock()
                    .insert(connection_id.to_string(), present);
                if !present {
                    return Err("未安装 nvidia-smi，GPU 指标跳过".to_string());
                }
            }
            _ => {
                return Err("GPU 能力探测失败，GPU 指标跳过".to_string());
            }
        }
    }

    run_probe(session, token, &gpu_query_command()).await
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

fn parse_system(raw: &str) -> Result<Option<SystemInfo>, String> {
    let parts = segments(raw);
    if parts.len() < 6 {
        return Err("系统信息输出不完整".to_string());
    }
    let uptime_secs = parts[0]
        .split_whitespace()
        .next()
        .and_then(|v| v.split('.').next())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let load = parse_loadavg(&parts[1]);
    let uname = parts[2].split_whitespace().map(str::to_string).collect::<Vec<_>>();
    let kernel = uname.get(1).cloned().unwrap_or_default();
    let arch = uname.get(2).cloned().unwrap_or_default();
    let os = parts[3]
        .strip_prefix("PRETTY_NAME=")
        .map(|v| v.trim_matches('"').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "未知系统".to_string());
    let hostname = parts[4].lines().next().unwrap_or("").trim().to_string();
    let users = parts[5].trim().parse::<u32>().unwrap_or(0);
    Ok(Some(SystemInfo {
        hostname,
        os,
        kernel,
        arch,
        uptime_secs,
        load,
        users,
        cores: 0,
    }))
}

fn parse_loadavg(raw: &str) -> [f64; 3] {
    let mut values = [0.0f64; 3];
    for (slot, token) in raw.split_whitespace().take(3).enumerate() {
        values[slot] = token.parse().unwrap_or(0.0);
    }
    values
}

/// `/proc/stat` 的 "cpu" 行字段：user nice system idle iowait irq softirq steal ...
#[derive(Clone, Copy, Default)]
struct CpuTimes {
    user: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    steal: u64,
    total: u64,
}

fn parse_cpu_times(line: &str) -> Option<CpuTimes> {
    let mut fields = line.split_whitespace();
    let label = fields.next()?;
    if !label.starts_with("cpu") {
        return None;
    }
    let values: Vec<u64> = fields.filter_map(|v| v.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    let at = |i: usize| values.get(i).copied().unwrap_or(0);
    let user = at(0) + at(1); // user + nice
    let system = at(2);
    let idle = at(3);
    let iowait = at(4);
    let irq = at(5);
    let softirq = at(6);
    let steal = at(7);
    let total = user + system + idle + iowait + irq + softirq + steal;
    Some(CpuTimes { user, system, idle, iowait, steal, total })
}

/// 计算两个采样之间的使用率与分项占比（百分比）。
fn usage_between(prev: CpuTimes, cur: CpuTimes) -> Option<(f64, f64, f64, f64, f64)> {
    let dt = cur.total.checked_sub(prev.total)?;
    if dt == 0 {
        return None;
    }
    let pct = |field: u64, base: u64| base.saturating_sub(field) as f64 * 100.0 / dt as f64;
    let idle_delta = cur.idle.saturating_sub(prev.idle) + cur.iowait.saturating_sub(prev.iowait);
    let used = 100.0 - idle_delta as f64 * 100.0 / dt as f64;
    Some((
        used.clamp(0.0, 100.0),
        pct(prev.user, cur.user),
        pct(prev.system, cur.system),
        pct(prev.iowait, cur.iowait),
        pct(prev.steal, cur.steal),
    ))
}

fn parse_cpu(raw: &str) -> Result<Option<CpuInfo>, String> {
    let parts = segments(raw);
    if parts.len() < 2 {
        return Err("CPU 采样输出不完整".to_string());
    }
    let first: Vec<&str> = parts[0].lines().collect();
    let second: Vec<&str> = parts[1].lines().collect();

    let total_first = first
        .iter()
        .find(|l| l.starts_with("cpu "))
        .and_then(|l| parse_cpu_times(l));
    let total_second = second
        .iter()
        .find(|l| l.starts_with("cpu "))
        .and_then(|l| parse_cpu_times(l));
    let (total, user, system, iowait, steal) = match (total_first, total_second) {
        (Some(p), Some(c)) => match usage_between(p, c) {
            Some(v) => v,
            None => return Ok(None),
        },
        _ => return Err("CPU 采样数据缺失".to_string()),
    };

    let mut cores = Vec::new();
    for line in &second {
        let label = line.split_whitespace().next().unwrap_or("");
        if !label.starts_with("cpu") || label == "cpu" {
            continue;
        }
        let index: u32 = match label[3..].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let prev = first
            .iter()
            .find(|l| l.starts_with(&format!("{label} ")))
            .and_then(|l| parse_cpu_times(l));
        let cur = parse_cpu_times(line);
        if let (Some(p), Some(c)) = (prev, cur) {
            if let Some((percent, user, system, iowait, _)) = usage_between(p, c) {
                cores.push(CoreUsage { index, percent, user, system, iowait });
            }
        }
    }
    cores.sort_by_key(|c| c.index);

    Ok(Some(CpuInfo { total, user, system, iowait, steal, cores }))
}

fn parse_memory(raw: &str) -> Result<Option<MemoryInfo>, String> {
    let mut mem_total = 0u64;
    let mut mem_available: Option<u64> = None;
    let mut mem_free = 0u64;
    let mut buffers = 0u64;
    let mut cached = 0u64;
    let mut s_reclaimed = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;
    for line in raw.lines() {
        let mut fields = line.split_whitespace();
        let key = fields.next().unwrap_or("");
        let value = fields.next().and_then(|v| v.parse::<u64>().ok());
        match (key, value) {
            ("MemTotal:", Some(v)) => mem_total = v * 1024,
            ("MemAvailable:", Some(v)) => mem_available = Some(v * 1024),
            ("MemFree:", Some(v)) => mem_free = v * 1024,
            ("Buffers:", Some(v)) => buffers = v * 1024,
            ("Cached:", Some(v)) => cached = v * 1024,
            ("SReclaimable:", Some(v)) => s_reclaimed = v * 1024,
            ("SwapTotal:", Some(v)) => swap_total = v * 1024,
            ("SwapFree:", Some(v)) => swap_free = v * 1024,
            _ => {}
        }
    }
    if mem_total == 0 {
        return Err("内存数据缺失".to_string());
    }
    let available =
        mem_available.unwrap_or(mem_free + buffers + cached + s_reclaimed);
    let used = mem_total.saturating_sub(available);
    let swap_used = swap_total.saturating_sub(swap_free);
    Ok(Some(MemoryInfo {
        total_b: mem_total,
        used_b: used,
        available_b: available,
        percent: used as f64 * 100.0 / mem_total as f64,
        swap_total_b: swap_total,
        swap_used_b: swap_used,
        swap_percent: if swap_total > 0 {
            swap_used as f64 * 100.0 / swap_total as f64
        } else {
            0.0
        },
    }))
}

/// 判断挂载项是否为纯伪文件系统（排序时置于真实磁盘之后）。
fn is_pseudo_fs(fs: &str, mount: &str) -> bool {
    let pseudo = [
        "proc", "sysfs", "devpts", "tmpfs", "devtmpfs", "overlay", "squashfs", "ramfs", "cgroup",
        "cgroup2", "bpf", "tracefs", "debugfs", "securityfs", "pstore", "efivarfs", "configfs",
        "fusectl", "hugetlbfs", "mqueue", "nsfs", "binfmt_misc", "autofs", "rpc_pipefs",
    ];
    if pseudo.contains(&fs) {
        return true;
    }
    mount == "/dev" || mount.starts_with("/sys/") || mount.starts_with("/proc/")
}

fn parse_disk(raw: &str) -> Result<Option<DiskInfo>, String> {
    let mut mounts = Vec::new();
    for line in raw.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let fs = fields[0].to_string();
        let total_kib: u64 = fields[1].parse().unwrap_or(0);
        let used_kib: u64 = fields[2].parse().unwrap_or(0);
        let avail_kib: u64 = fields[3].parse().unwrap_or(0);
        let percent: f64 = fields[4].trim_end_matches('%').parse().unwrap_or(0.0);
        let mount = fields[5..].join(" ");
        if total_kib == 0 {
            continue;
        }
        mounts.push(MountInfo {
            fs,
            mount,
            total_b: total_kib * 1024,
            used_b: used_kib * 1024,
            avail_b: avail_kib * 1024,
            percent,
        });
    }
    if mounts.is_empty() {
        return Err("磁盘数据缺失".to_string());
    }
    mounts.sort_by(|a, b| {
        let pa = is_pseudo_fs(&a.fs, &a.mount) as u8;
        let pb = is_pseudo_fs(&b.fs, &b.mount) as u8;
        pa.cmp(&pb).then(a.mount.cmp(&b.mount))
    });
    let root = mounts.iter().find(|m| m.mount == "/");
    Ok(Some(DiskInfo {
        root_percent: root.map(|m| m.percent),
        root_total_b: root.map(|m| m.total_b).unwrap_or(0),
        root_used_b: root.map(|m| m.used_b).unwrap_or(0),
        mounts,
    }))
}

/// 判断是否为虚拟/容器网络接口。容器互访流量会在成对的 veth、docker0、
/// bridge、flannel/cali 等接口上重复计数，仪表盘只统计真实物理网卡。
fn is_virtual_interface(name: &str) -> bool {
    const PREFIXES: [&str; 13] = [
        "docker", "br-", "veth", "cali", "flannel", "cni", "kube", "virbr", "tun", "tap", "wg",
        "vz", "dummy",
    ];
    PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn parse_network(raw: &str) -> Result<Option<NetworkInfo>, String> {
    let mut interfaces = Vec::new();
    let mut physical = Vec::new();
    for line in raw.lines().skip(1) {
        let Some((name, rest)) = line.split_once(':') else { continue };
        let name = name.trim().to_string();
        if name == "lo" {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if fields.len() < 9 {
            continue;
        }
        let interface = InterfaceTraffic {
            name: name.clone(),
            rx_bytes: fields[0],
            tx_bytes: fields[8],
        };
        interfaces.push(interface.clone());
        if !is_virtual_interface(&name) {
            physical.push(interface);
        }
    }
    if interfaces.is_empty() {
        return Err("网络数据缺失".to_string());
    }
    // 只统计真实物理网卡；机器全是虚拟网卡时回退为全部（除 lo）。
    let counted: &Vec<InterfaceTraffic> = if physical.is_empty() { &interfaces } else { &physical };
    let rx: u64 = counted.iter().map(|i| i.rx_bytes).sum();
    let tx: u64 = counted.iter().map(|i| i.tx_bytes).sum();
    Ok(Some(NetworkInfo {
        rx_bytes: rx,
        tx_bytes: tx,
        rx_rate: None,
        tx_rate: None,
        interfaces,
    }))
}

/// ps 行解析中间结构：pid ppid pcpu pmem rss args。
#[derive(Debug, Clone)]
struct ProcessRow {
    pid: u32,
    ppid: u32,
    cpu: f64,
    mem: f64,
    rss_b: u64,
    args: String,
}

/// 按空白段（连续空格视为一个分隔）取一行前 n 个字段，返回剩余部分作为
/// args。`splitn(6, char::is_whitespace)` 会把 ps 列对齐的连续空格解析成
/// 空字段导致整行错位，必须按空白段扫描。
fn split_leading_fields(line: &str, n: usize) -> Option<(Vec<&str>, &str)> {
    let mut fields = Vec::with_capacity(n);
    let mut rest = line;
    for _ in 0..n {
        rest = rest.trim_start();
        if rest.is_empty() {
            return None;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        fields.push(&rest[..end]);
        rest = &rest[end..];
    }
    Some((fields, rest.trim_start()))
}

fn parse_process_rows(raw: &str) -> Vec<ProcessRow> {
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in raw.lines() {
        // 前 5 列为数字（pid ppid pcpu pmem rss），剩余整段为 args。
        let Some((fields, args)) = split_leading_fields(line, 5) else { continue };
        let Ok(pid) = fields[0].parse::<u32>() else { continue };
        // 双保险：即使远端 grep -v 失效，解析端也排除采集器自身进程。
        if line.contains(PROBE_MARK) {
            continue;
        }
        // 去重：CPU Top 段与 sshd 段可能输出同一进程两行。
        if !seen.insert(pid) {
            continue;
        }
        let ppid: u32 = fields[1].parse().unwrap_or(0);
        let cpu: f64 = fields[2].parse().unwrap_or(0.0);
        let mem: f64 = fields[3].parse().unwrap_or(0.0);
        let rss_kib: u64 = fields[4].parse().unwrap_or(0);
        rows.push(ProcessRow {
            pid,
            ppid,
            cpu,
            mem,
            rss_b: rss_kib * 1024,
            args: args.to_string(),
        });
    }
    rows
}

/// 把 `sshd: user [priv]` 父进程与其子进程 `sshd: user@pts/N` 合并成
/// `sshd: user@pts/0,pts/1` 单行展示（其他工具的通用形式）。
fn merge_sshd_rows(rows: Vec<ProcessRow>) -> Vec<ProcessRow> {
    let mut result = Vec::with_capacity(rows.len());
    // priv pid -> 该 priv 下所有 @pts 子进程。
    let mut children_by_priv: HashMap<u32, Vec<ProcessRow>> = HashMap::new();
    let mut consumed_pids = std::collections::HashSet::new();

    for row in &rows {
        if sshd_session_args(&row.args).is_some() {
            children_by_priv
                .entry(row.ppid)
                .or_default()
                .push(row.clone());
            consumed_pids.insert(row.pid);
        }
    }

    for row in rows {
        if consumed_pids.contains(&row.pid) {
            continue; // @pts 子进程行，稍后以合并行形式出现。
        }
        if is_sshd_priv(&row.args) {
            if let Some(children) = children_by_priv.remove(&row.pid) {
                if children.is_empty() {
                    result.push(row);
                    continue;
                }
                // 合并为一行：pid 取第一个子进程，ppid 保留 priv 父 pid，
                // CPU/内存累加，名称 `sshd: user@pts/0,pts/1`。
                let pts: Vec<&str> = children
                    .iter()
                    .filter_map(|child| sshd_session_pts(&child.args))
                    .collect();
                let user = sshd_session_user(&children[0].args).unwrap_or_else(|| "user".to_string());
                let name = if pts.is_empty() {
                    children[0].args.clone()
                } else {
                    format!("sshd: {user}@{}", pts.join(","))
                };
                result.push(ProcessRow {
                    pid: children[0].pid,
                    ppid: row.ppid,
                    cpu: children.iter().map(|c| c.cpu).sum::<f64>(),
                    mem: children.iter().map(|c| c.mem).sum::<f64>(),
                    rss_b: children.iter().map(|c| c.rss_b).sum::<u64>(),
                    args: name,
                });
                continue;
            }
            // 没有匹配到子进程的 priv 行：原样保留。
        }
        result.push(row);
    }

    result
}

/// `sshd: root [priv]` 形式（特权分离父进程）。
fn is_sshd_priv(args: &str) -> bool {
    args.starts_with("sshd:") && args.trim_end().ends_with("[priv]")
}

/// `sshd: root@pts/0` 形式的会话进程。
fn sshd_session_args(args: &str) -> Option<()> {
    let rest = args.strip_prefix("sshd: ")?;
    let (_user, at_pts) = rest.split_once('@')?;
    if at_pts.is_empty() || at_pts.contains(' ') {
        return None;
    }
    Some(())
}

fn sshd_session_user(args: &str) -> Option<String> {
    let rest = args.strip_prefix("sshd: ")?;
    let (user, _) = rest.split_once('@')?;
    if user.is_empty() {
        None
    } else {
        Some(user.to_string())
    }
}

/// 提取 `sshd: root@pts/2` 中的 `pts/2`（或 `root@pts/2,pts/3` 的原始列表）。
fn sshd_session_pts(args: &str) -> Option<&str> {
    let rest = args.strip_prefix("sshd: ")?;
    let (_, pts) = rest.split_once('@')?;
    let pts = pts.trim();
    if pts.is_empty() {
        None
    } else {
        Some(pts)
    }
}

fn parse_processes(raw: &str) -> Result<Option<Vec<ProcessInfo>>, String> {
    let rows = parse_process_rows(raw);
    if rows.is_empty() {
        return Err("进程数据缺失".to_string());
    }
    let merged = merge_sshd_rows(rows);
    let mut processes: Vec<ProcessInfo> = merged
        .into_iter()
        .map(|row| ProcessInfo {
            pid: row.pid,
            cpu: row.cpu,
            mem_percent: row.mem,
            rss_b: row.rss_b,
            name: row.args,
        })
        .collect();
    // 合并后重新按 CPU 降序取前 12。
    processes.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    processes.truncate(12);
    Ok(Some(processes))
}

fn parse_gpu(raw: &str) -> Result<Option<Vec<GpuInfo>>, String> {
    let mut gpus = Vec::new();
    for line in raw.lines() {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 6 {
            continue;
        }
        let name = fields[0].to_string();
        if name.is_empty() {
            continue;
        }
        gpus.push(GpuInfo {
            name,
            utilization: fields[1].parse().unwrap_or(0.0),
            temperature: fields[2].parse().unwrap_or(0.0),
            mem_used_b: (fields[3].parse::<f64>().unwrap_or(0.0) * 1024.0 * 1024.0) as u64,
            mem_total_b: (fields[4].parse::<f64>().unwrap_or(0.0) * 1024.0 * 1024.0) as u64,
            power_watts: fields[5].parse().ok(),
        });
    }
    if gpus.is_empty() {
        return Err("GPU 数据缺失".to_string());
    }
    Ok(Some(gpus))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_split_by_marker() {
        let raw = "a\n__PORTNEST_SPLIT__\nb\n__PORTNEST_SPLIT__\nc";
        assert_eq!(segments(raw), vec!["a", "b", "c"]);
    }

    #[test]
    fn loadavg_parse() {
        assert_eq!(parse_loadavg("1.23 4.56 7.89 3/1200 1234"), [1.23, 4.56, 7.89]);
        assert_eq!(parse_loadavg("garbage"), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn cpu_usage_between_samples() {
        let a = CpuTimes { user: 100, system: 50, idle: 400, iowait: 10, steal: 0, total: 600 };
        let b = CpuTimes { user: 150, system: 60, idle: 500, iowait: 10, steal: 0, total: 730 };
        let (total, user, system, _, _) = usage_between(a, b).expect("usage");
        // dt=130，idle 增量=100 → 使用率 23.08%；user=50/130，system=10/130。
        assert!((total - 23.0769).abs() < 0.01, "total={total}");
        assert!((user - 50.0 / 1.30).abs() < 0.01);
        assert!((system - 10.0 / 1.30).abs() < 0.01);
    }

    #[test]
    fn meminfo_parse() {
        let raw = "MemTotal: 16000000 kB\nMemFree: 2000000 kB\nMemAvailable: 8000000 kB\nBuffers: 100000 kB\nCached: 3000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n";
        let info = parse_memory(raw).expect("ok").expect("some");
        assert_eq!(info.total_b, 16_000_000 * 1024);
        assert_eq!(info.available_b, 8_000_000 * 1024);
        assert_eq!(info.swap_used_b, 500_000 * 1024);
    }

    #[test]
    fn meminfo_fallback_without_available() {
        let raw = "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 200 kB\nSReclaimable: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
        let info = parse_memory(raw).expect("ok").expect("some");
        assert_eq!(info.available_b, 500 * 1024);
        assert!((info.percent - 50.0).abs() < 0.01);
    }

    #[test]
    fn df_parse_and_pseudo_ordering() {
        let raw = "Filesystem 1024-blocks Used Available Capacity Mounted-on\n/dev/vda1 50000000 20000000 28000000 42% /\ntmpfs 1000000 500000 500000 50% /run\noverlay 1000000 100000 900000 10% /var/lib/docker\n";
        let info = parse_disk(raw).expect("ok").expect("some");
        assert_eq!(info.root_percent, Some(42.0));
        assert_eq!(info.mounts[0].mount, "/");
        assert_eq!(info.mounts[1].mount, "/run");
        assert_eq!(info.mounts[2].mount, "/var/lib/docker");
    }

    #[test]
    fn net_dev_parse_excludes_loopback_and_virtual() {
        let raw = concat!(
            "Inter-|   Receive                                                |  Transmit\n",
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n",
            "  lo: 100 10 0 0 0 0 0 0 100 10 0 0 0 0 0 0\n",
            " eth0: 800 8 0 0 0 0 0 0 300 3 0 0 0 0 0 0\n",
            "docker0: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n",
            "veth1a2b3c: 5000 50 0 0 0 0 0 0 5000 50 0 0 0 0 0 0\n",
            "flannel.1: 4000 40 0 0 0 0 0 0 4000 40 0 0 0 0 0 0\n",
            "br-3f9a: 2000 20 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n",
        );
        let info = parse_network(raw).expect("ok").expect("some");
        // 速率/累计只计物理网卡，虚拟网卡被排除但保留在明细里。
        assert_eq!(info.rx_bytes, 800);
        assert_eq!(info.tx_bytes, 300);
        assert_eq!(info.interfaces.len(), 5, "虚拟网卡仍保留在明细中");
    }

    #[test]
    fn net_dev_parse_falls_back_when_all_virtual() {
        let raw = "  lo: 100 10 0 0 0 0 0 0 100 10 0 0 0 0 0 0\ndocker0: 1000 10 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n";
        let info = parse_network(raw).expect("ok").expect("some");
        assert_eq!(info.rx_bytes, 1000);
        assert_eq!(info.tx_bytes, 500);
    }

    #[test]
    fn processes_parse_merges_sshd_sessions() {
        // 使用真实 ps 输出的多空格对齐格式（曾因连续空格被解析成空字段导致
        // 整行错位，必须用空白段扫描解析）。
        let raw = concat!(
            "1832842      1  0.0  0.0    1024 sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups\n",
            "3569127 1832842  2.5  0.2    2048 sshd: root [priv]\n",
            "3569139 3569127  0.5  0.1    1024 sshd: root@pts/0\n",
            "3732141 1832842  1.5  0.2    2048 sshd: root [priv]\n",
            "3732160 3732141  0.5  0.1    1024 sshd: root@pts/1\n",
            "3749369 1832842  0.8  0.2    2048 sshd: root [priv]\n",
            "3749385 3749369  0.5  0.1    1024 sshd: root@pts/2\n",
            "3755901 3749369  0.5  0.1    1024 sshd: root@pts/3\n",
            "     999      1  9.9  1.0  500000 k3s\n",
            "    PID  PPID  %CPU  %MEM   RSS ARGS\n",
        );
        let list = parse_processes(raw).expect("ok").expect("some");
        // sshd 会话按 priv 父进程归组合并为单行。
        let sshd_lines: Vec<&ProcessInfo> = list.iter().filter(|p| p.name.starts_with("sshd: root@")).collect();
        assert_eq!(sshd_lines.len(), 3, "三组 sshd 会话应合并为三行");
        let merged_multi: Vec<&str> = sshd_lines.iter().map(|p| p.name.as_str()).collect();
        assert!(merged_multi.contains(&"sshd: root@pts/2,pts/3"), "合并 pts 列表: {merged_multi:?}");
        assert!(merged_multi.contains(&"sshd: root@pts/0"));
        assert!(merged_multi.contains(&"sshd: root@pts/1"));
        // [priv] 行不再出现。
        assert!(!list.iter().any(|p| p.name.contains("[priv]")));
        // CPU 降序，k3s 最高；列值不再错位。
        assert_eq!(list[0].name, "k3s");
        assert_eq!(list[0].pid, 999);
        assert!((list[0].cpu - 9.9).abs() < 0.01);
        assert_eq!(list[0].rss_b, 500000 * 1024);
        // 去重：同一进程只出现一次（含头行被跳过）。
        assert_eq!(list.len(), 5);
    }

    #[test]
    fn processes_parse_matches_real_output() {
        // 用户服务器实测输出（多空格对齐），验证列不再错位。
        let raw = "3952527 3952449  3.3  1.7 543664 /home/kuscia/bin/k3s server\n";
        let list = parse_processes(raw).expect("ok").expect("some");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "/home/kuscia/bin/k3s server");
        assert_eq!(list[0].pid, 3952527);
        assert!((list[0].cpu - 3.3).abs() < 0.01);
        assert!((list[0].mem_percent - 1.7).abs() < 0.01);
        assert_eq!(list[0].rss_b, 543664 * 1024);
    }

    #[test]
    fn processes_parse_excludes_probe_self() {
        let raw = concat!(
            "999 1 9.9 1.0 500000 k3s\n",
            "3942155 3749385 0.0 0.0 1024 bash -c (: __PORTNEST_PROBE; ps axo pid=,ppid=,... )\n",
            "3942185 3942155 0.0 0.0 1024 bash -c (: __PORTNEST_PROBE; ps axo ...)\n",
        );
        let list = parse_processes(raw).expect("ok").expect("some");
        assert_eq!(list.len(), 1, "自身 bash 进程应被解析端过滤: {list:?}");
        assert_eq!(list[0].name, "k3s");
    }

    #[test]
    fn probe_commands_contain_no_ssh_literal() {
        // 验收要求：采集命令字符串不含 "ssh" 字样，`ps -ef | grep ssh`
        // 撞不到采集命令本身。sshd 段必须写作 [s]shd:。
        assert!(!PROBE_MARK.contains("ssh"));
        for command in [
            probe_system_command(),
            probe_cpu_command(),
            probe_memory_command(),
            probe_disk_command(),
            probe_network_command(),
            probe_processes_command(),
            probe_fallback_command(),
            gpu_query_command(),
            "nvidia-smi --query-gpu=name --format=csv".to_string(),
        ] {
            let marked = format!(": {PROBE_MARK}; {command}");
            assert!(!marked.contains("ssh"), "命令包含 ssh 字样: {marked}");
        }
    }

    #[test]
    fn processes_parse_fallback_without_args() {
        // 列数不足时的容忍：args 缺失也能解析出数值列。
        let raw = "1234 0 1.2 3 500000 k3s\n";
        let list = parse_processes(raw).expect("ok").expect("some");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "k3s");
        assert_eq!(list[0].rss_b, 500000 * 1024);
    }

    #[test]
    fn gpu_parse() {
        let raw = "NVIDIA GeForce RTX 4090, 0.0, 34.0, 25, 2464, 9.20 W";
        let list = parse_gpu(raw).expect("ok").expect("some");
        assert_eq!(list.len(), 1);
        assert!(list[0].name.contains("4090"));
        assert!((list[0].temperature - 34.0).abs() < 0.01);
        assert!((list[0].mem_total_b as f64 - 2464.0 * 1024.0 * 1024.0).abs() < 1.0);
    }

    #[test]
    fn copy_section_falls_back() {
        let mut prev = DashboardSnapshot::empty("c1");
        prev.memory = Some(MemoryInfo {
            total_b: 1,
            used_b: 1,
            available_b: 0,
            percent: 100.0,
            swap_total_b: 0,
            swap_used_b: 0,
            swap_percent: 0.0,
        });
        let mut snapshot = DashboardSnapshot::empty("c1");
        assert!(copy_section(&prev, "memory", &mut snapshot));
        assert!(snapshot.memory.is_some());
        assert!(!copy_section(&prev, "gpu", &mut snapshot));
    }
}
