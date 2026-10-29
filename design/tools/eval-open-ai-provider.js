// Opens the AI provider picker and selects the first provider so the whole
// configuration panel (fields, model list, actions) is on screen.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const add = document.querySelector('.ai-provider-add-button');
  if (!add) return 'no add button';
  add.click();
  await wait(400);
  const picker = document.querySelector('.ai-provider-picker-list button');
  if (!picker) return 'no provider rows';
  picker.click();
  await wait(700);
  return document.querySelector('.ai-config-card') ? 'config open' : 'config missing';
})();
