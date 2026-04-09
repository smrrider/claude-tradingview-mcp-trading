/**
 * Market Sentinel — 5-Layer Institutional Entry Framework
 *
 * Layer 1: ADX          — Only trade trending markets (ADX > 25)
 * Layer 2: EMA Ribbon   — Directional bias (8/13/21/34/55 stack)
 * Layer 3: TTM Squeeze  — Momentum direction post-compression
 * Layer 4: Stoch RSI    — Pullback timing (oversold cross for longs)
 * Layer 5: Volume       — Institutional participation (>1.5x avg)
 *
 * Data: Hyperliquid public API (no auth, no geo-block)
 * Execution: Pionex / BitGet via REST
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

async function loadRemoteSettings() {
  const url = process.env.DASHBOARD_URL;
  if (!url) return {};
  try {
    const r = await fetch(`${url}/api/public-settings`);
    if (!r.ok) return {};
    const s = await r.json();
    console.log(`📡 Settings loaded from dashboard: ${s.symbols.join(", ")}`);
    return s;
  } catch (_) { return {}; }
}

const _remote = await loadRemoteSettings();

const CONFIG = {
  symbols: _remote.symbols || (process.env.SYMBOLS || "HYPEUSDT").split(",").map(s => s.trim()).filter(Boolean),
  timeframe: _remote.timeframe || process.env.TIMEFRAME || "4H",
  maxTradeSizeUSD: parseFloat(_remote.maxTradeSize || process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(_remote.maxTradesPerDay || process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: _remote.paperTrading !== undefined ? _remote.paperTrading : process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE || "",
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  const intervalMap = { "1m":"1m","5m":"5m","15m":"15m","30m":"30m","1H":"1h","4H":"4h","1D":"1d" };
  const msMap = { "1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"1d":86400000 };
  const hlInterval = intervalMap[interval] || "1h";
  const coin = symbol.replace(/USDT$/, "");
  const startTime = Date.now() - (limit + 10) * (msMap[hlInterval] || 3600000);

  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: hlInterval, startTime, endTime: Date.now() } }),
  });

  if (!res.ok) throw new Error(`Hyperliquid error: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`No candle data for ${symbol}`);

  return data.slice(-limit).map(k => ({
    time: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
  }));
}

// ─── Indicator Library ────────────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function sma(values, period) {
  const s = values.slice(-period);
  return s.reduce((a, b) => a + b) / s.length;
}

// ── Layer 1 + 2: ADX and DI ──────────────────────────────────────────────────

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 2) return null;

  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const dn = p.low - c.low;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }

  // Wilder's sum smoothing (alpha = 1/period)
  function wilderSum(arr) {
    let val = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [val];
    for (let i = period; i < arr.length; i++) {
      val = val - val / period + arr[i];
      out.push(val);
    }
    return out;
  }

  const smTR  = wilderSum(trs);
  const smPlus = wilderSum(plusDMs);
  const smMinus = wilderSum(minusDMs);

  const diPlus  = smPlus.map((v, i)  => smTR[i] ? 100 * v / smTR[i] : 0);
  const diMinus = smMinus.map((v, i) => smTR[i] ? 100 * v / smTR[i] : 0);

  const dx = diPlus.map((dp, i) => {
    const dm = diMinus[i];
    return (dp + dm) ? 100 * Math.abs(dp - dm) / (dp + dm) : 0;
  });

  // ADX = Wilder's EMA of DX (true average, not sum)
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;

  return {
    adx: adxVal,
    diPlus:  diPlus[diPlus.length - 1],
    diMinus: diMinus[diMinus.length - 1],
  };
}

// ── Layer 2: EMA Ribbon ───────────────────────────────────────────────────────

function calcRibbonBias(closes) {
  const periods = [8, 13, 21, 34, 55];
  const emas = periods.map(p => ema(closes, p));
  if (emas.some(e => e === null)) return "neutral";
  const bullish = emas.every((v, i) => i === 0 || emas[i - 1] > v); // 8>13>21>34>55
  const bearish = emas.every((v, i) => i === 0 || emas[i - 1] < v); // 8<13<21<34<55
  return bullish ? "bullish" : bearish ? "bearish" : "neutral";
}

// ── Layer 3: TTM Squeeze ──────────────────────────────────────────────────────

function calcTTMSqueeze(candles, bbPeriod = 20, bbMult = 2.0, kcMult = 1.5) {
  if (candles.length < bbPeriod + 3) return null;

  function squeezeState(bars) {
    const c = bars.map(b => b.close);
    const mean = c.reduce((a, b) => a + b) / c.length;
    const sd = Math.sqrt(c.reduce((s, v) => s + (v - mean) ** 2, 0) / c.length);

    const bbUpper = mean + bbMult * sd;
    const bbLower = mean - bbMult * sd;

    let atrSum = 0;
    for (let i = 1; i < bars.length; i++) {
      atrSum += Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low  - bars[i - 1].close)
      );
    }
    const atr = atrSum / (bars.length - 1);
    const emaVal = ema(c, c.length) ?? mean;
    const kcUpper = emaVal + kcMult * atr;
    const kcLower = emaVal - kcMult * atr;

    return bbUpper < kcUpper && bbLower > kcLower;
  }

  function momentum(bars) {
    const c = bars.map(b => b.close);
    const h = bars.map(b => b.high);
    const l = bars.map(b => b.low);
    const rangeMid = (Math.max(...h) + Math.min(...l)) / 2;
    const bbMid = c.reduce((a, b) => a + b) / c.length;
    return c[c.length - 1] - (rangeMid + bbMid) / 2;
  }

  const curr = candles.slice(-bbPeriod);
  const prev = candles.slice(-bbPeriod - 1, -1);

  const squeezeOn   = squeezeState(curr);
  const prevSqueezeOn = squeezeState(prev);
  const squeezeFired  = prevSqueezeOn && !squeezeOn;

  const mom     = momentum(curr);
  const prevMom = momentum(prev);

  return {
    squeezeOn,
    squeezeFired,
    momentum: mom,
    momentumRising:  mom > prevMom,
    momentumFalling: mom < prevMom,
  };
}

// ── Layer 4: Stochastic RSI ───────────────────────────────────────────────────

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const minNeeded = rsiPeriod + stochPeriod + kPeriod + dPeriod + 5;
  if (closes.length < minNeeded) return null;

  // RSI series via Wilder's
  const rsi = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= rsiPeriod;
  avgLoss /= rsiPeriod;

  for (let i = rsiPeriod + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (rsiPeriod - 1) + Math.max(d, 0)) / rsiPeriod;
    avgLoss = (avgLoss * (rsiPeriod - 1) + Math.max(-d, 0)) / rsiPeriod;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  // Stochastic of RSI values
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsi.length; i++) {
    const slice = rsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...slice), hi = Math.max(...slice);
    rawK.push(hi === lo ? 50 : (rsi[i] - lo) / (hi - lo) * 100);
  }

  // SMA-smooth K → D
  function smooth(arr, p) {
    const out = [];
    for (let i = p - 1; i < arr.length; i++) {
      out.push(arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b) / p);
    }
    return out;
  }

  const kArr = smooth(rawK, kPeriod);
  const dArr = smooth(kArr, dPeriod);

  return {
    k:     kArr[kArr.length - 1],
    d:     dArr[dArr.length - 1],
    prevK: kArr[kArr.length - 2],
    prevD: dArr[dArr.length - 2],
  };
}

// ── Fair Value Gaps (confluence) ──────────────────────────────────────────────

function findNearestFVG(candles, price) {
  const bars = candles.slice(-100);
  let nearBull = null, nearBear = null;
  let minBull = Infinity, minBear = Infinity;

  for (let i = 2; i < bars.length - 1; i++) {
    if (bars[i].low > bars[i - 2].high) {
      const mid = (bars[i].low + bars[i - 2].high) / 2;
      const dist = Math.abs(price - mid);
      if (dist < minBull) { minBull = dist; nearBull = { low: bars[i - 2].high, high: bars[i].low }; }
    }
    if (bars[i].high < bars[i - 2].low) {
      const mid = (bars[i].high + bars[i - 2].low) / 2;
      const dist = Math.abs(price - mid);
      if (dist < minBear) { minBear = dist; nearBear = { low: bars[i].high, high: bars[i - 2].low }; }
    }
  }

  return { nearBull, nearBear };
}

// ── Layer 5: Volume ───────────────────────────────────────────────────────────

function calcVolumeRatio(candles, period = 20) {
  const vols = candles.map(c => c.volume);
  const avg = vols.slice(-period - 1, -1).reduce((a, b) => a + b) / period;
  return avg > 0 ? vols[vols.length - 1] / avg : 0;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";
const CSV_HEADERS = ["Date","Time (UTC)","Symbol","Side","Qty","Price","USD","Fee","Net","OrderID","Mode","Notes"].join(",");

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function writeTradeCsv(entry) {
  const now = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const qty  = entry.tradeSize ? (entry.tradeSize / entry.price).toFixed(6) : "";
  const fee  = entry.tradeSize ? (entry.tradeSize * 0.001).toFixed(4) : "";
  const net  = entry.tradeSize ? (entry.tradeSize - parseFloat(fee || 0)).toFixed(2) : "";
  const mode = !entry.allPass ? "BLOCKED" : entry.paperTrading ? "PAPER" : "LIVE";
  const notes = !entry.allPass
    ? entry.conditions.filter(c => !c.pass).map(c => `L${c.layer} fail`).join("; ")
    : "All 5 layers aligned";

  const row = [
    date, time, entry.symbol,
    entry.allPass ? "BUY" : "",
    qty,
    entry.price?.toFixed(4) ?? "",
    entry.tradeSize?.toFixed(2) ?? "",
    fee, net,
    entry.orderId ?? (entry.allPass ? "" : "BLOCKED"),
    mode,
    `"${notes}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Exchange Execution ───────────────────────────────────────────────────────

function signRequest(timestamp, method, path, body = "") {
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`)
    .digest("base64");
}

async function placeOrder(symbol, side, sizeUSD, price) {
  const qty = (sizeUSD / price).toFixed(6);
  const ts  = Date.now().toString();
  const path = "/api/v2/spot/trade/placeOrder";
  const body = JSON.stringify({ symbol, side, orderType: "market", quantity: qty });
  const sig  = signRequest(ts, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`Order failed: ${data.msg}`);
  return data.data;
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

async function postWebhook(entry) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });
  } catch (_) {}
}

// ─── Per-Symbol Run ───────────────────────────────────────────────────────────

async function runForSymbol(symbol, log) {
  console.log(`\n${"═".repeat(59)}`);
  console.log(`  ${symbol} | ${CONFIG.timeframe} | ${new Date().toISOString()}`);
  console.log(`${"═".repeat(59)}`);

  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes  = candles.map(c => c.close).filter(n => typeof n === "number" && !isNaN(n));

  console.log(`  Candles: ${closes.length}`);

  if (closes.length < 100) {
    console.log(`\n⚠️  Insufficient data (${closes.length} candles). Need 100+. Skipping.`);
    return;
  }

  const price = closes[closes.length - 1];

  // ── Calculate all 5 layers ───────────────────────────────────────────────
  const adxData   = calcADX(candles, 14);
  const ribbon    = calcRibbonBias(closes);
  const squeeze   = calcTTMSqueeze(candles);
  const stochRSI  = calcStochRSI(closes);
  const volRatio  = calcVolumeRatio(candles);
  const { nearBull, nearBear } = findNearestFVG(candles, price);

  // ── Print readings ───────────────────────────────────────────────────────
  console.log(`\n── Indicator Readings ───────────────────────────────────\n`);
  console.log(`  Price:       $${price.toFixed(4)}`);
  console.log(`  ADX:         ${adxData ? adxData.adx.toFixed(1) : "N/A"}`);
  console.log(`  DI+:         ${adxData ? adxData.diPlus.toFixed(1) : "N/A"}`);
  console.log(`  DI-:         ${adxData ? adxData.diMinus.toFixed(1) : "N/A"}`);
  console.log(`  Ribbon:      ${ribbon}`);
  if (squeeze) {
    const sqState = squeeze.squeezeOn ? "🔴 ON (compressed)" : squeeze.squeezeFired ? "🟢 FIRED" : "⚪ off";
    console.log(`  Squeeze:     ${sqState}`);
    console.log(`  Momentum:    ${squeeze.momentum > 0 ? "+" : ""}${squeeze.momentum.toFixed(3)} ${squeeze.momentumRising ? "↑" : "↓"}`);
  } else {
    console.log(`  Squeeze:     N/A`);
  }
  console.log(`  StochRSI K:  ${stochRSI ? stochRSI.k.toFixed(1) : "N/A"}`);
  console.log(`  StochRSI D:  ${stochRSI ? stochRSI.d.toFixed(1) : "N/A"}`);
  console.log(`  Volume:      ${volRatio.toFixed(2)}x avg`);
  if (nearBull) console.log(`  Bull FVG:    $${nearBull.low.toFixed(4)} – $${nearBull.high.toFixed(4)}`);
  if (nearBear) console.log(`  Bear FVG:    $${nearBear.low.toFixed(4)} – $${nearBear.high.toFixed(4)}`);

  // ── Determine Bias ───────────────────────────────────────────────────────
  const bullBias = ribbon === "bullish" && adxData?.diPlus > adxData?.diMinus;
  const bearBias = ribbon === "bearish" && adxData?.diMinus > adxData?.diPlus;
  const bias     = bullBias ? "BULLISH" : bearBias ? "BEARISH" : "NEUTRAL";

  console.log(`\n  Bias: ${bias}`);

  if (bias === "NEUTRAL") {
    console.log("\n  No directional alignment — no trade.\n");
    return;
  }

  // ── 5-Layer Check ────────────────────────────────────────────────────────
  console.log(`\n── Market Sentinel — 5 Layers (${bias}) ────────────────────\n`);

  const conditions = [];

  function check(layer, label, required, actual, pass) {
    conditions.push({ layer, label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} Layer ${layer}: ${label}`);
    console.log(`     Req: ${required}  |  Got: ${actual}`);
  }

  if (bullBias) {
    // Layer 1
    check(1, "ADX — Trending Market",
      "> 25",
      adxData ? adxData.adx.toFixed(1) : "N/A",
      !!(adxData && adxData.adx > 25));

    // Layer 2
    check(2, "DI+ > DI- (Bullish Pressure)",
      "DI+ > DI-",
      adxData ? `DI+ ${adxData.diPlus.toFixed(1)} / DI- ${adxData.diMinus.toFixed(1)}` : "N/A",
      !!(adxData && adxData.diPlus > adxData.diMinus));

    // Layer 3
    const momPass = !!(squeeze && squeeze.momentum > 0 && squeeze.momentumRising);
    check(3, "TTM Momentum — Bullish",
      "Momentum > 0 and rising",
      squeeze ? `${squeeze.momentum > 0 ? "+" : ""}${squeeze.momentum.toFixed(3)} ${squeeze.momentumRising ? "↑" : "↓"}` : "N/A",
      momPass);

    // Layer 4
    const kCrossUp   = !!(stochRSI && stochRSI.k > stochRSI.d && stochRSI.prevK <= stochRSI.prevD);
    const kOversold  = !!(stochRSI && stochRSI.k < 30);
    const kTurningUp = !!(stochRSI && stochRSI.k > stochRSI.prevK && stochRSI.k < 50);
    check(4, "StochRSI — Pullback Entry",
      "K<30, or K crossing D above, or K turning up <50",
      stochRSI ? `K ${stochRSI.k.toFixed(1)} / D ${stochRSI.d.toFixed(1)}` : "N/A",
      kCrossUp || kOversold || kTurningUp);

    // Layer 5
    check(5, "Volume — Institutional Participation",
      "> 1.5x avg",
      `${volRatio.toFixed(2)}x`,
      volRatio > 1.5);

  } else {
    // bearish mirror
    check(1, "ADX — Trending Market",
      "> 25",
      adxData ? adxData.adx.toFixed(1) : "N/A",
      !!(adxData && adxData.adx > 25));

    check(2, "DI- > DI+ (Bearish Pressure)",
      "DI- > DI+",
      adxData ? `DI- ${adxData.diMinus.toFixed(1)} / DI+ ${adxData.diPlus.toFixed(1)}` : "N/A",
      !!(adxData && adxData.diMinus > adxData.diPlus));

    const momPass = !!(squeeze && squeeze.momentum < 0 && squeeze.momentumFalling);
    check(3, "TTM Momentum — Bearish",
      "Momentum < 0 and falling",
      squeeze ? `${squeeze.momentum.toFixed(3)} ${squeeze.momentumFalling ? "↓" : "↑"}` : "N/A",
      momPass);

    const kCrossDown    = !!(stochRSI && stochRSI.k < stochRSI.d && stochRSI.prevK >= stochRSI.prevD);
    const kOverbought   = !!(stochRSI && stochRSI.k > 70);
    const kTurningDown  = !!(stochRSI && stochRSI.k < stochRSI.prevK && stochRSI.k > 50);
    check(4, "StochRSI — Pullback Entry",
      "K>70, or K crossing D below, or K turning down >50",
      stochRSI ? `K ${stochRSI.k.toFixed(1)} / D ${stochRSI.d.toFixed(1)}` : "N/A",
      kCrossDown || kOverbought || kTurningDown);

    check(5, "Volume — Institutional Participation",
      "> 1.5x avg",
      `${volRatio.toFixed(2)}x`,
      volRatio > 1.5);
  }

  const allPass = conditions.every(c => c.pass);
  const tradeSize = CONFIG.maxTradeSizeUSD;

  // ── Decision ─────────────────────────────────────────────────────────────
  console.log(`\n── Decision ─────────────────────────────────────────────\n`);

  const logEntry = {
    timestamp:   new Date().toISOString(),
    symbol,
    timeframe:   CONFIG.timeframe,
    bias,
    price,
    indicators:  {
      adx:          adxData?.adx,
      diPlus:       adxData?.diPlus,
      diMinus:      adxData?.diMinus,
      ribbon,
      squeezeOn:    squeeze?.squeezeOn,
      squeezeFired: squeeze?.squeezeFired,
      momentum:     squeeze?.momentum,
      stochK:       stochRSI?.k,
      stochD:       stochRSI?.d,
      volumeRatio:  volRatio,
    },
    conditions,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId:     null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = conditions.filter(c => !c.pass).map(c => `Layer ${c.layer} (${c.label})`);
    console.log(`🚫 TRADE BLOCKED — ${failed.length} layer(s) failed:`);
    failed.forEach(f => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL 5 LAYERS ALIGNED`);
    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — ${bias} $${tradeSize.toFixed(2)} ${symbol} at $${price.toFixed(4)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — ${bias} $${tradeSize.toFixed(2)} ${symbol}`);
      try {
        const order = await placeOrder(symbol, "buy", tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  writeTradeCsv(logEntry);
  await postWebhook(logEntry);
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length && !process.env.RAILWAY_ENVIRONMENT) {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}\nAdd to .env (local) or Railway Variables (cloud).\n`);
    process.exit(0);
  }

  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Market Sentinel — 5-Layer Institutional Entry Framework");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:    ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log(`  Symbols: ${CONFIG.symbols.join(", ")}`);
  console.log(`  TF:      ${CONFIG.timeframe}`);
  console.log("═══════════════════════════════════════════════════════════");

  const log = loadLog();

  const todayCount = countTodaysTrades(log);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`\n🚫 Daily trade limit reached (${todayCount}/${CONFIG.maxTradesPerDay}). Done for today.`);
    return;
  }
  console.log(`\n  Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);

  for (const symbol of CONFIG.symbols) {
    await runForSymbol(symbol, log);
  }

  saveLog(log);
  console.log(`\nLog saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Bot error:", err); process.exit(1); });
