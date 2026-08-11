# PortNest 手动发布指南（Windows）

本文用于从一个已完成开发和测试的提交，手动发布新的 PortNest Windows 版本。

> 命令默认在仓库根目录 `D:\code\PortNest` 的 PowerShell 中执行。文中的 `<版本号>` 使用纯语义版本号，例如 `0.0.5`；Git 标签同样不加 `v`，以保持与现有下载地址一致。

## 1. 发布前准备

确认本机具备：

- Node.js、npm、Rust stable 和 Cargo；
- Tauri 2 所需的 Windows C++ 构建工具和 WebView2；
- GitHub CLI（`gh`），且已登录；
- 更新签名私钥 `src-tauri\.keys\portnest.key`。

签名私钥被 Git 忽略。请单独安全备份，禁止提交、上传或发送给他人。丢失该私钥后，已安装版本将无法验证用新密钥签名的更新。

从干净的主分支开始：

```powershell
git switch main
git pull --ff-only
git status --short
gh auth status
```

`git status --short` 应无输出。检查目标版本尚未被使用：

```powershell
git tag --list "<版本号>"
gh release view "<版本号>"
```

两条命令都不应找到已有版本。

## 2. 同步版本号

以下三个文件中的版本号必须完全一致：

- `package.json` 的 `version`；
- `src-tauri\Cargo.toml` 的 `[package].version`；
- `src-tauri\tauri.conf.json` 的 `version`。

修改后执行：

```powershell
npm install --package-lock-only
cargo check --manifest-path src-tauri\Cargo.toml
npm run typecheck
npm run build
```

`npm install --package-lock-only` 会同步 `package-lock.json`；`cargo check` 会在需要时同步 `src-tauri\Cargo.lock`。再次核对版本：

```powershell
Select-String -Path package.json, package-lock.json, src-tauri\Cargo.toml, src-tauri\tauri.conf.json -Pattern 'version'
cargo metadata --manifest-path src-tauri\Cargo.toml --no-deps --format-version 1
```

检查改动并提交版本准备：

```powershell
git diff --check
git status --short
git add package.json package-lock.json src-tauri\Cargo.toml src-tauri\Cargo.lock src-tauri\tauri.conf.json
git commit -m "chore: prepare <版本号> release"
git push origin main
```

## 3. 构建并签名安装包

确认私钥存在：

```powershell
Test-Path "src-tauri\.keys\portnest.key"
```

输出必须为 `True`。在同一个 PowerShell 窗口执行构建：

```powershell
$env:CARGO_BUILD_JOBS="2"
$env:TAURI_SIGNING_PRIVATE_KEY_PATH=(Resolve-Path "src-tauri\.keys\portnest.key").Path
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

如果私钥设有密码，将最后一个环境变量改为实际密码；不要把密码写入仓库、脚本或命令历史。

预期产物：

```text
src-tauri\target\release\bundle\nsis\PortNest_<版本号>_x64-setup.exe
src-tauri\target\release\bundle\nsis\PortNest_<版本号>_x64-setup.exe.sig
```

确认两者均存在且非空：

```powershell
$installer="src-tauri\target\release\bundle\nsis\PortNest_<版本号>_x64-setup.exe"
$signature="$installer.sig"
Get-Item $installer, $signature | Select-Object FullName, Length, LastWriteTime
```

若构建成功但提示找不到私钥，可在设置上述签名环境变量后重新构建。不要发布缺少 `.sig` 的自动更新包。

## 4. 安装冒烟测试

在发布前至少完成以下检查：

1. 运行新安装包，可选择安装目录并正常启动；
2. 新建一个测试连接，确认核心 SSH/SFTP 或本地终端功能可用；
3. 从当前公开版本覆盖升级，确认用户数据仍然存在；
4. 在“设置 → 应用更新”中确认检查更新不会导致应用异常。

发现问题时停止发布，修复后重新提交、构建和测试；不要复用已经对外发布过的版本号。

## 5. 生成更新清单

读取签名并生成 UTC 发布时间：

```powershell
$version="<版本号>"
$installer="src-tauri\target\release\bundle\nsis\PortNest_${version}_x64-setup.exe"
$signature=(Get-Content "$installer.sig" -Raw).Trim()
$pubDate=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$signature
$pubDate
```

用实际版本说明、时间和签名更新 `release\latest.json`：

```json
{
  "version": "<版本号>",
  "notes": "本版本的用户可见变更摘要。",
  "pub_date": "<UTC 发布时间>",
  "platforms": {
    "windows-x86_64": {
      "signature": "<exe.sig 的完整单行内容>",
      "url": "https://github.com/biyuzhuang/PortNest/releases/download/<版本号>/PortNest_<版本号>_x64-setup.exe"
    }
  }
}
```

校验 JSON 和关键字段：

```powershell
$manifest=Get-Content release\latest.json -Raw | ConvertFrom-Json
$manifest.version
$manifest.platforms.'windows-x86_64'.url
if ($manifest.version -ne $version) { throw "latest.json 版本号不一致" }
if ($manifest.platforms.'windows-x86_64'.signature -ne $signature) { throw "latest.json 签名不一致" }
```

提交更新清单：

```powershell
git add release\latest.json
git commit -m "chore: publish <版本号> update manifest"
git push origin main
```

## 6. 创建 GitHub Release

先创建 Release 并上传安装包、签名和更新清单：

```powershell
gh release create "<版本号>" `
  "src-tauri\target\release\bundle\nsis\PortNest_<版本号>_x64-setup.exe" `
  "src-tauri\target\release\bundle\nsis\PortNest_<版本号>_x64-setup.exe.sig" `
  "release\latest.json" `
  --target main `
  --title "PortNest <版本号>" `
  --notes "本版本的用户可见变更摘要。"
```

该命令会创建同名 Git 标签。标签格式必须与 `latest.json` 下载 URL 中的版本目录一致。

## 7. 发布后验证

```powershell
gh release view "<版本号>" --json tagName,isDraft,isPrerelease,url,assets
Invoke-RestMethod "https://github.com/biyuzhuang/PortNest/releases/latest/download/latest.json"
```

然后完成最终验证：

- GitHub Release 中存在 `.exe`、`.exe.sig` 和 `latest.json` 三个附件；
- `latest.json` 的版本、下载 URL 和签名均正确；
- 在旧版本应用中检查更新，能够发现新版本、下载、安装并重新启动；
- Release 页面中的安装包可以手动下载和安装。

## 8. 常见问题与回退

- **`A public key has been found, but no private key`**：签名私钥环境变量未在构建进程所在的 PowerShell 会话中生效。重新设置第 3 节变量并重新构建。
- **`gh` 未登录或 Git 推送要求凭据**：执行 `gh auth login`，需要时再执行 `gh auth setup-git`。
- **Release 创建后发现附件错误**：立即将 Release 标记为草稿或删除错误附件，修正后重新上传；若用户可能已下载，不要替换同版本二进制，应提升补丁版本重新发布。
- **`latest.json` 已公开但安装包不可下载**：应用更新会失败。优先修复 Release 附件；确认三项附件可访问后再通知用户更新。

发布完成后可删除本机构建产物以释放空间；它们均不应提交：

```powershell
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item src-tauri\target -Recurse -Force -ErrorAction SilentlyContinue
```
