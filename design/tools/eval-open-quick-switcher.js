// Opens the quick switcher (Ctrl+K surface) for inspection.
(async () => {
  const trigger = document.querySelector('.titlebar-search');
  if (!trigger) return 'search trigger missing';
  trigger.click();
  await new Promise(r => setTimeout(r, 500));
  const input = document.querySelector('.quick-switcher input');
  input?.focus();
  return document.querySelector('.quick-switcher') ? 'open' : 'not open';
})();
