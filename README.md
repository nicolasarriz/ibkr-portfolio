# IBKR Portfolio Dashboard

Public, interactive view of my Interactive Brokers trading book — built for recruiters and anyone curious. Performance, holdings, allocation and risk metrics, refreshed automatically.

All figures are **indexed/anonymized**: the portfolio is shown as an index based at 100, with returns expressed as percentages. No absolute dollar amounts (NAV, market value, prices, dollar P&L) are ever written to the published data.

**Live site:** _enable GitHub Pages on this repo to get the URL_

![preview](assets/preview.png)

## Stack

- **Frontend** — plain HTML + CSS + JS, [Chart.js](https://www.chartjs.org/) via CDN. No build step.
- **Data** — `data/portfolio.json`, generated from an IBKR Flex Query (XML) and anonymized to an index/percentage schema before it is committed.
- **Automation** — GitHub Actions cron runs `scripts/fetch_flex.py` every weekday after US close, commits the new JSON, and Pages redeploys.

## Setup

### 1. Create the Flex Query in IBKR

1. IBKR Client Portal → **Settings → Account Settings → Reporting → Flex Queries → Activity Flex Query**.
2. Create a new query and include these sections:
   - Open Positions
   - Trades
   - Cash Report
   - Change in NAV (or Equity Summary in Base)
   - MTM Performance Summary in Base (optional, improves total P&L)
3. Choose **XML** as the format.
4. Save it — note the **Query ID** (numeric).
5. Under **Settings → Account Settings → Reporting → Flex Web Service**, generate a **Token**.

### 2. Add secrets to GitHub

In the repo settings → **Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `IBKR_FLEX_TOKEN` | Token from the Flex Web Service page |
| `IBKR_FLEX_QUERY_ID` | The numeric Query ID |

### 3. Enable GitHub Pages

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. The `pages.yml` workflow handles the rest.

### 4. First data pull

Go to **Actions → Update portfolio → Run workflow**. After it succeeds, the Pages deploy runs automatically.

## Local preview

Any static server works:

```bash
python -m http.server 8000
# open http://localhost:8000
```

To regenerate the JSON locally:

```bash
export IBKR_FLEX_TOKEN=...
export IBKR_FLEX_QUERY_ID=...
python scripts/fetch_flex.py
```

## Seeding history (one-time backfill)

A brand-new pipeline only records one NAV point per day, so the equity curve
starts almost flat. `scripts/backfill_history.py` reconstructs a daily curve
from the **current holdings' real market prices** (Yahoo Finance) over the life
of the book, then scales it so it starts at 100 and ends at the account's
**actual** total return — it never overstates performance. It also pulls a
matching S&P 500 series for the benchmark overlay.

```bash
BACKFILL_START=2026-03-04 python scripts/backfill_history.py   # inception date
```

Dates before a position was opened are hypothetical (they assume the current
allocation); the chart notes this. Going forward, `fetch_flex.py` appends the
real daily NAV on top of the seeded history.

## Customizing

- Edit `index.html` for layout, `style.css` for colors, `app.js` for chart behavior.
- The frontend reads only `data/portfolio.json` — feel free to hand-edit it for testing.
- The fallback `data/portfolio.json` shipped in this repo is mock data so the page renders before you wire up Flex.

## Privacy note

`scripts/fetch_flex.py` is built to **not** expose absolute dollar amounts: NAV is converted to a portfolio index based at 100, P&L is expressed as percentage returns, and per-position quantities, costs, prices and market values are dropped (only weight % and unrealized return % are kept). The committed `data/portfolio.json` is therefore safe to publish.

Note that prior commit history may still contain older, non-anonymized snapshots — scrub the history (e.g. `git filter-repo`) if that matters for your use case.

## License

MIT — see [LICENSE](LICENSE).
