// Port of server/data.py — chart, quote, profile, search.
// Built on Yahoo's v8 chart + v10 quoteSummary + v1 search endpoints.

import { Env, cleanNum } from "./env";
import { cached, crumbedGet, yfetch } from "./yahoo";

const BENCH = "^GSPC";
const DAY = 86400;

interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

// tf -> { lookback days, yahoo interval, cache ttl, aggregate secs }
const TIMEFRAMES: Record<string, { days: number; iv: string; ttl: number; agg: number | null }> = {
  d: { days: 5 * 365, iv: "1d", ttl: 300, agg: null },
  w: { days: 30 * 365, iv: "1wk", ttl: 900, agg: null },
  m: { days: 40 * 365, iv: "1mo", ttl: 3600, agg: null },
  i1: { days: 5, iv: "1m", ttl: 45, agg: null },
  i5: { days: 15, iv: "5m", ttl: 60, agg: null },
  i10: { days: 15, iv: "5m", ttl: 60, agg: 600 },
  i15: { days: 30, iv: "15m", ttl: 90, agg: null },
  i60: { days: 90, iv: "1h", ttl: 180, agg: null },
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function chartUrl(symbol: string, p1: number, p2: number, iv: string): string {
  return (
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${p1}&period2=${p2}&interval=${iv}&events=div%2Csplit&includePrePost=false`
  );
}

async function historyArrays(symbol: string, p1: number, p2: number, iv: string): Promise<Bars | null> {
  const r = await yfetch(chartUrl(symbol, p1, p2, iv));
  if (!r.ok) return null;
  const j: any = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res || !res.timestamp) return null;
  const ts: number[] = res.timestamp;
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose; // only on 1d+ intervals
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c === null || c === undefined || !isFinite(c)) continue;
    // Replicate yfinance auto_adjust=True: scale OHLC by adjclose/close.
    const factor = adj && isFinite(adj[i]) && c ? adj[i] / c : 1;
    const o = q.open?.[i],
      h = q.high?.[i],
      l = q.low?.[i],
      vol = q.volume?.[i];
    if (o == null || h == null || l == null) continue;
    out.t.push(ts[i]);
    out.o.push(round4(o * factor));
    out.h.push(round4(h * factor));
    out.l.push(round4(l * factor));
    out.c.push(round4(c * factor));
    out.v.push(vol == null ? 0 : Math.trunc(vol));
  }
  return out.t.length ? out : null;
}

function aggregate(bars: Bars, groupSecs: number): Bars {
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let cur: number | null = null;
  for (let i = 0; i < bars.t.length; i++) {
    const bucket = bars.t[i] - (bars.t[i] % groupSecs);
    if (cur !== bucket) {
      cur = bucket;
      out.t.push(bucket);
      out.o.push(bars.o[i]);
      out.h.push(bars.h[i]);
      out.l.push(bars.l[i]);
      out.c.push(bars.c[i]);
      out.v.push(bars.v[i]);
    } else {
      const k = out.h.length - 1;
      out.h[k] = Math.max(out.h[k], bars.h[i]);
      out.l[k] = Math.min(out.l[k], bars.l[i]);
      out.c[k] = bars.c[i];
      out.v[k] += bars.v[i];
    }
  }
  return out;
}

export async function getChart(env: Env, symbolRaw: string, tfRaw: string, day: string | null): Promise<any> {
  let tf = tfRaw === "i" ? "i10" : tfRaw;
  const symbol = symbolRaw.toUpperCase().trim();
  const cfg = TIMEFRAMES[tf];
  if (!cfg) throw new ValueErr(`unknown timeframe ${JSON.stringify(tf)}`);
  const intraday = tf.startsWith("i");
  if (day && !intraday) day = null;

  const todayIso = new Date().toISOString().slice(0, 10);
  const cacheTtl = day && day !== todayIso ? 3600 : cfg.ttl;

  return cached(`chart:${symbol}:${tf}:${day || ""}`, cacheTtl, async () => {
    let bars: Bars | null;
    if (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: `bad date ${JSON.stringify(day)}` };
      const d0 = Math.floor(Date.parse(day + "T00:00:00Z") / 1000);
      if (!isFinite(d0)) return { error: `bad date ${JSON.stringify(day)}` };
      bars = await historyArrays(symbol, d0, d0 + DAY, cfg.iv);
      if (!bars)
        return {
          error: `no intraday data for ${symbol} on ${day} (Yahoo keeps ~30 days of 1-min and ~60 days of 5-min data)`,
        };
    } else {
      const p2 = nowSec() + DAY;
      const p1 = p2 - cfg.days * DAY;
      bars = await historyArrays(symbol, p1, p2, cfg.iv);
      if (!bars) return { error: `no data for ${symbol}` };
    }
    if (cfg.agg) bars = aggregate(bars, cfg.agg);

    const result: any = { symbol, tf, bars, day };

    if (tf === "d" || tf === "w" || tf === "m") {
      try {
        const p2 = nowSec() + DAY;
        const p1 = p2 - cfg.days * DAY;
        const bench = (await cached(`hist:${BENCH}:${tf}`, cfg.ttl, () =>
          historyArrays(BENCH, p1, p2, cfg.iv),
        )) as Bars | null;
        if (bench) {
          const byTs = new Map<number, number>();
          for (let i = 0; i < bench.t.length; i++) byTs.set(bench.t[i], bench.c[i]);
          const aligned: (number | null)[] = [];
          let last: number | null = null;
          for (const t of bars.t) {
            if (byTs.has(t)) last = byTs.get(t)!;
            aligned.push(last);
          }
          result.bench = aligned;
        }
      } catch {}
      try {
        result.earnings = await cached(`earn:${symbol}`, 3600, () => earnings(env, symbol));
      } catch {
        result.earnings = [];
      }
    }
    return result;
  });
}

async function earnings(env: Env, symbol: string): Promise<any[]> {
  const { pastEarnings } = await import("./financials");
  const rows = await pastEarnings(env, symbol, 24); // [{t, eps, est, surprise}]
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prior = i >= 4 ? rows[i - 4] : null;
    if (r.eps != null && prior && prior.eps) {
      r.yoy = Math.round(((r.eps - prior.eps) / Math.abs(prior.eps)) * 1000) / 10;
    } else {
      r.yoy = null;
    }
  }
  return rows;
}

export async function getQuote(env: Env, symbolRaw: string): Promise<any> {
  const symbol = symbolRaw.toUpperCase().trim();
  return cached(`quote:${symbol}`, 3, async () => {
    const r = await yfetch(chartUrl(symbol, nowSec() - 5 * DAY, nowSec() + DAY, "1d"));
    const j: any = await r.json();
    const meta = j?.chart?.result?.[0]?.meta || {};
    return {
      symbol,
      last: cleanNum(meta.regularMarketPrice),
      prevClose: cleanNum(meta.chartPreviousClose ?? meta.previousClose),
      open: cleanNum(meta.regularMarketOpen),
      dayHigh: cleanNum(meta.regularMarketDayHigh),
      dayLow: cleanNum(meta.regularMarketDayLow),
      volume: cleanNum(meta.regularMarketVolume),
      ts: nowSec(),
    };
  });
}

function raw(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "object") return cleanNum(v.raw);
  return cleanNum(v);
}

export async function getProfile(env: Env, symbolRaw: string): Promise<any> {
  const symbol = symbolRaw.toUpperCase().trim();
  return cached(`profile:${symbol}`, 1800, async () => {
    const modules = "assetProfile,price,summaryDetail,defaultKeyStatistics,calendarEvents";
    const r = await crumbedGet(
      env,
      (crumb) =>
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
    );
    let res: any = {};
    if (r && r.ok) {
      const j: any = await r.json();
      res = j?.quoteSummary?.result?.[0] || {};
    }
    const ap = res.assetProfile || {};
    const price = res.price || {};
    const sd = res.summaryDetail || {};
    const ks = res.defaultKeyStatistics || {};
    const cal = res.calendarEvents || {};

    // IPO date from chart meta firstTradeDate.
    let ipo: string | null = null;
    try {
      const cr = await yfetch(chartUrl(symbol, nowSec() - 5 * DAY, nowSec() + DAY, "1d"));
      const cj: any = await cr.json();
      const ftd = cj?.chart?.result?.[0]?.meta?.firstTradeDate;
      if (ftd) {
        const d = new Date(ftd * 1000);
        ipo = `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
      }
    } catch {}

    const hqParts = [ap.city, ap.state || ap.country].filter(Boolean);
    const hq = hqParts.length ? hqParts.join(", ") : null;

    let summary: string | null = ap.longBusinessSummary || null;
    if (summary && summary.length > 170) {
      const cut = summary.slice(0, 170);
      summary = cut.slice(0, cut.lastIndexOf(" ")) + "…";
    }

    let nextEarnings: string | null = null;
    const ed = cal?.earnings?.earningsDate;
    if (Array.isArray(ed) && ed.length) {
      const t = raw(ed[0]);
      if (t != null) nextEarnings = new Date(t * 1000).toISOString();
    }

    return {
      summary,
      website: ap.website || null,
      hq,
      ipoDate: ipo,
      symbol,
      name: price.shortName || price.longName || symbol,
      exchange: price.exchangeName || price.fullExchangeName || null,
      sector: ap.sector || null,
      industry: ap.industry || null,
      marketCap: raw(price.marketCap) ?? raw(sd.marketCap),
      trailingPE: raw(sd.trailingPE),
      forwardPE: raw(sd.forwardPE),
      trailingEps: raw(ks.trailingEps),
      floatShares: raw(ks.floatShares),
      sharesOutstanding: raw(ks.sharesOutstanding),
      high52: raw(sd.fiftyTwoWeekHigh),
      low52: raw(sd.fiftyTwoWeekLow),
      avgVolume: raw(sd.averageVolume),
      nextEarnings,
    };
  });
}

export async function search(query: string): Promise<any> {
  const q = query.trim();
  if (!q) return [];
  return cached(`search:${q.toLowerCase()}`, 600, async () => {
    const r = await yfetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
    );
    if (!r.ok) return [];
    const j: any = await r.json();
    const out: any[] = [];
    for (const it of j.quotes || []) {
      if (!it.symbol) continue;
      out.push({
        symbol: it.symbol,
        name: it.shortname || it.longname || "",
        exchange: it.exchDisp || it.exchange || "",
        type: it.quoteType || "",
      });
    }
    return out;
  });
}

export class ValueErr extends Error {}
