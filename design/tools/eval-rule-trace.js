(() => {
  const el = document.querySelector('.path-input');
  const hits = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue; }
        if (!rule.selectorText) continue;
        let m = false; try { m = el.matches(rule.selectorText); } catch { continue; }
        if (!m) continue;
        const bc = rule.style.getPropertyValue('border-color');
        const b = rule.style.getPropertyValue('border');
        if (bc || b) hits.push({ href: (sheet.href || '').split('/').pop(), sel: rule.selectorText, bc, b });
      }
    };
    walk(rules);
  }
  return JSON.stringify({ computed: getComputedStyle(el).borderColor, hits }, null, 1);
})();
