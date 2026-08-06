# PortNest 手动发布流程

适用场景：代码修改、测试完成后，手动推送源码、手动打包、手动发布 GitHub Release。

> 下面所有 `<版本>` 请替换为实际版本号（例如 `0.0.3`）。标签不使用 `v` 前缀，与现有下载地址保持一致。

## 0. 确认版本号（发布新版本时）

以下三处版本号必须同步修改，且高于已发布版本：

- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/tauri.conf.json` → `"version"`

检查三处是否一致：

```powershell
Select-String -Path package.json, src-tauri\Cargo.toml, src-tauri\tauri.conf.json -Pattern 'version'
```

## 1. 提交并推送源码

```powershell
cd D:\code\PortNest
git status
git add -A
git commit -m "feat: 本次改动说明"
git push
```

首次推送请用 `git push -u origin main`。`src-tauri/.keys/`（签名密钥）、`dist/`、`node_modules/` 已被 `.gitignore` 排除，不会上传。

## 2. 手动打包（生成安装包 + 更新签名）

环境变量和 `npm run tauri build` 必须在**同一个 PowerShell 窗口**执行，否则签名密钥不会传入：

```powershell
$env:CARGO_BUILD_JOBS="2"
$env:TAURI_SIGNING_PRIVATE_KEY_PATH=(Resolve-Path "src-tauri\.keys\portnest.key").Path
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

等价的一行写法（复制到任意位置都能跑）：

```powershell
$env:CARGO_BUILD_JOBS="2"; $env:TAURI_SIGNING_PRIVATE_KEY_PATH=(Resolve-Path "src-tauri\.keys\portnest.key").Path; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""; npm run tauri build
```

产物：

- `src-tauri\target\release\bundle\nsis\PortNest_<版本>_x64-setup.exe`
- `src-tauri\target\release\bundle\nsis\PortNest_<版本>_x64-setup.exe.sig`

如果报错 `A public key has been found, but no private key`：说明环境变量没生效，**不需要重跑整个构建**，直接对已生成的安装包补签名：

```powershell
npx tauri signer sign -f "src-tauri\.keys\portnest.key" --password= "src-tauri\target\release\bundle\nsis\PortNest_<版本>_x64-setup.exe"
```

## 3. 更新 release/latest.json

生成当前 UTC 时间，并读取 `.sig` 文件内容：

```powershell
(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Get-Content "src-tauri\target\release\bundle\nsis\PortNest_<版本>_x64-setup.exe.sig" -Raw
```

按以下模板更新 `release/latest.json`：

```json
{
  "version": "<版本>",
  "notes": "PortNest <版本> Windows installer supports a custom installation directory and preserves existing user data during in-place upgrades.",
  "pub_date": "<上一步生成的 UTC 时间>",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 文件内容>",
      "url": "https://github.com/biyuzhuang/PortNest/releases/download/<版本>/PortNest_<版本>_x64-setup.exe"
    }
  }
}
```

## 4. 提交并推送 release 清单

```powershell
git add release/latest.json
git commit -m "chore: update release manifest to <版本>"
git push
```

## 5. 创建 GitHub Release 并上传产物

```powershell
gh auth status
gh release create <版本> `
  "src-tauri\target\release\bundle\nsis\PortNest_<版本>_x64-setup.exe" `
  "src-tauri\target\release\bundle\nsis\PortNest_<版本>_x64-setup.exe.sig" `
  "release\latest.json" `
  --title "PortNest <版本>" `
  --notes "PortNest <版本>"
```

## 6. 验证发布

- 打开 `https://github.com/biyuzhuang/PortNest/releases/latest/download/latest.json`，确认版本号和签名正确
- 应用内「设置 → 通用 → 基础 → 应用更新」触发更新，确认能下载并覆盖升级

## 常见问题

- **报 no private key**：签名环境变量没和构建在同一个会话里执行。用第 2 步的一行写法，或对现有 exe 手动执行 `tauri signer sign`。
- **推送要求输入凭据**：先执行 `gh auth setup-git`，再 `git push`。
- **gh 未登录**：执行 `gh auth login`。
- **标签格式**：不要加 `v` 前缀，与已有下载地址（`0.0.1`、`0.0.2`）保持一致。
- **签名密钥丢失**：`src-tauri/.keys/portnest.key` 无法从仓库恢复，请单独安全备份，绝不能上传。
