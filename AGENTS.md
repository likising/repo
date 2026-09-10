# Stock Price Monitor — Google Apps Script (US + HK stocks)

## Project

Web app built with Google Apps Script. Files: `Code.gs` (server), `Index.html` (UI), `appsscript.json` (manifest), `README.md`. Deploy: paste into script.google.com, deploy as web app (execute as Me). Yahoo Finance chart API (`/v8/finance/chart/<SYM>?interval=1m&range=1d`, hosts query1/query2.`. Indices: `^HSI`, `^IXIC`.

## Features / semantics (all implemented + verified)

- Per-symbol settings: alert email, check interval (min 1), monitoring window (min), up/down thresholds (%), maxAlerts (default 3.
- **Windowed delta per check**: current price vs window low (rise%) / window high (drop%), computed from in-window history ONLY — **current price excluded** from min/max scan; rise/drop clamped `>=0`; `deltaThisCheck = |rise|>=|drop| ? +rise : -drop` (rounded 4dp as `roundedDelta`). Stored per check as `{t,p,d}` in `state.history[sym]` (2× window, cap `MAX_HISTORY_POINTS`=500..
- **Displayed delta** = largest |Δ| across in-window per-check deltas (ties → newest), `refAt` = when that delta was produced (check time, NOT extreme time). In-window checks keep the peak until it ages out.
..
- **Emails**: sent only on out-of-threshold checks, **at most `maxAlerts` consecutive identical-delta** times per direction. Counter `state.alertCount[sym]`: same direction **AND same `roundedDelta`** → count+1 (cap `maxAlerts+1`); any delta value change (bigger or smaller,) or direction flip → reset to 1 (fresh, emails immediately; in-threshold check → reset to 0. Suppressed (`count > maxAlerts`) → log-only "Suppressed repeated…", no email。 Streak continues while identical delta persists..
- **HK symbols**: numeric codes auto-padded to 4 digits + `.HK` (`5`→`0005.HK`;also `5.HK`→`0005.HK`..
- **Google Finance links**: `^HSI`→`HSI:INDEXHANGSENG`, `^IXIC`→`.IXIC:INDEXNASDAQ`; US/HK stocksuse Yahoo meta exchangeName → `SYMBOL:NASDAQ/NYSE/AMEX/HKG` via `GOOGLE_EXCHANGE_NAME_TO_CODE`, fallback `:NASDAQ` (or `:HKG` for `.HK`). `urlSymbol_` in latest payload..
- **Card order persisted**: `saveOrder(symbols[])` reorders `cfg.items` (unmentioned symbols appended到 end。 Drag reorder via pointer events (touch+mouse) on the ⠿ grip; visual drag/src+drop-target styling…
- **UI**: light theme; card border color by quote currency (teal=HKD, blue=other; card header = one link (symbol+name,same href, hover→`#0e7490` no underline); price row: small grey currency prefix + price + delta with short timestamp (`DD/MM HH:MM` of the peak's production time). Chip: `Alert: up · n/max` while `alertCount>=1` (else shows "Window…"); `· suppressed` when `count>max`。 "Max consecutive alerts" field in add/edit dialog…
- **Toast/dialog fixes**: `call(fn,args,onOk)` attaches handlers BEFORE invoking (`google.script.run` fires with handlers configured at call time; any `.withSuccessHandler` chained afterward silently no-ops→ toasts/dialog dismissal dead).

## Key backend notes

- `getConfig`/`saveConfig_` on `SM_CONFIG` in ScriptProperties; `getState_`/`saveState_` on `SM_STATE` (shape: `{lastCheckedAt,history,latest,alertCount}`;log on `SM_LOG` (50 cap。
- Functions: `upsertItem`, `removeItem`, `saveOrder`, `checkSymbolNow`/`checkAllNow` (both return `{status,toastText}`), `sendTestEmail`, `getStatus`, `checkPrices` (minutely trigger; per-symbol interval gate with 10s tolerance), `checkSymbol_`. Alert email body references window low/high; no re-seed mechanism (history never reset on alert)。
- Status payload items get `urlSymbol` injected in `getStatus`; `latest[sym]` carries `{price,currency,name,deltaPct,refAt,at,alertCount,lastAlert,lastDelta,windowMin,windowMax}`.

## Repository-context caution

- Zero-width space (`U+200B`) corruption has repeatedly occurred via my tool text transmission — when `str_replace`/inline-python "not found" issues arise, prefer line-index-based python edits or `sed`; always `node --check` (copy `.gs`→`.js` first) to verify.
- Terminal inline heredocs are prone to `,,`/`==`/`::` corruption — verify with `cat -A`/`od -c` when syntax fails mysteriously; a clean-file approach (`file_editor`→strip ZWSP→run) is more reliable.

## User preferences

- **Output style**: Do NOT show reasoning/thinking process in responses — only conclusions and results. This applies to all conversations and topics.

## Latest state (as of 2026-09-07)

All requested features implemented and verified: light theme, HK normalization, Google Finance links (incl indices), drag-reorder persisted, currency-aware card colors, delta timestamp, min/max windowed delta, peak display, no re-seed, suppression (maxAlerts + delta-value-reset rule), chip gated on current `alertCount` (stale-tag "0/3" case fixed→shows "Window…"), card under title "…(resolved)" branch removed. Both `Code.gs` and `Index.html` pass `node --check`. No git commits yet.