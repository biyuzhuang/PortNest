// Dumps computed styles for the shell so P1 can be asserted, not eyeballed.
(() => {
  const pick = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: sel };
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  };
  const tab = document.querySelector('.session-tab.active');
  return JSON.stringify({
    titlebar: pick('.app-titlebar', ['height']),
    rail: pick('.module-rail', ['width']),
    railBtn: pick('.module-rail-btn.active', ['width', 'height', 'color', 'background-color']),
    tree: pick('.asset-sidebar', ['width', 'border-radius', 'box-shadow']),
    header: pick('.session-header', ['height']),
    tabActive: tab ? (() => {
      const cs = getComputedStyle(tab);
      return {
        height: cs.height,
        borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomColor,
        boxShadow: cs.boxShadow,
        background: cs.backgroundColor,
      };
    })() : 'none',
    tabIcon: pick('.session-tab-terminal-icon', ['width', 'height', 'color', 'background-color', 'border-radius']),
    statusbar: pick('.app-statusbar', ['height', 'background-color', 'font-size']),
    crumbIcon: pick('.titlebar-crumb svg', ['width', 'height']),
    searchPill: pick('.titlebar-search', ['height', 'width', 'border-color']),
    // any svg that escaped its container (the bug we just fixed)
    oversizedSvg: [...document.querySelectorAll('svg')]
      .filter(s => s.getBoundingClientRect().width > 60)
      .map(s => ({ cls: s.getAttribute('class'), w: Math.round(s.getBoundingClientRect().width) })),
  }, null, 2);
})();
