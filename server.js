// Scanner de ETFs — versión familiar (web real, sin dependencias)
// Node.js 24: solo node:http, node:fs, node:path y fetch nativo.
// Fórmula del Nivel 0–100 (documentada igual en la página y en el README):
// «Nivel = redondeo de [ 0,6 × (100 − RSI 14) + 0,4 × (25 × número de SMA (20/50/100/200) que están por encima del precio) ], limitado entre 0 y 100.»

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 15 * 60 * 1000;

const DEFAULT_SYMBOLS = ['SPYM', 'QQQM', 'RSP', 'JEPQ', 'SPMO'];
// En el scanner de Fernando, Apple se muestra como «APPLE» pero el símbolo real es AAPL.
const DISPLAY = { AAPL: 'APPLE' };
const SMA_PERIODS = [20, 50, 100, 200];

const cache = new Map(); // symbol -> { at, data }

// ---------- utilidades ----------
function normalizeSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase();
  if (s === 'APPLE') s = 'AAPL';
  return /^[A-Z0-9.\-]{1,12}$/.test(s) ? s : null;
}
function displaySymbol(sym) { return DISPLAY[sym] || sym; }
function round2(n) { return n == null || !isFinite(n) ? null : Math.round(n * 100) / 100; }
// Precios menores a $1 (criptos chicas como DOGE/SHIB) necesitan más decimales.
function roundPrice(n) { return n == null || !isFinite(n) ? null : (Math.abs(n) >= 1 ? round2(n) : Math.round(n * 1e6) / 1e6); }

// ---------- datos Yahoo ----------
async function fetchChart(symbol) {
  const url = (host) => `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/json' } };
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(url(host), opts);
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (res) return res;
    } catch (_) { /* probar el siguiente host */ }
  }
  throw new Error(`Sin datos de Yahoo para ${symbol}`);
}

// ---------- cálculos ----------
// Serie RSI 14 Wilder completa; rsiSeries[i] corresponde a closes[i] (null hasta tener 14 cambios).
function rsiSeriesWilder(closes) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < 15) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / 14, avgLoss = loss / 14;
  out[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
    avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function smaAt(closes, i, period) {
  if (i + 1 < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += closes[k];
  return sum / period;
}
function smaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Señal con la regla EXACTA de Fernando: SOLO medias móviles, sin RSI.
// smas = {20,50,100,200} (pueden ser null).
function signalFor(price, smas) {
  const vals = SMA_PERIODS.map(p => smas[p]).filter(v => v != null);
  if (!vals.length) return null;
  const above = vals.filter(v => price > v).length;
  const belowAll = vals.every(v => price < v);
  if (belowAll) return 'Favorable';
  if (above >= 3) return 'No Favorable';
  return 'Interesante';
}

// Nivel según la fórmula documentada en el encabezado de este archivo.
function nivelFor(price, smas, rsi) {
  if (rsi == null) return null;
  const vals = SMA_PERIODS.map(p => smas[p]).filter(v => v != null);
  if (!vals.length) return null;
  const abovePrice = vals.filter(v => v > price).length; // SMA que están por encima del precio
  const positionComponent = 25 * abovePrice;
  const n = Math.round(0.6 * (100 - rsi) + 0.4 * positionComponent);
  return Math.max(0, Math.min(100, n));
}

function positionText(price, smas) {
  const entries = SMA_PERIODS.map(p => ({ p, v: smas[p] })).filter(e => e.v != null);
  if (!entries.length) return 'Sin datos';
  const above = entries.filter(e => price > e.v).map(e => e.p).sort((a, b) => b - a);
  const below = entries.filter(e => price < e.v).map(e => e.p).sort((a, b) => b - a);
  if (!below.length) return 'Sobre todas las SMA';
  if (!above.length) return 'Debajo de todas las SMA';
  return `Sobre SMA ${above.join(', SMA ')} | Debajo SMA ${below.join(', SMA ')}`;
}

function buildSymbolData(symbol, chart) {
  const meta = chart.meta || {};
  const timestamps = chart.timestamp || [];
  const quote = (chart.indicators && chart.indicators.quote && chart.indicators.quote[0]) || {};
  const rawCloses = quote.close || [];
  const rawHighs = quote.high || [], rawLows = quote.low || [];
  const closes = [], dates = [], highs = [], lows = [];
  for (let i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] != null && isFinite(rawCloses[i])) {
      closes.push(rawCloses[i]);
      highs.push(rawHighs[i] != null && isFinite(rawHighs[i]) ? rawHighs[i] : rawCloses[i]);
      lows.push(rawLows[i] != null && isFinite(rawLows[i]) ? rawLows[i] : rawCloses[i]);
      dates.push(timestamps[i] ? new Date(timestamps[i] * 1000).toISOString().slice(0, 10) : null);
    }
  }
  const last = closes.length - 1;
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[last];
  let changePct = meta.regularMarketChangePercent;
  if (changePct == null && last >= 1 && closes[last - 1]) {
    changePct = ((closes[last] - closes[last - 1]) / closes[last - 1]) * 100;
  }
  const rsiS = rsiSeriesWilder(closes);
  const smaSeriesMap = {};
  for (const p of SMA_PERIODS) smaSeriesMap[p] = smaSeries(closes, p);
  const smasNow = {};
  for (const p of SMA_PERIODS) smasNow[p] = last >= 0 ? smaSeriesMap[p][last] : null;
  const rsi = last >= 0 ? rsiS[last] : null;
  const signal = signalFor(price, smasNow);

  // Días en señal: racha terminando hoy, recalculando día por día.
  let daysInSignal = null;
  if (signal) {
    daysInSignal = 0;
    for (let i = last; i >= 0; i--) {
      const s = {};
      for (const p of SMA_PERIODS) s[p] = smaSeriesMap[p][i];
      const sig = signalFor(closes[i], s);
      if (sig === null || sig !== signal) break;
      daysInSignal++;
    }
    if (daysInSignal === 0) daysInSignal = 1;
  }

  const distances = {};
  for (const p of SMA_PERIODS) {
    distances[p] = smasNow[p] ? round2(((price - smasNow[p]) / smasNow[p]) * 100) : null;
  }

  // Serie de 6 meses (~126 días de mercado) para el gráfico del detalle.
  const from = Math.max(0, closes.length - 126);
  const series6m = {
    dates: dates.slice(from),
    closes: closes.slice(from).map(roundPrice),
    sma20: smaSeriesMap[20].slice(from).map(roundPrice),
    sma50: smaSeriesMap[50].slice(from).map(roundPrice),
  };

  return {
    symbol,
    display: displaySymbol(symbol),
    name: meta.longName || meta.shortName || symbol,
    type: meta.instrumentType === 'ETF' ? 'ETF' : (meta.instrumentType === 'EQUITY' ? 'Stock' : (meta.instrumentType === 'CRYPTOCURRENCY' ? 'Crypto' : (meta.instrumentType || '—'))),
    price: roundPrice(price),
    changePct: round2(changePct),
    rsi: round2(rsi),
    smas: { 20: round2(smasNow[20]), 50: round2(smasNow[50]), 100: round2(smasNow[100]), 200: round2(smasNow[200]) },
    distancesPct: distances,
    position: positionText(price, smasNow),
    signal,
    daysInSignal,
    supertrend: supertrend(highs, lows, closes),
    nivel: nivelFor(price, smasNow, rsi),
    week52: { low: round2(meta.fiftyTwoWeekLow), high: round2(meta.fiftyTwoWeekHigh) },
    closesCount: closes.length,
    lastDate: dates[last] || null,
    series6m,
  };
}

// ---------- Supertrend (del curso) a partir de OHLC del chart ----------
// ATR(10) Wilder, factor 3. Devuelve {value, direction} de la última vela.
function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  if (n < period + 2) return null;
  const atr = new Array(n).fill(null);
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  atr[period] = trSum / period;
  for (let i = period + 1; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  let fUb = null, fLb = null, trend = 1, st = null;
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const bUb = hl2 + mult * atr[i], bLb = hl2 - mult * atr[i];
    if (fUb === null) { fUb = bUb; fLb = bLb; }
    else {
      fUb = (bUb < fUb || closes[i - 1] > fUb) ? bUb : fUb;
      fLb = (bLb > fLb || closes[i - 1] < fLb) ? bLb : fLb;
    }
    if (trend === 1) { if (closes[i] < fLb) trend = -1; }
    else { if (closes[i] > fUb) trend = 1; }
    st = trend === 1 ? fLb : fUb;
  }
  return st == null ? null : { value: round2(st), direction: trend === 1 ? 'Alcista' : 'Bajista' };
}

// ---------- fundamentales del curso (PER, ROA, ROE, ROI, margen, dividendo, expense) ----------
// Fuente pública sin clave: páginas de stockanalysis.com. Falla suave: si no se puede
// leer, devuelve {} y la página muestra «sin datos» sin romper la tabla.
const FUND_CACHE_MS = 6 * 60 * 60 * 1000;
const fundCache = new Map();
function pageText(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
function statAfter(text, label) {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const m = text.slice(i + label.length, i + label.length + 40).match(/-?[0-9][0-9,]*\.?[0-9]*\s?[%xTBMK]?/);
  return m ? m[0].replace(/,/g, '').trim() : null;
}
async function fetchPage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'text/html' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return pageText(await r.text());
}
async function fetchFundamentals(symbol, kind) {
  const hit = fundCache.get(symbol);
  if (hit && Date.now() - hit.at < FUND_CACHE_MS) return hit.data;
  const slug = symbol.toLowerCase();
  const data = {};
  try {
    if (kind === 'ETF') {
      const t = await fetchPage(`https://stockanalysis.com/etf/${slug}/`);
      data.per = statAfter(t, 'PE Ratio');
      data.perFwd = statAfter(t, 'Forward PE');
      data.expense = statAfter(t, 'Expense Ratio');
      data.beta = statAfter(t, 'Beta');
      const hm = t.match(/Holdings\s+([0-9][0-9,]{2,})/);
      data.holdings = hm ? hm[1] : statAfter(t, 'Holdings');
      const dm = t.match(/Dividend \$[0-9.]+ \(([0-9.]+)%\)/);
      data.divYield = dm ? dm[1] + '%' : null;
    } else if (kind === 'Stock') {
      const t = await fetchPage(`https://stockanalysis.com/stocks/${slug}/`);
      data.per = statAfter(t, 'PE Ratio');
      data.perFwd = statAfter(t, 'Forward PE');
      data.beta = statAfter(t, 'Beta');
      data.mcap = statAfter(t, 'Market Cap');
      const dm = t.match(/Dividend \$[0-9.]+ \(([0-9.]+)%\)/);
      data.divYield = dm ? dm[1] + '%' : null;
      const pt = t.match(/Price Target ([0-9.]+)/);
      data.target = pt ? '$' + pt[1] : null;
      try {
        const r = await fetchPage(`https://stockanalysis.com/stocks/${slug}/financials/ratios/`);
        data.roe = statAfter(r, 'Return on Equity (ROE)');
        data.roa = statAfter(r, 'Return on Assets (ROA)');
        data.roi = statAfter(r, 'Return on Invested Capital (ROIC)');
        data.margin = statAfter(r, 'Net Profit Margin') || statAfter(r, 'Profit Margin') || statAfter(r, 'Net Margin');
      } catch (_) { /* ratios opcionales */ }
    }
  } catch (_) { /* falla suave: sin fundamentales */ }
  fundCache.set(symbol, { at: Date.now(), data });
  return data;
}

// ---------- datos ETF.com en vivo (API pública SIN sesión) + holdings StockAnalysis ----------
// La API pública de ETF.com (api-prod.etf.com/v2) sirve rendimientos SIN login:
// /v2/fund/tickers -> fundId por ticker; /v2/fund/performance/<fundId> -> retornos.
// Los holdings se leen de la página pública de StockAnalysis. Caché 6 h como fundamentales.
// La calificación Fit es propietaria de ETF.com y NO tiene endpoint público: queda como
// foto fechada en el cliente (ETF_COM) cuando existe.
const ETFCOM_CACHE_MS = 6 * 60 * 60 * 1000;
const etfcomCache = new Map();
let tickersCache = null;
// Cabeceras de navegador + reintento: algunos hosts (p. ej. Render) son rechazados
// por api-prod.etf.com con una llamada simple; con cabeceras completas y reintento
// la mayoría de esos rechazos se superan.
const ETF_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.etf.com',
  'Referer': 'https://www.etf.com/',
};
async function fetchJsonRetry(url, tries = 2) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: ETF_API_HEADERS });
      if (r.ok) return await r.json();
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    if (i + 1 < tries) await new Promise(res => setTimeout(res, 800));
  }
  throw lastErr || new Error('fetch failed');
}
async function fetchFundIdMap() {
  if (tickersCache && Date.now() - tickersCache.at < 24 * 60 * 60 * 1000) return tickersCache.map;
  const j = await fetchJsonRetry('https://api-prod.etf.com/v2/fund/tickers');
  const map = {};
  for (const t of j) if (t && t.ticker && t.fundId) map[String(t.ticker).toUpperCase()] = t.fundId;
  tickersCache = { at: Date.now(), map };
  return map;
}
// Respaldo: rendimientos anualizados desde Yahoo (adjclose = con dividendos y splits).
// Solo se usa si la API de ETF.com no responde; r5y solo si hay casi 5 años de historia
// (JEPQ, más joven, queda sin 5 años igual que en ETF.com).
async function fetchYahooReturns(symbol) {
  const url = (host) => `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/json' } };
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(url(host), opts);
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) continue;
      const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      const adj = (res.indicators && res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || [];
      const closes = [], stamps = [];
      const raw = adj.length ? adj : (q.close || []);
      const ts = res.timestamp || [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] != null && isFinite(raw[i]) && ts[i]) { closes.push(raw[i]); stamps.push(ts[i]); }
      }
      if (closes.length < 260) continue;
      const last = closes[closes.length - 1];
      const ann = (a, b, days) => days > 0 ? round2((Math.pow(a / b, 365.25 / days) - 1) * 100) : null;
      const out = { src: 'yahoo' };
      const i1 = closes.length - 1 - 252;
      if (i1 >= 0) out.r1y = ann(last, closes[i1], (stamps[stamps.length - 1] - stamps[i1]) / 86400);
      const spanDays = (stamps[stamps.length - 1] - stamps[0]) / 86400;
      if (spanDays >= 4.9 * 365.25) out.r5y = ann(last, closes[0], spanDays);
      out.asOf = new Date(stamps[stamps.length - 1] * 1000).toISOString().slice(0, 10);
      return out;
    } catch (_) { /* siguiente host */ }
  }
  return null;
}
async function fetchEtfcom(symbol) {
  const hit = etfcomCache.get(symbol);
  if (hit && Date.now() - hit.at < ETFCOM_CACHE_MS) return hit.data;
  const data = {};
  try {
    const map = await fetchFundIdMap();
    const id = map[symbol];
    if (id) {
      const j = await fetchJsonRetry(`https://api-prod.etf.com/v2/fund/performance/${id}`);
      const p = j.priceData || {};
      data.asOf = j.asOfDate ? String(j.asOfDate).split(',')[0] : null;
      data.r1m = round2(p.return1M); data.r3m = round2(p.return3M);
      data.rYtd = round2(p.returnYTD); data.r1y = round2(p.return1Y);
      data.r3y = round2(p.return3Y); data.r5y = round2(p.return5Y);
    }
  } catch (_) { /* rendimientos por API opcionales; abajo va el respaldo Yahoo */ }
  if (data.r1y == null) {
    try {
      const y = await fetchYahooReturns(symbol);
      if (y) Object.assign(data, y);
    } catch (_) { /* sin respaldo */ }
  }
  try {
    const r = await fetch(`https://stockanalysis.com/etf/${symbol.toLowerCase()}/holdings/`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'text/html' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const clean = (await r.text()).replace(/<!--[\s\S]*?-->/g, '');
    const top = [];
    const re = /<td class="sym[^"]*"><a[^>]*>([A-Z0-9.]+)<\/a><\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>([0-9]+\.[0-9]+)%<\/td>/g;
    let m;
    while ((m = re.exec(clean)) && top.length < 10) top.push([m[1], parseFloat(m[2])]);
    if (top.length) data.top = top;
    const t10 = clean.match(/Top 10 Percentage\s*<div[^>]*>([0-9.]+)%<\/div>/);
    if (t10) data.top10 = parseFloat(t10[1]);
    const th = clean.match(/Total Holdings\s*<div[^>]*>([0-9,]+)<\/div>/);
    if (th) data.count = parseInt(th[1].replace(/,/g, ''), 10);
  } catch (_) { /* holdings opcionales */ }
  // No cachear resultados vacíos: si todo falló, el próximo intento reintenta
  // en vez de servir 6 h de vacío.
  if (data.top || data.r1y != null) etfcomCache.set(symbol, { at: Date.now(), data });
  return data;
}

// ---------- rendimiento histórico anualizado (CAGR) para la calculadora ----------
// CAGR a 5 años (o desde que existe el activo, si tiene al menos 1 año de historia)
// con precios ajustados (dividendos y splits). Un activo con menos de 1 año queda
// con cagr null: anualizar tan poco tiempo no dice nada útil. Caché 6 h.
const CAGR_CACHE_MS = 6 * 60 * 60 * 1000;
const cagrCache = new Map();
async function fetchCagr(symbol) {
  const hit = cagrCache.get(symbol);
  if (hit && Date.now() - hit.at < CAGR_CACHE_MS) return hit.data;
  const data = { symbol, cagr: null, years: null, asOf: null };
  const url = (host) => `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/json' } };
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(url(host), opts);
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) continue;
      const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      const adj = (res.indicators && res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || [];
      const raw = adj.length ? adj : (q.close || []);
      const ts = res.timestamp || [];
      const closes = [], stamps = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] != null && isFinite(raw[i]) && ts[i]) { closes.push(raw[i]); stamps.push(ts[i]); }
      }
      if (closes.length < 2) continue;
      const years = ((stamps[stamps.length - 1] - stamps[0]) / 86400) / 365.25;
      data.years = round2(years);
      data.asOf = new Date(stamps[stamps.length - 1] * 1000).toISOString().slice(0, 10);
      if (years >= 1) data.cagr = round2((Math.pow(closes[closes.length - 1] / closes[0], 1 / years) - 1) * 100);
      break;
    } catch (_) { /* siguiente host */ }
  }
  cagrCache.set(symbol, { at: Date.now(), data });
  return data;
}

async function getSymbol(symbol, force) {
  if (!force) {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }
  const chart = await fetchChart(symbol);
  const data = buildSymbolData(symbol, chart);
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

// ---------- búsqueda de símbolos (por nombre de empresa o ticket) ----------
async function searchSymbols(q) {
  const url = (host) => `https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/json' } };
  for (const host of ['query2', 'query1']) {
    try {
      const r = await fetch(url(host), opts);
      if (!r.ok) continue;
      const j = await r.json();
      const quotes = (j && j.quotes) || [];
      return quotes
        .filter(x => x && x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF' || x.quoteType === 'CRYPTOCURRENCY'))
        .slice(0, 8)
        .map(x => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, type: x.quoteType === 'ETF' ? 'ETF' : (x.quoteType === 'CRYPTOCURRENCY' ? 'Crypto' : 'Stock') }));
    } catch (_) { /* probar el siguiente host */ }
  }
  return [];
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/search') {
      const q = String(u.searchParams.get('q') || '').trim().slice(0, 40);
      const results = q ? await searchSymbols(q) : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ q, results }));
      return;
    }
    if (u.pathname === '/api/fundamentals') {
      const sym = normalizeSymbol(u.searchParams.get('symbol'));
      const kind = u.searchParams.get('kind') || '';
      if (!sym) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'symbol required' })); return; }
      const fundamentals = await fetchFundamentals(sym, kind);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ symbol: sym, fundamentals }));
      return;
    }
    if (u.pathname === '/api/etfcom') {
      const sym = normalizeSymbol(u.searchParams.get('symbol'));
      if (!sym) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'symbol required' })); return; }
      const etfcom = await fetchEtfcom(sym);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ symbol: sym, etfcom }));
      return;
    }
    if (u.pathname === '/api/cagr') {
      const q = u.searchParams.get('symbols');
      const syms = q ? [...new Set(q.split(',').map(normalizeSymbol).filter(Boolean))].slice(0, 30) : [];
      const results = await Promise.all(syms.map(fetchCagr));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ symbols: results }));
      return;
    }
    if (u.pathname === '/api/scanner') {
      let symbols = DEFAULT_SYMBOLS;
      const q = u.searchParams.get('symbols');
      if (q) {
        symbols = [...new Set(q.split(',').map(normalizeSymbol).filter(Boolean))].slice(0, 30);
        if (!symbols.length) symbols = DEFAULT_SYMBOLS;
      }
      const fresh = u.searchParams.get('fresh') === '1';
      const results = await Promise.all(symbols.map(async (s) => {
        try { return await getSymbol(s, fresh); }
        catch (e) { return { symbol: s, display: displaySymbol(s), error: String(e.message || e) }; }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ updatedAt: new Date().toISOString(), symbols: results }));
      return;
    }
    // Estático (solo public/, sin salir de la carpeta)
    let rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(PORT, () => console.log(`Scanner familiar escuchando en http://localhost:${PORT}`));
