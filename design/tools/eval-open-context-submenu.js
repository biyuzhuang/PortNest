// Opens the context menu and forces its first submenu visible for a screenshot.
(async () => {
  const target = document.querySelector('.sidebar-nav') || document.querySelector('.asset-sidebar');
  if (!target) return 'tree missing';
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: Math.round(rect.left + 80), clientY: Math.round(rect.top + 120),
  }));
  await new Promise(r => setTimeout(r, 400));
  const submenu = document.querySelector('.hexhub-context-submenu');
  if (!submenu) return 'no submenu';
  submenu.classList.add('open');
  await new Promise(r => setTimeout(r, 200));
  return 'submenu open';
})();
