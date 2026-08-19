# lib/ — copied scoring modules

`forecast.js`, `climateBaseline.js`, and `crags.js` in this directory are
**verbatim copies** of the same-named files at the repo root, with two
intentional changes in `forecast.js`:

1. The `crags.js` import has its `?v=41` cache-busting query string
   stripped (Workers ES module resolution doesn't support query strings
   in import specifiers).
2. The `API` constant points directly at `https://api.open-meteo.com/v1/forecast`
   instead of `https://api.sendtemps.app/forecast` (the Worker's own public
   proxy). The browser copy routes through the Worker's proxy so every
   client shares one edge-cached response instead of hitting Open-Meteo's
   per-IP rate limit directly. This copy runs *inside* the Worker (for
   `GET /forecast/scored`), so pointing it at its own public hostname means
   the Worker calling itself over the public internet on every request —
   which returned Cloudflare error 522 in testing. `handleScoredForecast()`
   in `index.js` provides its own edge cache on top, so rate-limit
   protection is preserved, just applied at the `/forecast/scored` layer
   instead of at the Open-Meteo-call layer.

## Why copies instead of a shared package

Keeping these as plain copies (not a shared npm package or symlink) means:
- The web app's client-side bundle and the Worker's server-side bundle can
  each be deployed independently without a build/publish step in between.
- No risk of a shared-package version mismatch between web and Worker.

## Keeping them in sync

Whenever `forecast.js`, `climateBaseline.js`, or `crags.js` change at the
repo root (new crags, scoring tweaks, bug fixes), re-copy them here:

```bash
cp forecast.js worker/src/lib/forecast.js
cp climateBaseline.js worker/src/lib/climateBaseline.js
cp crags.js worker/src/lib/crags.js
sed -i "s|from './crags.js?v=[0-9]*'|from './crags.js'|" worker/src/lib/forecast.js
sed -i "s|const API = 'https://api.sendtemps.app/forecast';|const API = 'https://api.open-meteo.com/v1/forecast';|" worker/src/lib/forecast.js
```

Then diff against the root files to confirm the only differences are the
import line and the `API` constant, and redeploy the Worker.

**Why this matters:** `GET /forecast/scored` (used by the iOS app, and
eventually the web app) runs this exact code server-side. If these copies
drift from the root files, the iOS app and the website will silently
disagree on crag scores for the same day — the two clients need to be
running byte-identical scoring logic.

## Longer-term fix

Once the marketing/web app also calls `/forecast/scored` instead of running
`fetchAllForecasts`/`rankByDay`/`rankWeekendTrip` client-side, the root-level
copies of these three files can be deleted and the web app can fetch scored
JSON from the Worker directly — eliminating the sync step entirely. That
migration is tracked as a follow-up, not done yet.
