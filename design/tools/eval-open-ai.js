// Opens the AI dock from the rail (root is .ai-assistant-panel).
(async () => {
  const ai = [...document.querySelectorAll('.module-rail-btn')]
    .find(el => (el.getAttribute('title') || '').toLowerCase().includes('ai'));
  if (!ai) return 'ai button missing';
  ai.click();
  await new Promise(r => setTimeout(r, 900));
  return document.querySelector('.ai-assistant-panel') ? 'open' : 'not open';
})();
