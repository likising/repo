/**
 * Stock Price Monitor — Google Apps Script web app.
 *
 * Monitors US and HK stocks (Yahoo Finance quotes) and emails an alert when a
 * price moves beyond the up/down thresholds within the monitoring window.
 * Each monitored symbol carries its own settings (email, interval, window,
 * thresholds). Monitoring runs automatically while at least one symbol exists.
 */

var CONFIG_KEY = 'SM_CONFIG';
var STATE_KEY = 'SM_STATE';
var LOG_KEY = 'SM_LOG';
var TRIGGER_HANDLER = 'checkPrices';
var MAX_LOG_ENTRIES = 50;
var MAX_HISTORY_POINTS = 500;

/* ------------------------------ Web app entry ------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Stock Price Monitor')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* --------------------------------- Config ---------------------------------- */

function getConfig() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG_KEY);
  if (raw) {
    try {
      var saved = JSON.parse(raw);
      if (saved && Array.isArray(saved.items)) return { items: saved.items };
    } catch (e) { /* fall through to empty config */ }
  }
  return { items: [] };
}

function saveConfig_(cfg) {
  PropertiesService.getScriptProperties().setProperty(CONFIG_KEY, JSON.stringify(cfg));
}

function normalizeSymbol_(raw) {
  var s = String(raw || '').trim().toUpperCase();
  if (/^\d+$/.test(s)) s = ('0000' + s).slice(-4) + '.HK'; // "5" → "0005.HK"
  else if (/^\d+\.HK$/.test(s)) { // pad numeric HK codes, e.g. "5.HK" → "0005.HK"
    var digits = s.slice(0, -3);
    if (/^\d{1,4}$/.test(digits)) s = ('0000' + digits).slice(-4) + '.HK';
  }
  if (!/^[0-9A-Z^.\-=]+$/.test(s)) throw new Error('Invalid symbol "' + s + '".');
  return s;
}

var GOOGLE_EXCHANGE_NAME_TO_CODE = {
  NMS: 'NASDAQ', NYQ: 'NYSE', ASE: 'AMEX', HKG: 'HKG', HSI: 'INDEXHANGSENG', NDX: 'INDEXNASDAQ'
};

function urlSymbol_(symbol, quote) {
  var base = /\.HK$/.test(symbol) ? symbol.slice(0, -3) : symbol;
  // Explicit mappings take priority (e.g. Yahoo sometimes reports ^HSI's exchange as NDX^).
  if (base === '^HSI') return 'HSI:INDEXHANGSENG';
  if (base === '^IXIC') return '.IXIC:INDEXNASDAQ';
  var ex = quote && quote.exchange ? String(quote.exchange).toUpperCase() : '';
  var code = GOOGLE_EXCHANGE_NAME_TO_CODE[ex] || (/\.HK$/.test(symbol) ? 'HKG' : 'NASDAQ');
  return base + ':' + code;
}

function validateItem_(item) {
  var it = {
    symbol: normalizeSymbol_(item.symbol),
    email: String(item.email || '').trim(),
    intervalMin: Number(item.intervalMin),
    windowMin: Number(item.windowMin),
    upPct: Number(item.upPct),
    downPct: Number(item.downPct),
    maxAlerts: Number(item.maxAlerts) || 3
  };
  if (!(it.intervalMin >= 1)) throw new Error('Check interval must be at least 1 minute.');
  if (!(it.windowMin >= 1)) throw new Error('Monitoring window must be at least 1 minute.');
  if (!(it.upPct > 0)) throw new Error('Up threshold must be greater than 0.');
  if (!(it.downPct > 0)) throw new Error('Down threshold must be greater than 0.');
  if (!(it.maxAlerts >= 1)) throw new Error('Max consecutive alerts must be at least 1.');
  if (!it.email) it.email = Session.getEffectiveUser().getEmail() || '';
  if (!it.email) throw new Error('Please provide an alert email address.');
  return it;
}

function defaultEmail_() {
  var cfg = getConfig();
  for (var i = 0; i < cfg.items.length; i++) {
    if (cfg.items[i].email) return cfg.items[i].email;
  }
  return Session.getEffectiveUser().getEmail() || '';
}

/* ------------------------------- UI actions -------------------------------- */

function upsertItem(item) {
  var it = validateItem_(item || {});
  var cfg = getConfig();
  var state = getState_();
  var idx = -1;
  cfg.items.forEach(function (x, i) { if (x.symbol === it.symbol) idx = i; });
  if (idx >= 0) {
    cfg.items[idx] = it;
  } else {
    cfg.items.push(it);
    state.history[it.symbol] = []; // fresh baseline for a new symbol
    state.alertCount[it.symbol] = 0;
  }
  saveConfig_(cfg);
  state.lastCheckedAt[it.symbol] = 0; // check immediately
  saveState_(state);
  ensureTrigger_();
  addLog_('info', (idx >= 0 ? 'Updated ' : 'Added ') + it.symbol);
  checkPrices();
  return { status: getStatus(), toastText: 'Saved ' + it.symbol };
}

function removeItem(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  var cfg = getConfig();
  cfg.items = cfg.items.filter(function (x) { return x.symbol !== symbol; });
  saveConfig_(cfg);
  var state = getState_();
  delete state.history[symbol];
  delete state.latest[symbol];
  delete state.lastCheckedAt[symbol];
  delete state.alertCount[symbol];
  saveState_(state);
  if (!cfg.items.length) removeTriggers_();
  addLog_('info', 'Removed ' + symbol);
  return getStatus();
}

function checkSymbolNow(symbol) {
  symbol = normalizeSymbol_(symbol);
  var state = getState_();
  state.lastCheckedAt[symbol] = 0;
  saveState_(state);
  checkPrices();
  return { status: getStatus(), toastText: 'Card updated' };
}

function checkAllNow() {
  var state = getState_();
  state.lastCheckedAt = {};
  saveState_(state);
  checkPrices();
  return { status: getStatus(), toastText: 'All cards updated' };
}

function saveOrder(symbols) {
  var list = Array.isArray(symbols) ? symbols : [];
  var bySymbol = {};
  getConfig().items.forEach(function (i) { bySymbol[i.symbol] = i; });
  var ordered = [];
  list.forEach(function (s) {
    var sym = String(s || '').trim().toUpperCase();
    if (bySymbol[sym]) { ordered.push(bySymbol[sym]); delete bySymbol[sym]; }
  });
  // Any symbol the client didn't mention goes to the end, so nothing is lost.
  Object.keys(bySymbol).forEach(function (k) { ordered.push(bySymbol[k]); });
  saveConfig_({ items: ordered });
  return getStatus();
}

function sendTestEmail(email) {
  email = String(email || '').trim() || defaultEmail_();
  if (!email) throw new Error('Please provide an email address.');
  var cfg = getConfig();
  MailApp.sendEmail(email, '✅ Stock Monitor — test email',
    'This is a test email from your Stock Price Monitor.\n\n' +
    'Monitored symbols:\n' +
    (cfg.items.length
      ? cfg.items.map(function (i) {
          return '  • ' + i.symbol + ' — every ' + i.intervalMin + ' min, window ' +
            i.windowMin + ' min, +' + i.upPct + '% / -' + i.downPct + '% → ' + i.email;
        }).join('\n')
      : '  (none yet)') +
    '\n\nIf you received this, alerts are working.');
  addLog_('info', 'Test email sent to ' + email);
  return 'Test email sent to ' + email;
}

function getStatus() {
  var cfg = getConfig();
  var state = getState_();
  cfg.items.forEach(function (i) {
    var q = state.latest[i.symbol];
    i.urlSymbol = (q && q.urlSymbol) || urlSymbol_(i.symbol, q);
  });
  return {
    items: cfg.items,
    latest: state.latest,
    log: getLog_(),
    triggerActive: hasTrigger_(),
    serverTime: new Date().toISOString()
  };
}

/* ------------------------------ Trigger setup ------------------------------ */

function ensureTrigger_() {
  removeTriggers_();
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(1).create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

function hasTrigger_() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === TRIGGER_HANDLER;
  });
}

/* ------------------------------ Core checking ------------------------------ */

function checkPrices() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var cfg = getConfig();
    if (!cfg.items.length) return;
    var state = getState_();
    var now = Date.now();
    cfg.items.forEach(function (item) {
      // The trigger fires every minute; each symbol honors its own interval.
      var last = state.lastCheckedAt[item.symbol] || 0;
      if (last && now - last < item.intervalMin * 60000 - 10000) return;
      state.lastCheckedAt[item.symbol] = now;
      try {
        checkSymbol_(item, state, now);
      } catch (e) {
        state.latest[item.symbol] = { error: e.message, at: new Date(now).toISOString() };
        addLog_('error', item.symbol + ': ' + e.message);
      }
    });
    saveState_(state);
  } finally {
    lock.releaseLock();
  }
}

function checkSymbol_(item, state, now) {
  var sym = item.symbol;
  var quote = fetchQuote_(sym);
  var price = quote.price;
  if (!(price > 0)) throw new Error('No price available');

  // Keep 2x window of history (enough margin so points age out gradually)。
  var hist =(state.history[sym] || []).filter(function (pt) {
    return pt.t >= now - item.windowMin * 60000 * 2;
  });
  var windowStart = now - item.windowMin * 60000;

  // Windowed delta = current price vs the extremes of the recorded points inside
  // the window — the current price is deliberately NOT included in that scan.

  var inWindow = hist.filter(function (pt) { return pt.t >= windowStart; });


  var windowMinP = null, windowMaxP = null;
  inWindow.forEach(function (pt) {
    if (windowMinP == null || pt.p < windowMinP) windowMinP = pt.p;
    if (windowMaxP == null || pt.p > windowMaxP) windowMaxP = pt.p;
  });
  var risePct = windowMinP != null && windowMinP >  0 ? (price - windowMinP) / windowMinP *  100 :  0;
  var dropPct = windowMaxP != null && windowMaxP >  0 ? (windowMaxP - price) / windowMaxP *  100 :  0;
  risePct = Math.max(0, risePct); dropPct = Math.max(0, dropPct);
  var deltaThisCheck = Math.abs(risePct) >= Math.abs(dropPct) ? risePct : -dropPct;
  var roundedDelta = Math.round(deltaThisCheck * 10000) / 10000;

  // Store the per-check delta with the price, so the displayed peak can be computed later和
  hist.push({ t: now, p: price, d: deltaThisCheck });
  if (hist.length > MAX_HISTORY_POINTS) hist = hist.slice(-MAX_HISTORY_POINTS);
  state.history[sym] = hist;


  // Displayed delta =the in-window history point with the largest |delta|,(ties → newest)。
  var peak = null;
  inWindow.concat({ t: now, d: deltaThisCheck }).forEach(function (pt) {
    if (pt.d == null) return;
    if (!peak || Math.abs(pt.d) > Math.abs(peak.d) ||
        (Math.abs(pt.d) == Math.abs(peak.d) && pt.t > peak.t)) peak = pt;
  });


  // Alerts: at most maxAlerts consecutive per direction; in-threshold checks reset the streak.
  var prev = state.latest[sym] || {};
var direction = risePct >= item.upPct ? 'UP' : (dropPct >= item.downPct ? 'DOWN' : null);
var sameDelta = (prev.lastDelta != null && prev.lastDelta === roundedDelta);
var cnt = state.alertCount[sym] || 0;
if (direction) {
  cnt = (prev.lastAlert && prev.lastAlert.direction === direction && sameDelta) ? Math.min(cnt + 1, item.maxAlerts + 1) : 1;
} else {
  cnt =  0;
}
state.alertCount[sym] = cnt;
state.alertCount[sym] = cnt;
state.latest[sym] = {
  price: price,
  urlSymbol: urlSymbol_(sym, quote),
  currency: quote.currency,
  name: quote.name,
  exchange: quote.exchange,
  marketState: quote.marketState,
  tradeAt: quote.tradeAt,
  windowMin: windowMinP,
  windowMax: windowMaxP,
  deltaPct: peak ? peak.d : 0,
  refAt: peak ? new Date(peak.t).toISOString() : new Date(now).toISOString(),
  at: new Date(now).toISOString(),
  alertCount: cnt,
  lastAlert: direction ? { direction: direction, at: new Date(now).toISOString() } : (prev.lastAlert || null),
  lastDelta: roundedDelta,
};
if (direction) {
  if (cnt <= item.maxAlerts) {
    sendAlert_(item, quote, deltaThisCheck, direction, now);
    addLog_('alert', sym + ' ' + direction + ' ' + formatPct_(deltaThisCheck) +
      ' (' + price + ' ' + quote.currency + ') — alert emailed to ' + item.email);
  } else {
    addLog_('error', 'Suppressed repeated ' + direction + ' alert for ' + sym +
      ' (would be #' + cnt + ' of ' + item.maxAlerts + ' — price still ' +
      formatPct_(deltaThisCheck) + ' out of threshold)');
  }
} else {
  addLog_('check', sym + ' ' + price + ' ' + quote.currency + ' (' + formatPct_(deltaThisCheck) + ' in window)');
}
}



/* ------------------------------ Quote fetching ----------------------------- */

function fetchQuote_(symbol) {
  var hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  var lastErr = null;
  for (var i = 0; i < hosts.length; i++) {
    var url = hosts[i] + '/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1m&range=1d';
    try {
      var res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (res.getResponseCode() !== 200) {
        lastErr = new Error('HTTP ' + res.getResponseCode());
        continue;
      }
      var json = JSON.parse(res.getContentText());
      var result = json.chart && json.chart.result && json.chart.result[0];
      if (!result) {
        var apiErr = json.chart && json.chart.error;
        lastErr = new Error(apiErr ? apiErr.description : 'Symbol not found');
        continue;
      }
      var meta = result.meta || {};
      var price = meta.regularMarketPrice;
      if (price == null) {
        var closes = result.indicators && result.indicators.quote &&
          result.indicators.quote[0] && result.indicators.quote[0].close;
        if (closes) {
          for (var j = closes.length - 1; j >= 0; j--) {
            if (closes[j] != null) { price = closes[j]; break; }
          }
        }
      }
      if (price == null) throw new Error('No price in response');
      return {
        symbol: meta.symbol || symbol,
        name: meta.shortName || meta.longName || meta.symbol || symbol,
        price: price,
        currency: meta.currency || '',
        marketState: meta.marketState || '',
        exchange: meta.fullExchangeName || meta.exchangeName || '',
        tradeAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Quote unavailable');
}

/* --------------------------------- Alerts ---------------------------------- */

function sendAlert_(item, quote, deltaPct, direction, now) {
  var arrow = direction === 'UP' ? '📈' : '📉';
  var threshold = direction === 'UP' ? '+' + item.upPct + '%' : '-' + item.downPct + '%';
  var reference = direction === 'UP' ? 'window low' : 'window high';
  var subject = arrow + ' ' + quote.symbol + ' ' + direction + ' ' + formatPct_(deltaPct) +
    ' (threshold ' + threshold + ')';
  var body = [
    'Stock price alert',
    '',
    'Symbol:     ' + quote.symbol + ' (' + quote.name + ')',
    'Exchange:   ' + quote.exchange,
    'Direction:  ' + direction,
    'Change:     ' + formatPct_(deltaPct) + ' vs ' + reference + ' in the last ' + item.windowMin + ' min',
    'Price now:  ' + quote.price + ' ' + quote.currency,
    'Threshold:  ' + threshold,
    'Time:       ' + new Date(now).toString(),
    '',
    'The window has been re-seeded from the current price; the next alert',
    'will be measured against new extremes from ' + quote.price + ' ' + quote.currency + ' onward.'
  ].join('\n');
  MailApp.sendEmail(item.email, subject, body);
}

/* ------------------------------- State / log ------------------------------- */

function getState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  var state = { lastCheckedAt: {}, history: {}, latest: {}, alertCount: {} };
  if (raw) {
    try {
      var saved = JSON.parse(raw);
      if (saved.lastCheckedAt) state.lastCheckedAt = saved.lastCheckedAt;
      if (saved.history) state.history = saved.history;
      if (saved.latest) state.latest = saved.latest;
      if (saved.alertCount) state.alertCount = saved.alertCount;
    } catch (e) { /* keep defaults */ }
  }
  return state;
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function addLog_(type, message) {
  var log = getLog_();
  log.unshift({ type: type, message: message, at: new Date().toISOString() });
  if (log.length > MAX_LOG_ENTRIES) log = log.slice(0, MAX_LOG_ENTRIES);
  PropertiesService.getScriptProperties().setProperty(LOG_KEY, JSON.stringify(log));
}

function getLog_() {
  var raw = PropertiesService.getScriptProperties().getProperty(LOG_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch (e) { return []; }
}

/* --------------------------------- Helpers --------------------------------- */

function formatPct_(v) {
  return (v >= 0 ? '+' : '') + (Math.round(v * 100) / 100).toFixed(2) + '%';
}

function round4_(v) {
  return Math.round(v * 10000) / 10000;
}
