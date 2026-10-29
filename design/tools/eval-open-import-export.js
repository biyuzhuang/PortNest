(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const more = [...document.querySelectorAll('.titlebar-btn')].find(el => (el.getAttribute('title') || '') === '更多');
  if (!more) return 'menu button missing';
  more.click();
  await wait(300);
  const item = [...document.querySelectorAll('.app-menu-item')].find(el => (el.textContent || '').includes('导入 / 导出会话'));
  if (!item) return 'item missing';
  item.click();
  await wait(700);
  return document.querySelector('.session-transfer-modal') ? 'open' : 'not open';
})();
