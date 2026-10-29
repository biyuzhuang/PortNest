(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('新建连接'));
  if (!btn) return 'no button';
  btn.click();
  await wait(800);
  const card = document.querySelector('.connect-form-card');
  const scroll = document.querySelector('.connect-form-scroll-content');
  const remark = document.querySelector('.connect-remark-input');
  const pick = (el) => el ? {
    h: getComputedStyle(el).height, minH: getComputedStyle(el).minHeight,
    overflow: getComputedStyle(el).overflow, flex: getComputedStyle(el).flex,
    rect: Math.round(el.getBoundingClientRect().height * 10) / 10,
  } : null;
  return JSON.stringify({ card: pick(card), scroll: pick(scroll), remark: pick(remark) });
})();
