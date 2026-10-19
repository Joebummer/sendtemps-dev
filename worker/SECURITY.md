# API protections

The Open-Meteo key belongs only in the `OPEN_METEO_API_KEY` Cloudflare secret.
Neither forecast payloads nor cache keys contain that key. GitHub's deployment
token (`CF_API_TOKEN`) is separate and is supplied only to the deploy job.

## Request budgets

- Public API: 600 requests per minute per Cloudflare-provided client IP.
  This is a coarse burst guard, with headroom for shared mobile carrier IPs.
  OPTIONS requests are exempt. No app update or client API key is required.
- Weather providers: 30 outbound attempts per minute per Cloudflare location,
  shared across weather, marine, paid/free fallback, retries and scheduled work.
  Successful cache hits consume no provider allowance. Scored requests can use
  the existing same-day fallback for up to one hour; otherwise the API returns
  HTTP 429 with Retry-After: 60. No extra retries follow a locally exhausted budget.
- Both Cloudflare rate-limit bindings are approximate and local to an edge
  location. They are not globally exact monthly usage or spending caps. Batched
  locations/variables can count as multiple Open-Meteo billable API calls.
- Proxy inputs are bounded to the app's supported forecast size (10 future
  days, 4 past days, at most 40 variables, and at most the configured crag count).
  Unknown parameters and client-supplied keys never reach the provider or alter
  cache keys. Query order does not alter the cache key.
- Simultaneous refreshes in one Worker isolate share fully buffered results.
  Regional scoring remains shared across trip-date query variants. Cloudflare's
  15-minute edge cache serves subsequent requests.
- The existing 10,000 ms CPU bound remains. A previous 500 ms bound caused live
  forecast failures; lowering it requires measured CPU data from cold regions.

## Account checks

Use a dedicated Cloudflare deployment API token scoped to the existing
`sendtemps-api` Worker with Editor permissions, plus any route or other resource
permissions actually used by the deployment. Do not use a Global API Key.
Review the redirect Worker separately if a token is shared with that workflow.
Token restrictions and account-level billing settings require Cloudflare account
access and cannot be verified from this repository. Rotate any exposed secret
through the provider and update its deployment secret before revoking the old one.
The iOS project is not present in this repository and needs a separate check.
