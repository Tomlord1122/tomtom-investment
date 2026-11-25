import math

import pandas as pd
import pytest

from portfolio_compare.metrics import (
    annual_table,
    monthly_returns,
    normalize_weights,
    portfolio_returns,
    summarize,
)


def prices() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "STK": [100, 110, 99, 120, 108],
            "BND": [100, 101, 102, 103, 104],
        },
        index=["2020-01", "2020-02", "2020-03", "2021-01", "2021-02"],
    )


def test_normalize_weights_drops_zeros_and_scales():
    assert normalize_weights({"A": 50, "B": 50, "C": 0}) == {"A": 0.5, "B": 0.5}


def test_normalize_weights_rejects_empty():
    with pytest.raises(ValueError):
        normalize_weights({"A": 0})


def test_yearly_rebalance_resets_drift():
    returns = monthly_returns(prices())
    series = portfolio_returns(returns, {"STK": 0.5, "BND": 0.5})
    # 2020-02 is the first return month. 2021 starts a new year, so the
    # drifted 2020 weights must not carry into the January 2021 return.
    assert series.loc["2021-01"] == pytest.approx(0.5 * (120 / 99 - 1) + 0.5 * (103 / 102 - 1))


def test_no_rebalance_inside_the_year():
    returns = monthly_returns(prices())
    series = portfolio_returns(returns, {"STK": 0.5, "BND": 0.5})
    feb = 0.5 * 0.10 + 0.5 * 0.01
    held_stock = 0.5 * 1.10 / (1 + feb)
    held_bond = 0.5 * 1.01 / (1 + feb)
    march = held_stock * (99 / 110 - 1) + held_bond * (102 / 101 - 1)
    assert series.loc["2020-02"] == pytest.approx(feb)
    assert series.loc["2020-03"] == pytest.approx(march)


def test_summary_cagr_and_drawdown():
    returns = pd.Series([0.10, -0.20, 0.05], index=["2020-01", "2020-02", "2020-03"])
    stats = summarize(returns)
    growth = 1.10 * 0.80 * 1.05
    assert stats["cagr"] == pytest.approx(growth ** (12 / 3) - 1)
    assert stats["max_drawdown"] == pytest.approx(0.80 - 1)
    assert stats["volatility"] == pytest.approx(pd.Series([0.10, -0.20, 0.05]).std(ddof=1) * math.sqrt(12))


def test_annual_table_marks_partial_years():
    returns = pd.Series([0.10, 0.10], index=["2020-11", "2020-12"])
    rows = annual_table(returns)
    assert rows == [{"year": "2020", "return": pytest.approx(1.21 - 1), "partial": True}]
