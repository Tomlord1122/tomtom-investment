"""Portfolio math used by the static compare page and the tests.

Prices are month-end adjusted closes. A weight vector is renormalized to 1
and rebalanced on the first month of each calendar year, which matches the
yearly first-trading-day rule used by the Taiwan Couch Potato clones.
"""

from __future__ import annotations

import math

import pandas as pd


def normalize_weights(weights: dict[str, float]) -> dict[str, float]:
    cleaned = {symbol: float(weight) for symbol, weight in weights.items() if weight > 0}
    total = sum(cleaned.values())
    if total <= 0:
        raise ValueError("weights must sum to a positive number")
    return {symbol: weight / total for symbol, weight in cleaned.items()}


def monthly_returns(prices: pd.DataFrame) -> pd.DataFrame:
    """Wide adjusted-close frame to aligned simple returns.

    The first overlapping month is the base and is dropped. Later gaps stay
    missing so a delisted month cannot be treated as a zero return.
    """
    if prices.empty:
        raise ValueError("prices are empty")
    ordered = prices.sort_index()
    return ordered.pct_change().iloc[1:]


def portfolio_returns(returns: pd.DataFrame, weights: dict[str, float]) -> pd.Series:
    weights = normalize_weights(weights)
    missing = [symbol for symbol in weights if symbol not in returns.columns]
    if missing:
        raise ValueError(f"missing price history: {', '.join(missing)}")
    aligned = returns[list(weights)].dropna()
    if aligned.empty:
        raise ValueError("no overlapping months")
    weight_row = pd.Series(weights)
    values = []
    held = weight_row.copy()
    current_year = None
    for month, row in aligned.iterrows():
        year = str(month)[:4]
        if current_year != year:
            held = weight_row.copy()
            current_year = year
        asset_returns = row.reindex(held.index)
        portfolio_return = float((held * asset_returns).sum())
        values.append(portfolio_return)
        grown = held * (1 + asset_returns)
        held = grown / grown.sum()
    return pd.Series(values, index=aligned.index, name="portfolio")


def summarize(returns: pd.Series) -> dict[str, float | int | str | None]:
    if returns.empty:
        raise ValueError("returns are empty")
    growth = (1 + returns).cumprod()
    years = len(returns) / 12
    cagr = float(growth.iloc[-1] ** (1 / years) - 1) if years else 0.0
    volatility = float(returns.std(ddof=1) * math.sqrt(12)) if len(returns) > 1 else 0.0
    drawdown = growth / growth.cummax() - 1
    worst = str(returns.idxmin())
    annual = _annual_returns(returns)
    return {
        "start": str(returns.index[0]),
        "end": str(returns.index[-1]),
        "months": int(len(returns)),
        "cagr": cagr,
        "volatility": volatility,
        "max_drawdown": float(drawdown.min()),
        "best_year": max(annual.values()) if annual else None,
        "worst_year": min(annual.values()) if annual else None,
        "worst_month": worst,
    }


def growth_curve(returns: pd.Series, initial: float = 10_000) -> list[dict[str, float | str]]:
    growth = initial * (1 + returns).cumprod()
    return [{"month": str(month), "value": float(value)} for month, value in growth.items()]


def annual_table(returns: pd.Series) -> list[dict[str, float | str | bool]]:
    grouped: dict[str, list[float]] = {}
    for month, value in returns.items():
        grouped.setdefault(str(month)[:4], []).append(float(value))
    rows = []
    for year, values in grouped.items():
        total = 1.0
        for value in values:
            total *= 1 + value
        rows.append({"year": year, "return": total - 1, "partial": len(values) < 12})
    return rows


def _annual_returns(returns: pd.Series) -> dict[str, float]:
    return {row["year"]: row["return"] for row in annual_table(returns) if not row["partial"]}
