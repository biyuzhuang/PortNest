// Opens the window-close confirmation dialog.
(async () => {
  const close = document.querySelector('.titlebar-btn-close');
  if (!close) return 'close button missing';
  close.click();
  await new Promise(r => setTimeout(r, 400));
  return document.querySelector('.close-confirm-dialog') ? 'open' : 'not open';
})();
