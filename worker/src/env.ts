export interface Env {
  ASSETS: Fetcher;
  RS_KV: KVNamespace;
  VEGANSURGE_CONTACT: string;
}

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function secUA(env: Env): string {
  return `VeganSurge/1.0 personal research (${env.VEGANSURGE_CONTACT || "contact-not-set@example.com"})`;
}

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function httpError(status: number, detail: string): Response {
  return json({ detail }, status);
}

// Accept tickers, indices (^GSPC), and FX/pairs (=X). Bounds upstream input.
export const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;

export function cleanNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return null;
  return n;
}
