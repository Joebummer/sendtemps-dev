# SendTemps

A climbing forecast PWA for Victorian crags — built for fast "where should I climb this weekend" decisions.

Pulls hourly forecasts from Open-Meteo for every crag, scores conditions against each crag's ideal temperature range, aspect, and drying time, and surfaces a daily and weekend-trip outlook.

## Crag coverage

Day trip range (under 3h from Melbourne) plus weekend destinations across Victoria — Arapiles, Grampians, Buffalo, Cathedral Ranges, You Yangs, Camel's Hump, Werribee Gorge, Beckworth, Staughton Vale, Mt Alexander group, and more.

## Stack

Vanilla HTML / CSS / JS — no build step. Single-page module imports.

- `index.html` — entry
- `app.js` — UI rendering, state, theme, hide/show, drag tabs
- `forecast.js` — Open-Meteo fetch + scoring
- `crags.js` — crag database (lat/lon, aspect, ideal temp, drive times, closures)
- `style.css` — styles, dark mode, layout

## Local development

```bash
npm install
node server.cjs
# open http://localhost:5000
```

The Node server is for local development only — production is pure static files served from GitHub Pages.

## Deploy

Push to `main`. GitHub Pages auto-rebuilds.

Cache-busting versions are pinned in `index.html` → `app.js?v=N` → `forecast.js?v=M` → `crags.js?v=K`. Bump all three when files change so the PWA picks up updates.
