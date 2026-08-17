# PortNest Windows 全手动发布指南

本文覆盖完整的手动发布流程：修改版本号、质量检查、使用 Tauri 私钥签名打包、安装验证、生成更新清单、创建带 `v` 的 GitHub Release，以及发布后验证。

所有命令均在仓库根目录 `D:\code\PortNest` 的 PowerShell 中执行。

## 版本命名规则

应用内部版本必须是合法 SemVer，不带 `v`；Git 标签和 GitHub Release 带 `v`：

```powershell
$version="0.0.7"       # package、Cargo、Tauri、latest.json
$tag="v$version"       # Git 标签、GitHub Release
```

对应安装包名称由 Tauri 生成，文件名不带 `v`：

```text
PortNest_0.0.7_x64-setup.exe
```

`latest.json.version` 使用 `0.0.7`，下载 URL 的标签目录使用 `v0.0.7`。

## 1. 发布前准备

本机需要 Node.js 18+、npm、Rust stable、Cargo、Windows C++ 构建工具、WebView2、GitHub CLI，以及更新签名私钥 `src-tauri\.keys\portnest.key`。

私钥禁止提交、上传或发送给他人。丢失私钥后，已安装的旧版本将无法验证后续更新。

```powershell
node --version
npm --version
rustc --version
cargo --version
gh --version
gh auth status
Test-Path "src-tauri\.keys\portnest.key"
```

最后一条命令必须输出 `True`。

从最新且干净的主分支开始：

```powershell
git switch main
git pull --ff-only origin main
git status --short
```

`git status --short` 必须无输出。若存在修改，先确认、提交或妥善处理，不要在状态不明的工作区发布。

确认版本尚未被使用：

```powershell
$version="0.0.7"
$tag="v$version"
git tag --list $tag
gh release view $tag
```

第一条命令应无输出，第二条应提示 Release 不存在。已经公开的版本禁止覆盖，必须提升版本号。

## 2. 修改并同步版本号

以下位置必须使用同一个、不带 `v` 的版本号：

- `package.json` 的 `version`；
- `package-lock.json` 顶层及根包的 `version`；
- `src-tauri\Cargo.toml` 的 `[package].version`；
- `src-tauri\Cargo.lock` 中 `name = "portnest"` 对应的 `version`；
- `src-tauri\tauri.conf.json` 的 `version`。

让 npm 同步前两个文件：

```powershell
$version="0.0.7"
npm version $version --no-git-tag-version
```

手动将 `src-tauri\Cargo.toml` 和 `src-tauri\tauri.conf.json` 的项目版本改为 `$version`，然后让 Cargo 同步锁文件：

```powershell
cargo check --manifest-path src-tauri\Cargo.toml
```

核对五处项目版本，输出必须全部相同：

```powershell
$package=Get-Content package.json -Raw | ConvertFrom-Json
$packageLock=Get-Content package-lock.json -Raw | ConvertFrom-Json
$tauri=Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json
$cargo=cargo metadata --manifest-path src-tauri\Cargo.toml --no-deps --format-version 1 | ConvertFrom-Json

$package.version
$packageLock.version
$packageLock.packages."".version
$tauri.version
($cargo.packages | Where-Object name -eq "portnest").version
```

## 3. 质量检查并提交版本

```powershell
npm run typecheck
npm run build
cargo check --manifest-path src-tauri\Cargo.toml
git diff --check
```

检查改动只包含预期的版本更新：

```powershell
git status --short
git diff -- package.json package-lock.json src-tauri\Cargo.toml src-tauri\Cargo.lock src-tauri\tauri.conf.json
```

提交并推送：

```powershell
git add package.json package-lock.json src-tauri\Cargo.toml src-tauri\Cargo.lock src-tauri\tauri.conf.json
git commit -m "chore: prepare $tag release"
git push origin main
git status -sb
```

预期显示 `main...origin/main`，且没有未提交文件。

## 4. 使用私钥签名打包

本节的签名是 Tauri Updater 用于验证更新包完整性和来源的 minisign 签名，会生成 `.exe.sig`。它不等同于 Windows Authenticode 证书签名；如果需要消除 Windows SmartScreen 的“未知发布者”提示，还需另行配置代码签名证书。

### 4.1 设置签名变量

当前 Tauri CLI 要求 `TAURI_SIGNING_PRIVATE_KEY` 包含私钥内容。不要使用 `TAURI_SIGNING_PRIVATE_KEY_PATH`，否则可能提示找到了公钥但没有私钥。

无密码私钥：

```powershell
$env:CARGO_BUILD_JOBS="2"
$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content -Raw -LiteralPath "src-tauri\.keys\portnest.key")
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

有密码私钥使用隐藏输入，避免密码进入命令历史：

```powershell
$env:CARGO_BUILD_JOBS="2"
$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content -Raw -LiteralPath "src-tauri\.keys\portnest.key")
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=Read-Host "签名私钥密码" -MaskInput
```

不要输出私钥环境变量，也不要把密钥或密码写入脚本、文档、日志或 Git。

### 4.2 正式构建

```powershell
npm run tauri:build
```

首次 release 编译可能需要数分钟。成功日志应包含 `Finished 1 bundle`，且不能包含签名错误。

构建结束后立即清除敏感环境变量：

```powershell
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
```

### 4.3 核对安装包和签名

```powershell
$version="0.0.7"
$bundleDir="src-tauri\target\release\bundle\nsis"
$installer=Join-Path $bundleDir "PortNest_${version}_x64-setup.exe"
$signature="$installer.sig"

if (!(Test-Path $installer)) { throw "安装包不存在：$installer" }
if (!(Test-Path $signature)) { throw "签名不存在：$signature" }
if ((Get-Item $installer).Length -le 0) { throw "安装包为空" }
if ((Get-Item $signature).Length -le 0) { throw "签名为空" }

Get-Item $installer, $signature | Select-Object FullName,Length,LastWriteTime
Get-FileHash $installer -Algorithm SHA256
Get-FileHash $signature -Algorithm SHA256
```

## 5. 安装和功能冒烟测试

发布前至少完成：

1. 运行安装包，确认可以安装、启动和正常退出；
2. 确认应用显示的版本为 `$version`；
3. 从当前公开版本覆盖安装，确认连接、文件夹和设置仍存在；
4. 验证 SSH 连接、终端输入输出和断开；
5. 验证 SFTP 浏览及至少一次上传或下载；
6. 验证本地终端可以启动；
7. 验证 MySQL 连接和一次只读查询；
8. 验证独立设置窗口和明暗主题切换；
9. 验证“设置 → 应用更新”不会异常。

发现问题时停止发布。修复后重新提交、构建和测试；不要复用已经公开的版本号。

## 6. 生成 `release\latest.json`

```powershell
$version="0.0.7"
$tag="v$version"
$bundleDir="src-tauri\target\release\bundle\nsis"
$installer=Join-Path $bundleDir "PortNest_${version}_x64-setup.exe"
$signature=(Get-Content "$installer.sig" -Raw).Trim()
$pubDate=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$downloadUrl="https://github.com/biyuzhuang/PortNest/releases/download/$tag/$(Split-Path $installer -Leaf)"

$pubDate
$downloadUrl
```

用实际发布时间、签名和发布说明更新 `release\latest.json`：

```json
{
  "version": "0.0.7",
  "notes": "填写本版本面向用户的变更摘要。",
  "pub_date": "填写上一步生成的 UTC 时间",
  "platforms": {
    "windows-x86_64": {
      "signature": "填写 .exe.sig 的完整单行内容",
      "url": "https://github.com/biyuzhuang/PortNest/releases/download/v0.0.7/PortNest_0.0.7_x64-setup.exe"
    }
  }
}
```

规则：`version` 不带 `v`；URL 的标签带 `v`；`signature` 必须完整且保持单行。

校验清单：

```powershell
$manifest=Get-Content release\latest.json -Raw | ConvertFrom-Json
if ($manifest.version -ne $version) { throw "latest.json 版本号不一致" }
if ($manifest.platforms.'windows-x86_64'.url -ne $downloadUrl) { throw "latest.json 下载地址不一致" }
if ($manifest.platforms.'windows-x86_64'.signature -ne $signature) { throw "latest.json 签名不一致" }
$manifest | ConvertTo-Json -Depth 10
```

提交更新清单：

```powershell
git add release\latest.json
git commit -m "chore: publish $tag update manifest"
git push origin main
```

## 7. 创建带 `v` 的 GitHub Release

先创建草稿，避免用户看到附件不完整的 Release：

```powershell
$version="0.0.7"
$tag="v$version"
$bundleDir="src-tauri\target\release\bundle\nsis"
$installer=Join-Path $bundleDir "PortNest_${version}_x64-setup.exe"
$signature="$installer.sig"
```

将用户可见的发布说明写入 `release\RELEASE_NOTES.md`，然后执行：

```powershell
gh release create $tag `
  $installer `
  $signature `
  "release\latest.json" `
  --target main `
  --title "PortNest $tag" `
  --notes-file "release\RELEASE_NOTES.md" `
  --draft
```

检查草稿：

```powershell
gh release view $tag --json tagName,isDraft,isPrerelease,url,assets
```

必须包含：

```text
PortNest_0.0.7_x64-setup.exe
PortNest_0.0.7_x64-setup.exe.sig
latest.json
```

全部正确后公开并设为 Latest：

```powershell
gh release edit $tag --draft=false --latest
```

## 8. 发布后验证

```powershell
gh release view $tag --json tagName,isDraft,isPrerelease,url,assets
$remoteManifest=Invoke-RestMethod "https://github.com/biyuzhuang/PortNest/releases/latest/download/latest.json"
$remoteManifest.version
$remoteManifest.platforms.'windows-x86_64'.url
Invoke-WebRequest $remoteManifest.platforms.'windows-x86_64'.url -Method Head
```

最后使用旧版本 PortNest 验证应用内更新：能够发现新版本、下载并通过签名验证、完成安装和重启，且原有连接与设置没有丢失。

## 9. 常见问题

### 找到公钥但找不到私钥

```text
A public key has been found, but no private key
```

通常是使用了当前 CLI 不识别的 `TAURI_SIGNING_PRIVATE_KEY_PATH`。在执行构建的同一个 PowerShell 中重新设置：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content -Raw -LiteralPath "src-tauri\.keys\portnest.key")
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

### 私钥密码错误

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=Read-Host "签名私钥密码" -MaskInput
npm run tauri:build
```

禁止为了绕过错误而发布缺少 `.sig` 的安装包。

### Release 或标签已存在

```powershell
git tag --list $tag
gh release view $tag
```

若版本已公开，应提升补丁版本。只有在草稿从未公开且无人下载时，才考虑删除草稿后重建。

### `latest.json` 可下载，但安装包不可用

这会导致应用内更新失败。检查 Release 附件名称、URL 中带 `v` 的标签，以及 Release 是否已公开。修复前不要通知用户更新。

### GitHub CLI 未登录

```powershell
gh auth login
gh auth setup-git
gh auth status
```

## 10. 可选清理

确认发布和更新验证全部完成后，可清理可重建的产物：

```powershell
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item src-tauri\target -Recurse -Force -ErrorAction SilentlyContinue
```

不要删除 `src-tauri\.keys`，并确保签名私钥已有安全的离线备份。
