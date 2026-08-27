// Port of server/main.py — JSON API + static frontend on Cloudflare Workers.
// Static assets are served by the ASSETS binding; /api/* is handled here.

import { Env, httpError, json, SYMBOL_RE } from "./env";
import { getChart, getQuote, getProfile, search, ValueErr } from "./data";
import { getFinancials } from "./financials";
import { getRsRating, buildStep, universeReady } from "./rsrating";

async function handleApi(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const sym = url.searchParams.get("symbol") || "";

  // Endpoints that take a symbol must get a well-formed one.
  if (path !== "/api/search" && !SYMBOL_RE.test(sym)) {
    return httpError(400, "invalid symbol");
  }

  try {
    if (path === "/api/chart") {
      const tf = url.searchParams.get("tf") || "d";
      const day = url.searchParams.get("day");
      let result: any;
      try {
        result = await getChart(env, sym, tf, day);
      } catch (e) {
        if (e instanceof ValueErr) return httpError(400, e.message);
        return httpError(502, `data fetch failed: ${e}`);
      }
      if (result && result.error) return httpError(404, result.error);
      return json(result);
    }

    if (path === "/api/quote") return json(await getQuote(env, sym));
    if (path === "/api/profile") return json(await getProfile(env, sym));
    if (path === "/api/financials") return json(await getFinancials(env, sym));

    if (path === "/api/rsrating") {
      const chart: any = await getChart(env, sym, "d", null);
      if (chart.error) return json({ status: "na" });
      const closes = (chart.bars.c as number[]).slice(-260);
      // Warm the universe on demand so it doesn't only depend on cron.
      if (!(await universeReady(env))) ctx.waitUntil(buildStep(env));
      return json(await getRsRating(env, closes));
    }

    if (path === "/api/search") {
      try {
        return json(await search(url.searchParams.get("q") || ""));
      } catch {
        return json([]);
      }
    }
  } catch (e) {
    const label =
      path === "/api/quote"
        ? "quote fetch failed"
        : path === "/api/profile"
        ? "profile fetch failed"
        : path === "/api/financials"
        ? "financials fetch failed"
        : path === "/api/rsrating"
        ? "rs rating failed"
        : "request failed";
    return httpError(502, `${label}: ${e}`);
  }

  return httpError(404, "not found");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(url, env, ctx);
    }

    // Static asset; mirror the Python "no-cache" revalidation for HTML/JS/CSS.
    const resp = await env.ASSETS.fetch(request);
    const p = url.pathname;
    if (p === "/" || p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css")) {
      const r = new Response(resp.body, resp);
      r.headers.set("Cache-Control", "no-cache");
      return r;
    }
    return resp;
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(buildStep(env).catch((e) => console.error("rs build failed:", e)));
  },
};
