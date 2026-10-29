# 剩余工作清单（收尾，第 25 轮）

> 度量工具：`python design/tools/audit_debt.py`。
> `styles/tokens.css` 是唯一出现原始色值的文件，其余文件都算“组件层”。

## 最终度量

| 指标 | 会话开始 | 最终 | 说明 |
| --- | ---: | ---: | --- |
| `!important`（全仓） | 339 | **22** | 全部有明确用途，见下 |
| 十六进制色值（全仓） | 678 | **187** | 全部在 `tokens.css` |
| `rgb()/hsl()` 字面色值（全仓） | 227 | **19** | 全部在 `tokens.css` |
| 组件层原始色值（22 文件） | 282 | **0** | — |
| 全仓 CSS 行数 | 17,448 | **14,359** | −17.7% |

### 剩余 22 条 `!important` 的完整清单

| 位置 | 数量 | 用途与不可删原因 |
| --- | ---: | --- |
| `App.css`（`prefers-reduced-motion` 2 个块） | 6 | 无障碍：关闭过渡/动画 |
| `SettingsModal.css` / `shell.css` | 4 | 同上（reduced-motion） |
| `App.css` xterm 覆盖（4 组选择器） | 4 | xterm.js 给 viewport/screen 写内联背景；只有 `!important` 能压过内联样式，用于透明/纯色/午夜背景与条纹 |
| `App.css` `.app-body.files-layout-stacked > .right-panel` | 1 | `RightPanel` 通过 `style={props.style}` 接收内联宽度，堆叠布局需要用 `!important` 复位为 100% |
| `App.css` 状态点（2 条泛型 + 5 条复合） | 7 | 4 类容器（tab/状态点/连接点/通用点）× 8 种状态的交叉规则，泛型与复合选择器互相需要重要性；已用 32 组探针实测确认颜色一致 |

合计 22。除此之外全仓没有 `!important`。

## 收尾验证（第 25 轮）

对所有可运行界面做了一次完整回归，并与第 16–24 轮的基线逐像素比对：

| 界面 | 结果 |
| --- | --- |
| 主窗口 明/暗 | `bbox = None` |
| 应用菜单 明/暗、右键菜单 明/暗、子菜单 | `bbox = None` |
| 连接表单 明/暗 | `bbox = None` |
| 会话迁移弹窗（导入/导出） | `bbox = None` |
| 设置页 18 页 × 明暗 | 与 `r8-final-*` 一致（个别页面右下角出现/消失的是 `FeedbackHost` 浮动按钮，属于随机挂载时序，不是样式回归；两次连拍即可复现该抖动） |
| AI 侧栏 明/暗 | 与 `r11-ai-*-final` 一致 |
| 密钥管理器 | 与基线一致（浏览器模式下的 `invoke` 错误提示为后端缺失，非样式） |
| 构建 / 类型 / 对比度 / 类名覆盖 | `build` ✅ `tsc` ✅ 176 组对比度 ✅ 848 使用 / 833 已样式化 / 15 误报 ✅ |

最终截图集：`design/verify/final-*.png`（app 明暗、菜单明暗、右键菜单明暗、连接表单明暗、导入弹窗、AI 暗色、密钥管理暗色）。

## 本次迁移做了什么（浓缩）

1. **建了 token 契约**：`styles/tokens.css` 成为唯一色值来源；皮肤 × 明暗的全部表面/文字/描边/强调/状态色 + 终端背景、代码块、协议色、阴影、滚动条遮罩等组件 token。
2. **组件逐个收编**：设置页、AI 侧栏、资产右键菜单、密钥管理器、Docker/服务器概览/MySQL、命令广播、指标条等全部改为 token；其中 AI 侧栏原有的 `--agent-*` 私有色板与暗色补丁整段删除。
3. **合并重叠层**：设置页样式从 4 层收进 `SettingsModal.css`；菜单统一到 `styles/overlays.css` + `AssetContextMenu.css`；`Surfaces.css`/`Themes.css`/`visual-refresh.css` 的重复规则与死代码清理（累计 −3,000+ 行、−339 条 `!important`、−491 处色值）。
4. **可证明的清理**：`prune_css.py`（同选择器覆盖 / 未使用类 / 跨层链式去重）、`strip_rules.py`（退役类族）、`strip_important.py`（按选择器去重要）、`move_rules.py`（规则搬家）、`format_css.py`（只改空白）、`diff_shots.py` + `settings-shots.mjs`（逐屏截图回归）、`style-fingerprint.mjs` + 三个 `eval-*-probe.js`（计算样式矩阵验证）。
5. **顺手修的缺陷**：深色主按钮白字低对比度、AI 深色面板白字、MySQL 深色图标不生效、设置页四层覆盖导致的样式漂移。

## 仍未做（需要功能改动/评审，不属于 CSS 收尾）

1. 去掉 xterm 内联背景：需改 `TerminalView.tsx` 的终端主题策略，并用真实终端会话验证（浏览器模式无法开终端）。
2. 状态点改为 `data-status` 单一属性选择器：需改 TSX 并逐状态验证。
3. 堆叠文件面板宽度改为 CSS 变量：需改 `RightPanel.tsx` 的内联 width。
4. `@layer` 分层：当前只剩功能型 `!important`，层序无法解决它们；若要引入，应在上述三项完成后再做，否则收益有限。

视觉基线：`design/verify/final-*.png` 与第 16–24 轮的 `r8/r11/r16/r17-*`。

## 第 26 轮（交互细节修复）

四项用户可见问题，均已截图对照：

1. **输入框多重框**：新增 `.field-flush` 契约——`styles/forms.css` 的全局文本控件规则与 `App.css` 中遗留的同名规则都排除该类；搜索框、文件夹名输入、左侧搜索框的内层 `<input>` 只负责文本，边框、背景、焦点环全部由外层 `.asset-search` / `.folder-name-input` / `.search-wrapper` 绘制。焦点态从“外层 ring + 内层边框/ring”变为单层 ring。
2. **创建时间/最近连接两行**：新增 `.asset-time-cell`（12px、`tabular-nums`、`nowrap`），列宽改为 `96px 104px 104px`；1180 断点保持 96px，980 断点仍隐藏这两列。实测每条时间 1 行、行高 18px。
3. **资产筛选移入 rail**：删除 `styles/tree.css` 的 `.sidebar-filters` / `.filter-chip`，在 `Sidebar.tsx` 的 `.module-rail-primary` 内用 `.module-rail-btn` 复用“图标 + 文字”的竖向按钮，`.module-rail-filters` 归 `styles/shell.css`；与“资产树”按钮之间用现有 `.module-rail-divider`（28×1，`--line`）做空间与功能分隔。筛选行为不变（仍会打开资产树）。
4. **收起资产树时面板压到 rail 下**：`.sidebar.tree-collapsed` 宽度从 40px 改为 `var(--w-rail)`（54px），并在 `.main-content` 补 6px 左间距，收起/展开的 gutter 一致；AI dock 打开时 sidebar 同样从 40px 改为 `var(--w-rail)`，避免面板盖住 rail 右缘。

度量与验证（第 26 轮）：

- `npm run typecheck` ✅、`npm run build` ✅、`python design/tools/contrast.py` → OK。
- `python design/tools/audit_debt.py`：`!important` 22、hex 187、rgb/hsl 19，组件层原始色值 0（均未增加）。
- 实测：收起后 `sidebar = rail = 54px`，`main-content.left = 60px`；`asset-search` 内层 input `border 0 / background transparent / height 28px`，文件夹名 input `height 32px`；时间单元格 `getClientRects().length = 1`。
- 截图：`r26-before-data.png` / `r26-after-data.png`、`r26-before-folder.png` / `r26-after-folder.png`、`r26-before-collapsed.png` / `r26-after-collapsed2.png`、`r26-after-dark.png`、`r26-after-folder-dark.png`、`r26-after-ai.png`。

## 第 27 轮（创建/编辑资产窗口紧凑化）

- 新增组件样式 `src/components/ConnectionForm.css`，在 `src/index.tsx` 末尾加载（与 AssetList.css 同一策略）：窗口高度改为内容自适应（`height:auto`，`max-height:min(720px, 100vh - 24px)`），只有窗口确实太矮时才在卡片内滚动。
- 收紧顶部标题、标签页、分区、字段标签与底部栏的留白；窗口高度 ≤640px 时进入更密一档（隐藏 kicker、分区说明与协议卡描述）。
- 输入框保持全局 32px 控件高度（不缩小点击目标），紧凑主要来自字段重排：
  - SSH 的“连接信息”主机、端口、用户名同一行（3 列）；数据库表单仍为 2 列。
  - “认证方式”与密码同一行；私钥/Agent 时认证方式独占一行，私钥与私钥密码同一行。
  - 颜色标签与色板同一行；分区说明与标题同一基线，不再单独占一行。
- 在运行中的 Tauri 调试窗口 **800×600** 与临时恢复的 **1440×900** 下验证：SSH 密码、SSH 私钥、PostgreSQL 三种常规页均无滚动条，全部字段一屏可见。
- `npm run typecheck` ✅、`npm run build` ✅、`python design/tools/contrast.py` → OK；`audit_debt.py` 的 `!important`/hex/rgb 数量未变。
- 截图：`r27-form-before.png` / `r27-form-after.png`、`r27-form-db.png`、`r27-form-key.png`、`r27-form-tall.png`。

## 第 28 轮（颜色标签落地 + 顶部搜索框定宽）

- **颜色标签生效**：资产表单保存的 `connections.color` 之前只落库、没有任何界面消费。现在资产列表与资产树的连接行在最左侧显示一个实心颜色圆点（在协议图标之前），与参考样式一致；无颜色的行保留同宽透明占位，名称与图标不会因是否有颜色而跳动。颜色只来自运行时数据，CSS 里只定义圆点尺寸，组件不新增原始色值。
- **顶部搜索框定宽**：试过 `clamp(220px, 30vw, 440px)` 后偏宽，最终回到 `width: 220px`（1142px 窗口下约为上一版 335px 的 2/3）；≤1180px 只隐藏 `Ctrl K` 快捷键，占位文案始终可见。
- 验证：在运行中的 Tauri 窗口（1142×755）截图中，两条已有颜色资产（红 `#ff3b30`、青 `#32b4d4`）在资产列表与资产树均显示前置圆点；顶部搜索框为正常宽度并完整显示占位文案。
- `npm run typecheck` ✅、`npm run build` ✅、`python design/tools/contrast.py` → OK；`audit_debt.py` 的 `!important`/hex/rgb 数量未变。
- 截图：`r28-asset-colors.png`。

## 第 29 轮（文件面板收起箭头）

- 文件面板展开时，左缘的“收起文件面板”按钮图标由 `back`（左向 chevron）改为 `chevronRight`（右向 chevron），与收起方向一致；收起态“展开文件面板”的 `‹` 保持左向（[RightPanel.tsx](src/components/RightPanel.tsx#L95)）。
- 右侧面板本身没有其它几何变化；`npm run typecheck` ✅、`npm run build` ✅。
- 验证时主窗口被设置窗口遮挡且处于最小化，未能稳定截到面板左缘；改动为单图标替换，方向由 `chevronRight` 路径保证。
