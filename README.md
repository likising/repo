# Stock Price Monitor (Google Apps Script)

A simple web app that watches US and HK stock prices (via Yahoo Finance) and emails you
when a price moves beyond your thresholds within a monitoring window.

## Features

- **Per-symbol settings** — each stock has its own alert email, check interval (min 1 minute), monitoring window, and up/down thresholds (%).
- **US + HK markets** — US tickers (`AAPL`, `TSLA`), HK tickers (`0700.HK`, `9988.HK`), indices (`^HSI`, `^IXIC`).
- **Email alerts** — sent via `MailApp` from your Google account when the price crosses a threshold.
- **Re-baselining** — after each alert the baseline resets to the current price, so you don't get spammed by the same move.
- **Light-theme card UI** — one card per quote (currency + price, Δ in window, trade/check times) with three floating buttons: ↻ refresh & check now, … settings (test email + recent 50 activity log entries), + add a symbol. Card border color follows the quote currency (teal = HKD, blue = USD), so indices like `^HSI` show as HK cards.
- **HK symbol normalization** — numeric codes are padded to 4 digits with `.HK` appended in the backend (`5` → `0005.HK`).
- **Google Finance links** — clicking a symbol/name opens its Google Finance page (`0005:HKG`, `AAPL:NASDAQ`, `IBM:NYSE`, `^HSI` → `HSI:INDEXHANGSENG`, `^IXIC` → `.IXIC:INDEXNASDAQ`). The exchange comes from Yahoo's quote metadata, falling back to NASDAQ/HKG.
- **Drag reorder & error cards** — cards are reorderable via the ⠿ handle and the order is persisted (via `saveOrder`, stored the same way as quotes/settings in Script Properties); fetch failures turn the status dot red and show the error inline.

## How it works

1. A time-driven trigger fires `checkPrices()` every minute (the minimum Apps Script allows).
2. Each run respects your **check interval**: if not enough time has passed since the last check, it exits.
3. For each symbol it fetches the latest quote from the Yahoo Finance chart API
   (`query1/query2.finance.yahoo.com/v8/finance/chart/<symbol>`).
4. Each check computes a **per-check delta** — the current price vs the **window's extremes** (the
   lowest and highest recorded prices inside the rolling **monitoring window**; the current price
   is excluded from that scan). Rise % is computed from the window low, drop % from the window high;
   whichever is larger is the delta. If the rise ≥ up threshold or the drop ≥ down threshold, an email
   is sent — **at most `maxAlerts` consecutive times per direction (default 3)**. The streak
   resets whenever a check falls back inside the thresholds (or the direction flips), so a fresh
   move alerts again; beyond the cap, alerts are suppressed (logged, no email) until the move ends.
5. The **displayed delta** is the **largest |Δ| across all per-check deltas recorded inside the
   window** (ties → the newest), with its timestamp showing when that delta was produced. In-window
   checks leave it unchanged once a peak has formed; it ages out after the window rolls past it.

## Files

| File | Purpose |
|---|---|
| `Code.gs` | Server code: web app entry, config, triggers, quote fetch, alert logic, email |
| `Index.html` | Web UI |
| `appsscript.json` | Manifest with required OAuth scopes |

## Setup (manual, ~5 minutes)

1. Go to <https://script.google.com> → **New project**.
2. Create three files and paste the contents of this repo:
   - `Code.gs` (default file)
   - `Index.html` (**+ → HTML**)
   - `appsscript.json` (enable **Project Settings → Show "appsscript.json" manifest file in editor**, then edit it)
3. **Deploy → New deployment → type: Web app**
   - Execute as: **Me**
   - Who has access: **Only myself** (or anyone you like)
4. Open the web app URL, fill in the settings, and press **▶ Start monitoring**.

The first run will ask you to authorize the scopes (fetch external URLs, send email, manage triggers).

## Setup (with clasp)

```bash
npm install -g @google/clasp
clasp login
clasp create --type webapp --title "Stock Price Monitor"
clasp push        # from this directory
clasp deploy
```

Then open the deployment URL from `clasp deployments` / the Apps Script editor.

## Notes & limitations

- **1-minute granularity**: Apps Script time triggers can't fire more often than once per minute.
- **Quotes**: Yahoo Finance unofficial API. HK quotes are typically delayed ~15 min; US prices
  reflect the latest regular-market (or pre/post) quote Yahoo exposes.
- **Trigger clock drift**: minute triggers are not guaranteed to fire at exact seconds; the app
  uses elapsed-time checks, so intervals are approximate to ±1 minute.
- **Monitoring lifecycle**: monitoring starts automatically when you add your first symbol and
  the trigger is removed when the last symbol is deleted.
- **Email quota**: consumer Gmail accounts can send ~100 emails/day via Apps Script. The
  re-baselining after each alert keeps volume low.
- If Yahoo rate-limits one host, the code automatically falls back to the second host.
