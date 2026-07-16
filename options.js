const logContainer       = document.getElementById('log-container');
const detectContainer    = document.getElementById('detections-container');
const clearBtn           = document.getElementById('clear-btn');
const clearDetectionsBtn = document.getElementById('clear-detections-btn');
const statTotal    = document.getElementById('stat-total');
const statSuccess  = document.getElementById('stat-success');
const statFail     = document.getElementById('stat-fail');
const statSkipped  = document.getElementById('stat-skipped');

const PAGE_SIZE = 15;
let acceptedData = [];
let detectData   = [];
let acceptedPage = 1;
let detectPage   = 1;

// Prev/Next pager markup. Returns '' when only one page (nothing to page).
function pager(page, total, action) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return '';
  return `
    <div class="pager">
      <button class="pg-btn" data-action="${action}" data-dir="prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span class="pg-info">Page ${page} of ${pages}</span>
      <button class="pg-btn" data-action="${action}" data-dir="next" ${page >= pages ? 'disabled' : ''}>Next →</button>
    </div>`;
}

// Clamp a page into [1, pages] (data can shrink on Clear / cap).
function clampPage(page, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return Math.min(Math.max(page, 1), pages);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDiag(d) {
  if (!d) return '<span style="color:#bbb">—</span>';
  const line = (k, v) => `<span class="k">${k}:</span> ${escapeHtml(v)}`;
  const text = [
    ...(d.note ? [line('NOTE', d.note), ''] : []),
    line('GET status', d.getStatus),
    line('GET url', d.getUrl),
    line('GET redirected', d.getRedirected),
    line('GET title', d.getTitle),
    line('viewstate found', d.hadViewState),
    line('fields', (d.getFields || []).join(', ')),
    '',
    line('POST status', d.postStatus),
    line('POST url', d.postUrl),
    line('POST redirected', d.postRedirected),
    line('POST title', d.postTitle),
    '',
    `<span class="k">GET snippet:</span>\n${escapeHtml(d.getSnippet)}`,
    '',
    `<span class="k">POST snippet:</span>\n${escapeHtml(d.postSnippet)}`
  ].join('\n');
  return `<details class="diag"><summary>view</summary><pre class="diag-pre">${text}</pre></details>`;
}

function render(entries) {
  acceptedData = entries || [];
  const log = acceptedData;

  // 'unpriced' entries were skipped (no rate) — not quote attempts, exclude from total.
  const attempts = log.filter(e => e.outcome !== 'unpriced');
  statTotal.textContent   = attempts.length;
  statSuccess.textContent = log.filter(e => e.outcome === 'quoted').length;
  statFail.textContent    = log.filter(e => e.outcome === 'failed').length;
  if (statSkipped) statSkipped.textContent = log.filter(e => e.outcome === 'unpriced').length;

  if (!log.length) {
    logContainer.innerHTML = '<div class="log-empty">No quotes yet.</div>';
    return;
  }

  acceptedPage = clampPage(acceptedPage, log.length);
  const start = (acceptedPage - 1) * PAGE_SIZE;
  const pageRows = log.slice(start, start + PAGE_SIZE);

  const rows = pageRows.map(e => {
    const time = new Date(e.timestamp).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const outcome = e.outcome || 'failed';
    const statusMap = {
      quoted:   '<span class="status-badge success">Quoted (pending)</span>',
      failed:   '<span class="status-badge fail">Failed</span>',
      unpriced: '<span class="status-badge skipped">Unpriced (skip)</span>'
    };
    const status = statusMap[outcome] || statusMap.failed;
    const id = e.id || e.apprId || '—';
    const address = e.address || '—';
    const fee = (e.fee != null && e.fee !== '') ? `$${e.fee}` : '—';
    const note = e.errorMessage ? `<div style="color:#C62828;font-size:11px">${escapeHtml(e.errorMessage)}</div>` : '';
    return `
      <tr>
        <td><span class="appr-id">${escapeHtml(id)}</span></td>
        <td>${escapeHtml(address)}</td>
        <td>${fee}</td>
        <td>${status}${note}</td>
        <td class="time-cell">${time}</td>
      </tr>
    `;
  }).join('');

  logContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Order ID</th>
          <th>Address</th>
          <th>Quote</th>
          <th>Status</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  ` + pager(acceptedPage, log.length, 'accepted');
}

function renderDetections(entries) {
  detectData = entries || [];
  const log = detectData;
  if (!log.length) {
    detectContainer.innerHTML = '<div class="log-empty">No detections yet.</div>';
    return;
  }
  detectPage = clampPage(detectPage, log.length);
  const start = (detectPage - 1) * PAGE_SIZE;
  const pageRows = log.slice(start, start + PAGE_SIZE);
  const rows = pageRows.map(e => {
    const time = new Date(e.timestamp).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const orders = e.orders || [];
    const ids = orders.map(o => o.id).filter(Boolean).join(', ') || '—';
    const addrs = orders.map(o => escapeHtml(o.address)).filter(Boolean).join(' · ') || '—';
    return `
      <tr>
        <td><strong>${e.count}</strong></td>
        <td class="url-cell">${ids}</td>
        <td class="url-cell">${addrs}</td>
        <td class="time-cell">${time}</td>
      </tr>
    `;
  }).join('');
  detectContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Count</th>
          <th>Order IDs</th>
          <th>Address</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  ` + pager(detectPage, log.length, 'detect');
}

// Local YYYY-MM-DD (sort key) + human label from a timestamp
function localYMD(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayLabel(ts) {
  return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

// Per-day roll-up: Detected (from detectionLog.orders), and quote outcomes
// (from acceptedLog). Grouped by local calendar day, newest first.
function renderDailySummary() {
  const c = document.getElementById('daily-summary-container');
  const days = {}; // ymd -> { label, detected, quoted, failed, unpriced }
  const get = (ts) => {
    const k = localYMD(ts);
    if (!days[k]) days[k] = { label: dayLabel(ts), detected: 0, quoted: 0, failed: 0, unpriced: 0 };
    return days[k];
  };

  for (const e of detectData) {
    if (!e.timestamp) continue;
    get(e.timestamp).detected += (e.orders || []).length;
  }
  for (const e of acceptedData) {
    if (!e.timestamp) continue;
    const d = get(e.timestamp);
    const outcome = e.outcome || 'failed';
    if (outcome === 'quoted')        d.quoted++;
    else if (outcome === 'unpriced') d.unpriced++;
    else                             d.failed++;
  }

  const keys = Object.keys(days).sort().reverse();
  if (!keys.length) {
    c.innerHTML = '<div class="log-empty">No data yet.</div>';
    return;
  }
  const rows = keys.map(k => {
    const d = days[k];
    return `
      <tr>
        <td><strong>${d.label}</strong></td>
        <td>${d.detected}</td>
        <td style="color:#2E7D32;font-weight:600">${d.quoted}</td>
        <td style="color:#C62828">${d.failed}</td>
        <td style="color:#546E7A">${d.unpriced}</td>
      </tr>`;
  }).join('');
  c.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Detected</th>
          <th>Quoted</th>
          <th>Failed</th>
          <th>Unpriced</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Warn when recent detections found orders but NONE passed the filters —
// the silent "wrong filter" failure (e.g. filtering MD zips on GA orders).
function renderFilterWarning() {
  // Accept-side filters aren't wired yet (alarm phase). Nothing to warn about.
  const el = document.getElementById('filter-warning');
  if (el) el.style.display = 'none';
}

function renderHeartbeat(entries) {
  const log = entries || [];
  const c = document.getElementById('last-heartbeat');
  if (!log.length) {
    c.innerHTML = 'No heartbeats yet.';
    return;
  }
  const e = log[0];
  const time = new Date(e.timestamp).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const state = e.sessionLost
    ? '<span class="status-badge fail">Logged out</span>'
    : '<span class="status-badge success">Alive</span>';
  c.innerHTML = `Last heartbeat: ${time} &nbsp; ${state}`;
}

chrome.storage.local.get(['acceptedLog', 'detectionLog', 'heartbeatLog'], ({ acceptedLog, detectionLog, heartbeatLog }) => {
  render(acceptedLog);
  renderDetections(detectionLog);
  renderHeartbeat(heartbeatLog);
  renderDailySummary();
  renderFilterWarning();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.acceptedLog)  render(changes.acceptedLog.newValue);
  if (changes.detectionLog) renderDetections(changes.detectionLog.newValue);
  if (changes.heartbeatLog) renderHeartbeat(changes.heartbeatLog.newValue);
  if (changes.acceptedLog || changes.detectionLog) renderDailySummary();
  if (changes.detectionLog) renderFilterWarning();
});

clearBtn.addEventListener('click', () => {
  if (confirm('Clear all accepted order logs?')) {
    chrome.storage.local.set({ acceptedLog: [] });
  }
});

clearDetectionsBtn.addEventListener('click', () => {
  if (confirm('Clear all detection logs?')) {
    chrome.storage.local.set({ detectionLog: [] });
  }
});

// Pager clicks (event-delegated — buttons are re-created each render)
logContainer.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.pg-btn');
  if (!btn || btn.dataset.action !== 'accepted') return;
  acceptedPage += btn.dataset.dir === 'next' ? 1 : -1;
  render(acceptedData);
});
detectContainer.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.pg-btn');
  if (!btn || btn.dataset.action !== 'detect') return;
  detectPage += btn.dataset.dir === 'next' ? 1 : -1;
  renderDetections(detectData);
});

// Download Accepted Orders log as CSV (full log, not just current page)
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
document.getElementById('download-btn').addEventListener('click', () => {
  const log = acceptedData || [];
  if (!log.length) { alert('No quotes to download.'); return; }
  const header = ['Order ID', 'Address', 'City', 'Zip', 'Quote', 'Outcome', 'VendorBidID', 'Timestamp'];
  const lines = [header.join(',')];
  for (const e of log) {
    const outcome = e.outcome || 'failed';
    lines.push([e.id || e.apprId || '', e.address || '', e.city || '', e.zip || '',
                e.fee != null ? e.fee : '', outcome, e.vendorBidId || '', e.timestamp || ''].map(csvCell).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clearcap-quotes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
