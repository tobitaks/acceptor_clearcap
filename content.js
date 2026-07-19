// ClearCap — Available Offers monitor + auto-QUOTE (counter-offer).
//
// Clear Capital's broker UI is an Angular SPA, but the "Available" tab is fed by
// a plain JSON endpoint. We poll it directly (same-origin fetch, session cookie
// rides along) — no DOM scrape.
//
//   GET  vendorReports.cfc?method=getAvailableOffers  -> [] or [ offer, ... ]
//
// ACTION = QUOTE, not accept. Each new order (worth ~$20) is countered by
// submitting a quote via vendorBid.cfc (method=addBid). Our quote compensation
// comes from a user-managed rate table (city+zip -> amount, absolute). No table
// match => SKIP (alarm only — never quote an unpriced order). Due Date = current
// due +48h (+2 days), Quote Expires = +24h (+1 day), Reason = "Standard rate".
//
// The whole quote fires here in the content script (NOT the background worker):
// the server uses an Angular XSRF cookie that must be echoed as an X-XSRF-TOKEN
// header, and only the page context can read document.cookie.
const AVAILABLE_URL =
  'https://secure.clearcapital.com/secure/vendor/remote/ajax/vendorReports.cfc?method=getAvailableOffers';
const BID_URL =
  'https://secure.clearcapital.com/secure/vendor/remote/ajax/vendorBid.cfc';

const QUOTE_REASON_CD = 'STANDARD_RATE';
const DUE_OFFSET_DAYS     = 2; // quote Due Date  = current due + 48h
const EXPIRE_OFFSET_DAYS  = 1; // quote Expires   = current due + 24h

let lastSessionAlarm = 0;   // throttle logged-out alarm
let lastHeartbeat = 0;      // 30-min alive stamp
const processedIds = new Set();      // offer IDs already alarmed/logged this session
const attemptedQuoteIds = new Set(); // offer IDs we've already fired a quote for (session)

// --- Adaptive polling (anti-detection) -------------------------------------
// Volume-based bans (ValueLink-style) count requests/day. Poll SLOW by default,
// burst FAST while a bulk is actively landing.
const NORMAL_DEFAULT_SEC = 20;            // fallback if the setting is unset
const NORMAL_JITTER      = 5000;          // max ± jitter on the normal interval
const FAST_MS            = 500;           // base fast interval
const FAST_JITTER        = 100;           // → 400–600 ms
const FAST_LINGER_MS     = 3 * 60 * 1000; // stay fast 3 min after the last new order

let fastUntil = 0;                          // FAST while Date.now() < fastUntil
let normalMs  = NORMAL_DEFAULT_SEC * 1000;  // cached normal interval (from Settings)
let rates     = [];                         // cached rate table (from Settings)
let dailyLimit = 0;                         // cached daily quote cap (0 = unlimited)
let monitorStopped = false;                 // set true once the cap stops us

// Load + live-update settings (no reload needed).
chrome.storage.local.get(['normalIntervalSec', 'quoteRates', 'dailyQuoteLimit'], (r) => {
  const s = parseInt(r.normalIntervalSec, 10);
  if (s > 0) normalMs = s * 1000;
  if (Array.isArray(r.quoteRates)) rates = r.quoteRates;
  dailyLimit = parseInt(r.dailyQuoteLimit, 10) || 0;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.normalIntervalSec) {
    const s = parseInt(changes.normalIntervalSec.newValue, 10);
    if (s > 0) normalMs = s * 1000;
  }
  if (changes.quoteRates && Array.isArray(changes.quoteRates.newValue)) {
    rates = changes.quoteRates.newValue;
  }
  if (changes.dailyQuoteLimit) {
    dailyLimit = parseInt(changes.dailyQuoteLimit.newValue, 10) || 0;
  }
});

// Count of quotes SUBMITTED today (local calendar day). Recomputed from the log
// so it survives page/worker restarts. 'unpriced' (skipped) and 'failed' do NOT
// count against the cap.
function localYMD(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function quotesToday() {
  const { acceptedLog = [] } = await chrome.storage.local.get('acceptedLog');
  const today = localYMD(new Date().toISOString());
  return acceptedLog.filter(e =>
    e.outcome === 'quoted' && e.timestamp && localYMD(e.timestamp) === today
  ).length;
}
// Hit the cap → tell background to close the monitored tab + stop (kills polling).
function stopForLimit(n) {
  monitorStopped = true;
  console.log(`[ClearCap] daily quote limit ${dailyLimit} reached (${n}) — stopping + closing tab`);
  chrome.runtime.sendMessage({ type: 'STOP' });
}

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

function playAlarm() {
  // Alarms disabled for ClearCap — it auto-quotes silently. Detection still logs
  // (new orders + logged-out), just no audio. Call sites left in place so it's a
  // one-line flip to re-enable: sendMessage({ type: 'PLAY_AUDIO_ALERT' }).
}

// Stable identity for an offer. SOLICITATION_ID is the offer instance (what a
// quote targets); fall back through the other IDs if it's ever missing.
function offerId(o) {
  return String(o.SOLICITATION_ID || o.ORDER_ID || o.TRANSACTION_ID || o.MPID || '');
}

// An offer is "actionable" (a genuinely new order) only if we haven't already
// quoted it. Once we submit a quote the order STAYS in the feed but with
// HAS_QUOTE:1 — reading the feed's own flag (not just an in-memory Set) means a
// service-worker/page restart can't make us re-alarm OR re-quote it.
function isActionable(o) {
  return Number(o.HAS_QUOTE) !== 1;
}

// Compact, log/UI-friendly view of an offer. Available-feed field names.
function orderSummary(o) {
  const address = [o.DISPLAY_ADDRESS_LINE_1, o.DISPLAY_ADDRESS_LINE_4]
    .filter(Boolean).join(', ');
  const zip = o.ADDRESS_ZIP != null ? String(o.ADDRESS_ZIP) : '';
  const due = o.DUEDATE_VENDOR_LOCAL_DTS
    || `${o.DUEDATE_VENDOR_LOCAL_DATE || ''} ${o.DUEDATE_VENDOR_LOCAL_TIME || ''}`.trim();
  return {
    id: offerId(o),
    solicitationId: o.SOLICITATION_ID,
    orderId: o.ORDER_ID,
    transactionId: o.TRANSACTION_ID,
    mpid: o.MPID,
    address,
    city: o.ADDRESS_CITY || '',
    zip,
    state: o.ADDRESS_STATE || '',
    form: o.BROKER_FORM_NAME_S || '',
    payment: o.PAYMENT,
    due
  };
}

// --- Rate table -------------------------------------------------------------
// Each rule = {city, zip, ext, int} — one zip per row (user adds a row per zip).
// Match by the order's ZIP; if more than one row shares that zip (e.g. the Edisto
// trio all on 29438), the one whose city also matches wins, else the first. Then
// pick Exterior/Interior by the order's scope. Returns the numeric amount or null
// (null => SKIP: no matching row, OR that type's rate is blank/0/N-A — e.g. an
// Interior order in a city that only has an Exterior rate).
function normCity(s) { return String(s || '').trim().toLowerCase(); }
function normZip(s)  { return String(s ?? '').trim(); }

// Exterior vs Interior from the order's FORM name. An order is Exterior if the
// form name contains any of these keywords; otherwise it's treated as Interior.
// (Per the client's own classifier.) Matched case-insensitively against
// BROKER_FORM_NAME_S, e.g. "Exterior PCI - Property Condition Inspection",
// "Drive-by BPO", "Post Disaster Inspection".
const EXTERIOR_FORM_KEYS = ['property condition', 'drive-by', 'post disaster', 'ext'];
function isExterior(o) {
  const form = String(o.BROKER_FORM_NAME_S || '').toLowerCase();
  if (form.includes('interior')) return false; // explicit interior wins
  return EXTERIOR_FORM_KEYS.some(k => form.includes(k));
}

function lookupRate(o) {
  const city = normCity(o.ADDRESS_CITY);
  const zip  = normZip(o.ADDRESS_ZIP);
  if (!zip) return null;
  const zipHits = rates.filter(r => normZip(r.zip) === zip);
  if (!zipHits.length) return null;
  const hit = zipHits.find(r => normCity(r.city) === city) || zipHits[0];
  const raw = isExterior(o) ? hit.ext : hit.int;
  const amt = Number(raw);
  return Number.isFinite(amt) && amt > 0 ? amt : null; // blank/0/N-A for this type => skip
}

// --- Date math --------------------------------------------------------------
// Current due date is MM/DD/YYYY (ET, vendor-local). Add whole days and keep the
// same clock time verbatim — 48h == +2 days, 24h == +1 day, no timezone math.
function pad2(n) { return String(n).padStart(2, '0'); }
function addDaysMDY(mdy, days) {
  const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  d.setDate(d.getDate() + days);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

// Read the Angular XSRF-TOKEN cookie so we can echo it as a header.
function xsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Fire one quote (addBid) for an offer at the given fee. Returns a log entry.
async function submitQuote(o, fee) {
  const dueDate  = addDaysMDY(o.DUEDATE_VENDOR_LOCAL_DATE, DUE_OFFSET_DAYS);
  const expDate  = addDaysMDY(o.DUEDATE_VENDOR_LOCAL_DATE, EXPIRE_OFFSET_DAYS);
  const time     = o.DUEDATE_VENDOR_LOCAL_TIME || '';
  const summary  = orderSummary(o);
  const base = {
    id: summary.id, address: summary.address, city: summary.city, zip: summary.zip,
    fee, form: summary.form, due: `${dueDate} ${time}`.trim(),
    timestamp: new Date().toISOString()
  };

  if (!dueDate || !expDate || !time) {
    return { ...base, outcome: 'failed', errorMessage: 'could not compute due/expiry from offer dates' };
  }

  const params = new URLSearchParams();
  params.set('productTypeId', o.PRODUCT_TYPE_ID);
  params.set('solicitationId', o.SOLICITATION_ID);
  params.set('transactionId', o.TRANSACTION_ID);
  params.set('officeId', o.OFFICE_ID);
  params.set('vendorFee', String(fee));
  params.set('vendorDueDate', dueDate);
  params.set('vendorDueTime', time);
  params.set('vendorBidReasonCd', QUOTE_REASON_CD);
  params.set('vendorBidReasonComments', '');
  params.set('expirationDate', expDate);
  params.set('expirationTime', time);
  params.set('method', 'addBid');

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
  const tok = xsrfToken();
  if (tok) headers['X-XSRF-TOKEN'] = tok;

  const res = await fetch(BID_URL, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: params.toString()
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON = unexpected */ }

  const errMsg = json ? (json.ERRORMESSAGE || '') : (text ? text.slice(0, 200) : `HTTP ${res.status}`);
  const bidId  = json ? json.VENDORBIDID : undefined;
  const ok     = !!json && errMsg === '' && !!bidId;
  const outcome = ok ? 'quoted' : 'failed';

  return { ...base, outcome, vendorBidId: bidId, errorMessage: ok ? '' : errMsg };
}

// Quote each fresh order: rate lookup -> submit (or skip if unpriced). Sequential
// (quotes aren't a race) to keep request volume low. Logs every outcome.
// Respects the daily quote cap: counts today's submitted quotes and stops (closes
// the tab) once the limit is reached — trimmed BEFORE firing so it never overshoots.
async function quoteOrders(fresh) {
  // Running count of quotes already submitted today (recomputed from the log).
  let submittedToday = dailyLimit > 0 ? await quotesToday() : 0;
  if (dailyLimit > 0 && submittedToday >= dailyLimit) {
    stopForLimit(submittedToday);
    return;
  }

  for (const o of fresh) {
    if (monitorStopped) return;
    const id = offerId(o);
    if (attemptedQuoteIds.has(id)) continue;
    attemptedQuoteIds.add(id);

    const fee = lookupRate(o);
    if (fee == null) {
      const s = orderSummary(o);
      console.log(`[ClearCap] unpriced (no rate for ${s.city} ${s.zip}) — skip quote`);
      chrome.runtime.sendMessage({
        type: 'LOG_QUOTE',
        entry: { id: s.id, address: s.address, city: s.city, zip: s.zip, fee: null,
                 form: s.form, outcome: 'unpriced', timestamp: new Date().toISOString() }
      });
      continue;
    }

    try {
      const entry = await submitQuote(o, fee);
      console.log(`[ClearCap] quote ${entry.outcome} ${id} @ $${fee}`, entry.errorMessage || '');
      chrome.runtime.sendMessage({ type: 'LOG_QUOTE', entry });
      // A submitted quote counts against the daily cap.
      if (dailyLimit > 0 && entry.outcome === 'quoted') {
        submittedToday++;
        if (submittedToday >= dailyLimit) { stopForLimit(submittedToday); return; }
      }
    } catch (e) {
      console.error(`[ClearCap] quote failed ${id}:`, e);
      const s = orderSummary(o);
      chrome.runtime.sendMessage({
        type: 'LOG_QUOTE',
        entry: { id: s.id, address: s.address, city: s.city, zip: s.zip, fee,
                 form: s.form, outcome: 'failed', errorMessage: e?.message || 'fetch error',
                 timestamp: new Date().toISOString() }
      });
    }
  }
}

function extensionAlive() {
  return !!chrome.runtime?.id;
}

async function checkOrders() {
  if (monitorStopped) return; // daily quote cap hit — tab is being closed
  if (!extensionAlive()) {
    console.warn('[ClearCap] extension reloaded — stopping. Refresh page to resume.');
    return;
  }
  try {
    const res = await fetch(AVAILABLE_URL, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    // Parse the body REGARDLESS of content-type. Clear Capital serves the offers
    // array with a non-JSON content-type (renders as a white/HTML page in DevTools),
    // so gating on `content-type: json` wrongly discarded a valid 200 array and
    // flagged us "logged out". Also use res.text() (honors the feed's ISO-8859-1
    // charset) instead of res.json() (which forces UTF-8).
    const text = res.ok ? await res.text() : '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON — see sessionLost below */ }

    // Accept a bare array OR a common object wrapper.
    const offersData = Array.isArray(parsed) ? parsed
                     : Array.isArray(parsed?.DATA)   ? parsed.DATA
                     : Array.isArray(parsed?.offers) ? parsed.offers
                     : null;

    // "Logged out" ONLY on a real auth signal — never merely "couldn't parse an array".
    const looksLikeLogin = !!text && /<html|<!doctype/i.test(text) && /log\s*in|sign\s*in|password/i.test(text);
    const sessionLost = res.status === 401 || res.status === 403
      || (res.redirected && /login|signin|default\.cfm/i.test(res.url))
      || looksLikeLogin;

    const offers = offersData || []; // valid-but-unparseable 200 => 0 orders, NOT logged out
    // Only count/alarm/quote on orders we haven't already quoted (HAS_QUOTE:1
    // stays in the feed). count = new, actionable orders.
    const actionable = offers.filter(isActionable);
    const count = actionable.length;
    const lastChecked = new Date().toISOString();
    console.log(`[ClearCap] available: ${sessionLost ? 'session?' : `${count} new / ${offers.length} total`}`);

    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', count, lastChecked, sessionLost });

    // Heartbeat every 30 min.
    if (Date.now() - lastHeartbeat >= 30 * 60 * 1000) {
      lastHeartbeat = Date.now();
      const { heartbeatLog = [] } = await chrome.storage.local.get('heartbeatLog');
      heartbeatLog.unshift({ timestamp: lastChecked, count, sessionLost });
      if (heartbeatLog.length > 20) heartbeatLog.length = 20; // ~10 hrs
      await chrome.storage.local.set({ heartbeatLog });
      console.log(`[ClearCap] heartbeat @ ${lastChecked}`);
    }

    if (sessionLost) {
      if (Date.now() - lastSessionAlarm > 60000) {
        lastSessionAlarm = Date.now();
        console.warn('[ClearCap] non-array response — logged out? Re-login in the tab.');
        playAlarm();
      }
    } else if (count > 0) {
      const fresh = actionable.filter(o => !processedIds.has(offerId(o)));
      if (fresh.length) {
        fresh.forEach(o => processedIds.add(offerId(o)));
        // New offer(s) → burst to FAST to catch the rest of the bulk.
        fastUntil = Date.now() + FAST_LINGER_MS;
        playAlarm();

        const summaries = fresh.map(orderSummary);
        chrome.runtime.sendMessage({ type: 'LOG_DETECTION', count, orders: summaries });

        // Auto-quote: rate lookup per order, submit priced ones, skip unpriced.
        // Safe when the rate table is empty (everything is unpriced => alarm only).
        await quoteOrders(fresh);
      }
    }

    // Cap the session Sets so a long session doesn't grow them unbounded.
    if (processedIds.size > 500) {
      const trimmed = [...processedIds].slice(-300);
      processedIds.clear();
      trimmed.forEach(id => processedIds.add(id));
    }
    if (attemptedQuoteIds.size > 500) {
      const trimmed = [...attemptedQuoteIds].slice(-300);
      attemptedQuoteIds.clear();
      trimmed.forEach(id => attemptedQuoteIds.add(id));
    }
  } catch (e) {
    if (e?.message?.includes('Extension context invalidated')) {
      console.warn('[ClearCap] extension reloaded — stopping. Refresh page to resume.');
      return;
    }
    if (e?.message === 'Failed to fetch') {
      console.warn('[ClearCap] fetch failed (transient), retrying next tick');
    } else {
      console.error('[ClearCap] error:', e);
    }
  }

  setTimeout(checkOrders, pollInterval());
}

setTimeout(checkOrders, 1500);
