# ClearCap Acceptor — Context

Chrome extension (MV3) that monitors the **Clear Capital** broker portal for new
orders, sounds an audio alarm, and **auto-submits a counter-offer QUOTE** on each
priced order. Part of the `auto_acceptors` monorepo — one extension per portal
(see repo `CLAUDE.md`). ClearCap is a **different platform** from eStreet/Ascribe
(those are SpurAMS ASP.NET WebForms); do NOT assume their DOM/postback patterns.

## Platform

- Broker UI = **Angular SPA**, hash routing: `secure.clearcapital.com/secure/broker/#/available`
  (new orders) · `#/inprogress` (accepted) · `#/completed` (past).
- Backend = **ColdFusion AJAX** returning plain JSON. No viewstate, no DOM scrape.
- We poll the JSON endpoint directly (same-origin `fetch`, session cookie rides
  along). Only needs one logged-in broker tab open.

## The action is a QUOTE, not an accept

Each new order row has **3 buttons: Accept / Quote / Decline(Cancel)**. This bot
**only ever clicks Quote** — never Accept, never Cancel. New orders are worth ~$20;
we counter with our own compensation from a rate table. A quote is a *proposal*
(ClearCap/client then accepts or declines it) — so it is NOT a first-to-click race.

## Endpoints

**Detection (GET):**
```
https://secure.clearcapital.com/secure/vendor/remote/ajax/vendorReports.cfc?method=getAvailableOffers
```
Returns `[]` or an array of offer objects. `getAccepted` is the In-Progress feed.

**Quote submit (POST, `application/x-www-form-urlencoded`):**
```
https://secure.clearcapital.com/secure/vendor/remote/ajax/vendorBid.cfc
```
Payload (12 fields):

| field | value / source |
|---|---|
| `method` | `addBid` (constant; CFC method is in the BODY, not the URL) |
| `solicitationId` | offer `SOLICITATION_ID` |
| `transactionId` | offer `TRANSACTION_ID` |
| `productTypeId` | offer `PRODUCT_TYPE_ID` |
| `officeId` | offer `OFFICE_ID` |
| `vendorFee` | **rate-table amount** (absolute $) |
| `vendorDueDate` | current due **+2 days**, `MM/DD/YYYY` |
| `vendorDueTime` | `DUEDATE_VENDOR_LOCAL_TIME` verbatim (e.g. `11:00 AM`) |
| `expirationDate` | current due **+1 day**, `MM/DD/YYYY` |
| `expirationTime` | same time |
| `vendorBidReasonCd` | `STANDARD_RATE` (constant) |
| `vendorBidReasonComments` | empty |

Response: `{BIDAUTOACCEPTED, ERRORMESSAGE, VENDORBIDID}`.
**Success = `ERRORMESSAGE === ''` and `VENDORBIDID` truthy** → outcome `quoted`; else `failed`.

### Why the quote fires from content.js (not the service worker)

The POST needs the Angular **`XSRF-TOKEN` cookie echoed as an `X-XSRF-TOKEN`
header**. Only the page context can read `document.cookie`, so `submitQuote()`
runs in `content.js`. The background worker only logs.

### The "Confirm" step is UI-only

The manual flow is fill → Submit → "Confirm & Accept Terms of Assignment"
(Engagement-Letter checkbox + Confirm). But the network POST is the single `addBid`
call — no engagement-letter field in the payload. Headless just fires that POST.

## Offer JSON field names (getAvailableOffers)

These DIFFER from the getAccepted feed. Use:
- City = **`ADDRESS_CITY`** (UPPERCASE) · Zip = **`ADDRESS_ZIP`** (number) · State = `ADDRESS_STATE`
- Current due (ET, vendor-local) = **`DUEDATE_VENDOR_LOCAL_DATE`** + **`DUEDATE_VENDOR_LOCAL_TIME`**
  (`DUEDATE` is Pacific — do NOT use it for the form)
- Comp = `PAYMENT`; Keys = `SOLICITATION_ID` / `TRANSACTION_ID` / `ORDER_ID` / `MPID`
- Form = `BROKER_FORM_NAME_S`; scope = `PRODUCT_SCOPE_DESC`
- Quote state = **`HAS_QUOTE`** (0/1), `QUOTE_ID`, `QUOTE_STATUS`, `QUOTE_FEE`

## Pricing — rate table (Settings)

Row-based editor: **City · Zip · Exterior $ · Interior $** (one zip per row; a city
with many zips = many rows). Stored as `quoteRates` = `[{city, zip, ext, int}]`.

- **Match by ZIP**; if multiple rows share a zip (e.g. the Edisto trio on 29438),
  the row whose **city** also matches wins, else the first.
- **Exterior vs Interior** chosen per order (see below); use that rate.
- **No matching row, OR that type's rate is blank/0/N-A → SKIP** (alarm only, never
  quote an unpriced order).
- **Empty table → quoting disabled** (pure alarm).
- Seeded on **first install** from `default-rates.js` (146 rows / 91 cities,
  generated from `initial-table-rate.csv`; Commercial column intentionally dropped).
  `onInstalled` seeds only when `quoteRates` is empty — never clobbers user edits.

### Exterior vs Interior classifier (`isExterior` in content.js)

Reads `BROKER_FORM_NAME_S`, case-insensitive:
1. contains `"interior"` → **Interior** (explicit interior always wins)
2. else contains any of `property condition`, `drive-by`, `post disaster`, `ext` → **Exterior**
3. else → **Interior**

## Dates / timezone

All times are **ET** (vendor-local). Quote Due = current due **+2 calendar days**,
Quote Expires = **+1 day**, keeping the same clock time string — so no timezone math
(48h == +2 days, 24h == +1 day). `addDaysMDY()` does the date arithmetic.

## Guards (no double-quote)

- **`HAS_QUOTE === 1`** offers are dropped from count/alarm/quote — a quoted order
  stays in the feed with this flag set. Reads the feed (not just memory), so a
  service-worker/page restart can't re-quote.
- Session Sets `processedIds` (alarmed) + `attemptedQuoteIds` (quoted) back this up
  within a session.

## Adaptive polling (anti-detection)

Volume-based bans (ValueLink-style) count requests/day. Poll at a fixed,
jittered interval — `normalIntervalSec` (Settings, default 20s, min 5),
live-updates. ClearCap is **not** a first-to-accept race (orders stay Available
1–2h), so there is no fast-burst mode. Typical operating cadence: 600s (10 min).

## Daily quote limit

`dailyQuoteLimit` (Settings, 0/blank = unlimited). Counts quotes **submitted** today
(`outcome === 'quoted'`; unpriced/failed don't count), recomputed from the log
(restart-safe) + a running counter. Trims before firing (never overshoots); on hit
sends `STOP` → background closes the monitored tab → polling stops.

## Session / logged-out

If `getAvailableOffers` returns a non-array (login redirect / HTML), that's treated
as **session lost** → alarm (throttled 60s) + popup shows a red warning.

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

## Storage keys

- `quoteRates` — `[{city, zip, ext, int}]`
- `normalIntervalSec` — number (sec)
- `dailyQuoteLimit` — number (0 = unlimited)
- `acceptedLog` — quote log `[{id, address, city, zip, fee, form, outcome, vendorBidId, errorMessage, timestamp}]` (cap 500)
- `detectionLog` — `[{count, orders, timestamp}]` (cap 100)
- `monitorState` — `{monitoring, tabId, count, lastChecked, sessionLost}`
- `heartbeatLog` — alive stamps (cap 20)
- `loginAttempts` — `[timestamp_ms]`, rolling 10-min window (auto-login retry cap, max 3)

Outcomes: `quoted` (pending) · `failed` · `unpriced` (skipped, no/blank rate).

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, host permissions |
| `content.js` | Poll getAvailableOffers, alarm, rate lookup, **quote POST** (XSRF), daily cap |
| `background.js` | Offscreen audio, START/STOP, tab lifecycle, logging, seed rates on install |
| `default-rates.js` | `DEFAULT_RATES` seed (generated from initial-table-rate.csv) |
| `offscreen.html/js` | AudioContext beep (offscreen doc) |
| `popup.html/js` | Start/Stop UI, live count |
| `options.html/js` | Quote log, stats, daily summary, detections |
| `settings.html/js` | Poll interval, rate table editor (+ Clear all), daily quote limit |
| `icons/` | Solid dark-yellow (#C9A227) PNGs (16/48/128) |

## Usage

1. `chrome://extensions` → Developer mode → Load unpacked → this folder.
2. Log into Clear Capital in the same profile.
3. Click the extension icon → **START** (opens the Available tab, begins monitoring).
4. New order → alarm; priced order → auto-quote. Watch the console
   (`[ClearCap] quote quoted <id> @ $NN`) + the options Quotes log.
5. **STOP** closes the tab and halts.

## NOT yet runtime-verified in the wild

- Whether the server actually requires `X-XSRF-TOKEN` (sent defensively).
- The Interior classifier — every capture so far was Exterior. When a real Interior
  order lands, confirm its `BROKER_FORM_NAME_S`/`PRODUCT_SCOPE_DESC` and pin the matcher.
- Exact success/error response under a real live submit; date/time slot acceptance.

First live quote is the real test — if it fails, capture the `vendorBid.cfc`
request + response and adjust.
