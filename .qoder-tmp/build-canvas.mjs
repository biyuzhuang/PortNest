import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const outDir = "C:/Users/毕宇壮/.qoder/app/chat-session-visualizations/77c0a41e-2869-4879-8e79-aacf9a98e8c7/visualizations";
mkdirSync(outDir, { recursive: true });

const encode = (path) => readFileSync(path).toString("base64");
const before = encode(".qoder-tmp/before-light-zoom.png");
const after = encode(".qoder-tmp/asset-tree-light-zoom.png");
const dark = encode(".qoder-tmp/asset-tree-dark.png");
const empty = encode(".qoder-tmp/asset-tree-empty.png");

const html = `<div class="atc">
  <style>
    .atc {
      --bg: #0c1016;
      --panel: #141a23;
      --line: #232c39;
      --ink: #e8eef7;
      --muted: #93a1b5;
      --accent: #6f95ff;
      --green: #4ade9a;
      background:
        radial-gradient(1100px 500px at 100% -10%, rgba(111,149,255,.13), transparent 60%),
        radial-gradient(800px 400px at -10% 10%, rgba(20,184,166,.08), transparent 55%),
        var(--bg);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 30px;
      color: var(--ink);
      font-family: "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
      line-height: 1.55;
    }
    .atc * { box-sizing: border-box; }
    .atc-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
    .atc-kicker { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
    .atc h1 { margin: 6px 0 8px; font-size: 27px; line-height: 1.2; letter-spacing: -.02em; }
    .atc-lead { margin: 0; max-width: 760px; color: var(--muted); font-size: 13px; }
    .atc-meta { display: flex; gap: 8px; flex-wrap: wrap; }
    .atc-chip { padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.02); color: var(--muted); font-size: 11.5px; white-space: nowrap; }
    .atc-chip b { color: var(--ink); }
    .atc-stack { display: grid; gap: 16px; }
    .atc-card { overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    .atc-card.is-after { border-color: rgba(111,149,255,.38); box-shadow: 0 18px 50px rgba(79,124,255,.10); }
    .atc-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,.03), transparent); }
    .atc-card-head strong { font-size: 13.5px; }
    .atc-tag { padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
    .atc-tag.before { color: #c3ccda; background: #222a36; border: 1px solid #2e3847; }
    .atc-tag.after { color: #0b2b1a; background: var(--green); }
    .atc-shot { display: block; width: 100%; height: auto; background: #fff; }
    .atc-card-foot { padding: 11px 15px 14px; color: var(--muted); font-size: 12px; }
    .atc-card-foot b { color: var(--ink); font-weight: 600; }
    .atc-h2 { display: flex; align-items: center; gap: 10px; margin: 26px 0 12px; font-size: 15px; }
    .atc-h2::after { height: 1px; flex: 1; background: var(--line); content: ""; }
    .atc-two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .atc-two .atc-shot { background: #fff; }
    .atc-list { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 22px; margin: 0; padding: 0; list-style: none; }
    .atc-list li { position: relative; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
    .atc-list li::before { position: absolute; left: 0; top: .62em; width: 6px; height: 6px; border-radius: 2px; background: var(--accent); content: ""; }
    .atc-list b { color: var(--ink); font-weight: 600; }
    .atc-foot { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--line); color: #7f8da1; font-size: 11.5px; }
    .atc-ok { color: var(--green); }
    @media (max-width: 820px) {
      .atc { padding: 20px; }
      .atc-two, .atc-list { grid-template-columns: 1fr; }
      .atc h1 { font-size: 22px; }
    }
  </style>

  <header class="atc-head">
    <div>
      <div class="atc-kicker">PortNest · Asset tree</div>
      <h1>资产树改版对比</h1>
      <p class="atc-lead">同一个页面、同一组演示数据，只替换样式层。方向是 Fluent 数据工作台：收敛装饰，强化状态，把注意力留给资产本身。</p>
    </div>
    <div class="atc-meta">
      <span class="atc-chip"><b>浅色</b> / 深色</span>
      <span class="atc-chip">36px 行高</span>
      <span class="atc-chip">WCAG AA 主操作</span>
    </div>
  </header>

  <div class="atc-stack">
    <section class="atc-card">
      <div class="atc-card-head"><strong>改造前 · 旧样式层</strong><span class="atc-tag before">BEFORE</span></div>
      <img class="atc-shot" src="data:image/png;base64,${before}" alt="改造前的资产列表" />
      <div class="atc-card-foot">渐变表头 + 列竖线 + 纯文本延迟；文件夹行保留 4 个占位“—”，底部统计被隐藏。</div>
    </section>

    <section class="atc-card is-after">
      <div class="atc-card-head"><strong>改造后 · Fluent 精修</strong><span class="atc-tag after">AFTER · 推荐</span></div>
      <img class="atc-shot" src="data:image/png;base64,${after}" alt="改造后的资产列表" />
      <div class="atc-card-foot">中性表头与行分隔、协议图标色、延迟胶囊、文件夹行收敛；底部统计回归，主操作使用品牌蓝实心按钮。</div>
    </section>
  </div>

  <div class="atc-h2">深色主题 &amp; 空状态</div>
  <div class="atc-two">
    <section class="atc-card">
      <div class="atc-card-head"><strong>深色主题</strong><span class="atc-tag before">DARK</span></div>
      <img class="atc-shot" src="data:image/png;base64,${dark}" alt="深色主题下的资产列表" />
      <div class="atc-card-foot">沿用同一套 token，状态色与图层在深色下保持可读。</div>
    </section>
    <section class="atc-card">
      <div class="atc-card-head"><strong>空状态</strong><span class="atc-tag before">EMPTY</span></div>
      <img class="atc-shot" src="data:image/png;base64,${empty}" alt="搜索无结果时的空状态" />
      <div class="atc-card-foot">图标底座 + 一句说明 + 主操作；搜索无结果时文案自动切换。</div>
    </section>
  </div>

  <div class="atc-h2">改了什么</div>
  <ul class="atc-list">
    <li><b>工具栏</b>：去掉多余描边，选中数量改为按需显示的胶囊；新建连接升为主操作。</li>
    <li><b>表头</b>：移除渐变和竖分隔线，改为中性底色 + 底部 1px 分隔。</li>
    <li><b>协议</b>：SSH 蓝 / 数据库青 / 本地灰的图标底座，一眼区分类型。</li>
    <li><b>延迟</b>：改为带状态点的胶囊，在线 / 超时 / 测试中三态清晰。</li>
    <li><b>文件夹行</b>：只保留名称和连接数，隐藏 4 个占位“—”。</li>
    <li><b>细节</b>：真实文件夹 SVG、排序指示、底部统计、空状态说明；减少动画遵循 reduced-motion。</li>
  </ul>

  <footer class="atc-foot">
    <span>演示数据：192.0.2.x 为 RFC 5737 文档保留地址。</span>
    <span><span class="atc-ok">✓</span> typecheck · build · 浅色 / 深色 / 空状态实际渲染</span>
  </footer>
</div>`;

writeFileSync(`${outDir}/asset-tree-compare.html`, html);
console.log(`wrote ${outDir}/asset-tree-compare.html (${Math.round(html.length / 1024)} KB)`);
