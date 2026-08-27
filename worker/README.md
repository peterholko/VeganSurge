# VeganSurge — Cloudflare Worker

Deploys VeganSurge to **https://kittywithfangs.com** as a single Cloudflare
Worker. The Python/FastAPI backend (`../server`) was ported to TypeScript here;
the original `../web` frontend is served unchanged as static assets.

## Architecture

| Piece | Where |
|-------|-------|
| Static frontend (`../web`) | `assets` binding, `run_worker_first: true` |
| `/api/*` JSON endpoints | `src/index.ts` router |
| Yahoo client (crumb + cache) | `src/yahoo.ts` |
| chart / quote / profile / search | `src/data.ts` |
| financials (SEC EDGAR + Yahoo) | `src/financials.ts` |
| RS rating universe | `src/rsrating.ts` |

**Caching:** short-TTL data uses the edge Cache API; the SEC CIK map and the
Yahoo crumb live in the `RS_KV` namespace.

**RS rating universe:** the S&P 500 weighted-performance universe is built
incrementally to stay under the Workers Free-plan 10ms CPU limit. A cron
trigger (`*/2 * * * *`) and on-demand `/api/rsrating` polls each advance the
build by a few 20-symbol spark batches; it finalizes after ~10 ticks and
refreshes every 12h. Until ready, `/api/rsrating` returns `{"status":"warming"}`.

## Develop & deploy

```bash
npm install
npx wrangler dev      # local, real upstream fetches
npx wrangler deploy   # deploy to kittywithfangs.com
```

`VEGANSURGE_CONTACT` (the email SEC asks automated clients to send) is set in
`wrangler.jsonc` vars — change it there if needed.

## Notes

- `workers_dev` is disabled; the only public hostname is the custom domain.
- Yahoo's spark endpoint rejects requests above ~20 symbols — `BATCH` in
  `rsrating.ts` must stay ≤ 20.
- The frontend opens `/compare.html`, which Cloudflare 307-redirects to
  `/compare` (the `.html` extension is dropped); browsers follow it
  transparently with the query string intact.
