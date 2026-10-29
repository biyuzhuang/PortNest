// Opens the new-folder dialog and the app menu (two separate runs use the flag).
(async () => {
  const params = new URLSearchParams(location.search);
  const want = params.get('surface') || 'folder';
  if (want === 'menu') {
    const more = [...document.querySelectorAll('.titlebar-btn')]
      .find(el => (el.getAttribute('title') || '') === '更多');
    if (!more) return 'menu button missing';
    more.click();
    await new Promise(r => setTimeout(r, 350));
    return document.querySelector('.app-menu-dropdown') ? 'menu open' : 'menu closed';
  }
  const folder = [...document.querySelectorAll('.sidebar-header-actions button')]
    .find(el => (el.getAttribute('title') || '').includes('文件夹'));
  if (!folder) return 'folder button missing';
  folder.click();
  await new Promise(r => setTimeout(r, 350));
  return document.querySelector('.folder-create-dialog') ? 'folder open' : 'folder closed';
})();
