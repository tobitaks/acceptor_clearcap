function flash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1200);
}

// Normal-mode poll interval in seconds (default 20, min 5). Fast mode is fixed ~0.5s.
const normalInput = document.getElementById('normal-interval');
chrome.storage.local.get('normalIntervalSec', ({ normalIntervalSec = 20 }) => {
  normalInput.value = normalIntervalSec;
});
normalInput.addEventListener('input', (e) => {
  const v = Math.max(5, parseInt(e.target.value, 10) || 20);
  chrome.storage.local.set({ normalIntervalSec: v }, () => flash('saved-normal'));
});

// Daily quote limit (0 / blank = unlimited). Counts quotes submitted today;
// enforcement + tab-close lives in content.js.
const limitInput = document.getElementById('daily-limit');
chrome.storage.local.get('dailyQuoteLimit', ({ dailyQuoteLimit = 0 }) => {
  limitInput.value = dailyQuoteLimit || '';
});
limitInput.addEventListener('input', (e) => {
  const v = Math.max(0, parseInt(e.target.value, 10) || 0);
  chrome.storage.local.set({ dailyQuoteLimit: v }, () => flash('saved-limit'));
});

// --- Quote rate table -------------------------------------------------------
// Row-based editor: each row = City, Zip, Exterior rate, Interior rate. Stored
// under `quoteRates` as [{city, zip, ext, int}]. content.js matches an order's
// ADDRESS_CITY + ADDRESS_ZIP, then picks ext/int by the order's scope. No match
// (or a blank rate for that type) => skip (alarm only).
const rateBody   = document.getElementById('rate-body');
const rateStatus = document.getElementById('rate-status');
const addBtn     = document.getElementById('add-rate');

const cellStyle = 'width:100%; padding:7px 9px; border:1px solid #ccc; border-radius:6px; font-size:13px;';

function makeRow(rule = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td style="padding:4px 8px 4px 0;"><input class="r-city" type="text"  placeholder="Mount Pleasant" style="${cellStyle}"></td>
    <td style="padding:4px 8px;"><input class="r-zip"  type="text"  inputmode="numeric" placeholder="29464" style="${cellStyle}"></td>
    <td style="padding:4px 8px;"><input class="r-ext"  type="number" min="0" step="1" placeholder="—" style="${cellStyle}"></td>
    <td style="padding:4px 8px;"><input class="r-int"  type="number" min="0" step="1" placeholder="—" style="${cellStyle}"></td>
    <td style="padding:4px 0 4px 8px; text-align:center;">
      <button type="button" class="r-del" title="Remove row"
        style="border:none; background:none; color:#C62828; font-size:18px; line-height:1; cursor:pointer;">×</button>
    </td>`;
  tr.querySelector('.r-city').value = rule.city ?? '';
  tr.querySelector('.r-zip').value  = rule.zip  ?? '';
  tr.querySelector('.r-ext').value  = (rule.ext === 0 || rule.ext) ? rule.ext : '';
  tr.querySelector('.r-int').value  = (rule.int === 0 || rule.int) ? rule.int : '';
  return tr;
}

// Collect all rows -> array of rules. Keep only rows that have a city AND zip
// AND at least one rate; store ext/int as numbers ('' when blank).
function collectRules() {
  const rules = [];
  let valid = 0, partial = 0;
  rateBody.querySelectorAll('tr').forEach((tr) => {
    const city = tr.querySelector('.r-city').value.trim();
    const zip  = tr.querySelector('.r-zip').value.trim();
    const extRaw = tr.querySelector('.r-ext').value.trim();
    const intRaw = tr.querySelector('.r-int').value.trim();
    const ext = extRaw === '' ? '' : Number(extRaw);
    const int = intRaw === '' ? '' : Number(intRaw);
    if (!city && !zip && extRaw === '' && intRaw === '') return; // empty row — ignore
    const hasRate = (typeof ext === 'number' && ext > 0) || (typeof int === 'number' && int > 0);
    if (city && /^\d{3,5}$/.test(zip) && hasRate) { rules.push({ city, zip, ext, int }); valid++; }
    else partial++;
  });
  return { rules, valid, partial };
}

function renderStatus(valid, partial) {
  let html = `<strong>${valid}</strong> row${valid === 1 ? '' : 's'} active`;
  if (!valid) html += ' — quoting disabled (alarm only)';
  if (partial) html += ` <span style="color:#E65100;">(${partial} incomplete row${partial === 1 ? '' : 's'} not saved — need city, valid zip, and a rate)</span>`;
  rateStatus.innerHTML = html;
  rateStatus.style.color = valid ? '#2E7D32' : '#888';
}

function save() {
  const { rules, valid, partial } = collectRules();
  renderStatus(valid, partial);
  chrome.storage.local.set({ quoteRates: rules }, () => flash('saved-rates'));
}

// Event delegation: any input change saves; × removes the row then saves.
rateBody.addEventListener('input', save);
rateBody.addEventListener('click', (e) => {
  if (e.target.classList.contains('r-del')) {
    e.target.closest('tr').remove();
    if (!rateBody.querySelector('tr')) rateBody.appendChild(makeRow()); // keep one blank row
    save();
  }
});
addBtn.addEventListener('click', () => {
  rateBody.appendChild(makeRow());
  rateBody.querySelector('tr:last-child .r-city').focus();
});

// Clear all rows (with confirm) → leaves one blank row, saves empty table.
const clearBtn = document.getElementById('clear-rates');
clearBtn.addEventListener('click', () => {
  const { valid } = collectRules();
  if (valid && !confirm(`Clear all ${valid} rate row${valid === 1 ? '' : 's'}? This can't be undone.`)) return;
  rateBody.innerHTML = '';
  rateBody.appendChild(makeRow());
  save();
});

// Load stored rules into rows (at least one blank row to start).
chrome.storage.local.get('quoteRates', ({ quoteRates = [] }) => {
  if (Array.isArray(quoteRates) && quoteRates.length) {
    quoteRates.forEach(r => rateBody.appendChild(makeRow(r)));
  } else {
    rateBody.appendChild(makeRow());
  }
  const { valid, partial } = collectRules();
  renderStatus(valid, partial);
});
