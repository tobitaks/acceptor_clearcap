// ClearCap background service worker (ALARM phase).
//
// Detection + alarm live in content.js (it polls the getAvailableOffers JSON and
// plays the alarm). This worker owns: audio routing (offscreen), START/STOP, the
// monitored-tab lifecycle, detection logging, and the daily-accept-limit +
// batched-accept machinery — which is DORMANT until acceptOrder() below is filled.
const DASHBOARD_URL = 'https://secure.clearcapital.com/secure/broker/#/available';

const attemptedIds = new Set();

// ============================================================================
// ACCEPT — NOT YET IMPLEMENTED.
// We don't have the accept request yet (URL + method + payload). Capture it from
// a live "Available" order (Network tab: URL, Method, Payload) or the broker JS
// bundle, then implement acceptOrder() to POST/GET it and return the outcome.
// content.js does NOT send AUTO_ACCEPT_IDS yet, so this never runs until wired.
// ============================================================================
async function acceptOrder(order) {
  throw new Error('[ClearCap bg] accept not implemented — capture the accept request first');
}

async function logAccepted(entry) {
  const { acceptedLog = [] } = await chrome.storage.local.get('acceptedLog');
  acceptedLog.unshift(entry);
  if (acceptedLog.length > 500) acceptedLog.length = 500;
  await chrome.storage.local.set({ acceptedLog });
}

async function logDetection(entry) {
  const { detectionLog = [] } = await chrome.storage.local.get('detectionLog');
  detectionLog.unshift(entry);
  if (detectionLog.length > 100) detectionLog.length = 100;
  await chrome.storage.local.set({ detectionLog });
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play alarm sound when new orders are detected'
    });
  }
}

async function playAlarm() {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'PLAY_ALARM' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START') {
    chrome.tabs.create({ url: DASHBOARD_URL, active: true }, (tab) => {
      // Prevent Chrome memory-saver from discarding the monitored tab
      // (discard kills the content script => monitoring dies silently)
      chrome.tabs.update(tab.id, { autoDiscardable: false }, () => void chrome.runtime.lastError);
      chrome.storage.local.set({
        monitorState: { monitoring: true, tabId: tab.id, count: 0, lastChecked: null }
      });
    });
  }

  if (msg.type === 'STOP') {
    chrome.storage.local.get('monitorState', ({ monitorState }) => {
      if (monitorState?.tabId) {
        chrome.tabs.remove(monitorState.tabId, () => void chrome.runtime.lastError);
      }
      chrome.storage.local.set({
        monitorState: { monitoring: false, tabId: null, count: 0, lastChecked: null }
      });
    });
  }

  if (msg.type === 'STATUS_UPDATE') {
    chrome.storage.local.get('monitorState', ({ monitorState }) => {
      chrome.storage.local.set({
        monitorState: {
          ...monitorState,
          count: msg.count,
          lastChecked: msg.lastChecked,
          sessionLost: !!msg.sessionLost
        }
      });
    });
  }

  if (msg.type === 'PLAY_AUDIO_ALERT') {
    console.log('[ClearCap bg] play audio alarm');
    playAlarm();
  }

  if (msg.type === 'LOG_DETECTION') {
    logDetection({
      count: msg.count,
      orders: msg.orders || [],
      filtered: msg.filtered || [],
      timestamp: new Date().toISOString()
    });
  }

  if (msg.type === 'AUTO_ACCEPT_IDS') {
    // Dormant until acceptOrder() is implemented + content.js sends this.
    const list = Array.isArray(msg.orders) ? msg.orders : [];
    runBatchedAccepts(list, 10);
  }
});

// Count of SUCCESSFUL accepts logged today (local calendar day). Source of truth
// is acceptedLog — recomputed each call so it survives service-worker restarts.
function localYMD(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function acceptsToday() {
  const { acceptedLog = [] } = await chrome.storage.local.get('acceptedLog');
  const today = localYMD(new Date().toISOString());
  return acceptedLog.filter(e => e.outcome === 'accepted' && e.timestamp && localYMD(e.timestamp) === today).length;
}

// Stop monitoring: close the monitored tab (kills the poll loop → session goes
// idle) and clear monitorState. Mirrors the STOP handler; onRemoved also resets.
function stopMonitoring(reason) {
  chrome.storage.local.get('monitorState', ({ monitorState }) => {
    if (monitorState?.tabId) {
      chrome.tabs.remove(monitorState.tabId, () => void chrome.runtime.lastError);
    }
    chrome.storage.local.set({
      monitorState: { monitoring: false, tabId: null, count: 0, lastChecked: null }
    });
    console.log(`[ClearCap bg] monitoring stopped — ${reason}`);
  });
}

async function runBatchedAccepts(list, batchSize) {
  // Daily accept cap (0/blank = unlimited). Trim the attempt list to the
  // remaining budget BEFORE firing — successes ≤ attempts, so this can never
  // overshoot the cap.
  const { dailyAcceptLimit = 0 } = await chrome.storage.local.get('dailyAcceptLimit');
  const limit = parseInt(dailyAcceptLimit, 10) || 0;

  let work = list;
  if (limit > 0) {
    const already = await acceptsToday();
    const remaining = limit - already;
    if (remaining <= 0) {
      console.log(`[ClearCap bg] daily accept limit ${limit} already reached (${already}) — skipping ${list.length} & stopping`);
      stopMonitoring(`daily accept limit ${limit} reached`);
      return;
    }
    if (list.length > remaining) {
      console.log(`[ClearCap bg] trimming ${list.length} → ${remaining} to stay under daily limit ${limit}`);
      work = list.slice(0, remaining);
    }
  }

  console.log(`[ClearCap bg] accepting ${work.length} order(s) in batches of ${batchSize}`);
  for (let i = 0; i < work.length; i += batchSize) {
    const batch = work.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    console.log(`[ClearCap bg] batch ${batchNum} firing ${batch.length} parallel`);
    await Promise.allSettled(
      batch.map(o =>
        acceptOrder(o).catch(e => {
          console.error(`[ClearCap bg] accept ${o.id} failed:`, e);
          throw e;
        })
      )
    );
  }
  console.log('[ClearCap bg] all batches complete');

  // Hit the cap on successful accepts? Stop now.
  if (limit > 0) {
    const done = await acceptsToday();
    if (done >= limit) {
      console.log(`[ClearCap bg] daily accept limit reached (${done}/${limit}) — stopping`);
      stopMonitoring(`daily accept limit ${limit} reached`);
    }
  }
}

// If user manually closes the monitored tab, reset state
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get('monitorState', ({ monitorState }) => {
    if (monitorState?.tabId === tabId) {
      chrome.storage.local.set({
        monitorState: { monitoring: false, tabId: null, count: 0, lastChecked: null }
      });
    }
  });
});
