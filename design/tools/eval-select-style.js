// Print the computed box/style of the first select on the appearance page.
(() => {
  const el = document.querySelector('.settings-page .settings-card select');
  if (!el) return 'no select';
  const cs = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return JSON.stringify({
    rect: [box.x, box.y, box.width, box.height].map(v => Math.round(v * 10) / 10),
    padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
    border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderTopColor],
    font: [cs.fontSize, cs.fontFamily],
    width: cs.width,
    minWidth: cs.minWidth,
  });
})();
