#!/usr/bin/env python3
"""Quant AI Workbench: local multi-market analysis server."""

from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "reports.sqlite3"
DEFAULT_PORT = int(os.environ.get("QUANT_AI_PORT", "8787"))


def load_env_file() -> None:
    env_files = [ROOT / "api_keys.env", ROOT / ".env"]
    existing_files = [path for path in env_files if path.exists()]
    if not existing_files:
        return
    for env_path in existing_files:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and value and key not in os.environ:
                os.environ[key] = value


def json_response(handler: BaseHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(
    handler: BaseHTTPRequestHandler,
    body: bytes,
    content_type: str = "text/html; charset=utf-8",
    status: int = 200,
) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def ensure_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                asset_type TEXT NOT NULL,
                stance TEXT NOT NULL,
                summary TEXT NOT NULL,
                report_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC)")


def normalize_symbol(symbol: str) -> str:
    cleaned = symbol.strip().upper()
    safe = "".join(ch for ch in cleaned if ch.isalnum() or ch in ".-_=^")
    if not safe:
        raise ValueError("请输入股票、指数或币种代码")
    if safe.isdigit() and len(safe) == 6:
        if safe.startswith(("0", "2", "3")):
            return f"{safe}.SZ"
        if safe.startswith(("5", "6", "9")):
            return f"{safe}.SS"
    return safe[:32]


def detect_asset_type(symbol: str) -> str:
    if "-USD" in symbol or symbol.endswith("USDT") or symbol.endswith("BTC"):
        return "crypto"
    if symbol.startswith("^"):
        return "index"
    if "." in symbol:
        suffix = symbol.rsplit(".", 1)[-1]
        return {
            "HK": "hong_kong_stock",
            "SS": "china_a_share",
            "SZ": "china_a_share",
            "T": "japan_stock",
            "L": "uk_stock",
            "NS": "india_stock",
            "AX": "australia_stock",
            "TO": "canada_stock",
        }.get(suffix, "global_stock")
    return "us_stock"


def fetch_yahoo_chart(symbol: str, chart_range: str = "1y", interval: str = "1d") -> dict[str, Any]:
    encoded = urllib.parse.quote(symbol, safe="")
    path = f"/v8/finance/chart/{encoded}?range={urllib.parse.quote(chart_range)}&interval={urllib.parse.quote(interval)}"
    payload = fetch_json_with_retries(["query1.finance.yahoo.com", "query2.finance.yahoo.com"], path)

    result = payload.get("chart", {}).get("result") or []
    error = payload.get("chart", {}).get("error")
    if error:
        raise RuntimeError(error.get("description") or "行情数据源返回错误")
    if not result:
        raise RuntimeError("没有找到该代码的行情数据")
    return result[0]


def fetch_json_with_retries(hosts: list[str], path: str, attempts_per_host: int = 2) -> dict[str, Any]:
    errors = []
    for host in hosts:
        url = f"https://{host}{path}"
        req = urllib.request.Request(url, headers={"User-Agent": "QuantAIWorkbench/0.1"})
        for attempt in range(attempts_per_host):
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                errors.append(f"{host}: HTTP {exc.code}")
                if exc.code in {404, 429}:
                    break
            except urllib.error.URLError as exc:
                errors.append(f"{host}: {exc.reason}")
            except Exception as exc:
                errors.append(f"{host}: {exc}")
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError("无法连接行情数据源：" + "；".join(errors[-4:]))


def fetch_yahoo_news(symbol: str, limit: int = 8) -> list[dict[str, Any]]:
    encoded = urllib.parse.quote(symbol, safe="")
    url = (
        "https://query2.finance.yahoo.com/v1/finance/search"
        f"?q={encoded}&quotesCount=0&newsCount={limit}&enableFuzzyQuery=false"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "QuantAIWorkbench/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []

    news_items = []
    for item in payload.get("news") or []:
        title = item.get("title") or ""
        if not title:
            continue
        published = item.get("providerPublishTime")
        news_items.append(
            {
                "title": title,
                "publisher": item.get("publisher") or "Yahoo Finance",
                "link": item.get("link") or "",
                "summary": item.get("summary") or item.get("snippet") or "",
                "published_at": (
                    datetime.fromtimestamp(published, timezone.utc).strftime("%Y-%m-%d %H:%M")
                    if published
                    else ""
                ),
                "type": item.get("type") or "story",
            }
        )
    return news_items[:limit]


def clean_series(raw: dict[str, Any]) -> dict[str, Any]:
    timestamps = raw.get("timestamp") or []
    quote = ((raw.get("indicators") or {}).get("quote") or [{}])[0]
    adjclose = ((raw.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or []
    meta = raw.get("meta") or {}
    rows = []
    for idx, ts in enumerate(timestamps):
        close = value_at(adjclose, idx, value_at(quote.get("close"), idx))
        if close is None:
            continue
        rows.append(
            {
                "date": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"),
                "open": value_at(quote.get("open"), idx),
                "high": value_at(quote.get("high"), idx),
                "low": value_at(quote.get("low"), idx),
                "close": close,
                "volume": value_at(quote.get("volume"), idx) or 0,
            }
        )
    if len(rows) < 30:
        raise RuntimeError("可用行情太少，无法计算指标")
    return {"meta": meta, "rows": rows}


def value_at(values: Any, index: int, fallback: Any = None) -> Any:
    if not isinstance(values, list) or index >= len(values):
        return fallback
    return values[index]


def sma(values: list[float], window: int) -> list[float | None]:
    out: list[float | None] = []
    total = 0.0
    for idx, value in enumerate(values):
        total += value
        if idx >= window:
            total -= values[idx - window]
        out.append(total / window if idx >= window - 1 else None)
    return out


def ema(values: list[float], window: int) -> list[float | None]:
    if not values:
        return []
    alpha = 2 / (window + 1)
    out: list[float | None] = []
    current = values[0]
    for idx, value in enumerate(values):
        current = value if idx == 0 else alpha * value + (1 - alpha) * current
        out.append(current if idx >= window - 1 else None)
    return out


def rsi(values: list[float], window: int = 14) -> list[float | None]:
    out: list[float | None] = [None]
    gains: list[float] = []
    losses: list[float] = []
    for idx in range(1, len(values)):
        change = values[idx] - values[idx - 1]
        gains.append(max(change, 0))
        losses.append(abs(min(change, 0)))
        if idx < window:
            out.append(None)
            continue
        avg_gain = sum(gains[-window:]) / window
        avg_loss = sum(losses[-window:]) / window
        if avg_loss == 0:
            out.append(100.0)
        else:
            rs = avg_gain / avg_loss
            out.append(100 - (100 / (1 + rs)))
    return out


def stddev(values: list[float], window: int) -> list[float | None]:
    out: list[float | None] = []
    for idx in range(len(values)):
        if idx < window - 1:
            out.append(None)
            continue
        chunk = values[idx - window + 1 : idx + 1]
        mean = sum(chunk) / window
        variance = sum((v - mean) ** 2 for v in chunk) / window
        out.append(math.sqrt(variance))
    return out


def atr(rows: list[dict[str, Any]], window: int = 14) -> list[float | None]:
    true_ranges = []
    for idx, row in enumerate(rows):
        high = float(row["high"] or row["close"])
        low = float(row["low"] or row["close"])
        prev_close = float(rows[idx - 1]["close"]) if idx else float(row["close"])
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return sma(true_ranges, window)


def pct_change(current: float, previous: float | None) -> float | None:
    if previous in (None, 0):
        return None
    return (current / previous - 1) * 100


def last_non_null(values: list[Any]) -> Any:
    for value in reversed(values):
        if value is not None:
            return value
    return None


def clamp(value: float, low: float = 0, high: float = 100) -> float:
    return max(low, min(high, value))


def build_analysis(symbol: str) -> dict[str, Any]:
    raw = fetch_yahoo_chart(symbol)
    news = fetch_yahoo_news(symbol)
    cleaned = clean_series(raw)
    rows = cleaned["rows"]
    closes = [float(row["close"]) for row in rows]
    volumes = [float(row["volume"] or 0) for row in rows]
    ma20 = sma(closes, 20)
    ma60 = sma(closes, 60)
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    macd_line = [
        (a - b) if a is not None and b is not None else None for a, b in zip(ema12, ema26)
    ]
    macd_values = [v if v is not None else 0.0 for v in macd_line]
    signal_line = ema(macd_values, 9)
    histogram = [
        (m - s) if m is not None and s is not None else None
        for m, s in zip(macd_line, signal_line)
    ]
    rsi14 = rsi(closes, 14)
    std20 = stddev(closes, 20)
    boll_mid = ma20
    boll_upper = [
        (m + 2 * s) if m is not None and s is not None else None for m, s in zip(boll_mid, std20)
    ]
    boll_lower = [
        (m - 2 * s) if m is not None and s is not None else None for m, s in zip(boll_mid, std20)
    ]
    atr14 = atr(rows, 14)
    vol20 = sma(volumes, 20)
    latest = rows[-1]
    close = float(latest["close"])
    previous_close = float(rows[-2]["close"])
    change_pct = pct_change(close, previous_close) or 0.0
    perf_20 = pct_change(close, closes[-21] if len(closes) > 21 else None)
    perf_60 = pct_change(close, closes[-61] if len(closes) > 61 else None)
    perf_120 = pct_change(close, closes[-121] if len(closes) > 121 else None)
    latest_ma20 = last_non_null(ma20)
    latest_ma60 = last_non_null(ma60)
    latest_rsi = last_non_null(rsi14)
    latest_macd = last_non_null(macd_line)
    latest_hist = last_non_null(histogram)
    latest_atr = last_non_null(atr14)
    latest_vol20 = last_non_null(vol20)
    volume_ratio = (latest["volume"] / latest_vol20) if latest_vol20 else None
    volatility = (
        statistics_like_daily_volatility(closes[-60:]) if len(closes) >= 60 else None
    )
    scores = score_snapshot(
        close=close,
        ma20=latest_ma20,
        ma60=latest_ma60,
        rsi_value=latest_rsi,
        macd_hist=latest_hist,
        volume_ratio=volume_ratio,
        volatility=volatility,
        perf_20=perf_20,
    )
    signal = build_trade_signal(
        close=close,
        ma20=latest_ma20,
        ma60=latest_ma60,
        rsi_value=latest_rsi,
        macd_hist=latest_hist,
        boll_upper=last_non_null(boll_upper),
        boll_lower=last_non_null(boll_lower),
        atr_value=latest_atr,
        volume_ratio=volume_ratio,
        scores=scores,
    )
    timeframe_signals = build_timeframe_signals(
        closes=closes,
        ma20=ma20,
        ma60=ma60,
        rsi14=rsi14,
        histogram=histogram,
        volume_ratio=volume_ratio,
        risk_score=scores["risk_control"],
    )
    enriched_rows = []
    for idx, row in enumerate(rows[-180:]):
        source_idx = len(rows) - len(rows[-180:]) + idx
        enriched_rows.append(
            {
                **row,
                "ma20": ma20[source_idx],
                "ma60": ma60[source_idx],
                "rsi": rsi14[source_idx],
                "macd": macd_line[source_idx],
                "macd_signal": signal_line[source_idx],
                "macd_hist": histogram[source_idx],
                "boll_upper": boll_upper[source_idx],
                "boll_mid": boll_mid[source_idx],
                "boll_lower": boll_lower[source_idx],
                "atr": atr14[source_idx],
            }
        )
    meta = cleaned["meta"]
    return {
        "symbol": symbol,
        "asset_type": detect_asset_type(symbol),
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "currency": meta.get("currency") or "",
        "exchange": meta.get("exchangeName") or meta.get("fullExchangeName") or "",
        "quote": {
            "date": latest["date"],
            "price": close,
            "change_pct": change_pct,
            "volume": latest["volume"],
            "performance": {"20d": perf_20, "60d": perf_60, "120d": perf_120},
        },
        "latest_indicators": {
            "ma20": latest_ma20,
            "ma60": latest_ma60,
            "rsi14": latest_rsi,
            "macd": latest_macd,
            "macd_hist": latest_hist,
            "boll_upper": last_non_null(boll_upper),
            "boll_lower": last_non_null(boll_lower),
            "atr14": latest_atr,
            "volume_ratio": volume_ratio,
            "volatility_60d_annualized": volatility,
        },
        "signal": signal,
        "timeframe_signals": timeframe_signals,
        "news": news,
        "scores": scores,
        "series": enriched_rows,
    }


def statistics_like_daily_volatility(values: list[float]) -> float:
    returns = []
    for idx in range(1, len(values)):
        if values[idx - 1] != 0:
            returns.append(values[idx] / values[idx - 1] - 1)
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return math.sqrt(variance) * math.sqrt(252) * 100


def score_snapshot(**kwargs: Any) -> dict[str, float]:
    close = kwargs["close"]
    ma20 = kwargs["ma20"]
    ma60 = kwargs["ma60"]
    rsi_value = kwargs["rsi_value"]
    macd_hist = kwargs["macd_hist"]
    volume_ratio = kwargs["volume_ratio"]
    volatility = kwargs["volatility"]
    perf_20 = kwargs["perf_20"]
    trend = 50
    if ma20:
        trend += 20 if close > ma20 else -20
    if ma60:
        trend += 20 if close > ma60 else -20
    momentum = 50 + clamp((perf_20 or 0) * 2, -35, 35)
    if macd_hist is not None:
        momentum += 10 if macd_hist > 0 else -10
    if rsi_value is not None:
        momentum -= max(0, rsi_value - 75) * 0.8
        momentum += max(0, 35 - rsi_value) * 0.5
    volume_score = 50
    if volume_ratio is not None:
        volume_score += clamp((volume_ratio - 1) * 35, -25, 30)
    risk = 75
    if volatility is not None:
        risk -= clamp((volatility - 25) * 1.2, -15, 45)
    if rsi_value is not None and (rsi_value > 80 or rsi_value < 20):
        risk -= 15
    return {
        "trend": round(clamp(trend), 1),
        "momentum": round(clamp(momentum), 1),
        "volume": round(clamp(volume_score), 1),
        "risk_control": round(clamp(risk), 1),
        "overall": round(clamp((trend + momentum + volume_score + risk) / 4), 1),
    }


def build_trade_signal(**kwargs: Any) -> dict[str, Any]:
    close = kwargs["close"]
    ma20 = kwargs["ma20"]
    ma60 = kwargs["ma60"]
    rsi_value = kwargs["rsi_value"]
    macd_hist = kwargs["macd_hist"]
    boll_upper = kwargs["boll_upper"]
    boll_lower = kwargs["boll_lower"]
    atr_value = kwargs["atr_value"]
    volume_ratio = kwargs["volume_ratio"]
    scores = kwargs["scores"]
    points = 0
    reasons: list[str] = []
    cautions: list[str] = []

    if ma20 and close > ma20:
        points += 18
        reasons.append("价格站上 MA20，短线趋势偏强。")
    elif ma20:
        points -= 16
        cautions.append("价格低于 MA20，短线趋势仍弱。")

    if ma60 and close > ma60:
        points += 16
        reasons.append("价格站上 MA60，中期结构尚可。")
    elif ma60:
        points -= 14
        cautions.append("价格低于 MA60，中期结构偏谨慎。")

    if macd_hist is not None and macd_hist > 0:
        points += 14
        reasons.append("MACD 柱体为正，动量改善。")
    elif macd_hist is not None:
        points -= 12
        cautions.append("MACD 柱体为负，动量尚未转强。")

    if rsi_value is not None:
        if 45 <= rsi_value <= 68:
            points += 10
            reasons.append("RSI 位于健康区间，未明显过热。")
        elif rsi_value > 75:
            points -= 20
            cautions.append("RSI 偏高，短线有过热回撤风险。")
        elif rsi_value < 35:
            points -= 6
            cautions.append("RSI 偏弱，需等待企稳确认。")

    if volume_ratio is not None:
        if volume_ratio >= 1.25:
            points += 8
            reasons.append("量能高于 20 日均量，关注度提升。")
        elif volume_ratio < 0.65:
            points -= 6
            cautions.append("量能偏低，信号确认度不足。")

    if scores["risk_control"] < 40:
        points -= 18
        cautions.append("风险评分偏低，不适合激进跟进。")
    elif scores["risk_control"] > 65:
        points += 8
        reasons.append("风险评分较稳，波动压力可控。")

    confidence = round(clamp(50 + points * 0.7, 5, 95), 1)
    if points >= 30:
        action = "buy_watch"
        label = "买入观察"
        tone = "bullish"
    elif points >= 8:
        action = "hold_watch"
        label = "持有观察"
        tone = "neutral"
    elif points <= -25:
        action = "avoid_or_sell"
        label = "卖出/回避"
        tone = "bearish"
    else:
        action = "wait"
        label = "等待确认"
        tone = "neutral"

    support = [v for v in [ma20, boll_lower, ma60] if v]
    resistance = [v for v in [boll_upper, close + (atr_value or close * 0.03), close * 1.03] if v]
    stop_reference = None
    if atr_value:
        stop_reference = close - 1.5 * atr_value
    elif ma20:
        stop_reference = ma20 * 0.98

    return {
        "action": action,
        "label": label,
        "tone": tone,
        "confidence": confidence,
        "score": points,
        "reasons": reasons[:4],
        "cautions": cautions[:4],
        "levels": {
            "support": [round(v, 4) for v in support[:3]],
            "resistance": [round(v, 4) for v in resistance[:3]],
            "stop_reference": round(stop_reference, 4) if stop_reference else None,
        },
        "disclaimer": "信号仅用于研究观察，不构成买卖建议或交易指令。",
    }


def build_timeframe_signals(**kwargs: Any) -> list[dict[str, Any]]:
    closes = kwargs["closes"]
    ma20 = kwargs["ma20"]
    ma60 = kwargs["ma60"]
    rsi14 = kwargs["rsi14"]
    histogram = kwargs["histogram"]
    volume_ratio = kwargs["volume_ratio"]
    risk_score = kwargs["risk_score"]
    close = closes[-1]
    frames = [
        ("短线", "1-5 个交易日", 5, last_non_null(ma20), "看价格能否延续 MA20 上方强度。"),
        ("波段", "2-4 周", 20, last_non_null(ma20), "看 20 日趋势和 MACD 动量是否同向。"),
        ("中线", "1-3 个月", 60, last_non_null(ma60), "看价格是否保持在 MA60 上方并控制回撤。"),
    ]
    latest_rsi = last_non_null(rsi14)
    latest_hist = last_non_null(histogram)
    signals = []
    for name, horizon, lookback, anchor, focus in frames:
        past = closes[-lookback - 1] if len(closes) > lookback else None
        perf = pct_change(close, past)
        points = 0
        notes = []
        if anchor:
            if close > anchor:
                points += 22
                notes.append("价格在关键均线上方")
            else:
                points -= 22
                notes.append("价格低于关键均线")
        if perf is not None:
            if perf > 3:
                points += 16
                notes.append(f"{lookback} 日表现偏强")
            elif perf < -3:
                points -= 16
                notes.append(f"{lookback} 日表现偏弱")
        if latest_hist is not None:
            points += 10 if latest_hist > 0 else -10
        if latest_rsi is not None:
            if latest_rsi > 75:
                points -= 14
                notes.append("RSI 偏热")
            elif latest_rsi < 35:
                points -= 8
                notes.append("RSI 偏弱")
        if volume_ratio is not None and volume_ratio >= 1.2:
            points += 6
        if risk_score < 40:
            points -= 12
            notes.append("风险评分偏低")
        label = "等待确认"
        tone = "neutral"
        if points >= 24:
            label = "买入观察"
            tone = "bullish"
        elif points <= -22:
            label = "卖出/回避"
            tone = "bearish"
        elif points >= 6:
            label = "持有观察"
        signals.append(
            {
                "name": name,
                "horizon": horizon,
                "label": label,
                "tone": tone,
                "confidence": round(clamp(50 + points * 0.8, 5, 95), 1),
                "performance": perf,
                "focus": focus,
                "notes": notes[:3],
            }
        )
    return signals


def local_report(analysis: dict[str, Any]) -> dict[str, Any]:
    scores = analysis["scores"]
    indicators = analysis["latest_indicators"]
    price = analysis["quote"]["price"]
    signal = analysis.get("signal") or {}
    rsi_value = indicators.get("rsi14")
    ma20 = indicators.get("ma20")
    ma60 = indicators.get("ma60")
    stance = "neutral"
    if scores["overall"] >= 68 and scores["risk_control"] >= 45:
        stance = "bullish"
    elif scores["overall"] <= 42 or scores["risk_control"] <= 35:
        stance = "bearish"
    opportunities = []
    risks = []
    if ma20 and price > ma20:
        opportunities.append("价格位于 MA20 上方，短期趋势保持相对强势。")
    else:
        risks.append("价格未能站稳 MA20，短线趋势仍需确认。")
    if ma60 and price > ma60:
        opportunities.append("价格位于 MA60 上方，中期趋势结构较健康。")
    else:
        risks.append("价格低于或接近 MA60，中期趋势可能偏弱。")
    if rsi_value is not None:
        if rsi_value > 75:
            risks.append("RSI 偏高，短线存在过热或回撤风险。")
        elif rsi_value < 35:
            opportunities.append("RSI 偏低，若价格企稳可能出现修复机会。")
    if indicators.get("volume_ratio") and indicators["volume_ratio"] > 1.5:
        opportunities.append("成交量显著高于 20 日均量，资金关注度提升。")
    if indicators.get("volatility_60d_annualized") and indicators["volatility_60d_annualized"] > 45:
        risks.append("近 60 日年化波动率较高，仓位和止损需要更保守。")
    news = analysis.get("news") or []
    if news:
        latest_titles = "；".join(item.get("title", "") for item in news[:3] if item.get("title"))
        opportunities.append(f"近期资讯已纳入观察，最新主题包括：{latest_titles}。")
    else:
        risks.append("当前新闻源没有返回相关资讯，报告主要依赖价格和技术指标。")
    support = [round(v, 4) for v in [ma20, indicators.get("boll_lower"), ma60] if v]
    resistance = [round(v, 4) for v in [indicators.get("boll_upper"), price * 1.03] if v]
    return {
        "source": "local_rules",
        "stance": stance,
        "summary": f"{analysis['symbol']} 当前综合评分 {scores['overall']}，观点为 {stance}。",
        "opportunities": opportunities[:4] or ["当前没有明显的高确定性机会，建议等待更清晰的趋势或量能信号。"],
        "risks": risks[:4] or ["主要风险来自行情突发变化、数据延迟和模型判断不确定性。"],
        "key_levels": {"support": support[:3], "resistance": resistance[:3]},
        "trade_signal": signal,
        "watch_plan": [
            "观察价格能否持续站稳 MA20。",
            "观察 MACD 柱体是否继续改善。",
            "跟踪后续新闻是否确认或反转当前价格信号。",
            "若放量突破近期压力位，再提高关注级别。",
        ],
        "news_brief": [
            {
                "title": item.get("title", ""),
                "publisher": item.get("publisher", ""),
                "published_at": item.get("published_at", ""),
            }
            for item in news[:5]
        ],
        "disclaimer": "仅供研究和信息分析，不构成投资建议或交易指令。",
    }


def call_ai_report(analysis: dict[str, Any]) -> dict[str, Any] | None:
    api_key = (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("OPENROUTER_API_KEY")
    )
    if not api_key:
        return None
    base_url = os.environ.get("OPENAI_BASE_URL")
    model = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
    if os.environ.get("DEEPSEEK_API_KEY") and not os.environ.get("OPENAI_API_KEY"):
        base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
        model = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
    if os.environ.get("OPENROUTER_API_KEY"):
        base_url = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
        model = os.environ.get("OPENROUTER_MODEL", model)
    base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
    prompt = {
        "symbol": analysis["symbol"],
        "asset_type": analysis["asset_type"],
        "quote": analysis["quote"],
        "latest_indicators": analysis["latest_indicators"],
        "scores": analysis["scores"],
        "signal": analysis.get("signal", {}),
        "timeframe_signals": analysis.get("timeframe_signals", []),
        "news": analysis.get("news", [])[:8],
    }
    body = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是谨慎的量化研究助理。请输出严格 JSON，字段包含 stance, summary, "
                    "opportunities, risks, key_levels, watch_plan, disclaimer。"
                    "opportunities、risks、watch_plan 必须是字符串数组；"
                    "key_levels 必须包含 support 和 resistance 两个数组。不要给自动下单建议。"
                ),
            },
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ],
    }
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "QuantAIWorkbench/0.1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        content = payload["choices"][0]["message"]["content"]
        parsed = json.loads(extract_json(content))
        parsed["source"] = "ai"
        return normalize_report(parsed, analysis)
    except Exception:
        return None


def coerce_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        result = []
        for item in value:
            if isinstance(item, str):
                text = item.strip()
            elif isinstance(item, dict):
                text = (
                    item.get("text")
                    or item.get("title")
                    or item.get("summary")
                    or json.dumps(item, ensure_ascii=False)
                )
            else:
                text = str(item)
            if text:
                result.append(text)
        return result
    if isinstance(value, dict):
        return [
            f"{key}: {val}" if not isinstance(val, (dict, list)) else f"{key}: {json.dumps(val, ensure_ascii=False)}"
            for key, val in value.items()
        ]
    text = str(value).strip()
    return [text] if text else []


def coerce_number_list(value: Any) -> list[float | str]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    result: list[float | str] = []
    for item in value:
        if item in (None, ""):
            continue
        try:
            result.append(round(float(item), 4))
        except (TypeError, ValueError):
            result.append(str(item))
    return result


def normalize_report(report: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    fallback = local_report(analysis)
    stance = str(report.get("stance") or fallback["stance"]).lower()
    if stance not in {"bullish", "neutral", "bearish"}:
        stance = fallback["stance"]
    key_levels = report.get("key_levels") if isinstance(report.get("key_levels"), dict) else {}
    normalized = {
        "source": report.get("source", "ai"),
        "stance": stance,
        "summary": str(report.get("summary") or fallback["summary"]),
        "opportunities": coerce_text_list(report.get("opportunities")) or fallback["opportunities"],
        "risks": coerce_text_list(report.get("risks")) or fallback["risks"],
        "key_levels": {
            "support": coerce_number_list(key_levels.get("support")) or fallback["key_levels"]["support"],
            "resistance": coerce_number_list(key_levels.get("resistance")) or fallback["key_levels"]["resistance"],
        },
        "watch_plan": coerce_text_list(report.get("watch_plan")) or fallback["watch_plan"],
        "trade_signal": report.get("trade_signal") if isinstance(report.get("trade_signal"), dict) else fallback.get("trade_signal"),
        "news_brief": report.get("news_brief") if isinstance(report.get("news_brief"), list) else fallback.get("news_brief", []),
        "disclaimer": str(report.get("disclaimer") or fallback["disclaimer"]),
    }
    return normalized


def extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def save_report(symbol: str, asset_type: str, report: dict[str, Any]) -> int:
    ensure_db()
    created_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            INSERT INTO reports(symbol, asset_type, stance, summary, report_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                symbol,
                asset_type,
                report.get("stance", "neutral"),
                report.get("summary", ""),
                json.dumps(report, ensure_ascii=False),
                created_at,
            ),
        )
        return int(cursor.lastrowid)


def list_reports() -> list[dict[str, Any]]:
    ensure_db()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, symbol, asset_type, stance, summary, report_json, created_at
            FROM reports ORDER BY created_at DESC LIMIT 50
            """
        ).fetchall()
    return [
        {
            "id": row["id"],
            "symbol": row["symbol"],
            "asset_type": row["asset_type"],
            "stance": row["stance"],
            "summary": row["summary"],
            "report": json.loads(row["report_json"]),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


class Handler(BaseHTTPRequestHandler):
    server_version = "QuantAIWorkbench/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        timestamp = time.strftime("%H:%M:%S")
        print(f"[{timestamp}] {self.address_string()} {fmt % args}")

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path == "/api/analyze":
                query = urllib.parse.parse_qs(parsed.query)
                symbol = normalize_symbol((query.get("symbol") or [""])[0])
                analysis = build_analysis(symbol)
                json_response(self, analysis)
                return
            if path == "/api/reports":
                json_response(self, {"reports": list_reports()})
                return
            self.serve_static(path)
        except Exception as exc:
            traceback.print_exc()
            json_response(self, {"error": str(exc)}, status=500)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if self.path == "/api/report":
                symbol = normalize_symbol(payload.get("symbol", ""))
                analysis = payload.get("analysis") or build_analysis(symbol)
                report = call_ai_report(analysis) or local_report(analysis)
                report_id = save_report(symbol, analysis["asset_type"], report)
                json_response(self, {"id": report_id, "report": report})
                return
            json_response(self, {"error": "Not found"}, status=404)
        except Exception as exc:
            traceback.print_exc()
            json_response(self, {"error": str(exc)}, status=500)

    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            file_path = STATIC_DIR / "index.html"
        else:
            safe = path.lstrip("/")
            file_path = (STATIC_DIR / safe).resolve()
            if not str(file_path).startswith(str(STATIC_DIR.resolve())):
                text_response(self, b"Forbidden", "text/plain", 403)
                return
        if not file_path.exists() or not file_path.is_file():
            text_response(self, b"Not found", "text/plain", 404)
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(file_path.suffix, "application/octet-stream")
        text_response(self, file_path.read_bytes(), content_type)


def main() -> None:
    load_env_file()
    ensure_db()
    preferred_port = DEFAULT_PORT
    if len(sys.argv) > 1:
        preferred_port = int(sys.argv[1])
    server, port = create_server(preferred_port)
    print(f"Quant AI Workbench running at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


def create_server(preferred_port: int) -> tuple[ThreadingHTTPServer, int]:
    for port in range(preferred_port, preferred_port + 20):
        try:
            return ThreadingHTTPServer(("127.0.0.1", port), Handler), port
        except OSError as exc:
            if exc.errno not in {48, 98, 10048}:
                raise
            print(f"Port {port} is already in use, trying {port + 1}...")
    raise OSError(f"No available local port from {preferred_port} to {preferred_port + 19}")


if __name__ == "__main__":
    main()
