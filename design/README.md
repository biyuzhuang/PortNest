# PortNest · UI 设计提案

这里是设计产物，**不是应用代码**。`src/` 和 `src-tauri/` 一行未改。

## 先看这个

1. 双击 **`mockup.html`** —— 静态预览，无需构建、无需联网。顶部可切换 5 个视图、4 套皮肤、明暗主题，以及「固定深色终端」。
2. 读 **`DESIGN-SPEC.md`** —— 诊断、方向、变量、组件、逐屏规范、实施路径。

## 目录

| 路径 | 说明 |
| --- | --- |
| `DESIGN-SPEC.md` | 主文档 |
| `mockup.html` | 可交互静态预览 |
| `contrast-report.md` | 176 组对比度实测（4 皮肤 × 2 主题 × 22 项） |
| `shots/` | mockup 的渲染图 |
| `tools/contrast.py` | 配色校验：`python tools/contrast.py`（改色后必跑） |
| `tools/render.ps1` | 重新渲染全部截图：`pwsh tools/render.ps1` |
| `tools/audit_css.py` | 统计现有 CSS 的设计值离散度 |
| `tools/audit_current.py` | 复核现有配色的对比度问题（§2.2 的证据） |
| `tools/audit_debt.py` | 迁移债务度量：`!important`、十六进制/`rgb()` 字面量、行数（每轮数字的唯一来源） |
| `tools/list_colors.py` | 列出某个 CSS 里色值字面量的行号 |
| `tools/prune_css.py` | 删除被覆盖的声明与没人使用的类规则（先 `--list` 再 `--apply`；`--chain` 按加载顺序跨文件比较，`--all` 比较全部选择器） |
| `tools/find_rules.py` | 按类名前缀列出规则、行号与 `!important` 属性 |
| `tools/move_rules.py` | 把某类规则从多层搬进一个 owner 文件，保留顺序与媒体查询 |
| `tools/strip_rules.py` | 从选择器组里摘除退役组件的类名成员（全部命中则删整条规则） |
| `tools/strip_important.py` | 按选择器正则去掉 `!important`（先 dry-run，再 `--apply`） |
| `tools/list_important.py` | 列出含 `!important` 的规则与属性 |
| `tools/style-fingerprint.mjs` | 导出元素计算样式 JSON，重构前后逐属性对比 |
| `tools/format_css.py` | 只重排空白；写入前自检内容不变 |
| `tools/unused_classes.py` | 找出 CSS 里存在、`.tsx` 里没有的类名 |
| `tools/settings-shots.mjs` | 设置页逐屏截图（18 页 × 明暗）+ console 错误 |
| `tools/diff_shots.py` | 两组截图逐像素对比（含差异包围盒） |
| `tools/inspect-rule.mjs` | 打印元素命中的规则与最终计算值，排查层序用 |
| `tools/check_mockup.py` | 校验 mockup 里的图标引用完整性 |
| `tools/fix_icons.py` | 修复 `<use>` 外层缺失 `viewBox` 导致图标被裁切（已应用） |
| `tools/solve.py` | 一次性取色求解器（记录色值的推导过程） |

## 重新生成截图

```powershell
pwsh design/tools/render.ps1
```

依赖本机 Microsoft Edge（无头模式）。若路径不同，改脚本里的 `$edge`。

## 重新校验配色

```powershell
python design/tools/contrast.py
```

全部通过时输出 `OK: every checked pair meets its threshold`，否则列出未达标的具体配对。

## 边界

- 本提案**不改动**应用源码、构建配置和依赖。
- 所有颜色均已用 WCAG 2.1 公式实测，未凭手感取色。
- 删掉整个 `design/` 目录即可完全回退。
