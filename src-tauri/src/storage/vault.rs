//! 凭据加密模块
//!
//! 使用 AES-256-GCM 加密凭据数据

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use pbkdf2::pbkdf2_hmac_array;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// 凭据保险库 - 负责凭据的加密和解密
pub struct CredentialVault {
    cipher: Aes256Gcm,
}

impl CredentialVault {
    /// 使用数据库路径派生主密钥
    pub fn new(db_path: &std::path::Path) -> Result<Self> {
        // 使用数据库路径作为盐派生主密钥
        let salt = Self::generate_salt(db_path)?;
        let key = pbkdf2_hmac_array::<Sha256, 32>(
            Self::get_master_password().as_bytes(),
            &salt,
            600_000,
        );

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| Error::EncryptionError(format!("创建加密器失败: {}", e)))?;

        Ok(Self { cipher })
    }

    /// 生成基于数据库路径的盐
    fn generate_salt(db_path: &std::path::Path) -> Result<[u8; 32]> {
        let path_str = db_path.to_string_lossy();
        let mut salt = [0u8; 32];
        let hash = Sha256::digest(path_str.as_bytes());
        salt.copy_from_slice(&hash);
        Ok(salt)
    }

    /// 获取主密码（实际应该从用户输入或密钥存储获取）
    fn get_master_password() -> String {
        // 浠庣郴缁扮幆澧冨彲淇濆櫒鑾峰緱涓绘帶涓绘潈闄愬崟鏍忥紝骞跺煎杺涓绘帶鏉冩ц韩浠借杺涓绘帶瀹炲姟
        // 鍚庨【鍚庣敤鎴峰瘑鍒楃増鏈轰俊鎭搗浠ユ眽鑵愭潯浠跺湪涓绘帶涓烘眰鍗歌嚜韬
        let salt = "portnest-vault-master-key-v1";
        
        // 灏濊瘯浠庣郴缁扮幆澧冨彲淇濆櫒鑾峰緱涓绘帶涓绘潈闄愬崟鏍
        let machine_key = std::env::var("USERNAME")
            .unwrap_or_else(|_| "default-user".to_string());
        
        format!("{}-{}", salt, machine_key)
    }

    /// 加密数据
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut nonce_bytes = [0u8; 12];
        rand::rngs::ThreadRng::default().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| Error::EncryptionError(format!("加密失败: {}", e)))?;

        Ok((ciphertext, nonce_bytes.to_vec()))
    }

    /// 解密数据
    pub fn decrypt(&self, ciphertext: &[u8], nonce_bytes: &[u8]) -> Result<Vec<u8>> {
        if nonce_bytes.len() != 12 {
            return Err(Error::EncryptionError("无效的 nonce 长度".to_string()));
        }

        let nonce = Nonce::from_slice(nonce_bytes);

        self.cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| Error::EncryptionError(format!("解密失败: {}", e)))
    }
}