# 投組比較

Pick a few Taiwan or US ETFs and stocks, set weights, and compare one yearly-rebalanced mix.

The page uses month-end adjusted closes. It rebalances in the first month of each year. Taiwan and US prices stay in their own currency, so a mixed portfolio is not a tradable TWD return.

## Update the history

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/update_history.py
.venv/bin/python scripts/build_site_data.py
```

Open `web/index.html` through a local server. `file://` cannot load `history.json`.

```bash
.venv/bin/python -m http.server 8765 --directory web
```

## CI

`.github/workflows/update-history.yml` runs on weekday evenings UTC, after the Taiwan close. It refreshes `data/history.parquet` and commits only when the history changed. Enable GitHub Pages from the `web/` folder on `main` if you want the page online.

Add a ticker by editing `data/catalog.json`, then run the update script or wait for the next scheduled run.
