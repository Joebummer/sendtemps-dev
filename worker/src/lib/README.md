# Production forecast modules

`forecast.js`, `climateBaseline.js` and `crags.js` here power the shared
`GET /forecast/scored` API used by Climbable. The older browser modules have
diverged. Do not overwrite the production modules by copying the browser files.

## Session scoring

Every available forecast date uses the strongest consecutive five-hour session
from 7am onwards. Today may shorten to the remaining one to four hours. Dates
without enough valid hourly weather use `daily-estimate-no-hourly-data`; closed
crags use `closure`. Missing model values never become ideal dry-weather hours,
and sessions cannot bridge missing hours.

The headline, temperature callout and temperature ceilings use the selected
session's temperatures. The existing 90-point `too warm for hard climbing` and
98-point `temp varies` ceilings remain. `bestWindow.avg` and `scoreWindow.average`
represent the resulting session score. When a temperature ceiling applies,
`bestWindow.hourlyAvg` / `scoreWindow.hourlyAverage` retain the uncapped hourly
mean and `temperatureCap` explains the limit.

The existing ten-day weather request already contains hourly data. Future
sessions reuse it without adding provider requests or full future hourly strips
to the public response. `scoreWindow.provisional` is true after tomorrow and the
window contribution describes these as provisional hourly model estimates. This
is horizon guidance, not a calibrated probability of forecast accuracy. Native
clients can use the metadata without a breaking schema change.

Destination rows inherit the selected best child's score, session and weather.
`rankWeekendTrip(forecasts, tripDates, ranked)` reuses daily rows, including their
normalized `cragId` form. Without the optional rows, it calculates the same
sessions and destination rollups. Trip scoring remains 50% worst day, 30% mean
and 20% median, preserving original forecast order for ties.

## Caching and validation

The Worker caches one normalized regional dataset plus original crag ordering
for 900 seconds, keyed by region, Melbourne calendar date and cache version.
A fallback is bounded to one hour. Trip selections aggregate cached daily scores
without downloading or scoring weather again. Full future hourly intermediates
are not duplicated in the regional payload. Client responses remain `no-store`.

Timezone conversions reuse a bounded cache of deterministic hourly timestamps
to keep ten-day scoring within the Worker's CPU budget. Cached timestamps never
contain weather or user data and callers receive fresh Date objects.

Bump `SCORED_CACHE_VERSION` for scorer or catalogue changes. Run
`npm run validate:crags` and the Worker/API-protection and scored-pipeline tests
before deploying. CI runs all scored-pipeline tests, including session, trip,
parent, caching, rain-recovery and Wollongong regressions. `npm run check` also
includes known legacy browser-parity and temperature-calibration expectations;
report those separately rather than changing current production calibration to
match outdated assertions.
