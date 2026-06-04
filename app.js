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

const fmtPct = (v, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

const fmtIndex = (v, digits = 2) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "muted");
const sign = (v) => (v > 0 ? "+" : "");

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
  renderRisk(d.risk || {});
  renderEquityChart();
  renderAllocChart();
  renderHoldings();
  renderMonthlyChart(d.monthly || []);
  renderMoversChart(d.holdings || []);
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

function renderRisk(r) {
  const mdd = document.getElementById("risk-mdd");
  mdd.textContent = r.maxDrawdownPct == null ? "N/A" : fmtPct(r.maxDrawdownPct);
  mdd.className = "kpi-value " + (r.maxDrawdownPct == null ? "muted" : cls(r.maxDrawdownPct));

  const vol = document.getElementById("risk-vol");
  vol.textContent = r.volatilityPct == null ? "N/A" : `${r.volatilityPct.toFixed(2)}%`;
  vol.className = "kpi-value" + (r.volatilityPct == null ? " muted" : "");

  const sharpe = document.getElementById("risk-sharpe");
  sharpe.textContent = r.sharpe == null ? "N/A" : r.sharpe.toFixed(2);
  sharpe.className = "kpi-value " + (r.sharpe == null ? "muted" : cls(r.sharpe));
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

  state.charts.equity = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Portfolio Index",
        data: values,
        borderColor: lineColor,
        backgroundColor: grad,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: lineColor,
        pointHoverBorderColor: "#fff",
        borderWidth: 2,
      }],
    },
    options: chartOpts({
      yTitle: "Portfolio Index",
      yFormatter: (v) => fmtIndex(v, 0),
      xTimeAxis: true,
      tooltipLabel: (ctx) => {
        const ret = ctx.parsed.y - 100;
        return `Index ${fmtIndex(ctx.parsed.y, 2)} (${fmtPct(ret)})`;
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

function renderMoversChart(holdings) {
  const ctx = document.getElementById("moversChart");
  if (state.charts.movers) state.charts.movers.destroy();

  const sorted = [...holdings].sort((a, b) => b.unrealizedPnlPct - a.unrealizedPnlPct);
  const top = sorted.slice(0, 5);
  const bot = sorted.slice(-5).reverse();
  const data = [...top, ...bot].filter((v, i, arr) => arr.findIndex((x) => x.symbol === v.symbol) === i);

  state.charts.movers = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.symbol),
      datasets: [{
        data: data.map((d) => d.unrealizedPnlPct),
        backgroundColor: data.map((d) => (d.unrealizedPnlPct >= 0 ? "rgba(46,204,113,0.75)" : "rgba(255,93,93,0.75)")),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b0d12",
          borderColor: "#1f2430",
          borderWidth: 1,
          titleColor: COLORS.text,
          bodyColor: COLORS.text,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (ctx) => {
              const h = data[ctx.dataIndex];
              return fmtPct(h.unrealizedPnlPct);
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: COLORS.grid, drawTicks: false },
          ticks: { color: COLORS.textMute, callback: (v) => `${v}%`, font: { size: 10 } },
          border: { display: false },
        },
        y: {
          grid: { display: false },
          ticks: {
            color: COLORS.text,
            font: { size: 11, family: "Inter", weight: "500" },
            padding: 4,
          },
          border: { display: false },
        },
      },
    },
  });
}

function chartOpts({ yFormatter, yTitle, xTimeAxis = false, tooltipLabel } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: { display: false },
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
