"""
Fetch IBKR Flex Query report and convert it to data/portfolio.json
consumed by the static frontend.

IMPORTANT — anonymized output:
  The committed JSON deliberately contains NO absolute money figures (no NAV,
  no market value, no cash, no dollar P&L). Performance is published as an
  index (base 100 at inception) plus percentages and portfolio weights, so the
  account's absolute size is never exposed. NAV is used internally only to
  derive the index series, and is dropped before writing.

Required env vars:
  IBKR_FLEX_TOKEN     -- token generated in IBKR Client Portal
  IBKR_FLEX_QUERY_ID  -- numeric ID of the Flex Query

The Flex Query in IBKR should include these sections at minimum:
  - Open Positions
  - Change in NAV / Net Asset Value (EquitySummaryByReportDateInBase) for the index
  - Trades or MTM Performance Summary (for monthly returns)
"""

import os
import sys
import time
import json
import math
import bisect
import datetime as dt
import xml.etree.ElementTree as ET
import urllib.request
import urllib.parse


BENCHMARK_SYMBOL = "%5EGSPC"  # ^GSPC — S&P 500 (Yahoo Finance, no API key)


FLEX_REQUEST_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest"
FLEX_STATEMENT_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement"
TRADING_DAYS = 252

# Equity-curve reconstruction (holdings' real prices, Yahoo)
PRICE_RANGE = "1y"
DEFAULT_START = "2026-03-04"  # inception of the book


def http_get(url: str, params: dict) -> bytes:
    qs = urllib.parse.urlencode(params)
    full = f"{url}?{qs}"
    req = urllib.request.Request(full, headers={"User-Agent": "ibkr-portfolio/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def request_statement(token: str, query_id: str) -> str:
    body = http_get(FLEX_REQUEST_URL, {"t": token, "q": query_id, "v": "3"})
    root = ET.fromstring(body)
    status = root.findtext("Status", "")
    if status != "Success":
        msg = root.findtext("ErrorMessage", "")
        raise RuntimeError(f"Flex request failed: {status} — {msg}")
    return root.findtext("ReferenceCode", "")


def fetch_statement(token: str, ref: str, retries: int = 6, wait: int = 5) -> bytes:
    last_err = None
    for _ in range(retries):
        try:
            body = http_get(FLEX_STATEMENT_URL, {"t": token, "q": ref, "v": "3"})
            head = body.lstrip()[:80].decode("utf-8", errors="ignore")
            if head.startswith("<FlexStatementResponse"):
                root = ET.fromstring(body)
                if root.findtext("Status") == "Warn":
                    last_err = root.findtext("ErrorMessage", "")
                    time.sleep(wait)
                    continue
            return body
        except Exception as exc:
            last_err = str(exc)
            time.sleep(wait)
    raise RuntimeError(f"Flex statement fetch failed: {last_err}")


def f(node, attr, default=0.0):
    v = node.attrib.get(attr)
    if v is None or v == "":
        return default
    try:
        return float(v)
    except ValueError:
        return default


def s(node, attr, default=""):
    return node.attrib.get(attr, default) or default


SECTOR_MAP = {
    # Technology
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology", "AMD": "Technology",
    "PLTR": "Technology", "TSM": "Technology", "ASML": "Technology", "ORCL": "Technology",
    "CRM": "Technology", "ADBE": "Technology", "AVGO": "Technology", "INTC": "Technology",
    "CSCO": "Technology", "IBM": "Technology",
    # Communication
    "GOOGL": "Communication Services", "GOOG": "Communication Services",
    "META": "Communication Services", "NFLX": "Communication Services",
    "DIS": "Communication Services", "VZ": "Communication Services",
    # Financials
    "JPM": "Financials", "BAC": "Financials", "WFC": "Financials", "GS": "Financials",
    "MS": "Financials", "C": "Financials", "BRK.B": "Financials", "BRK.A": "Financials",
    "V": "Financials", "MA": "Financials", "AXP": "Financials",
    # Consumer
    "AMZN": "Consumer Discretionary", "TSLA": "Consumer Discretionary",
    "HD": "Consumer Discretionary", "MCD": "Consumer Discretionary",
    "NKE": "Consumer Discretionary", "SBUX": "Consumer Discretionary",
    "WMT": "Consumer Staples", "COST": "Consumer Staples", "KO": "Consumer Staples",
    "PG": "Consumer Staples", "PEP": "Consumer Staples",
    # Healthcare
    "UNH": "Healthcare", "JNJ": "Healthcare", "LLY": "Healthcare", "PFE": "Healthcare",
    "MRK": "Healthcare", "ABBV": "Healthcare", "TMO": "Healthcare", "ABT": "Healthcare",
    # Industrials / Energy / Materials
    "BA": "Industrials", "CAT": "Industrials", "GE": "Industrials", "HON": "Industrials",
    "XOM": "Energy", "CVX": "Energy", "COP": "Energy", "OXY": "Energy",
    # Broad ETFs
    "QQQ": "US Large Cap ETF", "VOO": "US Large Cap ETF", "SPY": "US Large Cap ETF",
    "DIA": "US Large Cap ETF", "IVV": "US Large Cap ETF", "VTI": "US Total Market ETF",
    "IWM": "US Small Cap ETF",
    # Thematic ETFs
    "MAGS": "Mega Cap Tech ETF", "IGM": "Tech Sector ETF", "XLK": "Tech Sector ETF",
    "SMH": "Semiconductor ETF", "SOXX": "Semiconductor ETF",
    "XLF": "Financials ETF", "XLE": "Energy ETF", "XLV": "Healthcare ETF",
    # Bonds / commodities / international
    "TLT": "Fixed Income", "AGG": "Fixed Income", "BND": "Fixed Income", "IEF": "Fixed Income",
    "GLD": "Commodities", "SLV": "Commodities", "USO": "Commodities",
    "VWO": "Emerging Markets", "EEM": "Emerging Markets",
    "VEA": "Developed Markets ex-US", "EFA": "Developed Markets ex-US",
}


def map_asset_class(code: str) -> str:
    return {
        "STK": "Equity", "OPT": "Option", "FUT": "Future", "BOND": "Bond",
        "CASH": "FX", "ETF": "ETF", "FUND": "Fund",
    }.get((code or "").upper(), code or "Other")


def detect_asset_class(asset_cat: str, sub_cat: str) -> str:
    if (sub_cat or "").upper() in ("ETF", "FUND"):
        return "ETF"
    return map_asset_class(asset_cat)


def detect_sector(symbol: str, sub_cat: str, asset_class: str) -> str:
    if symbol in SECTOR_MAP:
        return SECTOR_MAP[symbol]
    if asset_class == "ETF":
        return "Other ETF"
    sub = (sub_cat or "").strip()
    if sub and sub.upper() not in ("COMMON", "ETF", "FUND"):
        return sub.title()
    return "Other"


def iso_date(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    return raw[:10]


def fetch_benchmark(dates: list, symbol: str = BENCHMARK_SYMBOL) -> list:
    """S&P 500 daily closes (Yahoo), aligned to the portfolio dates and indexed
    to 100 at the first date. Forward-fills non-trading days. Best-effort."""
    if not dates:
        return []
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5y&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    close_by_date = {}
    for t, c in zip(ts, closes):
        if c is None:
            continue
        close_by_date[dt.datetime.utcfromtimestamp(t).date().isoformat()] = c
    keys = sorted(close_by_date)
    if not keys:
        return []
    aligned = []
    for d in dates:
        i = bisect.bisect_right(keys, d) - 1  # latest market close on/before d
        if i >= 0:
            aligned.append((d, close_by_date[keys[i]]))
    if not aligned:
        return []
    base = aligned[0][1]
    return [{"date": d, "index": round(c / base * 100, 2)} for d, c in aligned if base]


def fetch_prices(symbol: str) -> dict:
    """Daily closes for a symbol from Yahoo, keyed by ISO date."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={PRICE_RANGE}&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    out = {}
    for t, c in zip(ts, closes):
        if c is not None:
            out[dt.datetime.utcfromtimestamp(t).date().isoformat()] = c
    return out


def build_equity(holdings: list, anchor_index: float, start: str) -> list:
    """Reconstruct the indexed equity curve from inception to the latest trading
    day as a buy-and-hold index of the *current* holdings, using their real daily
    prices (Yahoo) weighted by current portfolio weight. The daily SHAPE comes
    from real market moves; the curve is linearly scaled so start=100 and today=
    anchor_index (the account's real total return), so it never overstates."""
    prices = {}
    for h in holdings:
        prices[h["symbol"]] = fetch_prices(h["symbol"])
    # Common trading dates across every holding (avoids gaps), from inception on
    common = None
    for p in prices.values():
        common = set(p) if common is None else (common & set(p))
    dates = sorted(d for d in (common or []) if d >= start)
    if len(dates) < 2:
        return []
    t0 = dates[0]
    weights = {h["symbol"]: h["weight"] / 100.0 for h in holdings}

    raw = [(d, sum(weights[s] * (prices[s][d] / prices[s][t0]) for s in prices)) for d in dates]
    period_ret = raw[-1][1] - 1.0          # holdings' return over the window (fraction)
    target_total = anchor_index - 100.0    # account's real total return (pct)

    if period_ret > 0:
        k = target_total / (period_ret * 100.0)
        return [{"date": d, "index": round(100.0 + (bf - 1.0) * 100.0 * k, 2)} for d, bf in raw]
    bf_today = raw[-1][1] or 1.0
    return [{"date": d, "index": round(anchor_index * bf / bf_today, 2)} for d, bf in raw]


def risk_from_index(index_series: list) -> dict:
    """Annualized risk measures from an index series [{date, index}]."""
    vals = [p["index"] for p in index_series]
    if len(vals) < 4:  # need >= 3 daily returns
        return {"maxDrawdownPct": None, "volatilityPct": None, "sharpe": None}
    rets = [vals[i] / vals[i - 1] - 1 for i in range(1, len(vals)) if vals[i - 1]]
    n = len(rets)
    mean = sum(rets) / n
    var = sum((r - mean) ** 2 for r in rets) / n
    sd = math.sqrt(var)
    vol = sd * math.sqrt(TRADING_DAYS)
    ann_ret = mean * TRADING_DAYS
    peak, mdd = -math.inf, 0.0
    for v in vals:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, (peak - v) / peak)
    return {
        "maxDrawdownPct": round(-mdd * 100, 2),
        "volatilityPct": round(vol * 100, 2),
        "sharpe": round(ann_ret / vol, 2) if vol else None,
    }


def parse(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)

    # --- Holdings (anonymized: only return % and weight) -------------------
    raw = []
    total_cost = 0.0
    total_mv_signed = 0.0
    for p in root.iter("OpenPosition"):
        qty = f(p, "position")
        if qty == 0:
            continue
        avg_cost = f(p, "costBasisPrice")
        last = f(p, "markPrice")
        mv = f(p, "positionValue") or qty * last
        total_cost += avg_cost * qty
        total_mv_signed += mv
        u_pnl_pct = ((last / avg_cost) - 1) * 100 if avg_cost else 0.0
        symbol = s(p, "symbol")
        sub_cat = s(p, "subCategory")
        asset_class = detect_asset_class(s(p, "assetCategory"), sub_cat)
        raw.append({
            "symbol": symbol,
            "name": s(p, "description") or symbol,
            "assetClass": asset_class,
            "sector": detect_sector(symbol, sub_cat, asset_class),
            "unrealizedPnlPct": round(u_pnl_pct, 2),
            "_mv": mv,
        })
    total_mv = sum(h["_mv"] for h in raw) or 1.0
    holdings = []
    for h in raw:
        holdings.append({
            "symbol": h["symbol"],
            "name": h["name"],
            "assetClass": h["assetClass"],
            "sector": h["sector"],
            "unrealizedPnlPct": h["unrealizedPnlPct"],
            "weight": round(h["_mv"] / total_mv * 100, 2),
        })
    holdings.sort(key=lambda x: x["symbol"])

    # --- NAV history -> index series (base 100 at first date) --------------
    nav_by_date = {}
    for row in root.iter("EquitySummaryByReportDateInBase"):
        d = iso_date(s(row, "reportDate"))
        if d:
            nav_by_date[d] = f(row, "total")
    nav_series = [{"date": d, "nav": v} for d, v in sorted(nav_by_date.items()) if v]
    base_nav = nav_series[0]["nav"] if nav_series else 0.0
    equity = [
        {"date": p["date"], "index": round(p["nav"] / base_nav * 100, 2)}
        for p in nav_series
    ] if base_nav else []

    # --- Monthly realized return % from trades -----------------------------
    monthly_pnl, monthly_base = {}, {}
    nav_first_of_month = {}
    for p in nav_series:
        ym = p["date"][:7]
        nav_first_of_month.setdefault(ym, p["nav"])
    for tr in root.iter("Trade"):
        pnl = f(tr, "fifoPnlRealized")
        if pnl == 0:
            continue
        d = iso_date(s(tr, "tradeDate"))
        if not d:
            continue
        monthly_pnl[d[:7]] = monthly_pnl.get(d[:7], 0.0) + pnl
    monthly = []
    for ym in sorted(monthly_pnl):
        base = nav_first_of_month.get(ym) or base_nav
        if base:
            monthly.append({"month": ym, "returnPct": round(monthly_pnl[ym] / base * 100, 2)})

    # Real total return of the book vs cost basis (used to anchor the curve)
    book_return_pct = (total_mv_signed / total_cost - 1) * 100 if total_cost else 0.0

    return {
        "lastUpdated": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "baseCurrency": "USD",
        "holdings": holdings,
        "equity": equity,
        "monthly": monthly,
        "_navSeries": nav_series,      # internal only — stripped before writing
        "_bookReturnPct": book_return_pct,  # internal only
    }


def merge_history(data: dict, existing_path: str) -> dict:
    """Keep the original base-100 anchor across rolling Flex windows."""
    prev = None
    if os.path.exists(existing_path):
        try:
            with open(existing_path, "r", encoding="utf-8") as fh:
                prev = json.load(fh)
        except Exception:
            prev = None

    equity = data.get("equity") or []
    if prev and prev.get("equity"):
        prev_eq = {p["date"]: p["index"] for p in prev["equity"]}
        new_eq = {p["date"]: p["index"] for p in equity}
        # Re-base the new series onto the committed base via a shared date.
        shared = sorted(set(prev_eq) & set(new_eq))
        if shared:
            d0 = shared[-1]
            scale = prev_eq[d0] / new_eq[d0] if new_eq[d0] else 1.0
            new_eq = {d: round(v * scale, 2) for d, v in new_eq.items()}
        merged = {**prev_eq, **new_eq}
        equity = [{"date": d, "index": merged[d]} for d in sorted(merged)]
    data["equity"] = equity

    if prev and prev.get("monthly"):
        prev_m = {m["month"]: m["returnPct"] for m in prev["monthly"]}
        for m in data.get("monthly", []):
            prev_m[m["month"]] = m["returnPct"]
        data["monthly"] = [{"month": k, "returnPct": v} for k, v in sorted(prev_m.items())]
    return data


def finalize(data: dict) -> dict:
    """Compute index/return headline + risk, strip internal NAV fields."""
    data.pop("_navSeries", None)
    data.pop("_bookReturnPct", None)
    eq = data.get("equity") or []
    latest = eq[-1]["index"] if eq else 100.0
    data["index"] = round(latest, 2)
    data["totalReturnPct"] = round(latest - 100.0, 2)

    day = 0.0
    if len(eq) >= 2 and eq[-2]["index"]:
        day = (eq[-1]["index"] / eq[-2]["index"] - 1) * 100
    data["dayReturnPct"] = round(day, 2)

    ytd = 0.0
    if eq:
        year = eq[-1]["date"][:4]
        start = next((p for p in eq if p["date"].startswith(year)), eq[0])
        if start["index"]:
            ytd = (eq[-1]["index"] / start["index"] - 1) * 100
    data["ytdReturnPct"] = round(ytd, 2)

    data["risk"] = risk_from_index(eq)

    # Stable key order for a clean diff
    order = ["lastUpdated", "baseCurrency", "index", "totalReturnPct",
             "dayReturnPct", "ytdReturnPct", "risk", "holdings", "equity",
             "benchmark", "monthly"]
    return {k: data[k] for k in order if k in data}


def main():
    token = os.environ.get("IBKR_FLEX_TOKEN")
    qid = os.environ.get("IBKR_FLEX_QUERY_ID")
    if not token or not qid:
        print("ERROR: set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID", file=sys.stderr)
        sys.exit(2)

    ref = request_statement(token, qid)
    xml = fetch_statement(token, ref)
    data = parse(xml)

    out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "portfolio.json"))
    data = merge_history(data, out)

    # Extend the indexed equity curve to the latest trading day. IBKR's Flex NAV
    # history (EquitySummaryByReportDateInBase) is not available in this feed, so
    # the curve is reconstructed daily from the current holdings' real prices
    # (Yahoo), anchored to the book's real total return. Falls back to the merged
    # NAV/backfill curve if the reconstruction can't fetch prices.
    anchor = 100.0 + data.get("_bookReturnPct", 0.0)
    start = os.environ.get("BACKFILL_START", DEFAULT_START)
    try:
        rebuilt = build_equity(data.get("holdings", []), anchor, start)
        if rebuilt:
            data["equity"] = rebuilt
        else:
            print("equity rebuild produced no points; keeping prior curve", file=sys.stderr)
    except Exception as exc:
        print(f"equity rebuild skipped: {exc}", file=sys.stderr)

    # S&P 500 benchmark (best-effort; keep previous on failure)
    dates = [p["date"] for p in data.get("equity", [])]
    try:
        bench = fetch_benchmark(dates)
        if bench:
            data["benchmark"] = bench
    except Exception as exc:
        print(f"benchmark fetch skipped: {exc}", file=sys.stderr)
    if "benchmark" not in data and os.path.exists(out):
        try:
            with open(out, "r", encoding="utf-8") as fh:
                prev_b = json.load(fh).get("benchmark")
            if prev_b:
                data["benchmark"] = prev_b
        except Exception:
            pass

    data = finalize(data)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    print(
        f"Wrote {out} — index {data['index']} ({data['totalReturnPct']:+}%), "
        f"{len(data['holdings'])} positions, {len(data.get('equity', []))} index points"
    )


if __name__ == "__main__":
    main()
