"""Market data provider built on Yahoo Finance (via yfinance).

All functions return plain JSON-serializable dicts. A small in-process TTL
cache keeps repeated requests (chart redraws, quote polling from multiple
tabs) from hammering Yahoo.
"""

import math
import threading
import time

import yfinance as yf

_cache = {}
_cache_lock = threading.Lock()


def _cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (now + ttl, value)
        # opportunistic cleanup so the cache can't grow unbounded
        if len(_cache) > 512:
            for k in [k for k, (exp, _) in _cache.items() if exp <= now]:
                del _cache[k]
    return value


# tf -> (yahoo period, yahoo interval, cache ttl seconds, aggregate seconds)
TIMEFRAMES = {
    "d": ("5y", "1d", 300, None),
    "w": ("max", "1wk", 900, None),
    "m": ("max", "1mo", 3600, None),
    "i1": ("4d", "1m", 45, None),
    "i5": ("15d", "5m", 60, None),
    "i10": ("15d", "5m", 60, 600),  # Yahoo has no 10m; aggregate 5m pairs
    "i15": ("1mo", "15m", 90, None),
    "i60": ("3mo", "1h", 180, None),
}

BENCHMARK = "^GSPC"


def _clean(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def _history_arrays(symbol, period, interval, start=None, end=None, prepost=False):
    if start:
        df = yf.Ticker(symbol).history(
            start=start, end=end, interval=interval, auto_adjust=True, prepost=prepost
        )
    else:
        df = yf.Ticker(symbol).history(
            period=period, interval=interval, auto_adjust=True, prepost=prepost
        )
    if df is None or df.empty:
        return None
    out = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    for ts, row in zip(df.index, df.itertuples(index=False)):
        o, h, l, c = row.Open, row.High, row.Low, row.Close
        if c is None or (isinstance(c, float) and math.isnan(c)):
            continue
        out["t"].append(int(ts.timestamp()))
        out["o"].append(round(float(o), 4))
        out["h"].append(round(float(h), 4))
        out["l"].append(round(float(l), 4))
        out["c"].append(round(float(c), 4))
        out["v"].append(int(row.Volume) if row.Volume == row.Volume else 0)
    return out if out["t"] else None


def _aggregate(bars, group_secs):
    """Aggregate intraday bars into fixed buckets (e.g. 5m -> 10m)."""
    out = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    cur = None
    for i in range(len(bars["t"])):
        bucket = bars["t"][i] - (bars["t"][i] % group_secs)
        if cur != bucket:
            cur = bucket
            out["t"].append(bucket)
            out["o"].append(bars["o"][i])
            out["h"].append(bars["h"][i])
            out["l"].append(bars["l"][i])
            out["c"].append(bars["c"][i])
            out["v"].append(bars["v"][i])
        else:
            out["h"][-1] = max(out["h"][-1], bars["h"][i])
            out["l"][-1] = min(out["l"][-1], bars["l"][i])
            out["c"][-1] = bars["c"][i]
            out["v"][-1] += bars["v"][i]
    return out


def get_chart(symbol, tf, day=None, prepost=False):
    symbol = symbol.upper().strip()
    if tf == "i":
        tf = "i10"  # legacy alias
    if tf not in TIMEFRAMES:
        raise ValueError(f"unknown timeframe {tf!r}")
    period, interval, ttl, agg = TIMEFRAMES[tf]
    intraday = tf.startswith("i")
    prepost = bool(prepost) and intraday  # extended hours: intraday only
    if day and not intraday:
        day = None  # day replay only applies to intraday views

    def build():
        if day:
            import datetime as _dt

            try:
                d0 = _dt.date.fromisoformat(day)
            except ValueError:
                return {"error": f"bad date {day!r}"}
            bars = _history_arrays(
                symbol, None, interval,
                start=d0.isoformat(), end=(d0 + _dt.timedelta(days=1)).isoformat(),
                prepost=prepost,
            )
            if bars is None:
                return {
                    "error": f"no intraday data for {symbol} on {day} "
                    "(Yahoo keeps ~30 days of 1-min and ~60 days of 5-min data)"
                }
        else:
            bars = _history_arrays(symbol, period, interval, prepost=prepost)
            if bars is None:
                return {"error": f"no data for {symbol}"}
        if agg:
            bars = _aggregate(bars, agg)

        result = {"symbol": symbol, "tf": tf, "bars": bars, "day": day, "prepost": prepost}

        # Benchmark closes aligned to the same timestamps, for the RS line.
        if tf in ("d", "w", "m"):
            try:
                bench = _cached(
                    ("hist", BENCHMARK, period, interval),
                    ttl,
                    lambda: _history_arrays(BENCHMARK, period, interval),
                )
                if bench:
                    by_ts = dict(zip(bench["t"], bench["c"]))
                    aligned, last = [], None
                    for ts in bars["t"]:
                        last = by_ts.get(ts, last)
                        aligned.append(last)
                    result["bench"] = aligned
            except Exception:
                pass

        # Past earnings dates for chart markers + EPS YoY table.
        if tf in ("d", "w", "m"):
            try:
                result["earnings"] = _cached(
                    ("earn", symbol), 3600, lambda: _earnings(symbol)
                )
            except Exception:
                result["earnings"] = []
        return result

    cache_ttl = 3600 if day and day != time.strftime("%Y-%m-%d") else ttl
    return _cached(("chart", symbol, tf, day, prepost), cache_ttl, build)


def _earnings(symbol):
    df = yf.Ticker(symbol).get_earnings_dates(limit=24)
    if df is None or df.empty:
        return []
    rows = []
    now = time.time()
    for ts, row in df.sort_index().iterrows():
        if ts.timestamp() > now:
            continue  # upcoming report — would draw a bogus flag on the last bar
        eps = row.get("Reported EPS")
        est = row.get("EPS Estimate")
        sur = row.get("Surprise(%)")
        rows.append(
            {
                "t": int(ts.timestamp()),
                "eps": _clean(float(eps)) if eps is not None else None,
                # explicit None checks: `or` would turn a legitimate 0.0 into None
                "est": _clean(float(est)) if est is not None else None,
                "surprise": _clean(float(sur)) if sur is not None else None,
            }
        )
    # YoY % change vs the report 4 quarters earlier
    for i, r in enumerate(rows):
        prior = rows[i - 4] if i >= 4 else None
        if r["eps"] is not None and prior and prior["eps"]:
            r["yoy"] = round((r["eps"] - prior["eps"]) / abs(prior["eps"]) * 100, 1)
        else:
            r["yoy"] = None
    return rows


def get_quote(symbol):
    symbol = symbol.upper().strip()

    def build():
        fi = yf.Ticker(symbol).fast_info
        # fast_info.previous_close is loosely derived and can be wrong after
        # big gaps (VELO bug); the regular-market field is authoritative.
        prev = None
        try:
            prev = _clean(fi.regular_market_previous_close)
        except Exception:
            pass
        if prev is None:
            prev = _clean(fi.previous_close)
        return {
            "symbol": symbol,
            "last": _clean(fi.last_price),
            "prevClose": prev,
            "currency": getattr(fi, "currency", None),
            "open": _clean(fi.open),
            "dayHigh": _clean(fi.day_high),
            "dayLow": _clean(fi.day_low),
            "volume": _clean(fi.last_volume),
            "ts": int(time.time()),
        }

    return _cached(("quote", symbol), 3, build)


def get_profile(symbol):
    symbol = symbol.upper().strip()

    def build():
        t = yf.Ticker(symbol)
        info = {}
        try:
            info = t.get_info() or {}
        except Exception:
            pass
        next_earnings = None
        try:
            cal = t.calendar or {}
            dates = cal.get("Earnings Date") or []
            if dates:
                next_earnings = str(dates[0])
        except Exception:
            pass
        ipo = None
        try:
            t.history(period="5d")
            ftd = (t.history_metadata or {}).get("firstTradeDate")
            if ftd:
                ipo = time.strftime("%m/%d/%Y", time.gmtime(int(ftd)))
        except Exception:
            pass
        hq = ", ".join(x for x in [info.get("city"), info.get("state") or info.get("country")] if x) or None
        summary = info.get("longBusinessSummary")
        if summary:
            cut = summary[:170]
            summary = cut[: cut.rfind(" ")] + "…" if len(summary) > 170 else summary
        return {
            "summary": summary,
            "website": info.get("website"),
            "hq": hq,
            "ipoDate": ipo,
            "symbol": symbol,
            "name": info.get("shortName") or info.get("longName") or symbol,
            "exchange": info.get("fullExchangeName") or info.get("exchange"),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "marketCap": _clean(info.get("marketCap")),
            "trailingPE": _clean(info.get("trailingPE")),
            "forwardPE": _clean(info.get("forwardPE")),
            "trailingEps": _clean(info.get("trailingEps")),
            "floatShares": _clean(info.get("floatShares")),
            "sharesOutstanding": _clean(info.get("sharesOutstanding")),
            "high52": _clean(info.get("fiftyTwoWeekHigh")),
            "low52": _clean(info.get("fiftyTwoWeekLow")),
            "avgVolume": _clean(info.get("averageVolume")),
            "nextEarnings": next_earnings,
            # expanded fundamentals for the weekly/monthly Reports dock
            "beta": _clean(info.get("beta")),
            "priceToSales": _clean(info.get("priceToSalesTrailing12Months")),
            "roe": _clean(info.get("returnOnEquity")),
            "netMargin": _clean(info.get("profitMargins")),
            "grossMargin": _clean(info.get("grossMargins")),
            "ebitdaMargin": _clean(info.get("ebitdaMargins")),
            "dividendYield": _clean(info.get("dividendYield")),
            "exDivDate": (
                time.strftime("%m/%d/%Y", time.gmtime(int(info["exDividendDate"])))
                if info.get("exDividendDate")
                else None
            ),
            "debtToEquity": _clean(info.get("debtToEquity")),
            "shortPctFloat": _clean(info.get("shortPercentOfFloat")),
            "shortRatio": _clean(info.get("shortRatio")),
            "instHeldPct": _clean(info.get("heldPercentInstitutions")),
            "currency": info.get("currency") or info.get("financialCurrency"),
        }

    return _cached(("profile", symbol), 1800, build)


def get_financials(symbol):
    from . import financials

    symbol = symbol.upper().strip()
    return _cached(("fin", symbol), 43200, lambda: financials.get_financials(symbol))


def get_rs_rating(symbol):
    from . import rsrating

    symbol = symbol.upper().strip()

    def build():
        chart = get_chart(symbol, "d")
        if "error" in chart:
            return {"status": "na"}
        closes = chart["bars"]["c"][-260:]
        return rsrating.get_rs_rating(symbol, closes)

    with _cache_lock:
        hit = _cache.get(("rs", symbol))
        if hit and hit[0] > time.time():
            return hit[1]
    result = build()
    if result.get("status") == "ok":  # don't cache "warming" responses
        with _cache_lock:
            _cache[("rs", symbol)] = (time.time() + 1800, result)
    return result


def search(query):
    query = query.strip()
    if not query:
        return []

    def build():
        out = []
        for q in yf.Search(query, max_results=8).quotes:
            if not q.get("symbol"):
                continue
            out.append(
                {
                    "symbol": q["symbol"],
                    "name": q.get("shortname") or q.get("longname") or "",
                    "exchange": q.get("exchDisp") or q.get("exchange") or "",
                    "type": q.get("quoteType") or "",
                }
            )
        return out

    return _cached(("search", query.lower()), 600, build)
