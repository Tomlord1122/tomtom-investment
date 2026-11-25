#!/usr/bin/env python3
"""Refresh adjusted monthly history for the catalog.

Yahoo's chart endpoint is public and returns split-adjusted prices plus
cash dividends. We store month-end adjusted closes so the static site can
rebalance and compare without calling Yahoo from the browser.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "catalog.json"
HISTORY_PATH = ROOT / "data" / "history.parquet"
META_PATH = ROOT / "data" / "meta.json"
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
USER_AGENT = "portfolio-compare/0.1 (personal research; monthly refresh)"


def load_catalog() -> list[dict]:
    payload = json.loads(CATALOG_PATH.read_text())
    symbols = payload["symbols"]
    if not symbols:
        raise SystemExit("catalog is empty")
    return symbols


def fetch_chart(symbol: str) -> dict:
    query = urllib.parse.urlencode(
        {"interval": "1mo", "range": "max", "events": "div|split"}
    )
    url = f"{CHART_URL.format(symbol=urllib.parse.quote(symbol))}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode())
    result = payload.get("chart", {}).get("result")
    if not result:
        error = payload.get("chart", {}).get("error") or {}
        raise RuntimeError(error.get("description") or f"no chart for {symbol}")
    return result[0]


def month_ends(chart: dict) -> pd.DataFrame:
    timestamps = chart.get("timestamp") or []
    quote = (chart.get("indicators") or {}).get("quote") or [{}]
    closes = quote[0].get("close") or []
    adj = (chart.get("indicators") or {}).get("adjclose") or [{}]
    adjusted = adj[0].get("adjclose") if adj else None
    if adjusted is None:
        adjusted = closes

    dividends = (chart.get("events") or {}).get("dividends") or {}
    div_by_month: dict[str, float] = {}
    for event in dividends.values():
        month = datetime.fromtimestamp(event["date"], timezone.utc).strftime("%Y-%m")
        div_by_month[month] = div_by_month.get(month, 0.0) + float(event["amount"])

    rows = []
    for ts, close, adj_close in zip(timestamps, closes, adjusted):
        if close is None or adj_close is None:
            continue
        month = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")
        rows.append(
            {
                "month": month,
                "close": float(close),
                "adj_close": float(adj_close),
                "dividend": div_by_month.get(month, 0.0),
            }
        )
    if not rows:
        raise RuntimeError("chart had no usable closes")
    frame = pd.DataFrame(rows).drop_duplicates("month", keep="last")
    return frame.sort_values("month").reset_index(drop=True)


def refresh(symbols: list[dict], pause_sec: float = 0.4) -> tuple[pd.DataFrame, list[dict]]:
    frames = []
    statuses = []
    for item in symbols:
        symbol = item["symbol"]
        started = time.time()
        try:
            frame = month_ends(fetch_chart(symbol))
        except (urllib.error.URLError, TimeoutError, RuntimeError, KeyError, ValueError) as exc:
            statuses.append({"symbol": symbol, "ok": False, "error": str(exc)})
            print(f"FAIL {symbol}: {exc}", file=sys.stderr)
            continue
        frame.insert(0, "symbol", symbol)
        frames.append(frame)
        statuses.append(
            {
                "symbol": symbol,
                "ok": True,
                "months": int(len(frame)),
                "start": frame["month"].iloc[0],
                "end": frame["month"].iloc[-1],
            }
        )
        print(f"OK   {symbol} {len(frame)} months {frame['month'].iloc[0]}..{frame['month'].iloc[-1]}")
        elapsed = time.time() - started
        if elapsed < pause_sec:
            time.sleep(pause_sec - elapsed)
    if not frames:
        raise SystemExit("every symbol failed")
    history = pd.concat(frames, ignore_index=True)
    return history, statuses


def write_outputs(history: pd.DataFrame, statuses: list[dict]) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    history.to_parquet(HISTORY_PATH, index=False)
    meta = {
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Yahoo Finance chart API, monthly adjusted close",
        "symbols": statuses,
    }
    META_PATH.write_text(json.dumps(meta, indent=2) + "\n")


def main() -> None:
    history, statuses = refresh(load_catalog())
    write_outputs(history, statuses)
    failed = [item["symbol"] for item in statuses if not item["ok"]]
    if failed:
        raise SystemExit(f"partial refresh, failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
