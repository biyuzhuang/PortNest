// Opens the built-in local terminal so the session shell can be inspected
// without a real SSH host. Browser mode has no Tauri backend, so the session
// ends up in the "error" state — which is exactly the state we want to style.
(async () => {
  const button = [...document.querySelectorAll('.sidebar-header-actions button')]
    .find(el => (el.getAttribute('title') || '').includes('本地终端'));
  if (!button) return 'button not found';
  button.click();
  await new Promise(resolve => setTimeout(resolve, 2000));
  return 'clicked';
})();
