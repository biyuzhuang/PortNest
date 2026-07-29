# PortNest Windows 发布

## 当前安装包

- 安装器：`src-tauri/target/release/bundle/nsis/PortNest_0.1.0_x64-setup.exe`
- 更新签名：`src-tauri/target/release/bundle/nsis/PortNest_0.1.0_x64-setup.exe.sig`
- 更新清单：`release/latest.json`

安装器使用 NSIS，允许用户选择安装目录，并在安装后创建桌面快捷方式。

## 发布到 GitHub Releases

在 `biyuzhuang/PortNest` 创建标签和 Release，例如 `v0.1.0`，上传：

1. `PortNest_0.1.0_x64-setup.exe`
2. `latest.json`

客户端会从以下固定地址检查更新：

`https://github.com/biyuzhuang/PortNest/releases/latest/download/latest.json`

## 发布新版本

1. 同步修改以下三个版本号，且必须高于已发布版本：
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. 安全备份 `src-tauri/.keys/portnest.key`。此文件被 Git 忽略，绝不能上传。
3. 构建安装器：

```powershell
$env:CARGO_BUILD_JOBS="2"
$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content -Raw "src-tauri\.keys\portnest.key")
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

4. 如果构建器未自动生成签名，可手动执行：

```powershell
npx tauri signer sign -f "src-tauri/.keys/portnest.key" --password= "安装包完整路径"
```

5. 用新版本、下载地址和 `.sig` 内容更新 `release/latest.json`，随后上传安装器和清单。

应用内“设置 → 通用 → 基础 → 应用更新”会下载已签名安装器、覆盖升级并重启应用。
