(() => {
  const report = {};
  const probe = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  };
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    strip: probe('.transfer-strip', ['background-color']),
    row: probe('.transfer-row', ['background-color', 'color']),
    main: probe('.transfer-main', ['color']),
    name: probe('.transfer-name', ['color', 'font-size']),
    meta: probe('.transfer-meta', ['color']),
    pathInput: probe('.path-input', ['background-color', 'color', 'border-color']),
    panel: probe('.right-panel', ['background-color', 'border-left-color']),
  }, null, 1);
})();
