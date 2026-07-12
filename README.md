# ClearCap New Order Alarm

Chrome extension (Manifest V3) that monitors the **Clear Capital** broker portal for new available orders and sounds an audio alarm the moment one appears.

> **Alarm-only build.** Auto-accept is not wired yet — the Clear Capital accept request hasn't been captured. Detection + alarm are live; accept is a single stubbed function ready to fill in.

## How it works

Clear Capital's broker UI (`secure.clearcapital.com/secure/broker/#/available`) is an Angular SPA fed by a JSON endpoint. Instead of scraping the DOM, the content script polls that endpoint directly — the logged-in session cookie rides along on a same-origin `fetch`.

```
┌─────────┐   START    ┌────────────┐   opens    ┌──────────────────┐
│  Popup   │ ─────────▶ │ Background │ ─────────▶ │ broker tab       │
└─────────┘            │  (worker)  │            │  content.js      │
                       └────────────┘            └────────┬─────────┘
                              ▲                           │ GET getAvailableOffers
                              │                           ▼   (adaptive interval)
                              │                 ┌───────────────────────┐
                              │   detection      │ array non-empty?     │
                              └───────────────── │ new SOLICITATION_ID? │
                                                 └───────────────────────┘
                                        🔊 alarm (offscreen audio) + 📝 log
```

1. **Detect** — poll `vendorReports.cfc?method=getAvailableOffers`. A non-empty JSON array means new order(s).
2. **Alarm** — on a genuinely new offer (unseen `SOLICITATION_ID`), an offscreen document plays a triple beep. Heard even with Chrome in the background.
3. **Log** — each detection is stored locally and shown in the options page.
4. **Accept** — *not yet implemented.* See below.

## Adaptive polling (anti-detection)

Volume-based bans (ValueLink-style) count requests/day, so polling is slow by default and bursts only when a bulk is landing:

- **Normal mode** — configurable in Settings (default 20s, min 5s), jittered.
- **Fast mode** — ~0.5s for 3 min after a new offer, to catch the rest of a bulk, then falls back to Normal.

## Install

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Log into Clear Capital in the same Chrome profile

## Usage

1. Click the extension icon → **START** — opens the broker Available tab and begins monitoring.
2. Leave the tab open + stay logged in. Popup shows live count + last-checked time.
3. New order → beep-beep-beep.
4. **STOP** closes the monitored tab and halts monitoring.

If the session expires, the alarm sounds and the popup shows a red warning instead of silently monitoring nothing.

## Enabling auto-accept later

1. Capture the accept request from a **live** Available order (DevTools Network: URL, method, payload) or the broker JS bundle.
2. Implement `acceptOrder(order)` in `background.js` (marked with a `NOT YET IMPLEMENTED` block).
3. In `content.js`, apply the accept-side filters and send `AUTO_ACCEPT_IDS` (marked with a `DISABLED` block).
4. Restore the accept-side Settings (order type / keyword / exclude / daily accept limit) — the machinery (`runBatchedAccepts`, daily-limit enforcement) is already present and dormant.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, host permissions |
| `content.js` | Polls `getAvailableOffers`, detects new offers, alarm + detection log |
| `background.js` | Service worker — audio routing, tab lifecycle, logging, dormant accept machinery |
| `offscreen.html/js` | Audio playback (offscreen doc, AudioContext beeps) |
| `popup.html/js` | Start/Stop UI, live status |
| `options.html/js` | Detection log, stats |
| `settings.html/js` | Poll-interval setting |

## Disclaimer

For use on accounts you own. Automating may violate the portal's terms of service — use at your own risk.
