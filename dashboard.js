import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");
const LOG_PATH = path.join(__dirname, "safety-check-log.json");
const TRADES_PATH = path.join(__dirname, "trades.csv");

const app = express();
app.use(express.json());

// ─── Read .env into key/value object ─────────────────────────────────────────
function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter(l => l.includes("=") && !l.trim().startsWith("#"))
      .map(l => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).split("#")[0].trim()];
      })
  );
}

// ─── Write updated values back into .env ─────────────────────────────────────
function writeEnv(updates) {
  let content = fs.readFileSync(ENV_PATH, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^(${key}=).*`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `$1${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  fs.writeFileSync(ENV_PATH, content);
}

// ─── API: get current settings ───────────────────────────────────────────────
app.get("/api/settings", (req, res) => {
  // On Railway, .env doesn't exist — read from injected env vars directly
  const env = fs.existsSync(ENV_PATH) ? readEnv() : {};
  const symbolsRaw = env.SYMBOLS || process.env.SYMBOLS || env.SYMBOL || process.env.SYMBOL || "HYPEUSDT";
  res.json({
    symbols: symbolsRaw.split(",").map(s => s.trim()).filter(Boolean),
    timeframe: env.TIMEFRAME || process.env.TIMEFRAME || "1H",
    portfolioValue: env.PORTFOLIO_VALUE_USD || process.env.PORTFOLIO_VALUE_USD || "500",
    maxTradeSize: env.MAX_TRADE_SIZE_USD || process.env.MAX_TRADE_SIZE_USD || "100",
    maxTradesPerDay: env.MAX_TRADES_PER_DAY || process.env.MAX_TRADES_PER_DAY || "1000",
    paperTrading: (env.PAPER_TRADING || process.env.PAPER_TRADING) !== "false",
    cloudMode: !fs.existsSync(ENV_PATH),
  });
});

// ─── Railway API — update bot service variables ───────────────────────────────
async function updateRailwayVars(updates) {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_BOT_SERVICE_ID || "23bfdd71-ffc4-423a-af14-eb1e42234c41";
  const projectId = process.env.RAILWAY_PROJECT_ID || "28e67e75-d6d1-4501-8e29-d6ec68969699";
  if (!token) return { success: false, reason: "No RAILWAY_TOKEN set" };

  // Build variables upsert array
  const variables = Object.entries(updates).map(([name, value]) => ({ name, value }));

  const query = `
    mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;
  const input = {
    projectId,
    serviceId,
    environmentId: process.env.RAILWAY_BOT_ENVIRONMENT_ID || "",
    variables: Object.fromEntries(Object.entries(updates)),
  };

  try {
    const r = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { input } }),
    });
    const json = await r.json();
    if (json.errors) return { success: false, reason: json.errors[0].message };
    return { success: true };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

// ─── API: save settings ──────────────────────────────────────────────────────
app.post("/api/settings", async (req, res) => {
  const { symbols, timeframe, portfolioValue, maxTradeSize, maxTradesPerDay, paperTrading } = req.body;
  const updates = {
    SYMBOLS: Array.isArray(symbols) ? symbols.join(",") : symbols,
    TIMEFRAME: timeframe,
    PORTFOLIO_VALUE_USD: portfolioValue,
    MAX_TRADE_SIZE_USD: maxTradeSize,
    MAX_TRADES_PER_DAY: maxTradesPerDay,
    PAPER_TRADING: paperTrading ? "true" : "false",
  };

  // Save to local .env
  if (fs.existsSync(ENV_PATH)) writeEnv(updates);

  // Push to Railway bot service if token is available
  const railwayResult = await updateRailwayVars(updates);

  res.json({
    success: true,
    railway: railwayResult,
  });
});

// ─── Webhook — receive results from Railway bot ──────────────────────────────
let remoteRuns = [];

app.post("/api/webhook", (req, res) => {
  const entry = req.body;
  if (entry && entry.timestamp) {
    remoteRuns.unshift(entry); // newest first
    if (remoteRuns.length > 100) remoteRuns.pop(); // cap at 100
  }
  res.json({ received: true });
});

app.get("/api/remote-runs", (req, res) => {
  res.json(remoteRuns.slice(0, 20));
});

// ─── API: run bot now ─────────────────────────────────────────────────────────
let botOutput = [];
let botRunning = false;

app.post("/api/run", (req, res) => {
  if (botRunning) return res.json({ success: false, message: "Bot already running" });
  botOutput = [];
  botRunning = true;
  const child = spawn("node", ["bot.js"], { cwd: __dirname });
  child.stdout.on("data", d => botOutput.push(d.toString()));
  child.stderr.on("data", d => botOutput.push(d.toString()));
  child.on("close", () => { botRunning = false; });
  res.json({ success: true });
});

app.get("/api/run/status", (req, res) => {
  res.json({ running: botRunning, output: botOutput.join("") });
});

// ─── API: last few trades ─────────────────────────────────────────────────────
app.get("/api/trades", (req, res) => {
  if (!fs.existsSync(TRADES_PATH)) return res.json([]);
  const lines = fs.readFileSync(TRADES_PATH, "utf8").trim().split("\n");
  const header = lines[0];
  const keys = header.split(",");
  const rows = lines.slice(-11, -1).reverse().map(l =>
    Object.fromEntries(l.split(",").map((v, i) => [keys[i], v]))
  );
  res.json(rows);
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 900px; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #1e2130; border: 1px solid #2d3148; border-radius: 12px; padding: 24px; }
  .card h2 { font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 20px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  .field input, .field select { width: 100%; background: #0f1117; border: 1px solid #2d3148; border-radius: 8px; padding: 10px 12px; color: #e2e8f0; font-size: 14px; outline: none; transition: border-color 0.2s; }
  .field input:focus, .field select:focus { border-color: #6366f1; }
  .field select option { background: #1e2130; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; }
  .toggle-row span { font-size: 14px; color: #e2e8f0; }
  .toggle { position: relative; width: 44px; height: 24px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; inset: 0; background: #374151; border-radius: 24px; cursor: pointer; transition: 0.2s; }
  .slider:before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: 0.2s; }
  input:checked + .slider { background: #6366f1; }
  input:checked + .slider:before { transform: translateX(20px); }
  .btn { width: 100%; padding: 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
  .btn-primary { background: #6366f1; color: white; }
  .btn-primary:hover { background: #5254cc; }
  .btn-run { background: #059669; color: white; margin-top: 12px; }
  .btn-run:hover { background: #047857; }
  .btn-run:disabled { background: #374151; color: #64748b; cursor: not-allowed; }
  .status { font-size: 12px; color: #10b981; margin-top: 8px; min-height: 18px; }
  .status.error { color: #f87171; }
  .output { background: #0f1117; border: 1px solid #2d3148; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11px; color: #94a3b8; height: 380px; overflow-y: auto; white-space: pre-wrap; margin-top: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge-paper { background: #1e3a5f; color: #60a5fa; }
  .badge-live { background: #1a2e1a; color: #4ade80; }
  .badge-blocked { background: #2d1a1a; color: #f87171; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { color: #64748b; font-weight: 500; text-align: left; padding: 6px 8px; border-bottom: 1px solid #2d3148; }
  td { padding: 8px; border-bottom: 1px solid #1a1f35; color: #cbd5e1; }
  tr:last-child td { border-bottom: none; }
  .full-width { grid-column: 1 / -1; }
</style>
</head>
<body>
<h1>Trading Bot Dashboard</h1>
<p class="subtitle">Market Sentinel — HYPE perpetual strategy</p>

<div class="grid">

  <!-- Settings -->
  <div class="card">
    <h2>Bot Settings</h2>
    <div class="field">
      <label>Symbols (coins to trade)</label>
      <div id="symbolTags" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px">
        <input type="text" id="symbolInput" placeholder="e.g. BTCUSDT" style="flex:1" onkeydown="if(event.key==='Enter'){addSymbol();event.preventDefault()}">
        <button onclick="addSymbol()" style="background:#6366f1;color:white;border:none;border-radius:8px;padding:10px 14px;cursor:pointer;font-size:13px;font-weight:600">Add</button>
      </div>
    </div>
    <div class="field">
      <label>Timeframe</label>
      <select id="timeframe">
        <option value="1m">1 minute</option>
        <option value="5m">5 minutes</option>
        <option value="15m">15 minutes</option>
        <option value="30m">30 minutes</option>
        <option value="1H">1 hour</option>
        <option value="4H">4 hours</option>
        <option value="1D">1 day</option>
      </select>
    </div>
    <div class="field">
      <label>Portfolio Value (USD)</label>
      <input type="number" id="portfolioValue" placeholder="e.g. 500">
    </div>
    <div class="field">
      <label>Max Trade Size (USD)</label>
      <input type="number" id="maxTradeSize" placeholder="e.g. 100">
    </div>
    <div class="field">
      <label>Max Trades Per Day</label>
      <input type="number" id="maxTradesPerDay" placeholder="e.g. 1000">
    </div>
    <div class="toggle-row">
      <span>Paper Trading</span>
      <label class="toggle">
        <input type="checkbox" id="paperTrading">
        <span class="slider"></span>
      </label>
    </div>
    <button class="btn btn-primary" onclick="saveSettings()" style="margin-top:16px">Save Settings</button>
    <div class="status" id="saveStatus"></div>
  </div>

  <!-- Run Bot -->
  <div class="card full-width">
    <h2>Run Bot</h2>
    <p style="font-size:13px;color:#64748b;margin-bottom:16px;line-height:1.6">
      Manually trigger a bot run. It will fetch live data, check all strategy conditions, and log the decision.
    </p>
    <button class="btn btn-run" id="runBtn" onclick="runBot()" style="max-width:200px">▶ Run Now</button>
    <div class="status" id="runStatus"></div>
    <div class="output" id="runOutput">Waiting for run...</div>
  </div>

  <!-- Recent Trades -->
  <div class="card full-width">
    <h2>Recent Decisions (Local)</h2>
    <div id="tradesTable">
      <p style="color:#64748b;font-size:13px">No trades logged yet.</p>
    </div>
  </div>

  <!-- Railway Runs -->
  <div class="card full-width">
    <h2>Railway Runs <span style="font-size:11px;color:#64748b;font-weight:400;margin-left:8px">live from cloud — updates each hour</span></h2>
    <div id="remoteRuns">
      <p style="color:#64748b;font-size:13px">No Railway runs received yet. Set WEBHOOK_URL in Railway Variables to enable.</p>
    </div>
  </div>

</div>

<script>
let currentSymbols = [];

function renderTags() {
  const container = document.getElementById('symbolTags');
  container.innerHTML = currentSymbols.map((s, i) =>
    '<span style="background:#1a1f35;border:1px solid #6366f1;border-radius:20px;padding:4px 10px;font-size:12px;color:#a5b4fc;display:flex;align-items:center;gap:6px">' +
    s + '<span onclick="removeSymbol(' + i + ')" style="cursor:pointer;color:#64748b;font-size:14px;line-height:1">×</span></span>'
  ).join('');
}

function addSymbol() {
  const input = document.getElementById('symbolInput');
  const val = input.value.trim().toUpperCase();
  if (val && !currentSymbols.includes(val)) {
    currentSymbols.push(val);
    renderTags();
  }
  input.value = '';
}

function removeSymbol(i) {
  currentSymbols.splice(i, 1);
  renderTags();
}

async function loadSettings() {
  const r = await fetch('/api/settings');
  const s = await r.json();
  currentSymbols = s.symbols || ['HYPEUSDT'];
  renderTags();
  document.getElementById('timeframe').value = s.timeframe;
  document.getElementById('portfolioValue').value = s.portfolioValue;
  document.getElementById('maxTradeSize').value = s.maxTradeSize;
  document.getElementById('maxTradesPerDay').value = s.maxTradesPerDay;
  document.getElementById('paperTrading').checked = s.paperTrading;
}

async function saveSettings() {
  const btn = event.target;
  btn.textContent = 'Saving...';
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbols: currentSymbols,
      timeframe: document.getElementById('timeframe').value,
      portfolioValue: document.getElementById('portfolioValue').value,
      maxTradeSize: document.getElementById('maxTradeSize').value,
      maxTradesPerDay: document.getElementById('maxTradesPerDay').value,
      paperTrading: document.getElementById('paperTrading').checked,
    })
  });
  const s = document.getElementById('saveStatus');
  const data = await r.json();
  btn.textContent = 'Save Settings';
  if (data.success) {
    if (data.railway?.success) {
      s.textContent = '✓ Saved locally + synced to Railway';
    } else if (data.railway?.reason) {
      s.textContent = '✓ Saved locally — Railway sync failed: ' + data.railway.reason;
      s.className = 'status error';
    } else {
      s.textContent = '✓ Settings saved';
    }
    setTimeout(() => { s.textContent = ''; s.className = 'status'; }, 4000);
  }
}

let polling;
async function runBot() {
  const btn = document.getElementById('runBtn');
  const status = document.getElementById('runStatus');
  const output = document.getElementById('runOutput');
  btn.disabled = true;
  btn.textContent = '⏳ Running...';
  output.style.display = 'block';
  output.textContent = 'Starting bot...';
  await fetch('/api/run', { method: 'POST' });
  polling = setInterval(async () => {
    const r = await fetch('/api/run/status');
    const d = await r.json();
    output.textContent = d.output || 'Waiting for output...';
    output.scrollTop = output.scrollHeight;
    if (!d.running) {
      clearInterval(polling);
      btn.disabled = false;
      btn.textContent = '▶ Run Now';
      status.textContent = '✓ Run complete';
      setTimeout(() => status.textContent = '', 4000);
      loadTrades();
    }
  }, 500);
}

async function loadTrades() {
  const r = await fetch('/api/trades');
  const trades = await r.json();
  if (!trades.length) return;
  const cols = ['timestamp','symbol','side','decision','notes'];
  const table = document.getElementById('tradesTable');
  table.innerHTML = '<table><thead><tr>' +
    cols.map(c => '<th>' + c + '</th>').join('') +
    '</tr></thead><tbody>' +
    trades.map(t => '<tr>' + cols.map(c => '<td>' + (t[c] || '—') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>';
}

async function loadRemoteRuns() {
  const r = await fetch('/api/remote-runs');
  const runs = await r.json();
  const container = document.getElementById('remoteRuns');
  if (!runs.length) return;
  container.innerHTML = '<table><thead><tr>' +
    '<th>Time</th><th>Symbol</th><th>Price</th><th>EMA(8)</th><th>RSI(3)</th><th>Decision</th><th>Source</th>' +
    '</tr></thead><tbody>' +
    runs.map(r => {
      const time = new Date(r.timestamp).toLocaleTimeString();
      const date = new Date(r.timestamp).toLocaleDateString();
      const decision = r.allPass
        ? '<span class="badge badge-live">TRADE</span>'
        : '<span class="badge badge-blocked">BLOCKED</span>';
      const source = r.paperTrading
        ? '<span class="badge badge-paper">PAPER</span>'
        : '<span class="badge badge-live">LIVE</span>';
      return '<tr>' +
        '<td>' + date + ' ' + time + '</td>' +
        '<td>' + r.symbol + '</td>' +
        '<td>$' + (r.price || 0).toFixed(2) + '</td>' +
        '<td>$' + (r.indicators?.ema8 || 0).toFixed(2) + '</td>' +
        '<td>' + (r.indicators?.rsi3 || 0).toFixed(2) + '</td>' +
        '<td>' + decision + '</td>' +
        '<td>' + source + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table>';
}

// Poll remote runs every 60 seconds
loadRemoteRuns();
setInterval(loadRemoteRuns, 60000);

loadSettings();
loadTrades();
</script>
</body>
</html>`);
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Dashboard running at http://localhost:${PORT}\n`);
});
