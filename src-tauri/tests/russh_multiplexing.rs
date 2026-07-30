use portnest_lib::protocol::russh_backend::RusshBackend;
use portnest_lib::protocol::ssh_backend::{ConnectionTarget, SshBackend, TerminalSize};
use portnest_lib::protocol::{ConnectionOptions, Credential, CredentialType};
use std::time::Duration;

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
