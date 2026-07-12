// ClearCap — Available Offers monitor (ALARM phase).
//
// Detection is FAR simpler than eStreet: Clear Capital's broker UI is an Angular
// SPA, but the "Available" tab is fed by a plain JSON endpoint. We poll that
// endpoint directly (same-origin fetch, the logged-in session cookie rides along)
// and never touch the DOM. Non-empty array => new order(s) => alarm.
//
//   GET .../vendorReports.cfc?method=getAvailableOffers
//     -> [] when nothing available
//     -> [ {SOLICITATION_ID, ORDER_ID, TRANSACTION_ID, MPID, PAYMENT,
//           DISPLAY_ADDRESS_LINE_1, BROKER_FORM_NAME_S, ...}, ... ]
//
// AUTO-ACCEPT IS NOT WIRED YET. We don't yet have the accept request (URL +
// payload). Once captured, fill acceptOrder() in background.js and flip on the
// AUTO_ACCEPT_IDS send marked below. Until then this is a pure alarm.
const AVAILABLE_URL =
  'https://secure.clearcapital.com/secure/vendor/remote/ajax/vendorReports.cfc?method=getAvailableOffers';

let lastSessionAlarm = 0;   // throttle logged-out alarm
let lastHeartbeat = 0;      // 30-min alive stamp
const processedIds = new Set(); // offer IDs already alarmed/logged this session

// --- Adaptive polling (anti-detection) -------------------------------------
// Volume-based bans (ValueLink-style) count requests/day. Poll SLOW by default,
// burst FAST while a bulk is actively landing.
//   NORMAL: user-configurable (Settings), default 20s — human-plausible refresh
//   FAST:   ~0.5s — grabs the rest of a bulk while it's hot; drops back to
//                   NORMAL after 3 min with no new order.
const NORMAL_DEFAULT_SEC = 20;            // fallback if the setting is unset
const NORMAL_JITTER      = 5000;          // max ± jitter on the normal interval
const FAST_MS            = 500;           // base fast interval
const FAST_JITTER        = 100;           // → 400–600 ms
const FAST_LINGER_MS     = 3 * 60 * 1000; // stay fast 3 min after the last new order

let fastUntil = 0;                          // FAST while Date.now() < fastUntil
let normalMs  = NORMAL_DEFAULT_SEC * 1000;  // cached normal interval (from Settings)

// Load + live-update the normal interval from Settings (no reload needed).
chrome.storage.local.get('normalIntervalSec', ({ normalIntervalSec }) => {
  const s = parseInt(normalIntervalSec, 10);
  if (s > 0) normalMs = s * 1000;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.normalIntervalSec) {
    const s = parseInt(changes.normalIntervalSec.newValue, 10);
    if (s > 0) normalMs = s * 1000;
  }
});

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
  chrome.runtime.sendMessage({ type: 'PLAY_AUDIO_ALERT' });
}

// Stable identity for an offer. SOLICITATION_ID is the offer instance (what an
// accept targets); fall back through the other IDs if it's ever missing.
function offerId(o) {
  return String(o.SOLICITATION_ID || o.ORDER_ID || o.TRANSACTION_ID || o.MPID || '');
}

// Compact, log/UI-friendly view of an offer.
function orderSummary(o) {
  const address = [o.DISPLAY_ADDRESS_LINE_1, o.DISPLAY_ADDRESS_LINE_4]
    .filter(Boolean).join(', ');
  return {
    id: offerId(o),
    solicitationId: o.SOLICITATION_ID,
    orderId: o.ORDER_ID,
    transactionId: o.TRANSACTION_ID,
    mpid: o.MPID,
    address,
    form: o.BROKER_FORM_NAME_S || '',
    payment: o.PAYMENT,
    due: o.VENDOR_DUE_DTS_VENDOR_LOCAL_DTS || o.VENDOR_DUE_DTS || '',
    // full-text haystack for the (accept-side) keyword filters, kept for later
    rowText: `${address} ${o.BROKER_FORM_NAME_S || ''} ${o.STATE || ''}`
      .replace(/\s+/g, ' ').trim()
  };
}

function extensionAlive() {
  return !!chrome.runtime?.id;
}

async function checkOrders() {
  if (!extensionAlive()) {
    console.warn('[ClearCap] extension reloaded — stopping. Refresh page to resume.');
    return;
  }
  try {
    const res = await fetch(AVAILABLE_URL, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    // Distinguish "logged in, nothing available" ([]) from "session gone".
    // On logout the CF endpoint doesn't return a JSON array (redirect to login /
    // HTML / error object) — treat anything that isn't an array as session-lost.
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('json')) {
      try { data = await res.json(); } catch { data = null; }
    }
    const sessionLost = !Array.isArray(data);
    const offers = Array.isArray(data) ? data : [];
    const count = offers.length;
    const lastChecked = new Date().toISOString();
    console.log(`[ClearCap] available: ${sessionLost ? 'session?' : count}`);

    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', count, lastChecked, sessionLost });

    // Heartbeat: stamp "alive" every 30 min so after a hang/restart the last
    // entry shows roughly when polling stopped.
    if (Date.now() - lastHeartbeat >= 30 * 60 * 1000) {
      lastHeartbeat = Date.now();
      const { heartbeatLog = [] } = await chrome.storage.local.get('heartbeatLog');
      heartbeatLog.unshift({ timestamp: lastChecked, count, sessionLost });
      if (heartbeatLog.length > 20) heartbeatLog.length = 20; // ~10 hrs
      await chrome.storage.local.set({ heartbeatLog });
      console.log(`[ClearCap] heartbeat @ ${lastChecked}`);
    }

    if (sessionLost) {
      // Not a JSON array = almost certainly logged out. Alarm so unattended
      // monitoring doesn't die silently. Throttled to once per 60s.
      if (Date.now() - lastSessionAlarm > 60000) {
        lastSessionAlarm = Date.now();
        console.warn('[ClearCap] non-array response — logged out? Re-login in the tab.');
        playAlarm();
      }
    } else if (count > 0) {
      // Act only on offer IDs not seen before this session — a lingering offer
      // (still available on the next poll) stays in processedIds, so it isn't
      // re-alarmed every tick.
      const fresh = offers.filter(o => !processedIds.has(offerId(o)));
      if (fresh.length) {
        fresh.forEach(o => processedIds.add(offerId(o)));
        // New offer(s) → burst to FAST to catch the rest of the bulk. Timer
        // resets on every new offer, chaining a cluster together.
        fastUntil = Date.now() + FAST_LINGER_MS;
        playAlarm();

        const summaries = fresh.map(orderSummary);
        chrome.runtime.sendMessage({ type: 'LOG_DETECTION', count, orders: summaries });

        // ┌──────────────────────────────────────────────────────────────────┐
        // │ AUTO-ACCEPT — DISABLED. Once the accept request is captured and   │
        // │ acceptOrder() is filled in background.js, apply the accept-side   │
        // │ filters here and send:                                            │
        // │   chrome.runtime.sendMessage({ type: 'AUTO_ACCEPT_IDS',           │
        // │                                orders: toAccept });               │
        // └──────────────────────────────────────────────────────────────────┘
      }
    }

    // Cap processedIds so a long session doesn't grow it unbounded.
    if (processedIds.size > 500) {
      const trimmed = [...processedIds].slice(-300);
      processedIds.clear();
      trimmed.forEach(id => processedIds.add(id));
    }
  } catch (e) {
    if (e?.message?.includes('Extension context invalidated')) {
      console.warn('[ClearCap] extension reloaded — stopping. Refresh page to resume.');
      return;
    }
    if (e?.message === 'Failed to fetch') {
      // Transient: tab suspended, network blip, or session expired. Retry next tick.
      console.warn('[ClearCap] fetch failed (transient), retrying next tick');
    } else {
      console.error('[ClearCap] error:', e);
    }
  }

  setTimeout(checkOrders, pollInterval());
}

setTimeout(checkOrders, 1500);
