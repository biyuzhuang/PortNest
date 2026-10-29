(() => JSON.stringify({
  url: location.search,
  switches: document.querySelectorAll('.settings-switch').length,
  roleSwitch: document.querySelectorAll('[role="switch"]').length,
  settingsRoot: !!document.querySelector('.settings-shell, .settings-window, .settings-modal, .settings-page'),
  classes: [...new Set([...document.querySelectorAll('[class]')].slice(0, 60).map(e => e.className))].slice(0, 12),
}))();
