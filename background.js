// ClearCap background service worker.
//
// Detection + auto-quote both run in content.js (the quote POST needs the page's
// XSRF cookie, which a service worker can't read). This worker owns: audio
// routing (offscreen), START/STOP, the monitored-tab lifecycle, and logging.
const DASHBOARD_URL = 'https://secure.clearcapital.com/secure/broker/#/available';

// Default rate table (from initial-table-rate.csv) — seeded on first install.
importScripts('default-rates.js'); // defines DEFAULT_RATES

// Seed the rate table on fresh install only, and only if it's still empty (never
// clobber the user's own edits on an extension update/reload).
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.storage.local.get('quoteRates', ({ quoteRates }) => {
    if (!Array.isArray(quoteRates) || quoteRates.length === 0) {
      chrome.storage.local.set({ quoteRates: DEFAULT_RATES });
      console.log(`[ClearCap bg] seeded ${DEFAULT_RATES.length} default rate rows`);
    }
  });
});

async function logQuote(entry) {
  if (!entry) return;
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
    chrome.storage.local.remove('loginAttempts'); // fresh retry window per run
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

  if (msg.type === 'RELOGIN_NAV') {
    // Only navigate the monitored tab, and only if the request came FROM it —
    // a stray broker tab's request is ignored, preserving the login cap.
    chrome.storage.local.get('monitorState', ({ monitorState }) => {
      if (monitorState?.monitoring && sender.tab && sender.tab.id === monitorState.tabId) {
        chrome.tabs.update(
          monitorState.tabId,
          { url: 'https://secure.clearcapital.com/login.cfm' },
          () => void chrome.runtime.lastError
        );
      }
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
      timestamp: new Date().toISOString()
    });
  }

  if (msg.type === 'LOG_QUOTE') {
    logQuote(msg.entry);
  }
});

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
