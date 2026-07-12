function flash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1200);
}

// Normal-mode poll interval in seconds (default 20, min 5). Fast mode is fixed ~0.5s.
// This is the only setting that affects the alarm today; accept-side settings
// (order type / keyword / exclude / daily accept limit) come back once
// auto-accept is wired for Clear Capital.
const normalInput = document.getElementById('normal-interval');
chrome.storage.local.get('normalIntervalSec', ({ normalIntervalSec = 20 }) => {
  normalInput.value = normalIntervalSec;
});
normalInput.addEventListener('input', (e) => {
  const v = Math.max(5, parseInt(e.target.value, 10) || 20);
  chrome.storage.local.set({ normalIntervalSec: v }, () => flash('saved-normal'));
});
