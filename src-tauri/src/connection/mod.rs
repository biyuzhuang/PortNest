//! 连接管理器模块

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::Result;
use crate::protocol::{ConnectionHandle, PluginRegistry, SessionStatus};

/// 连接会话状态
pub struct ConnectionSession {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub protocol: &'static str,
    pub handle: Arc<dyn ConnectionHandle>,
    pub created_at: std::time::Instant,
    pub last_activity: std::sync::atomic::AtomicI64,
}

/// 连接管理器
pub struct ConnectionManager {
    sessions: RwLock<HashMap<Uuid, Arc<ConnectionSession>>>,
    plugin_registry: Arc<PluginRegistry>,
}

impl ConnectionManager {
    pub fn new(plugin_registry: Arc<PluginRegistry>) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            plugin_registry,
        }
    }

    /// 创建新会话
    pub fn create_session(
        &self,
        connection_id: Uuid,
        protocol: &'static str,
        handle: Arc<dyn ConnectionHandle>,
    ) -> Uuid {
        let session_id = Uuid::new_v4();
        let session = Arc::new(ConnectionSession {
            id: session_id,
            connection_id,
            protocol,
            handle,
            created_at: std::time::Instant::now(),
            last_activity: std::sync::atomic::AtomicI64::new(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64,
            ),
        });

        let mut sessions = self.sessions.write();
        sessions.insert(session_id, session.clone());

        session_id
    }

    /// 获取会话
    pub fn get_session(&self, session_id: Uuid) -> Option<Arc<ConnectionSession>> {
        let sessions = self.sessions.read();
        sessions.get(&session_id).cloned()
    }

    /// 获取所有活跃会话
    pub fn get_active_sessions(&self) -> Vec<Arc<ConnectionSession>> {
        let sessions = self.sessions.read();
        sessions
            .values()
            .filter(|s| s.handle.is_connected())
            .cloned()
            .collect()
    }

    /// 关闭会话
    pub fn close_session(&self, session_id: Uuid) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.write();
            sessions.remove(&session_id)
        };

        if let Some(_s) = session {
            // 触发断开连接
            // 注意: 这里需要协议插件实现 disconnect 方法
            tracing::info!("会话 {} 已关闭", session_id);
        }

        Ok(())
    }

    /// 更新最后活动时间
    pub fn touch_session(&self, session_id: Uuid) {
        let sessions = self.sessions.read();
        if let Some(session) = sessions.get(&session_id) {
            session.last_activity.store(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
    }

    /// 获取会话状态
    pub fn session_status(&self, session_id: Uuid) -> Option<SessionStatus> {
        let sessions = self.sessions.read();
        sessions.get(&session_id).map(|s| s.handle.status())
    }

    /// 清理断开连接的会话
    pub fn cleanup_disconnected(&self) {
        let mut sessions = self.sessions.write();
        sessions.retain(|_, s| s.handle.is_connected());
    }

    /// 获取插件注册表
    pub fn plugin_registry(&self) -> &Arc<PluginRegistry> {
        &self.plugin_registry
    }
}
