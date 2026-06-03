"""
Fetch IBKR Flex Query report and convert it to data/portfolio.json
consumed by the static frontend.

Required env vars:
  IBKR_FLEX_TOKEN     -- token generated in IBKR Client Portal
  IBKR_FLEX_QUERY_ID  -- numeric ID of the Flex Query

The Flex Query in IBKR should include these sections at minimum:
  - Open Positions
  - Cash Report (or Net Asset Value)
  - Change in NAV (for equity curve)
  - Trades or Realized & Unrealized Performance Summary
"""

import os
import sys
import time
import json
import datetime as dt
import xml.etree.ElementTree as ET
import urllib.request
import urllib.parse


FLEX_REQUEST_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest"
FLEX_STATEMENT_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement"


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


def parse(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)

    # --- Holdings -----------------------------------------------------------
    holdings = []
    for p in root.iter("OpenPosition"):
        qty = f(p, "position")
        if qty == 0:
            continue
        avg_cost = f(p, "costBasisPrice")
        last = f(p, "markPrice")
        mv = f(p, "positionValue") or qty * last
        u_pnl = f(p, "fifoPnlUnrealized")
        u_pnl_pct = ((last / avg_cost) - 1) * 100 if avg_cost else 0.0
        symbol = s(p, "symbol")
        sub_cat = s(p, "subCategory")
        asset_class = detect_asset_class(s(p, "assetCategory"), sub_cat)
        holdings.append({
            "symbol": symbol,
            "name": s(p, "description") or symbol,
            "assetClass": asset_class,
            "sector": detect_sector(symbol, sub_cat, asset_class),
            "quantity": qty,
            "avgCost": round(avg_cost, 4),
            "lastPrice": round(last, 4),
            "marketValue": round(mv, 2),
            "unrealizedPnl": round(u_pnl, 2),
            "unrealizedPnlPct": round(u_pnl_pct, 2),
        })

    # --- NAV / cash ---------------------------------------------------------
    nav = 0.0
    cash = 0.0
    base_ccy = "USD"
    for nav_row in root.iter("EquitySummaryByReportDateInBase"):
        nav = f(nav_row, "total")
        cash = f(nav_row, "cash")
        base_ccy = s(nav_row, "currency") or base_ccy
    if nav == 0:
        nav = sum(h["marketValue"] for h in holdings) + cash

    # --- Equity curve from ChangeInNAV -------------------------------------
    equity = []
    for row in root.iter("EquitySummaryByReportDateInBase"):
        d = s(row, "reportDate")
        if d:
            equity.append({"date": iso_date(d), "value": round(f(row, "total"), 2)})
    equity.sort(key=lambda x: x["date"])
    if not equity and nav:
        equity = [{"date": dt.date.today().isoformat(), "value": round(nav, 2)}]

    # --- P&L ---------------------------------------------------------------
    mtm_rows = list(root.iter("MTMPerformanceSummaryInBase"))
    total_pnl = sum(f(row, "total") for row in mtm_rows)
    # Fallback: use sum of unrealized PnL from open positions (matches IBKR "Unrealized P&L")
    if total_pnl == 0 and holdings:
        total_pnl = sum(h["unrealizedPnl"] for h in holdings)

    total_cost = sum((h["avgCost"] * h["quantity"]) for h in holdings)
    if total_cost:
        total_pnl_pct = sum(h["unrealizedPnl"] for h in holdings) / total_cost * 100
    else:
        total_pnl_pct = 0.0

    day_pnl = 0.0
    day_pnl_pct = 0.0
    if len(equity) >= 2:
        day_pnl = equity[-1]["value"] - equity[-2]["value"]
        if equity[-2]["value"]:
            day_pnl_pct = day_pnl / equity[-2]["value"] * 100

    # YTD = first equity point of current year vs latest
    ytd_pnl = 0.0
    ytd_pct = 0.0
    if equity:
        year = equity[-1]["date"][:4]
        start = next((p for p in equity if p["date"].startswith(year)), equity[0])
        ytd_pnl = equity[-1]["value"] - start["value"]
        ytd_pct = (ytd_pnl / start["value"] * 100) if start["value"] else 0.0

    # --- Monthly realized PnL bucket from trades ---------------------------
    monthly_map = {}
    for tr in root.iter("Trade"):
        pnl = f(tr, "fifoPnlRealized")
        if pnl == 0:
            continue
        d = iso_date(s(tr, "tradeDate"))
        if not d:
            continue
        ym = d[:7]
        monthly_map[ym] = monthly_map.get(ym, 0.0) + pnl
    monthly = [{"month": k, "pnl": round(v, 2)} for k, v in sorted(monthly_map.items())]

    return {
        "lastUpdated": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "baseCurrency": base_ccy,
        "nav": round(nav, 2),
        "cash": round(cash, 2),
        "totalPnl": round(total_pnl, 2),
        "totalPnlPct": round(total_pnl_pct, 2),
        "dayPnl": round(day_pnl, 2),
        "dayPnlPct": round(day_pnl_pct, 2),
        "ytdPnl": round(ytd_pnl, 2),
        "ytdPct": round(ytd_pct, 2),
        "holdings": holdings,
        "equity": equity,
        "monthlyPnl": monthly,
    }


def map_asset_class(code: str) -> str:
    return {
        "STK": "Equity",
        "OPT": "Option",
        "FUT": "Future",
        "BOND": "Bond",
        "CASH": "FX",
        "ETF": "ETF",
        "FUND": "Fund",
    }.get((code or "").upper(), code or "Other")


def iso_date(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    return raw[:10]


def merge_history(data: dict, existing_path: str) -> dict:
    """Append today's snapshot to historical equity / monthly P&L from prior run."""
    if not os.path.exists(existing_path):
        return data
    try:
        with open(existing_path, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except Exception:
        return data

    today = dt.date.today().isoformat()

    # --- Equity history ----------------------------------------------------
    prev_equity = prev.get("equity") or []
    by_date = {p["date"]: p["value"] for p in prev_equity}
    by_date[today] = data["nav"]
    for p in data.get("equity", []):
        by_date.setdefault(p["date"], p["value"])
    merged_equity = [{"date": d, "value": round(v, 2)} for d, v in sorted(by_date.items())]
    data["equity"] = merged_equity

    # --- Day P&L / YTD from merged equity ----------------------------------
    if len(merged_equity) >= 2:
        last_v = merged_equity[-1]["value"]
        prev_v = merged_equity[-2]["value"]
        data["dayPnl"] = round(last_v - prev_v, 2)
        data["dayPnlPct"] = round((last_v - prev_v) / prev_v * 100, 2) if prev_v else 0.0
    if merged_equity:
        year = merged_equity[-1]["date"][:4]
        start = next((p for p in merged_equity if p["date"].startswith(year)), merged_equity[0])
        ytd = merged_equity[-1]["value"] - start["value"]
        data["ytdPnl"] = round(ytd, 2)
        data["ytdPct"] = round(ytd / start["value"] * 100, 2) if start["value"] else 0.0

    # --- Monthly realized P&L (union) --------------------------------------
    prev_monthly = {m["month"]: m["pnl"] for m in (prev.get("monthlyPnl") or [])}
    for m in data.get("monthlyPnl", []):
        prev_monthly[m["month"]] = m["pnl"]
    data["monthlyPnl"] = [{"month": k, "pnl": v} for k, v in sorted(prev_monthly.items())]
    return data


def main():
    token = os.environ.get("IBKR_FLEX_TOKEN")
    qid = os.environ.get("IBKR_FLEX_QUERY_ID")
    if not token or not qid:
        print("ERROR: set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID", file=sys.stderr)
        sys.exit(2)

    ref = request_statement(token, qid)
    xml = fetch_statement(token, ref)
    data = parse(xml)

    out = os.path.join(os.path.dirname(__file__), "..", "data", "portfolio.json")
    out = os.path.abspath(out)
    data = merge_history(data, out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    print(
        f"Wrote {out} — NAV {data['nav']} {data['baseCurrency']}, "
        f"{len(data['holdings'])} positions, equity points {len(data.get('equity', []))}"
    )


if __name__ == "__main__":
    main()
