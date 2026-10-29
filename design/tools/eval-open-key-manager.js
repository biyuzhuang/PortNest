// Opens the SSH key manager (reachable from the app menu in browser mode).
(async () => {
  const more = [...document.querySelectorAll('.titlebar-btn')]
    .find(el => (el.getAttribute('title') || '') === '更多');
  if (!more) return 'menu button missing';
  more.click();
  await new Promise(r => setTimeout(r, 250));
  const item = [...document.querySelectorAll('.app-menu-item')]
    .find(el => (el.textContent || '').includes('密钥管理器'));
  if (!item) return 'key manager item missing';
  item.click();
  await new Promise(r => setTimeout(r, 600));
  return document.querySelector('.key-picker-modal') ? 'open' : 'not open';
})();
