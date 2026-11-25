#!/usr/bin/env python3
"""Turn the parquet history into one JSON file the static page can load."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
HISTORY_PATH = ROOT / "data" / "history.parquet"
CATALOG_PATH = ROOT / "data" / "catalog.json"
META_PATH = ROOT / "data" / "meta.json"
OUT_PATH = ROOT / "web" / "history.json"


def main() -> None:
    catalog = json.loads(CATALOG_PATH.read_text())
    meta = json.loads(META_PATH.read_text()) if META_PATH.exists() else {}
    history = pd.read_parquet(HISTORY_PATH)
    series = {}
    for symbol, frame in history.groupby("symbol"):
        ordered = frame.sort_values("month")
        usd = ordered["usd_twd"] if "usd_twd" in ordered else None
        prices = ordered["adj_close"]
        if not str(symbol).endswith((".TW", ".TWO")) and usd is not None:
            prices = prices * usd
        series[symbol] = [
            [month, round(float(price), 6)]
            for month, price in zip(ordered["month"], prices)
            if pd.notna(price)
        ]
    payload = {
        "updated_at": meta.get("updated_at"),
        "source": meta.get("source"),
        "symbols": catalog["symbols"],
        "series": series,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
