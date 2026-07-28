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
        let master_key = Self::get_or_create_master_key(db_path)?;
        let key = pbkdf2_hmac_array::<Sha256, 32>(&master_key, &salt, 600_000);

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| Error::EncryptionError(format!("创建加密器失败: {}", e)))?;

        Ok(Self { cipher })
    }

    pub fn needs_legacy_migration(db_path: &std::path::Path) -> bool {
        db_path.exists() && !db_path.with_file_name("vault.key").exists()
    }

    pub fn legacy(db_path: &std::path::Path) -> Result<Self> {
        let salt = Self::generate_salt(db_path)?;
        let legacy_password = format!(
            "portnest-vault-master-key-v1-{}",
            std::env::var("USERNAME").unwrap_or_else(|_| "default-user".to_string())
        );
        let key = pbkdf2_hmac_array::<Sha256, 32>(legacy_password.as_bytes(), &salt, 600_000);
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| Error::EncryptionError(format!("创建旧凭据迁移器失败: {}", e)))?;
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

    fn get_or_create_master_key(db_path: &std::path::Path) -> Result<Vec<u8>> {
        let key_path = db_path.with_file_name("vault.key");
        if key_path.exists() {
            let key = std::fs::read(&key_path)
                .map_err(|e| Error::EncryptionError(format!("读取凭据主密钥失败: {}", e)))?;
            if key.len() != 32 {
                return Err(Error::EncryptionError("凭据主密钥长度无效".to_string()));
            }
            return Ok(key);
        }

        let mut key = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        std::fs::write(&key_path, &key)
            .map_err(|e| Error::EncryptionError(format!("保存凭据主密钥失败: {}", e)))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| Error::EncryptionError(format!("限制主密钥权限失败: {}", e)))?;
        }
        Ok(key)
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
