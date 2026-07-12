const startBtn   = document.getElementById('start-btn');
const stopBtn    = document.getElementById('stop-btn');
const optionsBtn = document.getElementById('options-link');
const dot        = document.getElementById('dot');
const countEl    = document.getElementById('count');
const labelEl    = document.getElementById('label');
const lastEl     = document.getElementById('last-checked');

function render(state) {
  const on = !!state?.monitoring;

  dot.className     = 'dot' + (on ? ' active' : '');
  startBtn.disabled = on;
  stopBtn.disabled  = !on;

  if (on && state.sessionLost) {
    countEl.textContent = '!';
    countEl.className   = 'count alert';
    labelEl.textContent = 'LOGGED OUT — re-login in the tab';
    lastEl.textContent  = state.lastChecked
      ? `Last checked: ${new Date(state.lastChecked).toLocaleTimeString()}`
      : '';
  } else if (on && state.lastChecked) {
    const c = state.count ?? 0;
    countEl.textContent = c;
    countEl.className   = 'count' + (c > 0 ? ' alert' : '');
    labelEl.textContent = `new order${c !== 1 ? 's' : ''}`;
    lastEl.textContent  = `Last checked: ${new Date(state.lastChecked).toLocaleTimeString()}`;
  } else if (!on) {
    countEl.textContent = '–';
    countEl.className   = 'count';
    labelEl.textContent = '';
    lastEl.textContent  = '';
  }
}

chrome.storage.local.get('monitorState', ({ monitorState }) => render(monitorState));

chrome.storage.onChanged.addListener((changes) => {
  if (changes.monitorState) render(changes.monitorState.newValue);
});

startBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'START' });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' });
});

optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
