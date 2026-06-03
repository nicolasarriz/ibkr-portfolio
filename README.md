# IBKR Portfolio Dashboard

Public, interactive view of my Interactive Brokers trading book — built for recruiters and anyone curious. Holdings, P&L, equity curve and allocation, refreshed automatically.

**Live site:** _enable GitHub Pages on this repo to get the URL_

![preview](assets/preview.png)

## Stack

- **Frontend** — plain HTML + CSS + JS, [Chart.js](https://www.chartjs.org/) via CDN. No build step.
- **Data** — `data/portfolio.json`, generated from an IBKR Flex Query (XML).
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

## Customizing

- Edit `index.html` for layout, `style.css` for colors, `app.js` for chart behavior.
- The frontend reads only `data/portfolio.json` — feel free to hand-edit it for testing.
- The fallback `data/portfolio.json` shipped in this repo is mock data so the page renders before you wire up Flex.

## Privacy note

Everything in `data/portfolio.json` is public once you push. If you'd rather not expose absolute dollar amounts, edit `scripts/fetch_flex.py` to normalize NAV / cash / market values to a starting basis of 100 before writing the JSON.

## License

MIT — see [LICENSE](LICENSE).
