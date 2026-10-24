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

const DEFAULT_SYMBOLS = ['SPYM', 'QQQM', 'SCHD', 'RSP', 'JEPQ', 'SPMO', 'VTI', 'SCHG', 'META', 'AAPL'];
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

// Señal con la regla EXACTA de Fernando. smas = {20,50,100,200} (pueden ser null).
function signalFor(price, smas, rsi) {
  const vals = SMA_PERIODS.map(p => smas[p]).filter(v => v != null);
  if (!vals.length || rsi == null) return null;
  const above = vals.filter(v => price > v).length;
  const belowAll = vals.every(v => price < v);
  if (belowAll || rsi <= 35) return 'Favorable';
  if (above >= 3 || rsi >= 65) return 'No Favorable';
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
  const closes = [], dates = [];
  for (let i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] != null && isFinite(rawCloses[i])) {
      closes.push(rawCloses[i]);
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
  const signal = signalFor(price, smasNow, rsi);

  // Días en señal: racha terminando hoy, recalculando día por día.
  let daysInSignal = null;
  if (signal) {
    daysInSignal = 0;
    for (let i = last; i >= 0; i--) {
      const s = {};
      for (const p of SMA_PERIODS) s[p] = smaSeriesMap[p][i];
      const sig = signalFor(closes[i], s, rsiS[i]);
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
    nivel: nivelFor(price, smasNow, rsi),
    week52: { low: round2(meta.fiftyTwoWeekLow), high: round2(meta.fiftyTwoWeekHigh) },
    closesCount: closes.length,
    lastDate: dates[last] || null,
    series6m,
  };
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
