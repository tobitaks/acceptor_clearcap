// ClearCap — auto-login on the login page.
//
// Runs on https://secure.clearcapital.com/login.cfm (two-step: Username→Next,
// Password→Log in). Credentials are assumed pre-filled by the browser/password
// manager; this script only clicks the button. It fires once per page load, so
// the two steps walk themselves: Next → (page reload) → Log in → logged in.
//
// Safety: only acts while monitoring is active, and never more than 3 clicks per
// rolling 10-minute window (loginAttempts) — a bad-credential loop can't spin.
const MAX_LOGIN_ATTEMPTS = 3;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const BUTTON_RE = /^(log\s*in|next)\b/i;

function alive() { return !!chrome.runtime?.id; }

// First visible control whose label starts with "Log in" or "Next". Excludes
// "Forgot your password?" / "Switch user" (they don't match the regex).
function findLoginButton() {
  const els = document.querySelectorAll(
    'button, input[type=submit], input[type=button], a'
  );
  for (const el of els) {
    const label = (el.innerText || el.value || '').trim();
    if (BUTTON_RE.test(label) && el.offsetParent !== null) return el;
  }
  return null;
}

// Poll for the button up to `timeoutMs` (server-rendered page, but be safe).
function waitForButton(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const btn = findLoginButton();
      if (btn) return resolve(btn);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

(async () => {
  if (!alive()) return;

  const { monitorState } = await chrome.storage.local.get('monitorState');
  if (!monitorState?.monitoring) return; // deliberate manual logout — do nothing

  const now = Date.now();
  let { loginAttempts = [] } = await chrome.storage.local.get('loginAttempts');
  loginAttempts = loginAttempts.filter((t) => now - t < LOGIN_WINDOW_MS);

  if (loginAttempts.length >= MAX_LOGIN_ATTEMPTS) {
    console.warn(`[ClearCap login] gave up — ${MAX_LOGIN_ATTEMPTS} attempts in 10 min`);
    await chrome.storage.local.set({
      monitorState: { ...monitorState, sessionLost: true }
    });
    return;
  }

  const btn = await waitForButton(3000);
  if (!btn) {
    console.warn('[ClearCap login] no Next/Log in button found');
    await chrome.storage.local.set({ monitorState: { ...monitorState, sessionLost: true } });
    return;
  }

  loginAttempts.push(now);
  await chrome.storage.local.set({ loginAttempts });
  console.log(`[ClearCap login] clicking "${(btn.innerText || btn.value || '').trim()}"`);
  btn.click();
})();
