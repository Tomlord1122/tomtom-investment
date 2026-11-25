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
    # Monthly bars can stamp a post-split price on the month before the split.
    # 0050's 2025 4-for-1 split landed on 2013-12 and printed a fake -73% year.
    query = urllib.parse.urlencode(
        {
            "interval": "1d",
            "range": "max",
            "events": "div|split",
            "includeAdjustedClose": "false",
        }
    )
    url = f"{CHART_URL.format(symbol=urllib.parse.quote(symbol))}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode())
    result = payload.get("chart", {}).get("result")
    if not result:
        error = payload.get("chart", {}).get("error") or {}
        raise RuntimeError(error.get("description") or f"no chart for {symbol}")
    return result[0]


def split_ratio(event: dict) -> float:
    ratio = event.get("splitRatio", event.get("numerator", 1) / event.get("denominator", 1))
    if isinstance(ratio, str) and ":" in ratio:
        numerator, denominator = ratio.split(":", 1)
        return float(numerator) / float(denominator)
    return float(ratio)


def month_ends(chart: dict) -> pd.DataFrame:
    timestamps = chart.get("timestamp") or []
    quote = (chart.get("indicators") or {}).get("quote") or [{}]
    closes = quote[0].get("close") or []
    events = chart.get("events") or {}
    dividends = events.get("dividends") or {}
    splits = events.get("splits") or {}

    rows = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        when = datetime.fromtimestamp(ts, timezone.utc)
        rows.append({"month": when.strftime("%Y-%m"), "date": when.date().isoformat(), "close": float(close)})
    if not rows:
        raise RuntimeError("chart had no usable closes")
    daily = pd.DataFrame(rows).drop_duplicates("date", keep="last").sort_values("date")
    frame = daily.groupby("month", as_index=False).tail(1).reset_index(drop=True)

    div_by_month: dict[str, float] = {}
    for event in dividends.values():
        month = datetime.fromtimestamp(event["date"], timezone.utc).strftime("%Y-%m")
        div_by_month[month] = div_by_month.get(month, 0.0) + float(event["amount"])
    split_by_month: dict[str, float] = {}
    for event in splits.values():
        month = datetime.fromtimestamp(event["date"], timezone.utc).strftime("%Y-%m")
        split_by_month[month] = split_by_month.get(month, 1.0) * split_ratio(event)

    frame["dividend"] = frame["month"].map(lambda month: div_by_month.get(month, 0.0))
    frame["split"] = frame["month"].map(lambda month: split_by_month.get(month, 1.0))
    factor = 1.0
    adjusted = []
    for close, dividend, split in zip(frame["close"][::-1], frame["dividend"][::-1], frame["split"][::-1]):
        adjusted.append(close * factor)
        factor /= split
    frame["adj_close"] = list(reversed(adjusted))
    return frame[["month", "close", "adj_close", "dividend"]].sort_values("month").reset_index(drop=True)


def reject_split_shift(frame: pd.DataFrame) -> None:
    changes = frame["adj_close"].pct_change()
    worst = changes.min()
    if pd.notna(worst) and worst < -0.6:
        month = frame.loc[changes.idxmin(), "month"]
        raise RuntimeError(f"adjusted close fell {worst:.0%} in {month}; refusing a likely split shift")


def twse_month_ends(symbol: str) -> pd.DataFrame:
    stock_no = symbol.split(".", 1)[0]
    frames = []
    start = datetime(2012, 1, 1, tzinfo=timezone.utc)
    cursor = start
    now = datetime.now(timezone.utc)
    while cursor <= now:
        date = cursor.strftime("%Y%m01")
        url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date}&stockNo={stock_no}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
        if payload.get("stat") != "OK":
            continue
        last = payload["data"][-1]
        roc_year, month, day = last[0].split("/")
        frames.append(
            {
                "month": f"{int(roc_year) + 1911}-{int(month):02d}",
                "close": float(str(last[6]).replace(",", "")),
            }
        )
        time.sleep(0.25)
        cursor = datetime(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1, tzinfo=timezone.utc)
    frame = pd.DataFrame(frames).drop_duplicates("month").sort_values("month")
    if HISTORY_PATH.exists():
        previous = pd.read_parquet(HISTORY_PATH)
        older = previous[(previous["symbol"] == symbol) & (previous["month"] < frame["month"].min())]
        if not older.empty:
            frame = pd.concat([older.drop(columns="symbol"), frame], ignore_index=True)
    chart = fetch_chart(symbol)
    events = chart.get("events") or {}
    dividends = events.get("dividends") or {}
    splits = events.get("splits") or {}
    div_by_month: dict[str, float] = {}
    for event in dividends.values():
        month = datetime.fromtimestamp(event["date"], timezone.utc).strftime("%Y-%m")
        div_by_month[month] = div_by_month.get(month, 0.0) + float(event["amount"])
    ratios = [split_ratio(event) for event in splits.values()]
    detected = []
    closes = frame["close"].tolist()
    months = frame["month"].tolist()
    for index in range(1, len(closes)):
        jump = closes[index - 1] / closes[index]
        for ratio in ratios:
            if ratio > 1.5 and abs(jump / ratio - 1) < 0.35:
                detected.append((months[index], ratio))
                pass
    split_months = dict(detected) or {
        datetime.fromtimestamp(event["date"], timezone.utc).strftime("%Y-%m"): split_ratio(event)
        for event in splits.values()
    }
    frame["dividend"] = frame["month"].map(lambda month: div_by_month.get(month, 0.0))
    ratio = 1.0
    adjusted = []
    for month, close in zip(frame["month"][::-1], frame["close"][::-1]):
        adjusted.append(close / ratio)
        ratio *= split_months.get(month, 1.0)
    adjusted.reverse()
    frame["adj_close"] = adjusted
    return frame[["month", "close", "adj_close", "dividend"]].reset_index(drop=True)


def refresh(symbols: list[dict], pause_sec: float = 0.4) -> tuple[pd.DataFrame, list[dict]]:
    frames = []
    statuses = []
    for item in symbols:
        symbol = item["symbol"]
        started = time.time()
        try:
            frame = twse_month_ends(symbol) if symbol == "0050.TW" else month_ends(fetch_chart(symbol))
            reject_split_shift(frame)
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
