# Production forecast modules

`forecast.js`, `climateBaseline.js` and `crags.js` here power the shared
`GET /forecast/scored` API used by Climbable. The older browser modules have
diverged. Do not overwrite the production modules by copying the browser files.

## Session scoring

Forecast days 1–3 (today is day 1) use the strongest consecutive five-hour
session. Days 4–8 use the broader daily calculation and report `daily-estimate`,
with no `scoreWindow` or window contribution, retaining the daily temperature
and rain explanations. The boundary uses calendar dates, including for
single-date and trip-only queries.

The other forecast dates retain the strongest consecutive five-hour session
from 7am onwards. Today may shorten to the remaining one to four hours. Session
dates without enough valid hourly weather use `daily-estimate-no-hourly-data`;
closed crags use `closure`. Missing model values never become ideal dry-weather
hours, and sessions cannot bridge missing hours.

For session dates, the headline, temperature callout and temperature ceilings use the selected
session's temperatures. The existing 90-point `too warm for hard climbing` and
98-point `temp varies` ceilings remain. `bestWindow.avg` and `scoreWindow.average`
represent the resulting session score. When a temperature ceiling applies,
`bestWindow.hourlyAvg` / `scoreWindow.hourlyAverage` retain the uncapped hourly
mean and `temperatureCap` explains the limit.

The existing ten-day weather request already contains hourly data. Future
sessions reuse it without adding provider requests or full future hourly strips
to the public response. `scoreWindow.provisional` is true after tomorrow and the
window metadata identifies these as provisional hourly model estimates. This
is horizon guidance, not a calibrated probability of forecast accuracy. Native
clients can use the metadata without a breaking schema change.

Session contributions now average the actual hourly scoring factors, including
hourly limits, and reconcile from 100 to the headline after integer rounding.
There is no synthetic window bonus. `scoreWindow` retains the selected period
and provisional metadata; `weatherScoreBasis` is `best-hourly-window` for these
sessions. Weather quality excludes residual recovery ceilings but retains rain
and temperature constraints. Hand-built pre-scored windows without internal
hourly context retain the legacy explanation fallback.

Rain totals and mean/peak probabilities use real hourly samples for both daily
and session periods, rather than distributing grouped rain-window totals evenly.
Grouped windows remain presentation summaries. Hourly rain uses the stronger of
amount and probability penalties, so drizzle cannot remove sustained rain risk.
The amount deduction interpolates continuously from 0 points at 0 mm/h through
15 at 0.05, 35 at 0.2, 70 at 2, 85 at 5 and 95 at 10 mm/h. This removes the
old 35-point jump immediately above 1 mm/h. Hourly weather and recovery remain
unsmoothed, so genuine rain changes and wet-rock constraints stay visible.
Probability deductions and surrounding-hour rain context also vary continuously.
The wider-day rain-risk floor persists across all probability values. Daily
estimates use continuous probability deductions as well.

Physical wetness is retained even under a recovery ceiling. The final moisture
constraint is the stronger of the physical deduction and the recovery ceiling,
not the sum of their deficits. Existing drying rates and local relief factors
are unchanged. Active rain is described as wet rather than drying.

Session candidates require daylight for the full hourly interval, based on the
crag coordinates. Today's minimum length shrinks only with remaining daylight;
future days still require five complete samples. `scoreWindow.usability` and
the native-compatible reason describe wet-hour counts, dry-hour counts, usable
hours and the longest usable run. A usable hour requires no measurable rain,
rain probability at most 35%, score at least 50, recovery ceiling at least 80,
and complete marine data for sea cliffs. This is forecast usability, not proof
of actual dry rock. Average scores are not artificially smoothed or raised to
hide interruptions.

Configured sea cliffs expose marine `availability` as available, partial or
unavailable. Zero-valued wave observations are valid. Incomplete wave/swell
data retains any known hazard and limits the conditions score to 64, while
leaving ordinary weather available; this is a confidence limit, not a calm-sea
estimate. Inland crags do not receive it.

Saved regional payloads reselect today's remaining daylight session on every
response. The compact `scoreContext` on hourly samples preserves exact scoring
inputs for this recalculation. `day.dailyContext` retains broad-day summaries
for fallback when no session remains. `forecast` metadata reports retrieval
time, age in seconds, stale status and source. Stale responses also add a plain
language notice to existing reason strings, including after midnight rollover.
For non-sandstone rock, a new shower restarts recovery while retaining any larger
unfinished event; sandstone keeps its existing trace exemption and productive
drying rules. The temperature explanation distinguishes the peak-performance
warmth threshold from the broader general cragging temperature range.

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
