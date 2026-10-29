// Opens the new-connection dialog (browser mode can render it; only saving
// needs Tauri) so the form surface can be inspected.
(async () => {
  const button = [...document.querySelectorAll('.asset-icon-button')]
    .find(el => (el.getAttribute('title') || '').includes('新建连接'));
  if (!button) return 'new-connection button not found';
  button.click();
  await new Promise(resolve => setTimeout(resolve, 900));
  return 'opened';
})();
