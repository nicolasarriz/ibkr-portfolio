"""
One-time (re-runnable) backfill of the indexed equity curve.

The live pipeline (fetch_flex.py) only records one real NAV point per day, so a
fresh account starts with an almost-flat chart. This script reconstructs a
historical curve as a BUY-AND-HOLD index of the *current* holdings, using their
real daily prices from Yahoo Finance, weighted by their current portfolio
weight, over the actual life of the book (BACKFILL_START .. today).

The daily SHAPE comes from the holdings' real market moves; the curve is then
linearly scaled so that start = 100 and today = the account's real index
(actual total return), so it never overstates the real performance. Going
forward, fetch_flex.py appends the real daily NAV.

Run:  python scripts/backfill_history.py
Env:  BACKFILL_START=YYYY-MM-DD   (inception of the book; default 2026-03-04)
"""

import os
import json

from fetch_flex import fetch_benchmark, risk_from_index, build_equity, DEFAULT_START


def main():
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "portfolio.json"))
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    holdings = data.get("holdings") or []
    anchor = data.get("index") or 100.0
    start = os.environ.get("BACKFILL_START", DEFAULT_START)
    equity = build_equity(holdings, anchor, start)
    if not equity:
        print("No price history fetched — aborting, file unchanged.")
        return

    dates = [p["date"] for p in equity]
    try:
        benchmark = fetch_benchmark(dates)
    except Exception as exc:
        print(f"benchmark fetch skipped: {exc}")
        benchmark = data.get("benchmark") or []

    # Recompute headline + risk from the rebuilt series
    latest = equity[-1]["index"]
    data["index"] = round(latest, 2)
    data["totalReturnPct"] = round(latest - 100.0, 2)
    day = (equity[-1]["index"] / equity[-2]["index"] - 1) * 100 if len(equity) >= 2 and equity[-2]["index"] else 0.0
    data["dayReturnPct"] = round(day, 2)
    year = equity[-1]["date"][:4]
    start = next((p for p in equity if p["date"].startswith(year)), equity[0])
    data["ytdReturnPct"] = round((equity[-1]["index"] / start["index"] - 1) * 100, 2) if start["index"] else 0.0
    data["risk"] = risk_from_index(equity)
    data["equity"] = equity
    if benchmark:
        data["benchmark"] = benchmark

    order = ["lastUpdated", "baseCurrency", "index", "totalReturnPct",
             "dayReturnPct", "ytdReturnPct", "risk", "holdings", "equity",
             "benchmark", "monthly"]
    data = {k: data[k] for k in order if k in data}

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    print(
        f"Backfilled {len(equity)} points {equity[0]['date']}..{equity[-1]['date']} | "
        f"index {data['index']} ({data['totalReturnPct']:+}%) | "
        f"benchmark pts {len(data.get('benchmark', []))} | risk {data['risk']}"
    )


if __name__ == "__main__":
    main()
