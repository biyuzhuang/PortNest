(async () => {
  const host = document.createElement('div');
  host.className = 'app-container';
  host.style.cssText = 'position:fixed;left:-9999px;top:0;';
  const states = ['connected', 'connecting', 'reconnecting', 'starting', 'restored', 'disconnected', 'stopped', 'error'];
  const shapes = ['session-tab-status', 'session-status-dot', 'conn-status-dot', 'status-dot'];
  host.innerHTML = states.map(state => shapes.map(shape =>
    `<span class="${shape} status-${state}" data-k="${shape}/${state}"></span>`
  ).join('')).join('');
  document.body.appendChild(host);
  await new Promise(r => setTimeout(r, 200));
  const out = {};
  for (const el of host.querySelectorAll('[data-k]')) {
    out[el.dataset.k] = getComputedStyle(el).backgroundColor;
  }
  host.remove();
  return JSON.stringify(out);
})();
