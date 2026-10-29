// After a session exists: trace tab + icon styling and assert shell geometry.
(async () => {
  const click = [...document.querySelectorAll('.sidebar-header-actions button')]
    .find(el => (el.getAttribute('title') || '').includes('本地终端'));
  click?.click();
  await new Promise(r => setTimeout(r, 1500));

  const trace = (selector, props) => {
    const el = document.querySelector(selector);
    if (!el) return 'missing';
    const hits = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        let m = false;
        try { m = el.matches(rule.selectorText); } catch { continue; }
        if (!m) continue;
        const found = {};
        for (const p of props) {
          const v = rule.style.getPropertyValue(p);
          if (v) found[p] = v + (rule.style.getPropertyPriority(p) ? ' !' : '');
        }
        if (Object.keys(found).length) hits.push({ sel: rule.selectorText, found });
      }
    }
    const cs = getComputedStyle(el);
    const computed = {};
    for (const p of props) computed[p] = cs.getPropertyValue(p);
    return { computed, hits: hits.slice(-6) };
  };

  const geo = sel => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };

  return JSON.stringify({
    geometry: {
      titlebar: geo('.app-titlebar'),
      rail: geo('.module-rail'),
      header: geo('.session-header'),
      tab: geo('.session-tab.active'),
      statusbar: geo('.app-statusbar'),
      closeBtn: geo('.session-tab-close'),
      actionBtn: geo('.session-action-btn'),
    },
    tab: trace('.session-tab.active', ['background-color', 'border-bottom-width', 'border-bottom-color', 'box-shadow']),
    tabIcon: trace('.session-tab-terminal-icon', ['background-color', 'color', 'width', 'height']),
  }, null, 2);
})();
