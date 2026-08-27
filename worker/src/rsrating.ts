// Port of server/rsrating.py — approximate IBD RS Rating.
// The universe (S&P 500 weighted 12-mo performance) is expensive to build,
// so it's built incrementally across cron ticks and stored in KV. Until it's
// ready the endpoint reports {"status":"warming"}.

import { Env, UA } from "./env";

const WEIGHTS: [number, number][] = [
  [63, 0.4],
  [126, 0.2],
  [189, 0.2],
  [252, 0.2],
];
const REFRESH_SECS = 12 * 3600;
const BATCH = 20; // Yahoo's spark endpoint rejects requests above ~20 symbols
const CHUNKS_PER_TICK = 3; // small spark parses per work tick; stays under the 10ms CPU budget

const UNIVERSE_KEY = "rs:universe"; // { scores:number[], built:number, n:number }
const BUILD_KEY = "rs:build"; // { symbols:string[], cursor:number, scores:number[], started:number }

export function weightedPerf(closes: (number | null)[]): number | null {
  const vals = closes.filter((c) => c != null && isFinite(c as number)) as number[];
  const n = vals.length;
  if (n < 70) return null;
  const last = vals[n - 1];
  let score = 0;
  for (const [lb, w] of WEIGHTS) {
    const base = vals[Math.max(0, n - 1 - lb)];
    if (!base) return null;
    score += w * (last / base - 1);
  }
  return score;
}

async function sp500Symbols(): Promise<string[]> {
  const r = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", {
    headers: { "User-Agent": UA },
  });
  if (!r.ok) return [];
  const html = await r.text();
  const start = html.indexOf('id="constituents"');
  if (start === -1) return [];
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end === -1 ? undefined : end);
  // First cell of each row links the ticker to its NYSE/Nasdaq quote page.
  const re = /href="https:\/\/www\.(?:nyse|nasdaq)\.com\/[^"]*">([A-Z][A-Z.\-]{0,6})<\/a>/g;
  const syms: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(table))) syms.push(m[1].replace(/\./g, "-")); // BRK.B -> BRK-B for Yahoo
  return [...new Set(syms)];
}

// Spark API: closes for many symbols in one request.
async function sparkCloses(symbols: string[]): Promise<Map<string, (number | null)[]>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols
    .map(encodeURIComponent)
    .join(",")}&range=1y&interval=1d`;
  const out = new Map<string, (number | null)[]>();
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return out;
  const j: any = await r.json();
  for (const sym of symbols) {
    const node = j[sym];
    if (node?.close) out.set(sym, node.close);
  }
  return out;
}

// Advance the universe build by one batch per call. Idempotent; persists
// state to KV between calls. Kept deliberately light (one spark parse per
// tick) so it fits the Workers Free-plan 10ms CPU budget; cron + on-demand
// polls drive it to completion over several ticks.
export async function buildStep(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const build = (await env.RS_KV.get(BUILD_KEY, "json")) as
    | { symbols: string[]; cursor: number; scores: number[]; started: number }
    | null;

  // Init tick: fetch the symbol list (heavy regex) and stop — process batches
  // on subsequent ticks so no single tick does regex + spark parse together.
  if (!build) {
    const universe = (await env.RS_KV.get(UNIVERSE_KEY, "json")) as { built: number } | null;
    if (universe && now - universe.built < REFRESH_SECS) return; // still fresh
    const symbols = await sp500Symbols();
    if (symbols.length < 100) return; // wiki fetch failed; try again next tick
    await env.RS_KV.put(
      BUILD_KEY,
      JSON.stringify({ symbols, cursor: 0, scores: [], started: now }),
      { expirationTtl: 3600 },
    );
    return;
  }

  // Work tick: process up to CHUNKS_PER_TICK spark batches.
  const chunks: string[][] = [];
  for (let i = 0; i < CHUNKS_PER_TICK && build.cursor < build.symbols.length; i++) {
    chunks.push(build.symbols.slice(build.cursor, build.cursor + BATCH));
    build.cursor += BATCH;
  }
  if (chunks.length) {
    const maps = await Promise.all(chunks.map((c) => sparkCloses(c).catch(() => new Map())));
    chunks.forEach((chunk, ci) => {
      for (const sym of chunk) {
        const s = weightedPerf(maps[ci].get(sym) || []);
        if (s != null) build.scores.push(s);
      }
    });
  }

  if (build.cursor >= build.symbols.length) {
    if (build.scores.length > 100) {
      build.scores.sort((a, b) => a - b);
      await env.RS_KV.put(
        UNIVERSE_KEY,
        JSON.stringify({ scores: build.scores, built: now, n: build.scores.length }),
      );
    }
    await env.RS_KV.delete(BUILD_KEY);
  } else {
    await env.RS_KV.put(BUILD_KEY, JSON.stringify(build), { expirationTtl: 3600 });
  }
}

function bisectLeft(arr: number[], x: number): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function getRsRating(env: Env, closes: (number | null)[]): Promise<any> {
  const score = weightedPerf(closes);
  if (score == null) return { status: "na" };
  const universe = (await env.RS_KV.get(UNIVERSE_KEY, "json")) as { scores: number[]; n: number } | null;
  if (!universe) return { status: "warming" };
  const pct = bisectLeft(universe.scores, score) / universe.scores.length;
  const rating = Math.max(1, Math.min(99, Math.round(pct * 98) + 1));
  return {
    status: "ok",
    rating,
    score: Math.round(score * 100 * 100) / 100,
    universe: "S&P 500",
    n: universe.scores.length,
  };
}

export async function universeReady(env: Env): Promise<boolean> {
  const u = await env.RS_KV.get(UNIVERSE_KEY);
  return !!u;
}
