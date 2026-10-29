(async () => {
  const host = document.createElement('div');
  host.className = 'mysql-workspace';
  host.innerHTML = `
    <div class="mysql-tree">
      <div class="mysql-tree-row database active">
        <span class="mysql-tree-toggle expanded"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 6 6 6-6 6"/></svg></span>
        <b>demo_db</b><em>3</em>
      </div>
      <div class="mysql-tree-row table">
        <span class="mysql-table-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16"/></svg></span>
        <span class="mysql-object-name">users</span>
      </div>
      <div class="mysql-object-group collapsible">
        <span class="mysql-object-type-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/></svg></span>
        <b>表</b><em>3</em>
      </div>
      <div class="mysql-object-card">
        <span class="mysql-object-card-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16"/></svg></span>
        <strong>users</strong>
      </div>
    </div>`;
  document.body.appendChild(host);
  await new Promise(r => setTimeout(r, 200));
  const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
  const toggle = host.querySelector('.mysql-tree-toggle svg');
  const typeIcon = host.querySelector('.mysql-object-type-icon');
  const tableIcon = host.querySelector('.mysql-table-icon');
  const result = {
    toggle: rect(toggle),
    typeIconColor: getComputedStyle(typeIcon).color,
    tableIconColor: getComputedStyle(tableIcon).color,
    cardIconColor: getComputedStyle(host.querySelector('.mysql-object-card-icon')).color,
  };
  host.remove();
  return JSON.stringify(result);
})();
