# BPO HQ Sign-in Gate — Design

**Date:** 2026-10-30
**Status:** Draft
**Branch:** `feat/bpohq-auth`
**Reference implementation:** `../acceptor_estreet` (same feature, already shipped there)

## Intent

Only operators with a BPO HQ account may use the ClearCap extension. The
operator signs in once in the popup; until then the extension does nothing.
If their access is withdrawn in BPO HQ, a running bot stops within about an
hour. This is the same sign-in gate eStreet already has, ported to ClearCap.

## Goals

- Popup shows a sign-in screen until signed in. Two methods: **email +
  password**, or **paste an admin-minted token** ("Use a token instead" link).
- START refuses without a stored sign-in.
- Settings page and Logs (options) page show "Sign in first" while signed out.
- Logs page shows the signed-in account and a **Sign out** button.
- Access is re-checked against BPO HQ (`GET /api/auth/me/`):
  - on START,
  - when the popup opens,
  - **every 60 minutes** by a `chrome.alarms` alarm (user decision), while
    monitoring.
- Revoked/invalid sign-in → sign out, stop monitoring (close the tab, like
  STOP), popup shows the sign-in screen with the reason.

## Non-goals

- **No order/quote syncing** to BPO HQ (user decision). No company or MLS
  settings.
- No ClearCap portal keepalive. The order poll (`getAvailableOffers`, every
  `normalIntervalSec`) already keeps the ClearCap session alive.
- Fixing the other analysis findings (all broker tabs polling, Clear Log
  resetting the daily cap, stale README, etc.) except where listed under
  "Required supporting change".

## Anti-goals

- **A BPO HQ outage stopping quoting.** Network errors, timeouts, 5xx and 429
  keep the current state; only a definite revoke (403 on `/me/`) or a missing
  sign-in stops the bot.
- **Any extra request to ClearCap.** The gate talks only to BPO HQ.
- **Sign-out that doesn't stick.** After sign-out or a revoke, nothing may write
  `monitoring: true` back (see supporting change).

## Decided (user's, carried over from eStreet)

1. Gate only — no company selection, no data sync.
2. Sign out button lives on the Logs (options) page.
3. Server address is one `BASE_URL` constant in a new `config.js`, set to
   `https://bpohq.com/` (trailing slash stripped). Local dev value
   `http://localhost:8000`. `host_permissions` gains `https://bpohq.com/*` and
   `http://localhost:8000/*`.
4. Token sign-ins (`source: 'token'`) are **not** revoked on the server at sign
   out; email/password sign-ins (`source: 'login'`) are (`POST
   /api/auth/logout/`, fire-and-forget).
5. No OTP/authenticator field in the popup.
6. Hourly re-check while running (this conversation).

## How it works

### Code reuse

Copy from eStreet unchanged where possible:

- `config.js` (BASE_URL).
- `lib/auth-api.js` — `authRequest`, `authLogin`, `authMe`, `authLogout`,
  `authCleanToken`, `classifyAuthFailure`. Pure, dual export.
- `lib/storage-queue.js` — `createWriteQueue`.
- Their tests (`tests/auth-api.test.js`, `tests/storage-queue.test.js`) and a
  `package.json` with `"test": "node --test tests/*.test.js"`. This is
  ClearCap's first test suite.

The background worker loads them with
`importScripts('config.js', 'lib/storage-queue.js', 'lib/auth-api.js', 'default-rates.js')`.
Check worker function names for collisions with lib exports (shared global
scope).

Background auth code ports eStreet's `loadAuth`, `saveAuth`, `clearAuth`,
`authDeps` (10 s timeout), `toAuthUser`, `checkAuth` (compare-and-set on the
token so a concurrent sign-out isn't undone), `checkAuthAndEnforce`, and the
`AUTH_LOGIN`, `AUTH_TOKEN`, `AUTH_LOGOUT`, `AUTH_CHECK` message handlers,
minus everything company/sync related (`companies` is not stored).

### Stored auth

`auth` = `{ token, user, source: 'login'|'token', checkedAt }`.

### Checks

| When | Call | On revoked / signed out | On transient |
|------|------|------------------------|--------------|
| START | `/me/` | refuse START, popup shows reason | refuse START: "Could not reach BPO HQ. Check the connection and try again." (matches eStreet; only a running bot rides out outages) |
| Popup open (`AUTH_CHECK`) | `/me/` | sign out; if monitoring, stop | nothing |
| Alarm `auth-check`, every 60 min | `/me/` | sign out; if monitoring, stop + reason | nothing, next hour retries |
| Every order poll (content.js) | none — reads cached `auth` from storage | no token → poller does nothing (like `monitoring: false`) | — |

The alarm is created on START and cleared on STOP/stop. Needs the `alarms`
permission. A worker restart does not lose it (alarms persist).

### Stopping

"Stop" here = what STOP does today (close the monitored tab, write
`monitoring: false`), plus a `stopReason` (`'BPO HQ access revoked'` /
`'Not signed in to BPO HQ'`) the popup can show. Sign-out stops monitoring too.

### Required supporting change: queued `monitorState` writes

Today `STATUS_UPDATE`, `tabs.onRemoved`, START, STOP and `login.js` each
read-modify-write `monitorState` with no queue, so a `STATUS_UPDATE` racing a
stop can write `monitoring: true` back. That would let a revoked operator keep
quoting. So:

- Every background write of `monitorState` goes through the write queue.
- `STATUS_UPDATE` never changes `monitoring`/`tabId`; it only merges
  `count`, `lastChecked`, `sessionLost`, and only if still monitoring.
- `login.js` stops writing `monitorState` itself and sends a message
  (e.g. `SESSION_LOST`) that the worker applies in the queue.
- Network calls stay outside queued jobs; never await a queued function from
  inside a queued job (deadlock).

### Popup

Port eStreet's signed-out view: email, password, "Use a token instead" /
"Use email and password instead" toggle, Sign in button, error line. Same
error texts (`transientText`: "BPO HQ error (N)…" / "Could not reach BPO HQ
(reason)."; lastError: "Extension error: … Reload the extension and try
again."). Signed in → today's popup unchanged, plus the stop reason when
present. Keep ClearCap's look (dark-yellow brand), not eStreet's.

### Settings and Logs pages

Signed out → page body replaced by a "Sign in first — open the extension popup"
card (eStreet's gate). Logs page header gets "Signed in as <email>" (plus
" · with a token" for token sign-ins) and **Sign out**. Pages react live to
`auth` changing in storage.

## Left to the builder

- File layout of the background auth section and exact message names beyond
  the four `AUTH_*` ones.
- Copy and layout, matching ClearCap's existing pages.
- Whether `checkedAt` is shown anywhere.

## Docs

Update `CONTEXT.md` (storage keys, sign-in section, files table) and the
monorepo `CLAUDE.md` only if ClearCap is mentioned there. README is stale
overall; add a short "BPO HQ sign-in" section, don't rewrite the rest.

## Risks

- Existing installs: after updating, the operator must sign in before START
  works. Intended.
- Hourly check means a revoked operator can keep quoting up to ~60 min.
  Accepted (user decision).
