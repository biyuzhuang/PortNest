// Opens the asset-tree context menu via a synthetic contextmenu event.
(async () => {
  const target = document.querySelector('.sidebar-nav') || document.querySelector('.asset-sidebar');
  if (!target) return 'tree missing';
  const rect = target.getBoundingClientRect();
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: Math.round(rect.left + 80),
    clientY: Math.round(rect.top + 120),
  });
  target.dispatchEvent(event);
  await new Promise(r => setTimeout(r, 400));
  const menu = document.querySelector('.asset-context-menu, .sidebar-context-menu, .context-menu');
  return menu ? 'open' : 'not open';
})();
