// Port of server/financials.py — annual + quarterly EPS/sales with YoY.
// SEC EDGAR via the per-concept API (companyconcept) to keep each response
// small (companyfacts is multi-MB and risks the CPU limit). Street EPS and
// estimates come from Yahoo.

import { Env, cleanNum, secUA } from "./env";
import { cached, crumbedGet, crumbedPost } from "./yahoo";

const REV_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "RevenuesNetOfInterestExpense",
];
const EPS_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAYMS = 86400000;
const dnum = (iso: string) => Math.floor(Date.parse(iso + "T00:00:00Z") / DAYMS);
const epochOf = (iso: string) => Math.floor(Date.parse(iso + "T00:00:00Z") / 1000);

function pct(cur: number | null, prior: number | null): number | null {
  if (cur == null || prior == null || prior === 0) return null;
  return Math.round(((cur - prior) / Math.abs(prior)) * 1000) / 10;
}
function clean(v: number | null): number | null {
  return v == null || !isFinite(v) ? null : v;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---- SEC CIK lookup (cached map in KV) ----
async function cikFor(env: Env, symbol: string): Promise<number | null> {
  const KEY = "sec:cikmap";
  let map = (await env.RS_KV.get(KEY, "json")) as Record<string, number> | null;
  if (!map) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": secUA(env) } });
    if (!r.ok) return null;
    const j: any = await r.json();
    map = {};
    for (const k of Object.keys(j)) {
      const v = j[k];
      if (v?.ticker) map[String(v.ticker).toUpperCase()] = Number(v.cik_str);
    }
    await env.RS_KV.put(KEY, JSON.stringify(map), { expirationTtl: 7 * 86400 });
  }
  return map[symbol.toUpperCase()] ?? null;
}

interface ConceptItem {
  start: string;
  end: string;
  val: number;
}

async function fetchConcept(env: Env, cik: number, tag: string, unitFilter: string): Promise<ConceptItem[]> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, "0")}/us-gaap/${tag}.json`;
  const r = await fetch(url, { headers: { "User-Agent": secUA(env) } });
  if (!r.ok) return [];
  const j: any = await r.json();
  const out: ConceptItem[] = [];
  for (const unit of Object.keys(j.units || {})) {
    if (!unit.includes(unitFilter)) continue;
    for (const it of j.units[unit]) {
      if (it.val == null || !it.start || !it.end) continue;
      out.push({ start: it.start, end: it.end, val: Number(it.val) });
    }
  }
  return out;
}

// Merge concept items across tags in priority order (tags[0] wins), dedup by (start,end).
async function collect(env: Env, cik: number, tags: string[], unitFilter: string): Promise<ConceptItem[]> {
  const results = await Promise.all(tags.map((t) => fetchConcept(env, cik, t, unitFilter)));
  const map = new Map<string, ConceptItem>();
  // reversed so the highest-priority tag (index 0) overwrites last
  for (let i = tags.length - 1; i >= 0; i--) {
    for (const it of results[i]) map.set(`${it.start}|${it.end}`, it);
  }
  return [...map.values()].sort((a, b) => dnum(a.end) - dnum(b.end));
}

function splitDurations(items: ConceptItem[]): {
  quarters: Map<string, number>;
  annuals: Map<string, { start: string; val: number }>;
} {
  const quarters = new Map<string, number>();
  const annuals = new Map<string, { start: string; val: number }>();
  for (const it of items) {
    const dur = dnum(it.end) - dnum(it.start);
    if (dur >= 75 && dur <= 100) quarters.set(it.end, it.val);
    else if (dur >= 340 && dur <= 380) annuals.set(it.end, { start: it.start, val: it.val });
  }
  return { quarters, annuals };
}

function deriveQ4(quarters: Map<string, number>, annuals: Map<string, { start: string; val: number }>): void {
  for (const [end, a] of annuals) {
    if (quarters.has(end)) continue;
    const inside: number[] = [];
    for (const [e, v] of quarters) {
      if (dnum(a.start) < dnum(e) && dnum(e) < dnum(end)) inside.push(v);
    }
    if (inside.length === 3) quarters.set(end, a.val - inside.reduce((s, x) => s + x, 0));
  }
}

function yearAgo(endIso: string, mapping: Map<string, number>, window = 25): number | null {
  const target = dnum(endIso) - 365;
  for (let delta = 0; delta < window; delta++) {
    for (const sign of [1, -1]) {
      const cand = target + delta * sign;
      const iso = new Date(cand * DAYMS).toISOString().slice(0, 10);
      if (mapping.has(iso)) return mapping.get(iso)!;
    }
  }
  return null;
}

// ---- Yahoo street EPS via visualization API ----
export interface EarnRow {
  t: number;
  eps: number | null;
  est: number | null;
  surprise: number | null;
  yoy?: number | null;
}

export async function pastEarnings(env: Env, symbol: string, size: number): Promise<EarnRow[]> {
  const r = await crumbedPost(
    env,
    (crumb) => `https://query1.finance.yahoo.com/v1/finance/visualization?crumb=${encodeURIComponent(crumb)}`,
    {
      sortField: "startdatetime",
      sortType: "DESC",
      entityIdType: "earnings",
      includeFields: ["ticker", "startdatetime", "startdatetimetype", "epsestimate", "epsactual", "epssurprisepct"],
      query: { operator: "eq", operands: ["ticker", symbol] },
      offset: 0,
      size,
    },
  );
  if (!r || !r.ok) return [];
  const j: any = await r.json();
  const doc = j?.finance?.result?.[0]?.documents?.[0];
  if (!doc?.rows) return [];
  const col: Record<string, number> = {};
  doc.columns.forEach((c: any, i: number) => (col[c.id] = i));
  const now = Date.now();
  const rows: EarnRow[] = [];
  for (const row of doc.rows) {
    const dt = Date.parse(row[col.startdatetime]);
    if (!isFinite(dt) || dt > now) continue;
    const eps = cleanNum(row[col.epsactual]);
    if (eps == null) continue;
    rows.push({
      t: Math.floor(dt / 1000),
      eps,
      est: cleanNum(row[col.epsestimate]),
      surprise: cleanNum(row[col.epssurprisepct]),
    });
  }
  rows.sort((a, b) => a.t - b.t); // ascending
  return rows;
}

// ---- Yahoo forward estimates via earningsTrend ----
async function estimates(env: Env, symbol: string): Promise<Record<string, { eps: number | null; sales: number | null; arrow: string | null }>> {
  const r = await crumbedGet(
    env,
    (crumb) =>
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsTrend&crumb=${encodeURIComponent(crumb)}`,
  );
  const out: Record<string, any> = {};
  if (!r || !r.ok) return out;
  const j: any = await r.json();
  const trend = j?.quoteSummary?.result?.[0]?.earningsTrend?.trend || [];
  for (const t of trend) {
    if (t.period !== "0y" && t.period !== "+1y") continue;
    const eps = cleanNum(t.earningsEstimate?.avg?.raw);
    const sales = cleanNum(t.revenueEstimate?.avg?.raw);
    const cur = cleanNum(t.epsTrend?.current?.raw);
    const m30 = cleanNum(t.epsTrend?.["30daysAgo"]?.raw);
    let arrow: string | null = null;
    if (cur != null && m30 != null) arrow = cur > m30 ? "up" : cur < m30 ? "down" : null;
    out[t.period] = { eps, sales, arrow };
  }
  return out;
}

export async function getFinancials(env: Env, symbolRaw: string): Promise<any> {
  const symbol = symbolRaw.toUpperCase().trim();
  return cached(`fin:${symbol}`, 43200, () => buildFinancials(env, symbol));
}

async function buildFinancials(env: Env, symbol: string): Promise<any> {
  let revQ = new Map<string, number>();
  let revA = new Map<string, number>();
  let epsQGaap = new Map<string, number>();
  let epsAGaap = new Map<string, number>();
  let fySpans = new Map<string, string>(); // fy end -> fy start

  try {
    const cik = await cikFor(env, symbol);
    if (cik) {
      const revItems = await collect(env, cik, REV_TAGS, "USD");
      const epsItems = await collect(env, cik, EPS_TAGS, "USD/shares");
      const rs = splitDurations(revItems);
      const es = splitDurations(epsItems);
      deriveQ4(rs.quarters, rs.annuals);
      deriveQ4(es.quarters, es.annuals);
      revQ = rs.quarters;
      revA = new Map([...rs.annuals].map(([e, a]) => [e, a.val]));
      epsQGaap = es.quarters;
      epsAGaap = new Map([...es.annuals].map(([e, a]) => [e, a.val]));
      fySpans = new Map([...rs.annuals].map(([e, a]) => [e, a.start]));
    }
  } catch {}

  const street = await pastEarnings(env, symbol, 40);

  // Map street EPS reports to SEC fiscal quarter-ends.
  const qEnds = [...new Set([...revQ.keys(), ...epsQGaap.keys()])].sort((a, b) => dnum(a) - dnum(b));
  const epsQStreet = new Map<string, number>();
  const reportForQ = new Map<string, number>();
  for (const s of street) {
    if (s.eps == null) continue;
    const rdate = dnum(new Date(s.t * 1000).toISOString().slice(0, 10));
    const cand = qEnds.filter((e) => dnum(e) < rdate && rdate <= dnum(e) + 130);
    let qend: string;
    if (cand.length) qend = cand[cand.length - 1];
    else {
      const d = new Date((s.t - 45 * 86400) * 1000);
      qend = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-28`;
    }
    epsQStreet.set(qend, s.eps);
    reportForQ.set(qend, s.t);
  }

  // ---------- quarterly table ----------
  const allQ = [...new Set([...qEnds, ...epsQStreet.keys()])].sort((a, b) => dnum(a) - dnum(b));
  let quarterly = allQ.map((e) => {
    const [y, m] = e.split("-").map(Number);
    const eps = epsQStreet.has(e) ? epsQStreet.get(e)! : epsQGaap.get(e) ?? null;
    const epsPrior = yearAgo(e, epsQStreet) ?? yearAgo(e, epsQGaap);
    const sales = revQ.get(e) ?? null;
    const salesPrior = yearAgo(e, revQ);
    return {
      end: e,
      t: epochOf(e),
      label: `${MONTHS[m - 1]} ${String(y).slice(2)}`,
      full: `Qtr Ended ${MONTHS_FULL[m - 1]} ${y}`,
      eps: eps != null ? clean(round2(eps)) : null,
      epsPrior: epsPrior != null ? clean(round2(epsPrior)) : null,
      epsPct: pct(eps, epsPrior),
      sales: sales != null ? clean(Math.round((sales / 1e6) * 10) / 10) : null,
      salesPrior: salesPrior != null ? clean(Math.round((salesPrior / 1e6) * 10) / 10) : null,
      salesPct: pct(sales, salesPrior),
      report: reportForQ.get(e) ?? null,
    };
  });
  quarterly = quarterly.slice(-40);

  // ---------- annual table ----------
  const fyEnds = [...new Set([...revA.keys(), ...epsAGaap.keys()])].sort((a, b) => dnum(a) - dnum(b));
  const fyMonth = fyEnds.length ? MONTHS[Number(fyEnds[fyEnds.length - 1].split("-")[1]) - 1] : "Dec";
  const annual: { year: number; end: string; eps: number | null; sales: number | null; epsPct?: number | null; salesPct?: number | null }[] = [];
  for (const e of fyEnds) {
    const year = Number(e.split("-")[0]);
    if (year < 2015) continue;
    const spanStart = fySpans.get(e) ?? new Date((dnum(e) - 365) * DAYMS).toISOString().slice(0, 10);
    const sq: number[] = [];
    for (const [qe, v] of epsQStreet) {
      if (dnum(spanStart) < dnum(qe) && dnum(qe) <= dnum(e)) sq.push(v);
    }
    const eps = sq.length === 4 ? round2(sq.reduce((s, x) => s + x, 0)) : epsAGaap.get(e) ?? null;
    annual.push({ year, end: e, eps, sales: revA.get(e) ?? null });
  }
  for (const a of annual) {
    const prior = annual.find((p) => p.year === a.year - 1) || null;
    a.epsPct = prior ? pct(a.eps, prior.eps) : null;
    a.salesPct = prior ? pct(a.sales, prior.sales) : null;
  }

  // ---------- estimates ----------
  const est = await estimates(env, symbol).catch(() => ({} as any));
  const lastActualYear = annual.length ? annual[annual.length - 1].year : new Date().getUTCFullYear() - 1;
  const estRows: any[] = [];
  ["0y", "+1y"].forEach((key, i) => {
    const e = est[key];
    if (!e) return;
    if (e.eps == null && e.sales == null) return;
    estRows.push({
      year: lastActualYear + 1 + i,
      eps: e.eps != null ? round2(e.eps) : null,
      sales: e.sales,
      est: true,
      trend: e.arrow,
    });
  });

  const rows: any[] = annual
    .filter((a) => a.year >= 2019)
    .map((a) => ({
      year: a.year,
      eps: a.eps,
      epsPct: a.epsPct,
      sales: a.sales != null ? clean(Math.round((a.sales / 1e6) * 10) / 10) : null,
      salesPct: a.salesPct,
      est: false,
      trend: null,
    }));
  for (const er of estRows) {
    const prior = rows.length ? rows[rows.length - 1] : null;
    er.epsPct = prior ? pct(er.eps, prior.eps) : null;
    er.sales = er.sales != null ? clean(Math.round((er.sales / 1e6) * 10) / 10) : null;
    er.salesPct = prior ? pct(er.sales, prior.sales) : null;
    rows.push(er);
  }

  const actualEpsPcts = rows.filter((r) => !r.est && r.epsPct != null).map((r) => r.epsPct).slice(-3);
  const actualSalesPcts = rows.filter((r) => !r.est && r.salesPct != null).map((r) => r.salesPct).slice(-3);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);

  return {
    symbol,
    fyMonth,
    annual: rows,
    quarterly,
    epsGrowth3y: avg(actualEpsPcts),
    salesGrowth3y: avg(actualSalesPcts),
    lastSurprise: street.length ? street[street.length - 1].surprise : null,
  };
}
