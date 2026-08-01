# Auto-login on session expiry — Design

**Date:** 2026-08-01
**Extension:** `acceptor_clearcap`
**Status:** approved design, pending implementation plan

## Problem

The ClearCap monitor tab holds a broker session cookie. When that session
expires, `getAvailableOffers` stops returning an array (login redirect / HTML)
and the bot only alarms + flags `sessionLost`, then keeps polling a dead
session. A human must re-log-in by hand.

Operating model: one monitored tab stays open, polling every ~10 min
(`normalIntervalSec = 600`). ClearCap is **not** a first-to-accept race — orders
stay Available for 1–2 hours — so auto-login taking a few seconds to click
through the login page is fine; there is no urgency.

## Goal

When the session expires **while monitoring is active**, automatically click
through ClearCap's login page (credentials assumed pre-filled by the browser)
and resume polling — without risking account lockout from a bad-credential loop.

## Login flow (from screenshots)

ClearCap login is a server-rendered page at
`https://secure.clearcapital.com/login.cfm`, two steps:

1. **Username step** (`login.cfm?logout=true`): username pre-filled
   (e.g. `laurilei@65`), button labeled **Next →**.
2. **Password step** (`login.cfm?target=...`): password pre-filled, button
   labeled **Log in →**. Also shows "Switch user" / "Forgot your password?"
   links (must NOT be clicked).

Each click navigates to the next page, so a content script that simply fires
once per page load walks the whole flow: `Next` → page reload → `Log in` →
logged in.

## Decisions (locked)

- **Retry cap:** max **3 clicks per rolling 10-min window**. On the 4th, give up
  (flag `sessionLost`, stop clicking) to avoid a lockout spiral.
- **Trigger gate:** only auto-login when `monitorState.monitoring === true`.
  Respects a deliberate manual logout.
- **Button match:** text match (no exact selectors — we only have screenshots).
  A visible `button` / `input[type=submit|button]` / `a` whose trimmed text
  **starts with** `Log in` or `Next` (case-insensitive; the `→` is ignored).
  This excludes "Forgot your password?" and "Switch user".
- **Fast-burst polling: removed.** Not a race; always poll at the normal
  interval.

## Architecture

Five touch points. Detection stays where it already is; we add a login-page
script and small handoffs.

### 1. `login.js` (NEW) — content script on the login page

`manifest.json` gains a second `content_scripts` entry:
`matches: ["https://secure.clearcapital.com/login.cfm*"]`, `js: ["login.js"]`,
`run_at: "document_idle"`. (`host_permissions` already covers the host.)

On load, IIFE:

1. Bail if `chrome.runtime?.id` is missing (extension reloaded).
2. Read `monitorState`; if `!monitoring` → **return** (do nothing).
3. Read `loginAttempts` (array of ms timestamps); drop entries older than
   10 min. If `>= 3` remain → log "gave up", set
   `monitorState.sessionLost = true` (so the popup shows the red warning),
   **return**.
4. Wait up to ~3 s (poll every 50 ms) for a **visible** button matching
   `/^(log\s*in|next)\b/i` on `innerText`/`value`. Visible = `offsetParent !==
   null`. If none found → log + return.
5. Push `now` to `loginAttempts`, save, then `btn.click()`. Page navigates; the
   next page load re-runs this script for the second step.

### 2. `content.js` (broker) — three edits

- **Disable fast-burst:** remove `fastUntil` / `inFastMode()` / `FAST_*`
  constants and the `fastUntil = Date.now() + FAST_LINGER_MS` assignment.
  `pollInterval()` returns only the jittered normal interval.
- **Hand off on session loss:** in the `sessionLost` branch, if the rolling
  `loginAttempts` count is `< 3` and we haven't already started navigating this
  page (`window.__clearcapLoginNav` guard), set the flag and
  `location.assign('https://secure.clearcapital.com/login.cfm')`, then `return`
  (the poll loop stops because the page is navigating). This covers the case
  where the fetch returns login-HTML but the tab itself stayed on the broker
  page (the SPA didn't redirect it). If the cap is already hit, fall through to
  the existing throttled `sessionLost` alarm and keep polling (no navigation, no
  `return`).
- **Reset the counter on recovery:** on a good poll (`!sessionLost`), if
  `loginAttempts` is non-empty, clear it — a confirmed live session resets the
  window.

### 3. `background.js` — two edits

- **Clear `loginAttempts` on `START`** (fresh run starts with a clean window).
- **Safe-landing redirect:** `chrome.tabs.onUpdated` listener, gated to
  `changeInfo.status === 'complete'` **and** `tabId === monitorState.tabId`
  **and** `monitoring`. If the monitored tab settles on a
  `secure.clearcapital.com` URL that is **neither** a `login.cfm` page **nor** a
  `/secure/broker` page (i.e. logged in but dropped on some other page after
  login), redirect it to `DASHBOARD_URL`. Guarantees polling resumes regardless
  of where ClearCap lands the user post-login. Login pages and broker pages are
  left alone (owned by `login.js` / `content.js`).

### 4. `manifest.json`

Add the `login.js` content-script entry (above). No new permissions.

### 5. `CONTEXT.md`

Document the auto-login behavior, the `loginAttempts` storage key, and the
fast-burst removal.

## Data flow

```
poll (10 min) → getAvailableOffers
   ├─ array, actionable orders → quote (unchanged)
   ├─ array, none              → clear loginAttempts if any; idle
   └─ non-array / login-HTML  → sessionLost
        └─ monitoring & attempts<3 → location.assign(login.cfm)
             └─ login.js: Next → (reload) → Log in → logged in
                  └─ lands on broker (or off-target → bg redirects to dashboard)
                       └─ content.js resumes; first good poll clears loginAttempts
        └─ attempts>=3 → give up: flag sessionLost, throttled warning, keep polling
```

## New storage key

- `loginAttempts` — `[timestamp_ms, ...]`, rolling 10-min window, effective cap
  3. Cleared on `START`, on the first good poll after recovery.

## Failure modes

- **Bad/expired credentials:** 3 clicks in 10 min → stop, flag `sessionLost`,
  popup shows red. No lockout spiral. Auto-retries next 10-min window.
- **Login markup changed:** text match finds no button → logs, no click, session
  stays lost until fixed. Fails safe (never clicks the wrong control).
- **Extension reloaded mid-flow:** `chrome.runtime?.id` guard bails cleanly.

## Runtime-unverified (confirm on first live logout)

- Exact login button element/markup (text match should survive it).
- Whether ClearCap lands on the broker dashboard after login or off-target (the
  background safe-landing redirect covers off-target either way).
- Whether the expired session bounces the tab to `login.cfm` on its own, or the
  tab stays on broker and only the fetch sees login-HTML (the `content.js`
  hand-off covers both).

## Out of scope

- Scheduled auto-START via `chrome.alarms` (separate feature; tab stays open for
  now).
- Storing/entering credentials — assumed pre-filled by the browser/password
  manager.
