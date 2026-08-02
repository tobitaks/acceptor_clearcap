# Auto-login on Session Expiry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the ClearCap session expires while monitoring is active, automatically click through the pre-filled login page and resume polling, without risking account lockout.

**Architecture:** A new content script (`login.js`) runs on `login.cfm`, gated to `monitorState.monitoring`, and clicks the visible `Next` / `Log in` button (text match), capped at 3 tries / 10 min via a `loginAttempts` storage key. The broker `content.js` hands off to the login page on session loss and resets the counter on recovery; `background.js` redirects the monitored tab back to the dashboard if login lands it off-target.

**Tech Stack:** Chrome Manifest V3 extension — vanilla JS, `chrome.storage.local`, `chrome.tabs`, content scripts. **No automated test harness** in this repo; every task is verified manually by loading the unpacked extension at `chrome://extensions` and watching the DevTools console.

## Global Constraints

- Manifest V3; no new `permissions` and no new `host_permissions` (existing `https://secure.clearcapital.com/*` already covers the login page).
- All `chrome.*` calls must first check `chrome.runtime?.id` where a stale content-script context is possible (existing `extensionAlive()` pattern).
- Retry cap: **3 clicks per rolling 10-minute window** (`MAX_LOGIN_ATTEMPTS = 3`, `LOGIN_WINDOW_MS = 10 * 60 * 1000`).
- Login page host/path: `https://secure.clearcapital.com/login.cfm`. Dashboard: `https://secure.clearcapital.com/secure/broker/#/available` (`DASHBOARD_URL` in `background.js`).
- Button match regex: `/^(log\s*in|next)\b/i` against trimmed `innerText`/`value`; element must be visible (`offsetParent !== null`).
- New storage key: `loginAttempts` — `[timestamp_ms, ...]`, rolling 10-min window.
- Commit after each task. Commit message trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Remove fast-burst polling from `content.js`

Not a race — poll always at the normal interval. Isolated change; verifiable on its own.

**Files:**
- Modify: `content.js` (constants ~35-45, `inFastMode`/`jitter`/`pollInterval` ~88-98, the `fastUntil = ...` assignment ~367)

**Interfaces:**
- Produces: `pollInterval()` returns only the jittered normal interval; no `fastUntil` / `inFastMode` / `FAST_*` symbols remain.

- [ ] **Step 1: Delete the FAST constants**

Remove these lines (the `FAST_*` block, keep `NORMAL_DEFAULT_SEC` and `NORMAL_JITTER`):

```js
const FAST_MS            = 500;           // base fast interval
const FAST_JITTER        = 100;           // → 400–600 ms
const FAST_LINGER_MS     = 3 * 60 * 1000; // stay fast 3 min after the last new order
```

And remove:

```js
let fastUntil = 0;                          // FAST while Date.now() < fastUntil
```

- [ ] **Step 2: Delete `inFastMode()` and simplify `pollInterval()`**

Replace:

```js
function inFastMode() {
  return Date.now() < fastUntil;
}
function jitter(base, spread) {
  return base - spread + Math.floor(Math.random() * (2 * spread + 1));
}
function pollInterval() {
  if (inFastMode()) return jitter(FAST_MS, FAST_JITTER); // 400–600 ms
  const spread = Math.min(NORMAL_JITTER, Math.floor(normalMs * 0.25));
  return jitter(normalMs, spread);
}
```

with:

```js
function jitter(base, spread) {
  return base - spread + Math.floor(Math.random() * (2 * spread + 1));
}
function pollInterval() {
  const spread = Math.min(NORMAL_JITTER, Math.floor(normalMs * 0.25));
  return jitter(normalMs, spread);
}
```

- [ ] **Step 3: Remove the fast-burst trigger on new orders**

In the `count > 0` branch of `checkOrders`, delete this line and its comment:

```js
        // New offer(s) → burst to FAST to catch the rest of the bulk.
        fastUntil = Date.now() + FAST_LINGER_MS;
```

- [ ] **Step 4: Verify no fast-burst symbols remain**

Run: `grep -nE 'fastUntil|inFastMode|FAST_' content.js`
Expected: no output.

- [ ] **Step 5: Load + smoke-test**

Load unpacked at `chrome://extensions`, START, open the monitored tab's DevTools console. Expected: `[ClearCap] available: ...` lines appear roughly every `normalIntervalSec` seconds (default 20s), never sub-second. No console errors.

- [ ] **Step 6: Commit**

```bash
git add content.js
git commit -m "Remove fast-burst polling (ClearCap is not a race)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add `login.js` + manifest entry (click through login)

The core of the feature: a content script on the login page that clicks `Next` then `Log in`, gated and capped.

**Files:**
- Create: `login.js`
- Modify: `manifest.json` (`content_scripts` array)

**Interfaces:**
- Consumes: `monitorState` (`{monitoring, tabId, ...}`) and `loginAttempts` (`[ts,...]`) from `chrome.storage.local`.
- Produces: pushes timestamps to `loginAttempts`; may set `monitorState.sessionLost = true` when the cap is hit.

- [ ] **Step 1: Create `login.js`**

```js
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
  if (!btn) { console.warn('[ClearCap login] no Next/Log in button found'); return; }

  loginAttempts.push(now);
  await chrome.storage.local.set({ loginAttempts });
  console.log(`[ClearCap login] clicking "${(btn.innerText || btn.value || '').trim()}"`);
  btn.click();
})();
```

- [ ] **Step 2: Register `login.js` in `manifest.json`**

Add a second object to the `content_scripts` array (after the existing broker entry):

```json
    {
      "matches": ["https://secure.clearcapital.com/login.cfm*"],
      "js": ["login.js"],
      "run_at": "document_idle"
    }
```

- [ ] **Step 3: Validate manifest JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Manual test — clicks through login**

Reload the extension. START (monitoring active). In the monitored tab, log out of ClearCap manually (or visit `login.cfm?logout=true`). Open that tab's DevTools console.
Expected: `[ClearCap login] clicking "Next"` → page advances → `[ClearCap login] clicking "Log in"` → logged in. `chrome.storage.local.get('loginAttempts')` shows 1–2 timestamps.

- [ ] **Step 5: Manual test — cap holds**

With monitoring active, force the login page to reload 4+ times within a minute (bad session). Expected: after 3 clicks, console shows `gave up — 3 attempts in 10 min` and no further clicks; no account lockout.

- [ ] **Step 6: Manual test — gate holds**

STOP monitoring, then load `login.cfm` manually. Expected: **no** `[ClearCap login]` click log (gate blocks it).

- [ ] **Step 7: Commit**

```bash
git add login.js manifest.json
git commit -m "Add login.js: auto-click through ClearCap login (gated, capped 3/10min)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Session-loss handoff + counter reset in `content.js`

Make the broker script hand off to the login page when the session dies, and reset the counter once a live session is confirmed.

**Files:**
- Modify: `content.js` (the `sessionLost` branch ~356-361 and the good-poll path)

**Interfaces:**
- Consumes: `loginAttempts` from storage (written by `login.js`, Task 2).
- Produces: navigates the tab to `login.cfm` on session loss; clears `loginAttempts` on a good poll.

- [ ] **Step 1: Add the login-window constant near the top**

Below `let lastSessionAlarm = 0;` add:

```js
const LOGIN_WINDOW_MS = 10 * 60 * 1000;   // matches login.js retry window
const MAX_LOGIN_ATTEMPTS = 3;
```

- [ ] **Step 2: Hand off to login on session loss**

Replace the existing `sessionLost` branch:

```js
    if (sessionLost) {
      if (Date.now() - lastSessionAlarm > 60000) {
        lastSessionAlarm = Date.now();
        console.warn('[ClearCap] non-array response — logged out? Re-login in the tab.');
        playAlarm();
      }
    } else if (count > 0) {
```

with:

```js
    if (sessionLost) {
      // Session expired. Hand off to the login page so login.js can click through
      // — but only if we're under the 3-tries/10-min cap, and only navigate once
      // per page (navigating leaves this page and stops the poll loop).
      const { loginAttempts = [] } = await chrome.storage.local.get('loginAttempts');
      const recent = loginAttempts.filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
      if (recent.length < MAX_LOGIN_ATTEMPTS && !window.__clearcapLoginNav) {
        window.__clearcapLoginNav = true;
        console.warn('[ClearCap] session lost — navigating to login for auto-login');
        location.assign('https://secure.clearcapital.com/login.cfm');
        return; // page is navigating; do not reschedule the poll
      }
      if (Date.now() - lastSessionAlarm > 60000) {
        lastSessionAlarm = Date.now();
        console.warn('[ClearCap] session lost — auto-login capped or pending');
        playAlarm();
      }
    } else if (count > 0) {
```

- [ ] **Step 3: Reset the counter on a good poll**

Immediately after the line that computes `sessionLost` is known false and before the `if (sessionLost)` block — specifically right after the `chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', ... })` call — add:

```js
    // Confirmed live session — reset the auto-login retry window.
    if (!sessionLost) {
      const { loginAttempts = [] } = await chrome.storage.local.get('loginAttempts');
      if (loginAttempts.length) chrome.storage.local.remove('loginAttempts');
    }
```

- [ ] **Step 4: Verify the `return` only fires on navigation**

Run: `grep -n '__clearcapLoginNav' content.js`
Expected: two hits (the set + the guard read) on the same branch; confirm the `return` is inside the `if (recent.length < ... && !window.__clearcapLoginNav)` block only.

- [ ] **Step 5: Manual test — full recovery loop**

Reload extension, START. In the monitored tab, log out of ClearCap. Watch the console:
Expected: `[ClearCap] session lost — navigating to login for auto-login` → tab goes to login → `login.js` clicks `Next`/`Log in` → tab returns to broker → next poll: `[ClearCap] available: N new / M total` (no more session-lost). `chrome.storage.local.get('loginAttempts')` is now empty/undefined.

- [ ] **Step 6: Commit**

```bash
git add content.js
git commit -m "content.js: hand off to login on session loss; reset retry counter on recovery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `background.js` — clear counter on START + safe-landing redirect

Guarantee a clean retry window per run, and force the monitored tab back to the dashboard if login drops it off-target.

**Files:**
- Modify: `background.js` (the `START` handler ~55-64; add a `chrome.tabs.onUpdated` listener)

**Interfaces:**
- Consumes: `monitorState` (`{monitoring, tabId}`), `DASHBOARD_URL`.
- Produces: clears `loginAttempts` on START; redirects the monitored tab to `DASHBOARD_URL` when it lands logged-in but off-target.

- [ ] **Step 1: Clear `loginAttempts` on START**

In the `if (msg.type === 'START')` handler, add `chrome.storage.local.remove('loginAttempts');` as the first line inside the handler:

```js
  if (msg.type === 'START') {
    chrome.storage.local.remove('loginAttempts'); // fresh retry window per run
    chrome.tabs.create({ url: DASHBOARD_URL, active: true }, (tab) => {
```

- [ ] **Step 2: Add the safe-landing redirect listener**

Append near the other `chrome.tabs.*` listeners (e.g. above `chrome.tabs.onRemoved`):

```js
// After auto-login, ClearCap may land the monitored tab on a page that is
// neither the login page nor the broker dashboard. If so, send it back to the
// dashboard so content.js resumes polling. Scoped strictly to the monitored tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  chrome.storage.local.get('monitorState', ({ monitorState }) => {
    if (!monitorState?.monitoring || monitorState.tabId !== tabId) return;
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab?.url) return;
      const u = tab.url;
      if (!u.startsWith('https://secure.clearcapital.com/')) return;
      const isLogin  = /\/login\.cfm/i.test(u);
      const isBroker = /\/secure\/broker/i.test(u);
      if (!isLogin && !isBroker && u !== DASHBOARD_URL) {
        console.log('[ClearCap bg] post-login off-target — redirecting to dashboard');
        chrome.tabs.update(tabId, { url: DASHBOARD_URL }, () => void chrome.runtime.lastError);
      }
    });
  });
});
```

- [ ] **Step 3: Validate JS parses**

Run: `node -c background.js && echo ok`
Expected: `ok`.

- [ ] **Step 4: Manual test — off-target landing recovers**

Reload, START. Trigger a logout so auto-login runs. If ClearCap lands on the broker dashboard directly, this listener is a no-op (fine). To exercise it: while monitoring, manually navigate the monitored tab to e.g. `https://secure.clearcapital.com/secure/vendor/` (a non-broker in-domain page).
Expected: console `post-login off-target — redirecting to dashboard`, tab returns to `#/available`, polling resumes.

- [ ] **Step 5: Manual test — normal broker nav untouched**

While monitoring, click around the broker SPA (`#/inprogress`, `#/completed`).
Expected: **no** redirect log; the listener leaves broker pages alone.

- [ ] **Step 6: Commit**

```bash
git add background.js
git commit -m "background.js: clear retry counter on START; redirect off-target tab to dashboard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Document auto-login in `CONTEXT.md`

Keep the context doc accurate — new behavior, new storage key, fast-burst removal.

**Files:**
- Modify: `CONTEXT.md` (Storage keys section ~134-143; add an Auto-login section; adjust the Adaptive-polling section ~114-119)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the `loginAttempts` storage key**

In the "## Storage keys" list, add:

```md
- `loginAttempts` — `[timestamp_ms]`, rolling 10-min window (auto-login retry cap, max 3)
```

- [ ] **Step 2: Add an Auto-login section**

Insert after the "## Session / logged-out" section:

```md
## Auto-login (session recovery)

When monitoring is active and the session expires, the bot re-logs-in itself
(credentials assumed pre-filled by the browser):

- `content.js` detects `sessionLost` → navigates the monitored tab to
  `login.cfm` (covers the case where only the fetch sees login-HTML but the tab
  stayed on the broker page).
- `login.js` (content script on `login.cfm*`) clicks the visible `Next` /
  `Log in` button (text match `/^(log\s*in|next)\b/i`). It fires once per page
  load, so the two-step flow (Username→Next, Password→Log in) walks itself.
- **Cap:** max 3 clicks per rolling 10-min window (`loginAttempts`). On the 4th,
  it gives up, flags `sessionLost` (popup shows red), keeps polling. No lockout
  spiral. Gated to `monitorState.monitoring` — a deliberate manual logout is
  left alone.
- After login, `background.js` redirects the monitored tab to the dashboard if
  ClearCap dropped it off-target. First good poll clears `loginAttempts`.
```

- [ ] **Step 3: Update the Adaptive-polling section**

Replace the "## Adaptive polling (anti-detection)" section body with:

```md
Volume-based bans (ValueLink-style) count requests/day. Poll at a fixed,
jittered interval — `normalIntervalSec` (Settings, default 20s, min 5),
live-updates. ClearCap is **not** a first-to-accept race (orders stay Available
1–2h), so there is no fast-burst mode. Typical operating cadence: 600s (10 min).
```

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md
git commit -m "docs: document auto-login + loginAttempts; note fast-burst removed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `login.js` gated + capped + text match → Task 2. ✓
- `content.js` handoff + counter reset → Task 3. ✓
- Fast-burst removal → Task 1. ✓
- `background.js` clear-on-START + safe-landing → Task 4. ✓
- `manifest.json` entry → Task 2. ✓
- `CONTEXT.md` + `loginAttempts` key → Task 5. ✓

**Type/name consistency:** `MAX_LOGIN_ATTEMPTS`, `LOGIN_WINDOW_MS`, `loginAttempts`, `BUTTON_RE`, `window.__clearcapLoginNav`, `DASHBOARD_URL` used consistently across Tasks 2–4. Constants intentionally duplicated in `login.js` and `content.js` (separate script contexts, no shared module).

**Placeholders:** none — all steps carry concrete code and exact verification commands.

**Note on ordering:** Task 1 (fast-burst removal) is independent and first for a clean isolated commit. Task 2 creates `login.js` before Task 3 makes `content.js` navigate to it, so the target script exists before it is invoked.
