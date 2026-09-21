use portnest_lib::protocol::russh_backend::RusshBackend;
use portnest_lib::protocol::ssh_backend::{
    session_pool_key, CancellationToken, ConnectionTarget, SshBackend, SshSessionPool, TerminalSize,
};
use portnest_lib::protocol::{ConnectionOptions, Credential, CredentialType};
use std::time::Duration;
use sha2::Digest;
use tokio::io::AsyncReadExt;

fn test_target() -> Option<(ConnectionTarget, Credential)> {
    let host = std::env::var("PORTNEST_TEST_SSH_HOST").ok()?;
    let username = std::env::var("PORTNEST_TEST_SSH_USERNAME").ok()?;
    let password = std::env::var("PORTNEST_TEST_SSH_PASSWORD").ok()?;
    let port = std::env::var("PORTNEST_TEST_SSH_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(22);

    Some((
        ConnectionTarget {
            host,
            port,
            username,
        },
        Credential {
            credential_type: CredentialType::Password,
            password: Some(password),
            private_key: None,
            passphrase: None,
        },
    ))
}

#[tokio::test]
async fn direct_tcpip_channel_reaches_ssh_target() {
    let Some((target, credential)) = test_target() else {
        eprintln!("skipping: PORTNEST_TEST_SSH_* variables are not configured");
        return;
    };
    let session = RusshBackend.connect(&target, &credential, &ConnectionOptions::default())
        .await.expect("connect test SSH session");
    let mut channel = session.open_direct_tcpip(&target.host, target.port, "127.0.0.1", 0)
        .await.expect("open direct-tcpip channel through SSH");
    let mut banner = [0_u8; 4];
    tokio::time::timeout(Duration::from_secs(10), channel.read_exact(&mut banner))
        .await.expect("read SSH banner before timeout").expect("read SSH banner");
    assert_eq!(&banner, b"SSH-");
    session.disconnect().await.expect("disconnect transport");
}

#[tokio::test]
async fn session_pool_reuses_transport_until_last_owner_releases() {
    let Some((target, credential)) = test_target() else {
        eprintln!("skipping: PORTNEST_TEST_SSH_* variables are not configured");
        return;
    };
    let options = ConnectionOptions::default();
    let key = session_pool_key("integration", &target, &credential, &options);
    let pool = SshSessionPool::new();
    let backend: std::sync::Arc<dyn SshBackend> = std::sync::Arc::new(RusshBackend);
    let first = pool.acquire(key.clone(), "shell".into(), backend.clone(), &target, &credential, &options)
        .await.expect("acquire shell lease");
    let second = pool.acquire(key.clone(), "tunnel".into(), backend, &target, &credential, &options)
        .await.expect("acquire tunnel lease");
    assert_eq!(first.id(), second.id());
    pool.release(&key, "shell").await;
    assert_eq!(second.status(), portnest_lib::protocol::SessionStatus::Connected);
    pool.release(&key, "tunnel").await;
}

#[tokio::test]
async fn shell_and_sftp_share_a_session_and_close_independently() {
    let Some((target, credential)) = test_target() else {
        eprintln!("skipping: PORTNEST_TEST_SSH_* variables are not configured");
        return;
    };

    let session = RusshBackend
        .connect(&target, &credential, &ConnectionOptions::default())
        .await
        .expect("connect test SSH session");
    let shell = session
        .open_shell(TerminalSize::new(80, 24).expect("terminal size"))
        .await
        .expect("open shell channel");
    let sftp = session.open_sftp().await.expect("open SFTP channel");

    sftp.list_dir(".").await.expect("list home directory");
    sftp.close().await.expect("close only SFTP channel");

    let marker = format!("PORTNEST_MULTIPLEX_{}", uuid::Uuid::new_v4());
    shell
        .write(format!("printf '%s\\n' '{marker}'\n").as_bytes())
        .await
        .expect("write after SFTP close");

    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains(&marker) {
            output.extend(shell.read().await.expect("read shell output"));
        }
        output
    })
    .await
    .expect("shell remained responsive after SFTP close");

    assert!(String::from_utf8_lossy(&output).contains(&marker));
    shell.close().await.expect("close shell channel");
    session.disconnect().await.expect("disconnect transport");
}

#[tokio::test]
async fn sftp_transfer_resume_checksum_permissions_and_atomic_edit() {
    let Some((target, credential)) = test_target() else {
        eprintln!("skipping: PORTNEST_TEST_SSH_* variables are not configured");
        return;
    };
    let session = RusshBackend
        .connect(&target, &credential, &ConnectionOptions::default())
        .await
        .expect("connect test SSH session");
    let sftp = session.open_sftp().await.expect("open SFTP channel");
    let id = uuid::Uuid::new_v4();
    let remote_dir = std::env::var("PORTNEST_TEST_SSH_TMP").unwrap_or_else(|_| "/tmp".to_string());
    let remote = format!("{}/portnest-sftp-{id}.txt", remote_dir.trim_end_matches('/'));
    let local_dir = std::env::temp_dir().join(format!("portnest-sftp-{id}"));
    std::fs::create_dir_all(&local_dir).expect("create local test dir");
    let upload = local_dir.join("upload.txt");
    let download = local_dir.join("download.txt");
    let content = b"PortNest SFTP integration\n".repeat(4096);
    std::fs::write(&upload, &content).expect("write upload fixture");

    sftp.upload(
        &upload.to_string_lossy(),
        &remote,
        None,
        CancellationToken::default(),
        None,
    )
    .await
    .expect("upload fixture");
    let remote_checksum = sftp.checksum_sha256(&remote).await.expect("remote checksum");
    assert_eq!(remote_checksum, format!("{:x}", sha2::Sha256::digest(&content)));

    sftp.download(
        &remote,
        &download.to_string_lossy(),
        None,
        CancellationToken::default(),
        None,
    )
    .await
    .expect("download fixture");
    assert_eq!(std::fs::read(&download).expect("read download"), content);

    sftp.set_permissions(&remote, 0o640).await.expect("set permissions");
    sftp.write_file_atomic(&remote, b"edited safely\n").await.expect("atomic edit");
    assert_eq!(sftp.read_file(&remote, 1024).await.expect("read edited file"), b"edited safely\n");

    sftp.delete_file(&remote).await.expect("remove remote fixture");
    sftp.close().await.expect("close SFTP");
    session.disconnect().await.expect("disconnect transport");
    std::fs::remove_dir_all(&local_dir).expect("remove local fixture");
}
