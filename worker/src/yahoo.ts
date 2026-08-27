// Yahoo Finance client. The chart/spark/search endpoints are open, but
// quoteSummary and the earnings "visualization" endpoint require a
// cookie + crumb pair. We fetch a pair on demand and cache it in KV.

import { Env, UA } from "./env";

const CRUMB_KEY = "yf:crumb";
const CRUMB_TTL = 60 * 30; // 30 min

interface CrumbPair {
  cookie: string;
  crumb: string;
}

async function fetchCrumb(): Promise<CrumbPair | null> {
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  await r1.body?.cancel();
  const cookie = (r1.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) return null;
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  if (!r2.ok) return null;
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.toLowerCase().includes("invalid") || crumb.length > 40) return null;
  return { cookie, crumb };
}

export async function getCrumb(env: Env, forceRefresh = false): Promise<CrumbPair | null> {
  if (!forceRefresh) {
    const cached = await env.RS_KV.get(CRUMB_KEY, "json");
    if (cached) return cached as CrumbPair;
  }
  const pair = await fetchCrumb();
  if (pair) {
    await env.RS_KV.put(CRUMB_KEY, JSON.stringify(pair), { expirationTtl: CRUMB_TTL });
  }
  return pair;
}

// Authenticated GET that retries once with a fresh crumb on 401/403.
export async function crumbedGet(env: Env, buildUrl: (crumb: string) => string): Promise<Response | null> {
  let pair = await getCrumb(env);
  if (!pair) return null;
  let r = await fetch(buildUrl(pair.crumb), { headers: { "User-Agent": UA, Cookie: pair.cookie } });
  if (r.status === 401 || r.status === 403) {
    pair = await getCrumb(env, true);
    if (!pair) return null;
    r = await fetch(buildUrl(pair.crumb), { headers: { "User-Agent": UA, Cookie: pair.cookie } });
  }
  return r;
}

export async function crumbedPost(env: Env, url: (crumb: string) => string, body: unknown): Promise<Response | null> {
  let pair = await getCrumb(env);
  if (!pair) return null;
  const doPost = (p: CrumbPair) =>
    fetch(url(p.crumb), {
      method: "POST",
      headers: { "User-Agent": UA, Cookie: p.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  let r = await doPost(pair);
  if (r.status === 401 || r.status === 403) {
    pair = await getCrumb(env, true);
    if (!pair) return null;
    r = await doPost(pair);
  }
  return r;
}

// ---- generic TTL cache via the Cache API ----
// Keyed by a synthetic https URL so the colo cache can store it.

export async function cached(
  key: string,
  ttl: number,
  build: () => Promise<unknown>,
): Promise<unknown> {
  const cache = caches.default;
  const cacheUrl = `https://vs-cache.internal/${encodeURIComponent(key)}`;
  const hit = await cache.match(cacheUrl);
  if (hit) return hit.json();
  const value = await build();
  const resp = new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "Cache-Control": `max-age=${ttl}` },
  });
  await cache.put(cacheUrl, resp.clone());
  return value;
}

export async function yfetch(url: string): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": UA } });
}
