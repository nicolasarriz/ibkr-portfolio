// IBKR Portfolio dashboard — vanilla JS + Chart.js
const COLORS = {
  text: "#e8ecf3",
  textDim: "#9aa3b2",
  textMute: "#6b7484",
  grid: "#1c2030",
  accent: "#6ea8ff",
  accent2: "#8b5cf6",
  green: "#2ecc71",
  red: "#ff5d5d",
};

const PALETTE = [
  "#6ea8ff", "#8b5cf6", "#2ecc71", "#f59e0b",
  "#ec4899", "#06b6d4", "#ef4444", "#a3e635",
  "#fb923c", "#14b8a6", "#f472b6", "#60a5fa",
];

// Minimum daily returns required before a time-series metric is shown
const MIN_RETURNS = 3;
const TRADING_DAYS = 252;
const DASH = "—";

const fmtPct = (v, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

const fmtIndex = (v, digits = 2) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "muted");
const sign = (v) => (v > 0 ? "+" : "");

// Map of ticker -> investment themes it contributes exposure to.
// Used to derive thematic exposure (% of book) the way IBKR PortfolioAnalyst groups holdings.
const THEME_MAP = {
  GOOGL: ["Artificial Intelligence", "Generative AI & LLMs", "Mega-Cap Tech"],
  GOOG: ["Artificial Intelligence", "Generative AI & LLMs", "Mega-Cap Tech"],
  NVDA: ["Artificial Intelligence", "Semiconductors", "AI Inference"],
  AMD: ["Artificial Intelligence", "Semiconductors", "AI Inference"],
  PLTR: ["Artificial Intelligence", "Generative AI & LLMs", "Cloud & Software"],
  MSFT: ["Artificial Intelligence", "Generative AI & LLMs", "Cloud & Software", "Mega-Cap Tech"],
  AAPL: ["Mega-Cap Tech"],
  META: ["Artificial Intelligence", "Mega-Cap Tech"],
  AMZN: ["Artificial Intelligence", "Cloud & Software", "Mega-Cap Tech"],
  SMH: ["Semiconductors", "AI Inference", "Artificial Intelligence"],
  SOXX: ["Semiconductors", "AI Inference", "Artificial Intelligence"],
  IGM: ["Cloud & Software", "Artificial Intelligence"],
  XLK: ["Cloud & Software", "Artificial Intelligence"],
  MAGS: ["Mega-Cap Tech", "Artificial Intelligence", "Generative AI & LLMs"],
  QQQ: ["Broad US Equity", "Mega-Cap Tech", "Artificial Intelligence"],
  VOO: ["Broad US Equity"],
  SPY: ["Broad US Equity"],
  IVV: ["Broad US Equity"],
  VTI: ["Broad US Equity"],
  JPM: ["Financials"],
  BAC: ["Financials"],
  GS: ["Financials"],
  V: ["Financials", "Fintech"],
  MA: ["Financials", "Fintech"],
};

let state = {
  data: null,
  range: "YTD",
  fromDate: null,
  allocMode: "asset",
  sort: { key: "weight", dir: "desc" },
  charts: {},
};

async function loadData() {
  try {
    const res = await fetch(`data/portfolio.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error("Failed to load portfolio data:", err);
    document.getElementById("last-updated").textContent = "Error loading data";
    document.getElementById("holdings-body").innerHTML =
      `<tr><td colspan="6" class="muted center">Unable to load portfolio data. Check that data/portfolio.json exists.</td></tr>`;
    return;
  }
  render();
}

function render() {
  const d = state.data;
  if (!d) return;

  const updated = new Date(d.lastUpdated || Date.now());
  document.getElementById("last-updated").textContent =
    "Updated " + updated.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  // Bound the from-date input to available equity data
  const fromInput = document.getElementById("from-date");
  if (d.equity?.length) {
    fromInput.min = d.equity[0].date;
    fromInput.max = d.equity[d.equity.length - 1].date;
  }

  renderKPIs(d);
  renderEquityChart();
  renderAllocChart();
  renderChangeInIndex(d);
  renderRiskMeasures(d);
  renderThemes(d);
  renderHoldings();
  renderMovers(d);
  renderMonthlyChart(d.monthly || []);
}

function renderKPIs(d) {
  const idxEl = document.getElementById("kpi-index");
  idxEl.textContent = fmtIndex(d.index ?? 100, 1);

  const totalEl = document.getElementById("kpi-total");
  totalEl.textContent = fmtPct(d.totalReturnPct);
  totalEl.className = "kpi-value " + cls(d.totalReturnPct);

  const dayEl = document.getElementById("kpi-day");
  dayEl.textContent = fmtPct(d.dayReturnPct);
  dayEl.className = "kpi-value " + cls(d.dayReturnPct);

  const ytdEl = document.getElementById("kpi-ytd");
  ytdEl.textContent = fmtPct(d.ytdReturnPct);
  ytdEl.className = "kpi-value " + cls(d.ytdReturnPct);
}

// ---- Daily returns + risk math (from the index series) ------------------
function dailyReturns(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].index;
    if (prev) out.push(equity[i].index / prev - 1);
  }
  return out;
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function stddev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

function maxDrawdown(equity) {
  let peak = -Infinity, mdd = 0;
  for (const p of equity) {
    if (p.index > peak) peak = p.index;
    if (peak > 0) mdd = Math.max(mdd, (peak - p.index) / peak);
  }
  return mdd; // positive fraction
}

function computeRisk(equity) {
  const r = dailyReturns(equity || []);
  if (r.length < MIN_RETURNS) return { ready: false, n: r.length };
  const m = mean(r);
  const sd = stddev(r);
  const downsideDev = Math.sqrt(r.map((x) => Math.min(x, 0) ** 2).reduce((a, b) => a + b, 0) / r.length);
  const vol = sd * Math.sqrt(TRADING_DAYS);
  const annRet = m * TRADING_DAYS;
  const posDays = (r.filter((x) => x > 0).length / r.length) * 100;
  return {
    ready: true,
    n: r.length,
    sharpe: sd ? annRet / vol : null,
    sortino: downsideDev ? annRet / (downsideDev * Math.sqrt(TRADING_DAYS)) : null,
    volatility: vol * 100,
    downsideDev: downsideDev * Math.sqrt(TRADING_DAYS) * 100,
    maxDrawdown: -maxDrawdown(equity) * 100,
    posDays,
  };
}

// Beta vs benchmark from aligned daily returns: cov(p,b) / var(b)
function computeBeta(equity, benchmark) {
  if (!benchmark?.length) return null;
  const bMap = new Map(benchmark.map((p) => [p.date, p.index]));
  const pts = (equity || []).filter((p) => bMap.has(p.date));
  if (pts.length < MIN_RETURNS + 1) return null;
  const pr = [], br = [];
  for (let i = 1; i < pts.length; i++) {
    const pp = pts[i - 1].index, pc = pts[i].index;
    const bp = bMap.get(pts[i - 1].date), bc = bMap.get(pts[i].date);
    if (pp && bp) { pr.push(pc / pp - 1); br.push(bc / bp - 1); }
  }
  if (br.length < MIN_RETURNS) return null;
  const mp = mean(pr), mb = mean(br);
  let cov = 0, varb = 0;
  for (let i = 0; i < br.length; i++) {
    cov += (pr[i] - mp) * (br[i] - mb);
    varb += (br[i] - mb) ** 2;
  }
  return varb ? cov / varb : null;
}

function renderRiskMeasures(d) {
  const risk = computeRisk(d.equity || []);
  const note = document.getElementById("risk-note");
  const set = (id, val, klass) => {
    const el = document.getElementById(id);
    el.textContent = val;
    el.className = "stat-value" + (klass ? " " + klass : "");
  };

  if (!risk.ready) {
    note.textContent = `Building history · ${risk.n + 1} day${risk.n === 0 ? "" : "s"}`;
    ["risk-sharpe", "risk-sortino", "risk-vol", "risk-mdd", "risk-beta", "risk-dd"].forEach((id) => set(id, DASH));
    return;
  }
  note.textContent = `${risk.n} daily returns`;
  set("risk-sharpe", risk.sharpe == null ? DASH : risk.sharpe.toFixed(2), risk.sharpe == null ? "" : cls(risk.sharpe));
  set("risk-sortino", risk.sortino == null ? DASH : risk.sortino.toFixed(2), risk.sortino == null ? "" : cls(risk.sortino));
  set("risk-vol", `${risk.volatility.toFixed(1)}%`);
  set("risk-mdd", `${risk.maxDrawdown.toFixed(1)}%`, "neg");
  set("risk-dd", `${risk.downsideDev.toFixed(1)}%`);
  const beta = computeBeta(d.equity || [], d.benchmark || []);
  set("risk-beta", beta == null ? DASH : beta.toFixed(2));
}

// ---- Change in Index (anonymized "Change in NAV") -----------------------
function renderChangeInIndex(d) {
  const eq = d.equity || [];
  const periodEl = document.getElementById("nav-period");
  const set = (id, val, klass) => {
    const el = document.getElementById(id);
    el.textContent = val;
    el.className = "stat-value" + (klass ? " " + klass : "");
  };

  if (!eq.length) {
    periodEl.textContent = "";
    ["nav-begin", "nav-end", "nav-change", "nav-best", "nav-worst", "nav-pos"].forEach((id) => set(id, DASH));
    return;
  }

  const begin = eq[0].index;
  const end = eq[eq.length - 1].index;
  const changePct = begin ? (end / begin - 1) * 100 : 0;
  periodEl.textContent = `${eq[0].date} → ${eq[eq.length - 1].date}`;

  set("nav-begin", fmtIndex(begin, 1));
  set("nav-end", fmtIndex(end, 1));
  set("nav-change", fmtPct(changePct), eq.length > 1 ? cls(changePct) : "");

  const r = dailyReturns(eq);
  if (r.length) {
    set("nav-best", fmtPct(Math.max(...r) * 100), "pos");
    set("nav-worst", fmtPct(Math.min(...r) * 100), "neg");
    set("nav-pos", `${((r.filter((x) => x > 0).length / r.length) * 100).toFixed(0)}%`);
  } else {
    set("nav-best", DASH);
    set("nav-worst", DASH);
    set("nav-pos", DASH);
  }
}

// ---- Investment themes (exposure as % of book) --------------------------
function renderThemes(d) {
  const holdings = d.holdings || [];
  const map = new Map();
  for (const h of holdings) {
    const themes = THEME_MAP[h.symbol];
    if (!themes) continue;
    for (const t of themes) map.set(t, (map.get(t) || 0) + (h.weight || 0));
  }
  const arr = [...map.entries()]
    .map(([label, pct]) => ({ label, pct }))
    .sort((a, b) => b.pct - a.pct);

  const el = document.getElementById("themes-list");
  if (!arr.length) {
    el.innerHTML = `<div class="muted center pad">No mapped themes.</div>`;
    return;
  }
  const max = arr[0].pct || 1;
  el.innerHTML = arr.map((t) => `
    <div class="theme-row">
      <span class="theme-name">${t.label}</span>
      <span class="theme-bar"><span style="width:${(t.pct / max) * 100}%"></span></span>
      <span class="theme-pct">${t.pct.toFixed(1)}%</span>
    </div>
  `).join("");
}

function filterEquityByRange(equity, range, fromDate) {
  if (!equity?.length) return [];
  if (fromDate) {
    const from = new Date(fromDate);
    return equity.filter((p) => new Date(p.date) >= from);
  }
  if (range === "ALL") return equity;
  const last = new Date(equity[equity.length - 1].date);
  let from;
  if (range === "YTD") {
    from = new Date(last.getFullYear(), 0, 1);
  } else if (range === "1M") {
    from = new Date(last); from.setMonth(from.getMonth() - 1);
  } else if (range === "3M") {
    from = new Date(last); from.setMonth(from.getMonth() - 3);
  } else if (range === "6M") {
    from = new Date(last); from.setMonth(from.getMonth() - 6);
  } else {
    return equity;
  }
  return equity.filter((p) => new Date(p.date) >= from);
}

function renderEquityChart() {
  const data = filterEquityByRange(state.data.equity || [], state.range, state.fromDate);
  const ctx = document.getElementById("equityChart");
  if (state.charts.equity) state.charts.equity.destroy();

  const labels = data.map((p) => p.date);
  // Re-base to 100 at the start of the selected period (indexed performance)
  const base = data[0]?.index || 100;
  const values = data.map((p) => (base ? (p.index / base) * 100 : 100));
  const first = values[0] || 0;
  const last = values[values.length - 1] || 0;
  const up = last >= first;
  const lineColor = up ? COLORS.green : COLORS.red;

  const grad = ctx.getContext("2d").createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, up ? "rgba(46,204,113,0.25)" : "rgba(255,93,93,0.25)");
  grad.addColorStop(1, "rgba(46,204,113,0)");

  const datasets = [{
    label: "Portfolio",
    data: values,
    borderColor: lineColor,
    backgroundColor: grad,
    fill: true,
    tension: 0.25,
    pointRadius: data.length <= 2 ? 3 : 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: lineColor,
    pointHoverBorderColor: "#fff",
    borderWidth: 2,
    order: 1,
  }];

  // S&P 500 benchmark, aligned to the same dates and re-based to 100 at window start
  const benchAll = state.data.benchmark || [];
  if (benchAll.length) {
    const bMap = new Map(benchAll.map((p) => [p.date, p.index]));
    const winDates = data.map((p) => p.date).filter((d) => bMap.has(d));
    if (winDates.length) {
      const bBase = bMap.get(winDates[0]) || 100;
      const benchValues = labels.map((d) => (bMap.has(d) && bBase ? (bMap.get(d) / bBase) * 100 : null));
      datasets.push({
        label: "S&P 500",
        data: benchValues,
        borderColor: COLORS.textMute,
        borderDash: [5, 4],
        backgroundColor: "transparent",
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 1.5,
        spanGaps: true,
        order: 2,
      });
    }
  }

  state.charts.equity = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: chartOpts({
      yTitle: "Indexed to 100",
      yFormatter: (v) => fmtIndex(v, 0),
      xTimeAxis: true,
      legend: datasets.length > 1,
      tooltipLabel: (ctx) => {
        const ret = ctx.parsed.y - 100;
        return `${ctx.dataset.label}: ${fmtIndex(ctx.parsed.y, 2)} (${fmtPct(ret)})`;
      },
    }),
  });
}

function aggregateAlloc(holdings, mode) {
  const map = new Map();
  for (const h of holdings) {
    const key = (mode === "sector" ? h.sector : h.assetClass) || "Other";
    map.set(key, (map.get(key) || 0) + (h.weight || 0));
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  const arr = [...map.entries()]
    .map(([label, value]) => ({ label, value, pct: total ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
  return arr;
}

function renderAllocChart() {
  const agg = aggregateAlloc(state.data.holdings || [], state.allocMode);
  const ctx = document.getElementById("allocChart");
  if (state.charts.alloc) state.charts.alloc.destroy();

  state.charts.alloc = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: agg.map((a) => a.label),
      datasets: [{
        data: agg.map((a) => a.value),
        backgroundColor: agg.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: "#11141b",
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: COLORS.textDim, padding: 12, font: { size: 11 }, boxWidth: 10, boxHeight: 10 },
        },
        tooltip: {
          backgroundColor: "#0b0d12",
          borderColor: "#1f2430",
          borderWidth: 1,
          titleColor: COLORS.text,
          bodyColor: COLORS.text,
          padding: 10,
          callbacks: {
            label: (c) => {
              const v = c.parsed;
              const tot = c.dataset.data.reduce((a, b) => a + b, 0);
              const pct = tot ? (v / tot) * 100 : 0;
              return `${c.label}: ${pct.toFixed(1)}%`;
            },
          },
        },
      },
    },
  });
}

function renderHoldings() {
  const tbody = document.getElementById("holdings-body");
  const rows = [...(state.data.holdings || [])];

  rows.sort((a, b) => {
    const { key, dir } = state.sort;
    const av = a[key], bv = b[key];
    if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === "asc" ? av - bv : bv - av;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted center">No open positions.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((h) => `
    <tr>
      <td class="sym">${h.symbol}</td>
      <td class="name">${h.name || ""}</td>
      <td>${h.assetClass || ""}</td>
      <td class="muted">${h.sector || ""}</td>
      <td class="num ${cls(h.unrealizedPnlPct)}">${fmtPct(h.unrealizedPnlPct)}</td>
      <td class="num">${(h.weight ?? 0).toFixed(1)}%</td>
    </tr>
  `).join("");
}

function renderMonthlyChart(monthly) {
  const ctx = document.getElementById("monthlyChart");
  if (state.charts.monthly) state.charts.monthly.destroy();

  state.charts.monthly = new Chart(ctx, {
    type: "bar",
    data: {
      labels: monthly.map((m) => m.month),
      datasets: [{
        label: "Realized Return",
        data: monthly.map((m) => m.returnPct),
        backgroundColor: monthly.map((m) => (m.returnPct >= 0 ? "rgba(46,204,113,0.75)" : "rgba(255,93,93,0.75)")),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: chartOpts({
      yFormatter: (v) => `${v}%`,
      tooltipLabel: (ctx) => fmtPct(ctx.parsed.y),
    }),
  });
}

// ---- Portfolio movers: weight % and contribution-to-return (CTR) --------
// CTR_i = weight_i * unrealizedReturn_i (in percentage points). Sum ≈ total return.
function renderMovers(d) {
  const holdings = d.holdings || [];
  const rows = holdings.map((h) => ({
    symbol: h.symbol,
    weight: h.weight || 0,
    ctr: ((h.weight || 0) / 100) * (h.unrealizedPnlPct || 0),
  })).sort((a, b) => b.ctr - a.ctr);

  const top = rows.slice(0, 3);
  const bottom = rows.slice(-3).reverse();

  const rowHtml = (r) => `
    <div class="mover-row">
      <span class="mover-sym">${r.symbol}</span>
      <span class="num mover-wt">${r.weight.toFixed(2)}</span>
      <span class="num ${cls(r.ctr)}">${r.ctr >= 0 ? "+" : ""}${r.ctr.toFixed(2)}</span>
    </div>`;

  document.getElementById("movers-top").innerHTML = top.map(rowHtml).join("") || `<div class="muted pad">—</div>`;
  document.getElementById("movers-bottom").innerHTML = bottom.map(rowHtml).join("") || `<div class="muted pad">—</div>`;
}

function chartOpts({ yFormatter, yTitle, xTimeAxis = false, tooltipLabel, legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: legend
        ? { display: true, position: "top", align: "end",
            labels: { color: COLORS.textDim, boxWidth: 12, boxHeight: 2, font: { size: 11 }, padding: 14 } }
        : { display: false },
      tooltip: {
        backgroundColor: "#0b0d12",
        borderColor: "#1f2430",
        borderWidth: 1,
        titleColor: COLORS.text,
        bodyColor: COLORS.text,
        padding: 10,
        displayColors: false,
        callbacks: tooltipLabel ? { label: tooltipLabel } : {},
      },
    },
    scales: {
      x: {
        grid: { color: COLORS.grid, drawTicks: false },
        ticks: {
          color: COLORS.textMute,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: xTimeAxis ? 8 : 12,
          font: { size: 10 },
        },
        border: { display: false },
      },
      y: {
        grid: { color: COLORS.grid, drawTicks: false },
        title: yTitle
          ? { display: true, text: yTitle, color: COLORS.textMute, font: { size: 10 } }
          : { display: false },
        ticks: {
          color: COLORS.textMute,
          callback: (v) => (yFormatter ? yFormatter(v) : v),
          font: { size: 10 },
        },
        border: { display: false },
      },
    },
  };
}

// Range toggle (clears custom from-date)
document.getElementById("range-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-range]");
  if (!btn) return;
  state.range = btn.dataset.range;
  state.fromDate = null;
  document.getElementById("from-date").value = "";
  document.querySelectorAll("#range-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
  renderEquityChart();
});

// Custom from-date picker (overrides range buttons)
document.getElementById("from-date").addEventListener("change", (e) => {
  state.fromDate = e.target.value || null;
  if (state.fromDate) {
    document.querySelectorAll("#range-toggle button").forEach((b) => b.classList.remove("active"));
  } else {
    const activeBtn = document.querySelector(`#range-toggle button[data-range="${state.range}"]`);
    if (activeBtn) activeBtn.classList.add("active");
  }
  renderEquityChart();
});

// Alloc toggle
document.getElementById("alloc-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  state.allocMode = btn.dataset.mode;
  document.querySelectorAll("#alloc-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
  renderAllocChart();
});

// Table sort
document.querySelectorAll("#holdings-table thead th").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (!key) return;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.key = key;
      state.sort.dir = typeof state.data.holdings[0][key] === "string" ? "asc" : "desc";
    }
    renderHoldings();
  });
});

loadData();
