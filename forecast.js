// Open-Meteo forecast fetching + scoring
// API: https://open-meteo.com/en/docs — free, no key, CORS-enabled

import { CRAGS } from './crags.js?v=33';
import { CLIMATE_PROFILES, CRAG_TO_PROFILE } from './climateBaseline.js';

// Routed through the SendTemps Worker (not Open-Meteo directly) so every
// client shares one edge-cached response instead of each device/network
// being subject to Open-Meteo's own per-IP rate limit. See worker/src/index.js
// GET /forecast.
const API = 'https://api.sendtemps.app/forecast';

// Fetch one batched request for the crags in `region` at once — Open-Meteo
// accepts comma-separated coords. `region` is a state code ('VIC', 'TAS', …)
// or 'ALL' for every crag nationwide. Scoping to one state cuts the request
// (and the edge-cached response) down to roughly a fifth of the full payload
// for most states, which is where most of the load-time cost was coming from.
export async function fetchAllForecasts(region = 'ALL') {
  const scoped = region === 'ALL' ? CRAGS : CRAGS.filter(c => c.state === region);
  // Safety net: never send an empty request (e.g. an unrecognised region code).
  const targetCrags = scoped.length ? scoped : CRAGS;
  const lats = targetCrags.map(c => c.lat).join(',');
  const lons = targetCrags.map(c => c.lon).join(',');
  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'apparent_temperature_max',
      'precipitation_sum',
      'precipitation_probability_max',
      'precipitation_hours',
      'windspeed_10m_max',
      'sunshine_duration',
      'weathercode',
    ].join(','),
    hourly: [
      'precipitation',
      'precipitation_probability',
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'windspeed_10m',
      'winddirection_10m',
      'windgusts_10m',
      'cloudcover',
      'shortwave_radiation',
      'weathercode',
    ].join(','),
    timezone: 'Australia/Melbourne',
    forecast_days: '8',
    past_days: '4',
  });

  const url = `${API}?${params}`;
  // Retry up to 3 times with backoff — handles transient 429s
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    res = await fetch(url);
    if (res.status !== 429) break;
  }
  if (!res.ok) throw new Error(`Forecast API error ${res.status}`);
  const data = await res.json();

  // Open-Meteo returns either a single object (one location) or an array (multiple).
  const list = Array.isArray(data) ? data : [data];

  // Compute today + tomorrow in Melbourne local time once.
  const todayMel = melbourneDateString(new Date());
  const tomorrowMel = melbourneDateString(new Date(Date.now() + 86400000));

  // Map each crag to its forecast object
  const byId = {};
  targetCrags.forEach((crag, i) => {
    const f = list[i];
    if (!f) return;
    // Compute hourly rock-dryness series for the whole hourly window.
    // This consumes past_days=4 of recent rain history plus 8 forecast days.
    const drynessSeries = computeDrynessSeries(crag, f.hourly);
    // Current dryness = the value at the hour closest to "now".
    const nowDryness = currentDryness(f.hourly, drynessSeries);
    // Per-hour view for today (remaining hours) and tomorrow, each with its
    // own best-window pick. The today strip is built from the current hour
    // forward, so a 2pm visit sees 2pm–7pm rather than the irrelevant
    // 6am–1pm that have already passed.
    const todayHourly = buildTodayHourly(crag, f.hourly, drynessSeries, todayMel);
    const todayBestWindow = bestWindow(todayHourly);
    const tomorrowHourly = buildTomorrowHourly(crag, f.hourly, drynessSeries, tomorrowMel);
    const tomorrowBestWindow = bestWindow(tomorrowHourly);
    // Last 4 days of daily precipitation totals for the sparkline.
    const pastPrecip = extractPastDailyPrecip(f.hourly, todayMel, 4);
    byId[crag.id] = {
      crag,
      hourly: f.hourly,
      drynessSeries,
      nowDryness,
      lastRain: findLastSignificantRain(f.hourly),
      pastPrecip,
      todayDate: todayMel,
      todayHourly,
      todayBestWindow,
      tomorrowDate: tomorrowMel,
      tomorrowHourly,
      tomorrowBestWindow,
      days: f.daily.time.map((date, di) => ({
        date,
        tMax: f.daily.temperature_2m_max[di],
        tMin: f.daily.temperature_2m_min[di],
        tFeel: f.daily.apparent_temperature_max[di],
        precipSum: f.daily.precipitation_sum[di],
        precipProb: f.daily.precipitation_probability_max[di],
        precipHours: f.daily.precipitation_hours[di],
        wind: f.daily.windspeed_10m_max[di],
        // Dominant daytime wind direction + exposure for this crag (8am–6pm).
        // Used to label "drying wind" vs "sheltered" in the score breakdown.
        ...daytimeWindExposure(crag, f.hourly, date),
        // Real solar exposure for this crag's wall on this day (geometry, not
        // aspect labels). scoreDay uses these for the heat/cold/sunshine maths.
        ...computeSolarExposure(crag, f.hourly, date),
        sunWindow: computeSunWindow(crag, f.hourly, date),
        // Temperature distribution across the climbing window. Lets scoreDay
        // weight the temp penalty by what fraction of the day is actually in
        // the comfort band, not just whether the peak hour clips inside it.
        climbTemps: computeClimbTemps(crag, f.hourly, date),
        // Humidity distribution across the climbing window. Lets scoreDay
        // apply a per-crag-tuned penalty when the rock spends real hours in
        // greasy/damp territory — weighted by rockType-driven dryRating.
        climbHumidity: computeClimbHumidity(crag, f.hourly, date),
        sunshine: f.daily.sunshine_duration[di], // seconds
        cloudMean: daytimeCloudMean(f.hourly, date), // mean daytime cloud cover %
        weatherCode: f.daily.weathercode[di],
        rainWindows: extractRainWindows(f.hourly, date),
        // Morning dryness (8am) and afternoon dryness (2pm) for this day,
        // pulled from the hourly dryness series. UI uses these to colour cards.
        morningDryness: drynessAtLocalHour(f.hourly, drynessSeries, date, 8),
        afternoonDryness: drynessAtLocalHour(f.hourly, drynessSeries, date, 14),
        dayDryness: drynessAtLocalHour(f.hourly, drynessSeries, date, 11), // mid-day single value
      })),
    };
  });
  return byId;
}

// ---- Rock dryness model ----
//
// Tracks an "accumulated wetness" value (0 = bone dry, ~10+ = saturated)
// hour-by-hour over the whole hourly window. Rain adds wetness; sun + wind +
// low humidity remove it. Rock type controls both how fast rain saturates and
// how fast it dries.
//
// Returned series matches `hourly.time` length; each entry is { wetness, dryness }
// where `dryness` is the user-facing 0–100 score.

// Drying half-life in hours when conditions are average (no sun, light wind,
// 60% humidity, mild temp). Sandstone is much slower than granite.
const DRY_HALFLIFE_HRS = {
  granite: 6,
  quartzite: 10,
  trachyte: 12,
  conglomerate: 14,
  sandstone: 24,
};

// How much rain (mm) it takes to push the rock fully saturated.
// Sandstone soaks a lot; granite very little.
const SATURATION_MM = {
  granite: 3,
  quartzite: 5,
  trachyte: 6,
  conglomerate: 7,
  sandstone: 10,
};

// Average wind direction + speed during climbing hours (8am–6pm) for a given
// local date. Returns { windDir, windAvg, windExposure } where windDir is a
// vector-mean bearing (°) so opposing winds don't cancel into a meaningless
// mean, and windExposure ∈ {'onshore','parallel','lee'} relative to the crag.
function daytimeWindExposure(crag, hourly, dateStr) {
  if (!hourly || !hourly.time) return { windDir: null, windAvg: null, windExposure: null };
  let sx = 0, sy = 0, speedSum = 0, gustSum = 0, count = 0;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 8 || hour > 18) continue;
    const dir = hourly.winddirection_10m?.[i];
    const spd = hourly.windspeed_10m?.[i];
    const gust = hourly.windgusts_10m?.[i] ?? spd;
    if (dir == null || spd == null) continue;
    const rad = (dir * Math.PI) / 180;
    // Weight each hour's direction by its speed so calm hours don't drag the
    // vector mean toward arbitrary directions.
    sx += Math.sin(rad) * spd;
    sy += Math.cos(rad) * spd;
    speedSum += spd;
    gustSum += gust;
    count++;
  }
  if (count === 0) return { windDir: null, windAvg: null, windExposure: null };
  const meanDir = (Math.atan2(sx, sy) * 180) / Math.PI;
  const windDir = (meanDir + 360) % 360;
  const windAvg = speedSum / count;
  const gustAvg = gustSum / count;
  const effective = Math.max(windAvg, gustAvg * 0.7);
  const { exposure } = aspectWindFactor(crag.aspect, windDir, effective);
  return { windDir, windAvg, windExposure: exposure };
}

// Compute the temperature distribution across the climbing window for a crag.
// Returns `{ climbHours, hoursInRange, hoursCold, hoursHot, meanTemp, meanApparent,
// maxApparent }` where climbHours = (climbCutoff - climbStart) and the in-range
// buckets are based on the crag's idealTemp. We use `apparent_temperature` for
// the in-range check because feels-like is what determines whether you can
// climb comfortably; wind chill at 5°C ambient still feels too cold.
//
// This lets scoreDay weight the temperature penalty by how MUCH of the climbing
// day is actually inside the comfort band, not just whether the peak afternoon
// hour clips into the range. A 3°C–12°C day with idealTemp [10,24] passes the
// old "tFeel inside range" check but practically only spends 1–2 hours in-range.
function computeClimbTemps(crag, hourly, dateStr) {
  const empty = {
    climbHours: 0, hoursInRange: 0, hoursCold: 0, hoursHot: 0,
    meanTemp: null, meanApparent: null, maxApparent: null,
  };
  if (!hourly || !hourly.time || !crag.idealTemp) return empty;
  const [lo, hi] = crag.idealTemp;
  const startH = (crag.trip === 'weekend' || crag.trip === 'both') ? 8 : 9;
  const cutoffH = (crag.trip === 'weekend' || crag.trip === 'both') ? 20 : 18;
  let inRange = 0, cold = 0, hot = 0, count = 0;
  let tempSum = 0, appSum = 0, maxApp = -Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < startH || hour >= cutoffH) continue;
    const temp = hourly.temperature_2m?.[i];
    const app = hourly.apparent_temperature?.[i] ?? temp;
    if (temp == null) continue;
    count++;
    tempSum += temp;
    appSum += app;
    if (app > maxApp) maxApp = app;
    if (app < lo) cold++;
    else if (app > hi) hot++;
    else inRange++;
  }
  if (count === 0) return empty;
  return {
    climbHours: count,
    hoursInRange: inRange,
    hoursCold: cold,
    hoursHot: hot,
    meanTemp: tempSum / count,
    meanApparent: appSum / count,
    maxApparent: maxApp,
  };
}

// Compute the humidity distribution across the climbing window for a crag.
// Returns `{ climbHours, hoursHumid, hoursModerate, hoursDry, meanRh, maxRh }`.
//
// Buckets per hour by relative humidity:
//   <60%  → dry      (crisp rock, friction good)
//   60–75% → moderate (climbable but rock starts to feel cooler/greasy)
//   >75%  → humid    (rock feels damp, sandstone/conglomerate gets slimy)
//
// scoreDay uses this with the per-crag dryRating (1–5) to compute a sensitivity
// multiplier: porous fast-drying rock (granite at 5) shrugs off humidity, while
// slow-drying rock (conglomerate at 1–2) takes a real hit when RH stays high.
function computeClimbHumidity(crag, hourly, dateStr) {
  const empty = {
    climbHours: 0, hoursHumid: 0, hoursModerate: 0, hoursDry: 0,
    meanRh: null, maxRh: null,
  };
  if (!hourly || !hourly.time) return empty;
  const startH = (crag.trip === 'weekend' || crag.trip === 'both') ? 8 : 9;
  const cutoffH = (crag.trip === 'weekend' || crag.trip === 'both') ? 20 : 18;
  let humid = 0, moderate = 0, dry = 0, count = 0;
  let rhSum = 0, maxRh = -Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < startH || hour >= cutoffH) continue;
    const rh = hourly.relative_humidity_2m?.[i];
    if (rh == null) continue;
    count++;
    rhSum += rh;
    if (rh > maxRh) maxRh = rh;
    if (rh > 75) humid++;
    else if (rh >= 60) moderate++;
    else dry++;
  }
  if (count === 0) return empty;
  return {
    climbHours: count,
    hoursHumid: humid,
    hoursModerate: moderate,
    hoursDry: dry,
    meanRh: rhSum / count,
    maxRh,
  };
}

// Compute the contiguous sun-on-wall window for a crag on a given date.
// Returns `{firstHour, lastHour, hours}` where firstHour/lastHour are the
// integer hours-of-day (Melbourne local) bounding the lit run, and `hours`
// is the count. Returns null if the wall never sees the sun on this date or
// is explicitly all-day shaded.
//
// We use a generous altitude cutoff (≥ 3°) matching computeSolarExposure so
// the labels stay consistent across the app. The window collapses repeated
// lit hours into a single span — if the geometry shows sun lighting the wall
// 8–10 and again 13–15 we return 8–15 with a small caveat. That’s rare; most
// natural cliff aspects light up in one block.
function computeSunWindow(crag, hourly, dateStr) {
  if (!hourly || !hourly.time || crag.lat == null || crag.lon == null) return null;
  if (crag.shade === 'all-day') return null;
  // Parent crags with mixed-aspect children have no single sun window. Let the
  // UI fall back to the author-written sunOnWall hint.
  if (!hasConcreteAspect(crag.aspect)) return null;
  let firstHour = null, lastHour = null;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    const when = melbourneHourToDate(t);
    const sun = sunPosition(when, crag.lat, crag.lon);
    if (sun.altitude <= 3) continue;
    if (!sunOnAspect(crag.aspect, sun.azimuth, sun.altitude)) continue;
    if (firstHour == null || hour < firstHour) firstHour = hour;
    if (lastHour == null || hour > lastHour) lastHour = hour;
  }
  if (firstHour == null) return null;
  // `lastHour` is the last *lit* hour; the wall stays lit until the end of
  // that hour, so we report `firstHour–(lastHour+1)` for human reading.
  return { firstHour, lastHour: lastHour + 1, hours: (lastHour + 1) - firstHour };
}

// Per-day solar exposure for a crag wall. Walks each hourly cell of the local
// date, calculates real sun position, and accumulates how many cloud-adjusted
// hours the sun was on the wall — split into three windows that matter for
// scoring:
//   sunHoursOnWall      — all daylight hours (used for general sunshine bonus)
//   sunHoursOnWallWarm  — 11am–4pm window (drives the heat penalty)
//   sunHoursOnWallCool  — 8am–11am window  (drives the cold-morning bonus)
// Each hour contributes (1 - cloudcover/100) so a cloudy 'lit' hour counts less.
function computeSolarExposure(crag, hourly, dateStr) {
  const empty = {
    sunHoursOnWall: 0,
    sunHoursOnWallWarm: 0,
    sunHoursOnWallCool: 0,
    sunHoursTotal: 0,
  };
  if (!hourly || !hourly.time || crag.lat == null || crag.lon == null) return empty;
  // 'shade: all-day' crags are physically shaded by surrounding terrain that
  // the geometric model can't see (deep gorge, overhang, boulder shelter).
  // Honour the explicit override.
  if (crag.shade === 'all-day') return empty;
  // Mixed-aspect parents have no single wall to compute against — zero out
  // solar exposure so scoring doesn't credit phantom sun hours.
  if (!hasConcreteAspect(crag.aspect)) return empty;
  let onWall = 0, warm = 0, cool = 0, total = 0;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    const when = melbourneHourToDate(t);
    const sun = sunPosition(when, crag.lat, crag.lon);
    if (sun.altitude <= 3) continue;
    const cloud = hourly.cloudcover?.[i] ?? 0;
    const clear = Math.max(0, 1 - cloud / 100);
    total += clear;
    if (!sunOnAspect(crag.aspect, sun.azimuth, sun.altitude)) continue;
    onWall += clear;
    if (hour >= 11 && hour < 16) warm += clear;
    if (hour >= 8 && hour < 11) cool += clear;
  }
  return {
    sunHoursOnWall: onWall,
    sunHoursOnWallWarm: warm,
    sunHoursOnWallCool: cool,
    sunHoursTotal: total,
  };
}

// Mean cloud cover (%) across daytime hours (8am–6pm) for a given date.
// Used to surface an 'overcast' callout when heavy cloud suppresses sun bonuses.
function daytimeCloudMean(hourly, dateStr) {
  if (!hourly?.time) return null;
  let sum = 0, count = 0;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < 8 || hour >= 18) continue;
    sum += hourly.cloudcover?.[i] ?? 50;
    count++;
  }
  return count > 0 ? sum / count : null;
}



// Smallest angle (0–180°) between two compass bearings.
function angularDistance(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

// How much the wind helps dry *this* wall, given:
//   crag.aspect    — direction the wall faces (e.g. 'N' = climber facing N)
//   windDir        — direction the wind is coming FROM (° from N, Open-Meteo)
//   effectiveWind  — km/h, gust-weighted speed
// Returns { factor, exposure } where factor multiplies the base drying rate
// and exposure ∈ {'onshore','parallel','lee'} for the UI/breakdown.
//
// Climbing intuition:
//   • Wind blowing toward the wall scours the boundary layer → fastest drying.
//   • Wind parallel to the wall still moves a lot of air past it.
//   • Wind from behind the cliff puts the wall in a wind shadow → drying stalls.
export function aspectWindFactor(aspect, windDir, effectiveWind) {
  // Base curve — scales with speed, capped well above the old 2.5 ceiling
  // because gust-weighted winds can be genuinely high.
  const base = 1 + Math.min(2.0, effectiveWind / 22); // up to ~3.0 at ~44 km/h+

  const wallFaces = ASPECT_AZIMUTH[aspect];
  if (wallFaces == null || windDir == null) {
    return { factor: base, exposure: 'parallel' };
  }
  // Both `aspect` (wall faces from) and `windDir` (wind comes from) use the
  // same "FROM" convention, so a small angular distance = wind blowing
  // straight at the wall.
  const offset = angularDistance(windDir, wallFaces);
  if (offset <= 45) {
    // Onshore — wind into the wall. Boost the drying factor above base.
    return { factor: base * 1.15, exposure: 'onshore' };
  }
  if (offset <= 90) {
    // Parallel / quartering — full base effect.
    return { factor: base, exposure: 'parallel' };
  }
  // Lee — wall sheltered. Most of the wind energy is on the other side of the
  // cliff. Drying slows substantially, but not to zero (eddies, leakage).
  // Stronger winds in the lee still help a little more than dead calm.
  const leeBase = 1 + Math.min(0.6, effectiveWind / 60);
  return { factor: leeBase, exposure: 'lee' };
}

function computeDrynessSeries(crag, hourly) {
  if (!hourly || !hourly.time) return [];
  const n = hourly.time.length;
  const halfLife = DRY_HALFLIFE_HRS[crag.rockType] ?? 12;
  const satMm = SATURATION_MM[crag.rockType] ?? 6;

  // Start assuming a dry-ish rock if past_days=4 covered the recent history.
  // We'll let the simulation walk forward from t=0 with wetness=0; if recent
  // rain falls inside the window it'll be captured. (The 4-day lookback is
  // adequate even for sandstone given the 24h half-life ⇒ ~4 half-lives.)
  let wetness = 0;
  const series = new Array(n);

  for (let i = 0; i < n; i++) {
    const mm = hourly.precipitation?.[i] ?? 0;
    const t = hourly.temperature_2m?.[i] ?? 15;
    const rh = hourly.relative_humidity_2m?.[i] ?? 70;
    const wind = hourly.windspeed_10m?.[i] ?? 10;
    const gust = hourly.windgusts_10m?.[i] ?? wind;
    const windDir = hourly.winddirection_10m?.[i] ?? null;
    const cloud = hourly.cloudcover?.[i] ?? 50;
    const swRad = hourly.shortwave_radiation?.[i] ?? 0;

    // Gust-weighted effective wind. Gusts dry rock faster than the average,
    // so we blend them in rather than relying purely on the mean speed.
    const effectiveWind = Math.max(wind, gust * 0.7);

    // 1) Add rain wetness. Each mm normalised by saturation point.
    if (mm > 0) {
      wetness += mm / satMm;
      // Cap accumulated wetness so a deluge doesn't make recovery impossibly slow.
      if (wetness > 3) wetness = 3;
    }

    // 2) Apply drying. Effective drying rate per hour =
    //    base_rate * sun_factor * wind_factor * humidity_factor * temp_factor
    // where base_rate corresponds to the half-life:  rate = ln(2)/halfLife
    const baseRate = Math.LN2 / halfLife;

    // Sun factor — direct sun on the wall dries it ~2.5x faster.
    // We approximate "sun on wall" with: solar radiation > 200 W/m^2 AND
    // the crag's aspect being roughly oriented toward the sun in the southern
    // hemisphere. Aspect-aware solar math comes in v49; for now use shortwave
    // radiation as a proxy: high SW = wall likely getting some sun.
    let sunFactor = 1;
    if (swRad > 500) sunFactor = 2.2; // strong direct sun likely
    else if (swRad > 250) sunFactor = 1.6; // moderate sun
    else if (swRad > 80) sunFactor = 1.2; // weak sun / scattered cloud
    // Heavy cloud cancels the sun bonus regardless of SW reading.
    if (cloud > 80) sunFactor = Math.min(sunFactor, 1.0);

    // Wind factor — speed *and* direction relative to the wall.
    // Onshore wind scours the wall; lee wind leaves it in shelter.
    const { factor: windFactor } = aspectWindFactor(crag.aspect, windDir, effectiveWind);

    // Humidity — high humidity slows evaporation.
    let humFactor = 1;
    if (rh < 50) humFactor = 1.4;
    else if (rh < 65) humFactor = 1.2;
    else if (rh > 85) humFactor = 0.55;
    else if (rh > 75) humFactor = 0.8;

    // Temperature — cold rock dries much slower.
    let tempFactor = 1;
    if (t < 2) tempFactor = 0.5;
    else if (t < 8) tempFactor = 0.7;
    else if (t > 25) tempFactor = 1.25;

    const dryRate = baseRate * sunFactor * windFactor * humFactor * tempFactor;
    // Exponential decay toward zero across one hour.
    wetness = wetness * Math.exp(-dryRate);
    if (wetness < 0.001) wetness = 0;

    // Convert wetness → 0–100 dryness score.
    // wetness=0 → 100, wetness=1 (just saturated) → ~37, wetness=2 → ~14,
    // wetness=3 (deluge cap) → ~5. Using exp curve keeps the top tier informative.
    const dryness = Math.round(100 * Math.exp(-wetness));
    series[i] = { wetness: Math.round(wetness * 100) / 100, dryness };
  }
  return series;
}

// ---- Solar position ----
//
// Compute sun azimuth (° from north, clockwise) and altitude (° above horizon)
// for a given UTC date at a given lat/lon. Algorithm is the standard
// NOAA / "Astronomical Almanac" low-precision formula — accurate to ~1°,
// which is plenty for deciding whether the sun is hitting a wall.
//
// References: NOAA Solar Position Algorithm; Astronomical Algorithms (Meeus).
export function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  // Julian day from JS Date (UTC)
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0

  // Mean longitude and mean anomaly of the sun (degrees)
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;

  // Ecliptic longitude (degrees)
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;

  // Obliquity of the ecliptic
  const epsilon = (23.439 - 0.0000004 * n) * rad;

  // Right ascension and declination
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));

  // Greenwich Mean Sidereal Time (degrees) → Local Sidereal Time
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = ((gmst * 15) + lon) * rad; // radians

  // Hour angle
  let H = lst - ra;
  // Normalise to [-pi, pi]
  while (H > Math.PI) H -= 2 * Math.PI;
  while (H < -Math.PI) H += 2 * Math.PI;

  const phi = lat * rad;

  // Altitude
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  );

  // Azimuth (from north, clockwise) — standard formula
  const azimuth = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
  );
  // atan2 above gives azimuth from south; convert to from-north clockwise.
  let azDeg = (azimuth / rad + 180) % 360;
  if (azDeg < 0) azDeg += 360;

  return { altitude: altitude / rad, azimuth: azDeg };
}

// Mapping from compass aspect code to the centre of the arc that faces it.
// A wall with aspect 'N' faces north → azimuth 0°. 'NE' → 45°, 'E' → 90°, etc.
const ASPECT_AZIMUTH = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
};

// True when an aspect string maps to a concrete compass bearing we can do
// geometry against. Parent crags with multi-aspect children (Cathedral Ranges,
// You Yangs etc.) use 'mixed' — they don't have a single wall direction, so
// sun-on-wall geometry is meaningless at the parent level.
export function hasConcreteAspect(aspect) {
  return aspect != null && Object.prototype.hasOwnProperty.call(ASPECT_AZIMUTH, aspect);
}

// Returns true if the sun (at given azimuth/altitude) is illuminating a wall
// of the given aspect. We treat a wall as lit when the sun's azimuth is within
// 75° of the wall's outward normal AND the sun is above ~3° (avoiding pre-dawn
// and twilight scatter). Mixed/unknown aspects return false — callers should
// check `hasConcreteAspect` and fall back to author-provided text instead of
// pretending they have a precise sun window.
export function sunOnAspect(aspect, sunAz, sunAlt) {
  if (sunAlt <= 3) return false;
  const wallAz = ASPECT_AZIMUTH[aspect];
  if (wallAz == null) return false;
  let diff = Math.abs(sunAz - wallAz);
  if (diff > 180) diff = 360 - diff;
  return diff <= 75;
}

// Parse a Melbourne-local ISO hour string ('2026-05-19T08:00') back into a Date
// (treating the string as Australia/Melbourne wall-clock time).
function melbourneHourToDate(isoLocal) {
  // Melbourne is UTC+10 (AEST) or +11 (AEDT). We need the right offset for the date.
  // Simplest reliable approach: build a Date from the ISO string interpreted as
  // local time-zoned via Intl, then extract.
  // Trick: format the candidate as both UTC and Melbourne and adjust.
  // For our purposes (only used in sun math, ~1° precision), DST error of 1 hour
  // shifts azimuth by ~15° — acceptable; but we still want it right.
  // Use a two-pass approach.
  const naiveUtc = new Date(isoLocal + 'Z'); // pretend the string is UTC
  // Find what Melbourne offset is at that instant.
  const offsetMin = melbourneOffsetMinutes(naiveUtc);
  return new Date(naiveUtc.getTime() - offsetMin * 60000);
}

function melbourneOffsetMinutes(date) {
  // Compute the timezone offset of Australia/Melbourne at this instant.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  let h = parseInt(get('hour'), 10);
  if (h === 24) h = 0;
  const localMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    h,
    parseInt(get('minute'), 10),
  );
  return (localMs - date.getTime()) / 60000;
}

// Build hourly strip data for a given crag and date. Array of objects
// { hour, isoHour, temp, wind, precip, precipProb, cloud, weatherCode, dryness,
//   sunAlt, sunAz, sunOnWall, score, isNow } limited to climbable hours
// (default 6am–7pm). For "today" pass `fromHour = currentMelbourneHour` so
// past hours are dropped from the strip.
function buildDayHourly(crag, hourly, drynessSeries, dateStr, fromHour = 6, toHour = 19) {
  if (!hourly || !hourly.time || !drynessSeries.length) return [];
  const out = [];
  const nowHour = melbourneHourNow();
  const isTodayStrip = dateStr === melbourneDateString(new Date());
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (!t.startsWith(dateStr)) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour < fromHour || hour > toHour) continue;
    const when = melbourneHourToDate(t);
    const sun = sunPosition(when, crag.lat, crag.lon);
    // Mixed/unknown aspect → we don't know if the wall is lit. Surface that as
    // null so the UI can show a neutral marker rather than "in shade".
    const lit = hasConcreteAspect(crag.aspect)
      ? sunOnAspect(crag.aspect, sun.azimuth, sun.altitude)
      : null;
    out.push({
      hour,
      isoHour: t,
      temp: hourly.temperature_2m?.[i] ?? null,
      wind: hourly.windspeed_10m?.[i] ?? null,
      windDir: hourly.winddirection_10m?.[i] ?? null,
      windGust: hourly.windgusts_10m?.[i] ?? null,
      windExposure: aspectWindFactor(
        crag.aspect,
        hourly.winddirection_10m?.[i] ?? null,
        Math.max(hourly.windspeed_10m?.[i] ?? 0, (hourly.windgusts_10m?.[i] ?? 0) * 0.7),
      ).exposure,
      humidity: hourly.relative_humidity_2m?.[i] ?? null,
      precip: hourly.precipitation?.[i] ?? 0,
      precipProb: hourly.precipitation_probability?.[i] ?? 0,
      cloud: hourly.cloudcover?.[i] ?? 0,
      weatherCode: hourly.weathercode?.[i] ?? null,
      dryness: drynessSeries[i]?.dryness ?? null,
      sunAlt: Math.round(sun.altitude),
      sunAz: Math.round(sun.azimuth),
      sunOnWall: lit,
      // Mark the cell whose hour matches the current Melbourne hour so the UI
      // can highlight "now" on the today strip. False for tomorrow/future.
      isNow: isTodayStrip && hour === nowHour,
    });
  }
  // Now score each hour and find the best window.
  // Pass each hour its rain context: count of hours within ±2h window that
  // also have precipProb > 30%. Sustained rain across the window should
  // penalise each hour more than a single isolated rainy hour.
  for (let i = 0; i < out.length; i++) {
    const nearby = out.slice(Math.max(0, i - 2), Math.min(out.length, i + 3));
    const rainNeighbours = nearby.filter(n => n !== out[i] && n.precipProb > 30).length;
    out[i].score = scoreHour(crag, out[i], rainNeighbours);
  }
  return out;
}

// Thin wrapper kept for clarity at call sites.
function buildTomorrowHourly(crag, hourly, drynessSeries, tomorrowDate) {
  return buildDayHourly(crag, hourly, drynessSeries, tomorrowDate, 6, 19);
}

// For the today strip we drop hours already past so the strip is forward-looking.
// We always keep the *current* hour (use floor of now).
function buildTodayHourly(crag, hourly, drynessSeries, todayDate) {
  const fromHour = Math.max(6, melbourneHourNow());
  return buildDayHourly(crag, hourly, drynessSeries, todayDate, fromHour, 19);
}

// Current hour-of-day in Melbourne local time, as an integer 0–23.
function melbourneHourNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Melbourne', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = parts.find(p => p.type === 'hour')?.value ?? '0';
  return parseInt(h, 10) % 24;
}

// Score a single hour 0–100 for climbing quality at this crag.
// Combines: rain (heavy penalty), temperature vs ideal, dryness, wind,
// and aspect-vs-sun bonuses or penalties depending on temperature.
// rainNeighbours: count of hours within ±2h that also have precipProb > 30%.
// Used to scale up the probability penalty for sustained rain windows vs
// isolated single-hour showers.
function scoreHour(crag, h, rainNeighbours = 0) {
  let s = 100;
  // Tracks whether any real penalty fired this hour (mirrors scoreDay's
  // `contributions.some(c => c.delta < 0)` check). Only actual non-zero
  // deductions count — e.g. a dryness delta that rounds to 0 doesn't.
  let hasPenalty = false;
  const penalize = (amount) => {
    if (amount > 0) { s -= amount; hasPenalty = true; }
  };

  // Rain — actual measured precip takes priority.
  // For probability-only rain, scale the penalty by how many surrounding
  // hours also have elevated probability (sustained = worse than a shower).
  if (h.precip > 1) penalize(70);
  else if (h.precip > 0.2) penalize(35);
  else if (h.precipProb > 60) {
    // Base -20, +3 per sustained neighbour, capped at -32
    penalize(Math.min(32, 20 + rainNeighbours * 3));
  } else if (h.precipProb > 30) {
    // Base -8, +2 per sustained neighbour, capped at -16
    penalize(Math.min(16, 8 + rainNeighbours * 2));
  }

  // Temperature vs ideal
  const [idealMin, idealMax] = crag.idealTemp;
  if (h.temp < idealMin) {
    penalize(Math.min(25, (idealMin - h.temp) * 2.5));
  } else if (h.temp > idealMax) {
    penalize(Math.min(35, (h.temp - idealMax) * 3.5));
  }

  // Dryness — penalty up to 35
  if (h.dryness != null && h.dryness < 100) {
    penalize(Math.round(((100 - h.dryness) / 100) * 35));
  }

  // Wind
  if (h.wind > 50) penalize(15);
  else if (h.wind > 35) penalize(5);

  // Humidity does not affect the hourly score (v59.14). It is surfaced as a
  // stat tile + chip on the day card instead — see scoreDay and the UI.

  // Sun-on-wall interactions. h.sunOnWall is null for mixed-aspect parents —
  // skip these tweaks rather than guess (children carry the real aspect).
  if (h.sunOnWall === true) {
    if (h.temp > 24) penalize(8); // sun-baked
    else if (h.temp < 12) s += 5; // sun-trap (bonus)
    else if (h.temp < 18) s += 3; // bonus
  } else if (h.sunOnWall === false) {
    // In shade
    if (h.temp > 24) s += 4; // shade is welcome (bonus)
    else if (h.temp < 8) penalize(4); // cold and shaded
  }

  // — Penalty integrity cap — same rule as scoreDay(): an hour that took
  // any real penalty can't claim a perfect 100, even if bonuses clawed it
  // all the way back there. Keeps hour-by-hour scores honest relative to
  // the day score, which already applies this same cap.
  const rawFinal = Math.max(0, Math.min(100, Math.round(s)));
  return (hasPenalty && rawFinal === 100) ? 99 : rawFinal;
}

// Find the best climbing window in a tomorrow-hourly array.
// A "window" is any run of consecutive hours all scoring ≥ threshold.
// We first find every qualifying run, then — for each — slide a fixed-width
// MAX_HOURS window across it and pick the highest-average sub-window. This
// keeps the recommendation actionable: even on a bluebird day where 12 hours
// all qualify, the user sees "best 5h block" rather than "any time, all day."
//
// Returns the highest-scoring window, or null if no run is long enough.
export function bestWindow(hourly) {
  if (!hourly || hourly.length < 2) return null;
  const threshold = 60;
  const MIN_HOURS = 2;
  const MAX_HOURS = 5;

  // Step 1: collect every contiguous run of qualifying hours.
  const runs = [];
  let cur = null;
  const closeRun = () => {
    if (cur && cur.hours.length >= MIN_HOURS) runs.push(cur);
    cur = null;
  };
  for (const h of hourly) {
    if (h.score >= threshold) {
      if (!cur) cur = { hours: [h] };
      else cur.hours.push(h);
    } else {
      closeRun();
    }
  }
  closeRun();
  if (runs.length === 0) return null;

  // Step 2: within each run, find the best fixed-width sub-window.
  // For runs shorter than MAX_HOURS we just use the whole run.
  // We also carry forward the *full* run's bounds and average so the UI can
  // upgrade the label to "Good all day" when one run blankets the climbable day.
  let bestRun = null;
  for (const run of runs) {
    const n = run.hours.length;
    const winLen = Math.min(MAX_HOURS, n);
    let bestStart = 0;
    let bestSum = -Infinity;
    for (let i = 0; i + winLen <= n; i++) {
      let sum = 0;
      for (let j = 0; j < winLen; j++) sum += run.hours[i + j].score;
      // Prefer earlier starts on ties so callers get a stable, intuitive pick
      // ("start at 9am" beats "start at 10am" if both averages match).
      if (sum > bestSum) { bestSum = sum; bestStart = i; }
    }
    const slice = run.hours.slice(bestStart, bestStart + winLen);
    const avg = bestSum / winLen;
    const runSum = run.hours.reduce((a, h) => a + h.score, 0);
    const candidate = {
      start: slice[0].hour,
      end: slice[slice.length - 1].hour + 1,
      sumScore: bestSum,
      count: winLen,
      hours: slice,
      avg,
      // Full underlying run — used by callers to detect "good all day" cases.
      runStart: run.hours[0].hour,
      runEnd: run.hours[run.hours.length - 1].hour + 1,
      runHours: n,
      runAvg: runSum / n,
    };
    // Pick the highest-avg sub-window across all runs; tie-break by length.
    if (!bestRun || candidate.avg > bestRun.avg ||
        (candidate.avg === bestRun.avg && candidate.count > bestRun.count)) {
      bestRun = candidate;
    }
  }
  return bestRun;
}

// Map a 0–100 dryness number to a category + label + colour band.
export function drynessBand(score) {
  if (score >= 90) return { label: 'Dry', short: 'Dry', color: 'success' };
  if (score >= 70) return { label: 'Mostly dry', short: 'Mostly dry', color: 'success' };
  if (score >= 50) return { label: 'Damp', short: 'Damp', color: 'warning' };
  if (score >= 30) return { label: 'Wet', short: 'Wet', color: 'warning' };
  return { label: 'Soaked', short: 'Soaked', color: 'error' };
}

function currentDryness(hourly, series) {
  if (!hourly || !hourly.time || !series.length) return null;
  const idx = nearestHourIndex(hourly.time, new Date());
  if (idx == null) return null;
  return series[idx]?.dryness ?? null;
}

// Find the index in hourly.time closest to a given Date (in Australia/Melbourne).
function nearestHourIndex(timeArr, when) {
  // hourly.time is in local Melbourne time as 'YYYY-MM-DDTHH:00' (because we set timezone)
  // Build the target local hour string for comparison.
  const targetIso = melbourneIsoHour(when);
  // Exact match preferred.
  const exact = timeArr.indexOf(targetIso);
  if (exact !== -1) return exact;
  // Otherwise find the closest hour by string comparison (lexicographic works because ISO).
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < timeArr.length; i++) {
    const diff = Math.abs(stringToHourDiff(timeArr[i], targetIso));
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return bestIdx === -1 ? null : bestIdx;
}

function stringToHourDiff(a, b) {
  // a, b like '2026-05-18T10:00'. Convert to Date and diff in hours.
  const da = new Date(a);
  const db = new Date(b);
  return (da - db) / 3600000;
}

function melbourneIsoHour(when) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(when);
  const get = (t) => parts.find(p => p.type === t)?.value;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:00`;
}

function drynessAtLocalHour(hourly, series, dateStr, hour) {
  if (!hourly || !hourly.time || !series.length) return null;
  const hh = String(hour).padStart(2, '0');
  const target = `${dateStr}T${hh}:00`;
  const idx = hourly.time.indexOf(target);
  if (idx === -1) return null;
  return series[idx]?.dryness ?? null;
}

// Find the most recent significant rain event (≥0.5mm hour) before or at "now".
// Returns { hoursAgo, totalMm, peakHour } or null.
// Per-day precipitation totals for the N days immediately before `todayDate`.
// Returns array of { date, mm } in chronological order (oldest first). Used
// for the past-rain sparkline under each crag card so the user can see at a
// glance whether the crag has been hammered all week or has been dry.
function extractPastDailyPrecip(hourly, todayDate, days = 4) {
  if (!hourly || !hourly.time) return [];
  // Build a date → [precipMm] map by scanning hourly precip arrays.
  const totals = new Map();
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    const date = t.slice(0, 10);
    if (date >= todayDate) continue; // strictly past
    const mm = hourly.precipitation?.[i] ?? 0;
    totals.set(date, (totals.get(date) ?? 0) + mm);
  }
  // Convert the last N entries (sorted) into the result.
  const sorted = Array.from(totals.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const slice = sorted.slice(-days);
  return slice.map(([date, mm]) => ({
    date,
    mm: Math.round(mm * 10) / 10,
  }));
}

function findLastSignificantRain(hourly) {
  if (!hourly || !hourly.time) return null;
  const nowIdx = nearestHourIndex(hourly.time, new Date());
  if (nowIdx == null) return null;
  // Walk backward to find the end of the most recent wet cluster.
  let endIdx = -1;
  for (let i = nowIdx; i >= 0; i--) {
    const mm = hourly.precipitation?.[i] ?? 0;
    if (mm >= 0.3) { endIdx = i; break; }
  }
  if (endIdx === -1) return null;
  // Find start of this cluster (walking back while still wet, allowing 1h gaps).
  let startIdx = endIdx;
  let gap = 0;
  for (let i = endIdx - 1; i >= 0; i--) {
    const mm = hourly.precipitation?.[i] ?? 0;
    if (mm >= 0.2) { startIdx = i; gap = 0; }
    else { gap += 1; if (gap >= 2) break; }
  }
  let totalMm = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    totalMm += hourly.precipitation?.[i] ?? 0;
  }
  const hoursAgo = nowIdx - endIdx;
  return {
    hoursAgo,
    totalMm: Math.round(totalMm * 10) / 10,
    endTime: hourly.time[endIdx],
  };
}

// Identify the most likely rain windows on a given day. Scans hourly precip + probability,
// clusters consecutive wet hours (prob >= 30% OR mm >= 0.2), and returns up to 2 windows.
// Each window: { startHour, endHour, peakHour, peakProb, totalMm, label }
// Returns [] if no meaningful rain risk.
function extractRainWindows(hourly, dateStr) {
  if (!hourly || !hourly.time) return [];
  const times = hourly.time;
  const probs = hourly.precipitation_probability || [];
  const mm = hourly.precipitation || [];

  // Collect indices for this date
  const idx = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i].startsWith(dateStr)) idx.push(i);
  }
  if (!idx.length) return [];

  // Mark wet hours (prob ≥ 30 OR ≥ 0.2mm)
  const wet = idx.map(i => ({
    hour: parseInt(times[i].slice(11, 13), 10),
    prob: probs[i] ?? 0,
    mm: mm[i] ?? 0,
    isWet: (probs[i] ?? 0) >= 30 || (mm[i] ?? 0) >= 0.2,
  }));

  // Cluster consecutive wet hours into windows
  const windows = [];
  let cur = null;
  for (const h of wet) {
    if (h.isWet) {
      if (!cur) cur = { hours: [h] };
      else cur.hours.push(h);
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);

  // Build summary objects
  const summaries = windows.map(w => {
    const peak = w.hours.reduce((a, b) => (b.prob > a.prob ? b : a), w.hours[0]);
    const totalMm = w.hours.reduce((s, h) => s + h.mm, 0);
    const start = w.hours[0].hour;
    const end = w.hours[w.hours.length - 1].hour + 1;
    return {
      startHour: start,
      endHour: end,
      peakHour: peak.hour,
      peakProb: Math.round(peak.prob),
      totalMm: Math.round(totalMm * 10) / 10,
      label: formatHourRange(start, end),
    };
  });

  // Rank by total rain × prob (importance), keep top 2
  summaries.sort((a, b) => (b.totalMm * b.peakProb) - (a.totalMm * a.peakProb));
  return summaries.slice(0, 2);
}

function formatHourRange(startH, endH) {
  const fmt = h => {
    if (h === 0) return '12am';
    if (h === 24) return 'midnight';
    if (h === 12) return '12pm';
    if (h < 12) return `${h}am`;
    return `${h - 12}pm`;
  };
  // If a single-hour window, show it as e.g. "5pm".
  if (endH - startH <= 1) return fmt(startH);
  return `${fmt(startH)}–${fmt(endH)}`;
}

// Climbable hour window. Rain outside this window doesn't ruin the day at the
// daily-score level (the hourly model + dryness already capture lingering wet-rock
// effects from pre-window rain).
//   start: typical earliest climbing start — 9am gives time for the rock to dry
//     after a dawn shower, plus the drive in. Weekend trips can start earlier
//     because you're already onsite.
//   end:   you're not climbing in the dark. Day trips: 6pm. Weekend trips: 8pm.
function climbStartHour(crag) {
  return (crag.trip === 'weekend' || crag.trip === 'both') ? 8 : 9;
}
function climbCutoffHour(crag) {
  return (crag.trip === 'weekend' || crag.trip === 'both') ? 20 : 18;
}

// Returns { sum, peakProb } for rain that falls during climbable hours only
// (between climbStart and cutoff). A window that straddles either bound is
// counted proportionally by overlap. Windows fully outside the climbing day
// (pre-dawn drizzle, or post-cutoff evening rain) don't contribute to the
// daily rain penalty — dryness handles their carry-over effect.
function climbableRain(day, startH, cutoffH) {
  const windows = day.rainWindows || [];
  if (!windows.length) {
    return { sum: day.precipSum || 0, peakProb: day.precipProb || 0, allAfterDark: false, sumBeforeClimb: 0, sumAfter: 0 };
  }
  let sumDuring = 0;
  let peakDuring = 0;
  let probHours = 0;      // accumulated peakProb × overlap hours — for weighted mean
  let sumBeforeClimb = 0; // rain that finished before climbing starts (e.g. dawn shower)
  let sumAfter = 0;       // rain after cutoff (post-dark)
  for (const w of windows) {
    const span = Math.max(1, w.endHour - w.startHour);
    // Fully before climb starts
    if (w.endHour <= startH) {
      sumBeforeClimb += w.totalMm;
      continue;
    }
    // Fully after cutoff
    if (w.startHour >= cutoffH) {
      sumAfter += w.totalMm;
      continue;
    }
    // Some overlap with the climbing window
    const overlapStart = Math.max(w.startHour, startH);
    const overlapEnd = Math.min(w.endHour, cutoffH);
    const duringFrac = Math.max(0, overlapEnd - overlapStart) / span;
    const beforeFrac = w.startHour < startH ? (startH - w.startHour) / span : 0;
    const afterFrac = w.endHour > cutoffH ? (w.endHour - cutoffH) / span : 0;
    sumDuring += w.totalMm * duringFrac;
    sumBeforeClimb += w.totalMm * beforeFrac;
    sumAfter += w.totalMm * afterFrac;
    // Only count peak prob if the peak hour falls inside the climbing window.
    if (w.peakHour >= overlapStart && w.peakHour < overlapEnd) {
      peakDuring = Math.max(peakDuring, w.peakProb);
    }
    // Accumulate prob × overlap hours for the time-weighted mean.
    // Uses the window's peakProb as a proxy for the whole window — conservative
    // (it's the worst hour) but avoids needing per-hour arrays here.
    probHours += w.peakProb * Math.max(0, overlapEnd - overlapStart);
  }
  // Time-weighted mean probability across all climbable hours.
  // Unrainy hours contribute 0, so this naturally dilutes a single late spike.
  const climbSpan = Math.max(1, cutoffH - startH);
  const weightedProb = Math.round(probHours / climbSpan);
  // "allAfterDark" preserved for the existing skipLateRain shortcut — true when
  // nothing meaningful fell during climbing hours but there's rain after cutoff.
  const allAfterDark = sumDuring < 0.2 && sumAfter >= 0.2;
  return { sum: sumDuring, peakProb: peakDuring, weightedProb, allAfterDark, sumBeforeClimb, sumAfter };
}

// True if the next day is climbable in the morning (no early rain, low daily rain total).
function nextMorningDry(nextDay) {
  if (!nextDay) return true; // no data → assume best case
  if ((nextDay.precipSum || 0) > 1) return false;
  const morningRain = (nextDay.rainWindows || []).some(w => w.startHour < 12);
  return !morningRain;
}

// Score a crag-day combo from 0-100. Higher = better climbing conditions.
// Factors: temperature in ideal range, low precip probability, low recent rain,
// reasonable wind, and aspect-vs-temperature interactions.
// `nextDay` is optional — used to decide whether late-evening rain can be ignored.
export function scoreDay(crag, day, prevDay, nextDay) {
  // — Seasonal closure check —
  // Crags may set `closedMonths: [8, 9, 10, 11]` for wildlife or access closures.
  // We short-circuit with score 0 and a clear reason so the card surfaces the closure
  // instead of a misleading conditions score.
  if (crag.closedAll) {
    const label = crag.closureReason ? `closed — ${crag.closureReason}` : 'currently closed';
    return {
      score: 0,
      reasons: [label],
      contributions: [{ category: 'closure', label, delta: -100, detail: label }],
    };
  }
  if (Array.isArray(crag.closedMonths) && crag.closedMonths.length) {
    const month = new Date(day.date + 'T12:00:00').getMonth() + 1; // 1–12
    if (crag.closedMonths.includes(month)) {
      const label = crag.closureReason ? `closed — ${crag.closureReason}` : 'closed (seasonal)';
      return {
        score: 0,
        reasons: [label],
        contributions: [{ category: 'closure', label, delta: -100, detail: label }],
      };
    }
  }
  let score = 100;
  const reasons = [];
  // Each contribution: { category, label, delta, detail }
  // category: temp | aspect | bestIn | precip | dryness | wind | sun | climate
  // delta: positive (bonus) or negative (penalty); rounded to int when applied
  // detail: short human-readable description of why this contribution applied
  const contributions = [];
  const add = (category, label, delta, detail) => {
    if (delta === 0) return;
    contributions.push({ category, label, delta: Math.round(delta), detail });
  };

  // — Climate baseline lookup (v59.17) —
  // Resolve the monthly climate normals for this crag so downstream blocks
  // can contextualise conditions against what’s typical here in this month.
  const _month = new Date(day.date + 'T12:00:00').toLocaleString('en-AU', { month: 'short' });
  const _profileKey = CRAG_TO_PROFILE[crag.id];
  const _profile = _profileKey ? CLIMATE_PROFILES[_profileKey] : null;
  const _norm = _profile?.monthly?.[_month] ?? null;
  // Convenience accessors — fall back gracefully if no profile exists
  const normTMax  = _norm?.tMax  ?? null;
  const normRh    = _norm?.rhMean ?? null;
  const normWind  = _norm?.windMax ?? null;

  // — Effective precipitation: only rain during climbable hours counts —
  // Climbable hours = climbStartHour..climbCutoffHour. Pre-climb rain (e.g. a
  // 2am–9am drizzle that's clear by climbing time) is already captured by the
  // hourly dryness model, so it doesn't double-count here.
  const startH = climbStartHour(crag);
  const cutoffH = climbCutoffHour(crag);
  const climb = climbableRain(day, startH, cutoffH);
  // Always use the climbable-hours sum/prob. The full-day precipSum was the old
  // fallback when we lacked hourly windows, but the windows-based path is now
  // robust enough to use unconditionally — morning-only rain shouldn't tank the
  // score for an otherwise dry afternoon.
  const effectiveSum = climb.sum;
  // weightedProb: time-weighted mean prob across climbable hours (dilutes a single
  // late-afternoon spike across the whole climbing day). Used for penalty thresholds.
  // peakProb: the worst single hour — kept for the detail string so users still
  // see the actual peak risk.
  const effectiveProb = climb.weightedProb ?? climb.peakProb;
  const peakProb = climb.peakProb;
  // Late-rain flag retained for the "rain after dark only" reason string.
  const skipLateRain = climb.allAfterDark && nextMorningDry(nextDay);

  // — Temperature scoring —
  // Old model used the day's peak apparent temperature (tFeel). That's the
  // warmest moment of the day — if it just clips into the ideal range, the
  // crag scores well even though most of the climbing window is too cold or
  // too hot. The new model uses the MEAN apparent temperature during climbing
  // hours plus a dwell-time correction.
  const [idealMin, idealMax] = crag.idealTemp;
  const ct = day.climbTemps || {};
  const climbHours = ct.climbHours || 0;
  // Headline temperature: mean apparent across climbing hours when we have
  // hourly data, otherwise fall back to the peak feels-like.
  const t = (climbHours > 0 && ct.meanApparent != null) ? ct.meanApparent : (day.tFeel ?? day.tMax);
  // Fraction of the climbing window that's actually in the comfort band.
  const inRangeFrac = climbHours > 0 ? ct.hoursInRange / climbHours : 1;
  // Dwell-time penalty: even if the mean is in-range, a window where only a
  // couple of hours sit inside the comfort band shouldn't score as "ideal".
  //   inRangeHours ≥ 6 → 0 penalty (most of the climbing day comfortable)
  //   inRangeHours = 4 → -1.4
  //   inRangeHours = 2 → -5.6
  //   inRangeHours = 0 → -10 (capped) on top of the temp-distance penalty
  let dwellPen = 0;
  if (climbHours >= 4) {
    const shortfall = Math.max(0, 6 - ct.hoursInRange);
    dwellPen = Math.min(10, shortfall * shortfall * 0.35);
  }
  if (t < idealMin) {
    const diff = idealMin - t;
    // Cold is climbable, just less pleasant — slightly gentler curve than
    // the heat side (×2.5 vs ×4) and capped at 25.
    const pen = Math.min(25, diff * 2.5) + dwellPen;
    score -= pen;
    if (diff > 5) reasons.push(`cold (${Math.round(t)}°C avg)`);
    const detail = climbHours > 0
      ? `${Math.round(t)}°C avg during climbing hours — ${Math.round(diff)}° below ideal (${idealMin}–${idealMax}°C); only ${ct.hoursInRange}/${climbHours}h in range`
      : `${Math.round(t)}°C — ${Math.round(diff)}° below ideal (${idealMin}–${idealMax}°C)`;
    add('temp', 'Temperature', -pen, detail);
  } else if (t > idealMax) {
    const diff = t - idealMax;
    const pen = Math.min(40, diff * 4) + dwellPen;
    score -= pen;
    if (diff > 3) reasons.push(`hot (${Math.round(t)}°C avg)`);
    const detail = climbHours > 0
      ? `${Math.round(t)}°C avg during climbing hours — ${Math.round(diff)}° above ideal (${idealMin}–${idealMax}°C); only ${ct.hoursInRange}/${climbHours}h in range`
      : `${Math.round(t)}°C — ${Math.round(diff)}° above ideal (${idealMin}–${idealMax}°C)`;
    add('temp', 'Temperature', -pen, detail);
  } else if (climbHours > 0 && dwellPen > 0) {
    // Mean lands in-range but a chunk of the climbing window is outside it.
    // Apply just the dwell-time penalty so users see why the day still drags.
    score -= dwellPen;
    if (ct.hoursCold > ct.hoursHot) {
      reasons.push(`cool stretches (${ct.hoursCold}h)`);
      add('temp', 'Temperature', -dwellPen, `mean ${Math.round(t)}°C, but only ${ct.hoursInRange}/${climbHours}h in range — ${ct.hoursCold}h cooler than ideal`);
    } else if (ct.hoursHot > 0) {
      reasons.push(`hot stretches (${ct.hoursHot}h)`);
      add('temp', 'Temperature', -dwellPen, `mean ${Math.round(t)}°C, but only ${ct.hoursInRange}/${climbHours}h in range — ${ct.hoursHot}h hotter than ideal`);
    } else {
      // Edge case: range is tiny so all out-of-range hours rounded to neither bucket
      add('temp', 'Temperature', -dwellPen, `mean ${Math.round(t)}°C, but only ${ct.hoursInRange}/${climbHours}h in range`);
    }
  } else {
    reasons.push(`temp ideal (${Math.round(t)}°C)`);
    const detail = climbHours > 0
      ? `${Math.round(t)}°C avg during climbing hours — ${ct.hoursInRange}/${climbHours}h inside ideal (${idealMin}–${idealMax}°C)`
      : `${Math.round(t)}°C — inside ideal range (${idealMin}–${idealMax}°C)`;
    add('temp', 'Temperature', 0, detail);
  }

  // — Humidity: descriptive label + score delta (v59.15) —
  //
  // Label is resolved here and pushed to reasons. The score delta is applied
  // AFTER all other bonuses (just before finalScore) so it can't be offset
  // by downstream bonuses pushing score back above 100.
  let _humidLabel = null;
  let _humidDelta = 0;
  {
    const hum = day.climbHumidity || {};
    const humClimbHours = hum.climbHours || 0;
    if (humClimbHours >= 4) {
      const hoursHumid = hum.hoursHumid || 0;
      const hoursDry = hum.hoursDry || 0;
      const meanRh = hum.meanRh ?? 70;
      const muggyHours = hoursHumid + 0.4 * (hum.hoursModerate || 0);
      // Baseline-adjusted dry threshold: if this crag normally sits at 80% RH,
      // 65% is genuinely dry for it — raise the 'dry air' trigger accordingly.
      const dryRhThresh = normRh != null ? Math.min(65, normRh - 15) : 55;

      if (climbHours > 0 && t >= 22 && hoursHumid >= 2) {
        _humidLabel = 'muggy';     _humidDelta = -8;
      } else if (t >= 18 && hoursHumid >= 4) {
        _humidLabel = 'muggy';     _humidDelta = -8;
      } else if (hoursHumid >= 3 || muggyHours >= 5) {
        _humidLabel = 'moist air'; _humidDelta = -3;
      } else if (hoursDry >= 6 && muggyHours === 0) {
        _humidLabel = 'crisp air'; _humidDelta = +3;
      } else if (meanRh < dryRhThresh) {
        _humidLabel = 'dry air';   _humidDelta = +2;
      } else {
        _humidLabel = 'comfortable'; _humidDelta = 0;
      }

      if (_humidLabel) reasons.push(_humidLabel);
    }
  }

  // — Sun-on-wall × temperature interaction (true solar geometry) —
  //
  // Replaces the old aspect-string cascade with hour-by-hour solar exposure
  // already computed in `day.sunHoursOnWall{,Warm,Cool}` (see
  // computeSolarExposure). The wall might be N-facing but tucked behind a
  // ridge that blocks the morning sun, or W-facing in winter when the sun
  // never gets high enough to hit it. Geometry handles all of that.
  //
  //   warmHours = cloud-adjusted hours of sun on the wall during 11am–4pm
  //   coolHours = cloud-adjusted hours of sun on the wall during 8am–11am
  //   totalHours = cloud-adjusted hours of sun on the wall over the whole day
  const sunHours = (day.sunshine ?? 0) / 3600;
  const warmHours = day.sunHoursOnWallWarm ?? 0;
  const coolHours = day.sunHoursOnWallCool ?? 0;
  const onWallHours = day.sunHoursOnWall ?? 0;
  const cloudMean = day.cloudMean ?? null; // mean daytime cloud cover %

  // Hot day (>22°C): each hour of direct sun on the wall during the hottest
  // part of the day adds a penalty. Capped so it can't dominate the score.
  if (t > 22) {
    if (warmHours >= 0.5) {
      const pen = Math.min(14, Math.round(warmHours * 3));
      score -= pen;
      if (pen >= 6) reasons.push('sun-baked wall');
      else if (t > 25 && warmHours > 2) reasons.push('afternoon sun-trap');
      add('aspect', 'Sun on wall × heat', -pen, `${warmHours.toFixed(1)}h direct sun on wall during the hottest hours`);
    }
    // Shade refuge: hot day AND the wall barely sees the sun in the warm window.
    if (warmHours < 1 && onWallHours < 3) {
      const bon = Math.min(8, Math.round(6 + (3 - Math.min(onWallHours, 3))));
      score += bon;
      reasons.push('shaded refuge');
      add('aspect', 'Shade × heat', +bon, `${onWallHours.toFixed(1)}h sun on wall — stays cool in the heat`);
    } else if (warmHours < 2 && onWallHours < 5) {
      // Afternoon-only shade still helps a bit.
      const bon = 3;
      score += bon;
      add('aspect', 'Partial shade × heat', +bon, `${warmHours.toFixed(1)}h direct sun in the warm window — partial shade helps`);
    }
  } else if (t > 18) {
    // Mid-warm day: smaller signal, same direction.
    if (warmHours >= 2) {
      const pen = Math.min(7, Math.round(warmHours * 1.4));
      score -= pen;
      add('aspect', 'Sun on wall × warmth', -pen, `${warmHours.toFixed(1)}h direct sun during 11am–4pm`);
    }
    if (warmHours < 1 && onWallHours < 3) {
      const bon = 3;
      score += bon;
      add('aspect', 'Shaded × warmth', +bon, `wall mostly in shade — mild bonus on a warm day`);
    }
  }

  // — Cloud kills sun-trap penalty —
  // On N/NE-facing crags whose appeal depends entirely on winter sun, heavy
  // overcast is not just a neutral modifier — it actively makes the crag cold
  // and grim. The sun-trap bonus already shrinks to zero via cloud-adjusted
  // sunHoursOnWall, but we need an *extra* penalty to reflect that the whole
  // reason to visit the crag (warmth) has been eliminated.
  //
  // Fires when:
  //   • N or NE aspect (sun-dependent orientation)
  //   • cold or cool day (t < 16°C — sun is the comfort mechanism)
  //   • cloudMean > 70% (heavy enough to kill direct sun)
  //   • no rain (rain is already penalised separately)
  //   • crag shade is not already 'all-day' (would be redundant)
  if (cloudMean != null && cloudMean > 70 && t < 16 &&
      (crag.aspect === 'N' || crag.aspect === 'NE' || crag.aspect === 'NW') &&
      crag.shade !== 'all-day' && (day.precipProb ?? 0) < 50) {
    // Scale: 70–80% cloud → -4, 80–90% → -7, 90%+ → -10
    // Steeper on colder days (t < 8 = full effect, t 8–16 = 70% effect)
    const cloudSeverity = cloudMean > 90 ? 10 : cloudMean > 80 ? 7 : 4;
    const coldMultiplier = t < 8 ? 1.0 : 0.7;
    const pen = Math.round(cloudSeverity * coldMultiplier);
    score -= pen;
    reasons.push('overcast sun-trap');
    add('sun', 'Cloud kills sun-trap', -pen,
      `${Math.round(cloudMean)}% daytime cloud on a N-facing wall — no direct sun, loses its warmth advantage`);
  }

  // Cold day (<8°C): morning sun on the wall is gold; full shade is grim.
  // Full bonus requires 2h+ of sun; 1–2h earns a partial bonus; <1h nothing.
  // tMax floor: if the day can't reach 10°C even with full sun, the wall stays
  // too cold for sun to be a meaningful asset — no bonus awarded.
  const tMax = day.tMax ?? t;
  if (t < 8) {
    if (tMax < 10) {
      // Too cold for sun to help — skip bonus entirely, shade penalty still applies
    } else if (coolHours >= 2 || warmHours >= 2.5) {
      const sunTrapHrs = coolHours + 0.5 * warmHours;
      const bon = Math.min(10, Math.round(sunTrapHrs * 2.5));
      score += bon;
      reasons.push('sun-trap wall');
      add('aspect', 'Sun on wall × cold', +bon, `${coolHours.toFixed(1)}h morning sun + ${warmHours.toFixed(1)}h midday on wall — a real sun-trap`);
    } else if (coolHours >= 1 || warmHours >= 1.5) {
      const sunTrapHrs = coolHours + 0.5 * warmHours;
      const bon = Math.min(5, Math.round(sunTrapHrs * 2.5));
      score += bon;
      add('aspect', 'Sun on wall × cold (partial)', +bon, `${coolHours.toFixed(1)}h morning sun + ${warmHours.toFixed(1)}h midday — some warmth but limited`);
    }
    if (onWallHours < 1) {
      const pen = 8;
      score -= pen;
      reasons.push('cold & shaded');
      add('aspect', 'Shade × cold', -pen, `wall barely sees the sun — stays cold all day`);
    }
  } else if (t < 12) {
    // Full bonus requires 2h+ of sun; 1–2h earns a partial bonus; <1h nothing.
    if (coolHours >= 2 || warmHours >= 2.5) {
      const sunTrapHrs = coolHours + 0.5 * warmHours;
      const bon = Math.min(5, Math.round(sunTrapHrs * 1.4));
      score += bon;
      add('aspect', 'Sun on wall × cool', +bon, `${onWallHours.toFixed(1)}h sun on wall on a cool day — takes the edge off`);
    } else if (coolHours >= 1 || warmHours >= 1.5) {
      const bon = 2;
      score += bon;
      add('aspect', 'Sun on wall × cool (partial)', +bon, `${onWallHours.toFixed(1)}h sun on wall — mild benefit on a cool day`);
    }
    if (onWallHours < 1) {
      const pen = 3;
      score -= pen;
      add('aspect', 'Shade × cool', -pen, `wall in shade most of the day — stays cool`);
    }
  }

  // — Per-crag heat cap (e.g. sun-bath aspects with no shade) —
  // Crags can set `heatCap: 22` to flag that they become genuinely hot above
  // that threshold on clear days. Falcon's Lookout is the canonical case: N-aspect,
  // no shade, conglomerate that gets uncomfortable over 22°C with clear sky.
  // Uses the PEAK apparent temperature (not the mean) because even a single
  // baking hour on a sun-trap aspect is the limiting factor for the day.
  const peakHeat = (ct.maxApparent != null) ? ct.maxApparent : (day.tFeel ?? day.tMax);
  if (typeof crag.heatCap === 'number' && peakHeat > crag.heatCap) {
    // sunHours is daily clear-sky proxy in hours (sunshine_duration / 3600).
    // Scale ramps quickly: at the cap the wall is already warm; every degree
    // over compounds because there's no shade refuge on these aspects.
    //   1° over: -8   |  3° over: -16  |  6° over (e.g. 28°C at Falcon's): -28
    //   10° over: hits the -40 cap (matches the temperature-mismatch ceiling).
    // Even on a partly cloudy day there's still meaningful sun on a N aspect,
    // so we apply a softer multiplier rather than a hard sunHours gate.
    const over = peakHeat - crag.heatCap;
    const clearness = Math.min(1, Math.max(0.4, sunHours / 7));
    const raw = (5 + over * 3) * clearness;
    const pen = Math.min(40, Math.round(raw));
    if (pen > 0) {
      score -= pen;
      reasons.push('sun-baked aspect');
      const climate = sunHours >= 5 ? `${sunHours.toFixed(1)}h of clear sun` : `${sunHours.toFixed(1)}h of sun forecast`;
      add('aspect', 'Sun-trap × heat', -pen, `peak ${peakHeat.toFixed(0)}°C with ${climate} — this aspect bakes above ${crag.heatCap}°C`);
    }
  }

  // — bestIn alignment with conditions —
  // Soft ±5 modifier: matches the day's character to the crag's sweet spot.
  // Categories: cold (<8°C), cool (8-16°C), mild (16-22°C), warm (>22°C)
  let dayCategory;
  if (t < 8) dayCategory = 'cold';
  else if (t < 16) dayCategory = 'cool';
  else if (t < 22) dayCategory = 'mild';
  else dayCategory = 'warm';
  if (crag.bestIn === dayCategory) {
    score += 5;
    add('bestIn', 'Sweet spot match', +5, `day is ${dayCategory}; crag is best in ${crag.bestIn}`);
  } else {
    const order = ['cold', 'cool', 'mild', 'warm'];
    const dist = Math.abs(order.indexOf(dayCategory) - order.indexOf(crag.bestIn));
    let pen = 0;
    if (dist >= 2) pen += 4;
    if (dist === 3) pen += 2; // cold↔warm: full mismatch
    if (pen > 0) {
      score -= pen;
      add('bestIn', 'Sweet spot mismatch', -pen, `day is ${dayCategory}; crag is best in ${crag.bestIn}`);
    }
  }

  // — Precipitation (climbable hours only) —
  // Build a detail string that explains WHY the rain penalty is what it is.
  // Pre-climb rain (e.g. a dawn shower) and post-cutoff rain are noted but
  // don't add to the penalty — dryness handles any rock-wetness carry-over.
  const preClimbMm = climb.sumBeforeClimb || 0;
  const postClimbMm = climb.sumAfter || 0;
  let rainDetail;
  if (effectiveSum < 0.2 && (preClimbMm > 0.2 || postClimbMm > 0.2)) {
    const parts = [];
    if (preClimbMm > 0.2) parts.push(`${preClimbMm.toFixed(1)}mm before ${startH}am`);
    if (postClimbMm > 0.2) parts.push(`${postClimbMm.toFixed(1)}mm after dark`);
    rainDetail = `dry during climbing hours — ${parts.join(' + ')} outside the window`;
  } else if (skipLateRain) {
    rainDetail = `${effectiveSum.toFixed(1)}mm during climbable hours (rain after dark ignored)`;
  } else {
    rainDetail = `${effectiveSum.toFixed(1)}mm forecast · ${Math.round(peakProb)}% peak chance (${Math.round(effectiveProb)}% avg across climbing hours)`;
  }
  if (effectiveSum > 5) {
    score -= 60;
    reasons.push('rain expected');
    add('precip', 'Rain forecast', -60, rainDetail);
  } else if (effectiveSum > 1) {
    score -= 30;
    reasons.push('showers likely');
    add('precip', 'Showers likely', -30, rainDetail);
  } else if (effectiveProb > 60) {
    score -= 20;
    reasons.push(`${Math.round(peakProb)}% rain chance`);
    add('precip', 'Rain chance', -20, rainDetail);
  } else if (effectiveProb > 30) {
    score -= 8;
    add('precip', 'Rain chance', -8, rainDetail);
  }
  if (skipLateRain && climb.sumAfter > 0.5) {
    reasons.push('rain after dark only');
  } else if (effectiveSum < 0.2 && preClimbMm > 0.5) {
    reasons.push('dry by climbing time');
  }

  // — Rock dryness (hourly model) —
  // Replaces the old previous-day-rain × dryRating approximation. The dryness
  // model already integrates rock type, rain history, sun, wind, humidity, and
  // temperature on an hourly basis, so we just translate the day's mid-day
  // dryness score (0–100) into a penalty.
  //
  // dryness 100 → 0 penalty; dryness 0 → 45 penalty. Linear in between.
  const dryness = (day.morningDryness != null && day.afternoonDryness != null)
    ? Math.min(day.morningDryness, day.afternoonDryness)
    : (day.dayDryness ?? day.morningDryness ?? day.afternoonDryness ?? 100);
  if (dryness < 100) {
    const penalty = Math.round(((100 - dryness) / 100) * 45);
    score -= penalty;
    if (dryness < 30) reasons.push('rock soaked');
    else if (dryness < 50) reasons.push('rock wet');
    else if (dryness < 70) reasons.push('still drying');
    add('dryness', 'Rock dryness', -penalty, `dryness ${dryness}/100 on ${crag.rockType}`);
  }
  // Keep an "overnight rain only" reason hint if prev-day's daytime was dry
  // but the calendar-day total was wet — useful colour for the card.
  const prevCutoff = prevDay ? climbCutoffHour(crag) : 0;
  const prevClimb = prevDay ? climbableRain(prevDay, prevCutoff) : null;
  const prevWasWetDuringDay = prevClimb ? prevClimb.sum > 3 : false;
  const prevWasWetOverall = prevDay ? (prevDay.precipSum || 0) > 3 : false;
  if (prevWasWetOverall && !prevWasWetDuringDay && dryness >= 80) {
    reasons.push('overnight rain only');
  }

  // — Wind —
  // Wind direction labels (cardinal) for the user-facing detail line.
  const compass = (deg) => {
    if (deg == null) return '';
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  };
  const dirLabel = day.windDir != null ? `${compass(day.windDir)} wind` : 'wind';
  const exposureNote = day.windExposure === 'onshore'
    ? ' — blowing into the wall'
    : day.windExposure === 'lee'
      ? ' — wall sits in the lee'
      : '';

  // Direction-vs-aspect multiplier on the wind *penalty* (not the drying
  // bonus, which has its own onshore/lee logic below).
  //
  // The same regional wind speed is perceived very differently depending on
  // whether it's hitting the wall head-on or coming over the back of the
  // cliff. We scale the base penalty by a subtle factor so the ranking nudges
  // toward sheltered crags on windy days without dramatically reshuffling
  // everything from a single signal.
  //
  //   onshore  → ×1.3  (worse, exposed to the brunt)
  //   parallel → ×1.0  (no change)
  //   lee      → ×0.8  (better, sheltered)
  const windPenaltyMult = day.windExposure === 'onshore' ? 1.3
    : day.windExposure === 'lee' ? 0.8
    : 1.0;

  if (day.wind > 50) {
    const penalty = Math.round(15 * windPenaltyMult); // 12 lee / 15 parallel / 20 onshore
    score -= penalty;
    reasons.push('very windy');
    add('wind', 'Wind', -penalty, `${Math.round(day.wind)} km/h ${dirLabel} — very windy${exposureNote}`);
  } else if (day.wind > 35) {
    const penalty = Math.round(5 * windPenaltyMult); // 4 lee / 5 parallel / 7 onshore
    score -= penalty;
    add('wind', 'Wind', -penalty, `${Math.round(day.wind)} km/h ${dirLabel} — gusty${exposureNote}`);
  } else if (day.wind > 15 && day.wind < 30 && prevWasWetDuringDay) {
    // Only credit a drying wind if the wall is actually exposed to it.
    // A wall in the lee doesn't benefit, even if the regional wind is brisk.
    if (day.windExposure === 'lee') {
      add('wind', 'Sheltered from wind', -2, `${Math.round(day.wind)} km/h ${dirLabel} — wall sits in the lee, rock dries slower`);
      score -= 2;
      reasons.push('sheltered from wind');
    } else {
      const bonus = day.windExposure === 'onshore' ? 6 : 4;
      score += bonus;
      reasons.push('drying wind');
      add('wind', 'Drying wind', +bonus, `${Math.round(day.wind)} km/h ${dirLabel}${exposureNote} — helps the rock dry`);
    }
  }

  // — Sunshine bonus on cool days, weighted by geometry —
  // We already credited sun-trap walls above. Here we just give a small bonus
  // when the overall day is sunny AND it's a cool day where warmth is welcome.
  // The bonus scales with how much of that sun actually reaches the wall,
  // rather than the aspect label.
  // t >= 10 floor: below 10°C ambient, sunshine doesn't improve friction or
  // comfort enough to deserve a bonus — the sun-trap block above handles
  // targeted wall-warming credit when it's warranted.
  if (sunHours > 6 && t >= 10 && t < 18 && crag.shade !== 'all-day') {
    // Ratio of wall-lit hours to total clear-sky daylight on this day.
    // 0 = wall never sees the sun; 1 = wall is lit any time the sun is up.
    const totalLit = day.sunHoursTotal ?? sunHours;
    const exposureRatio = totalLit > 0.5 ? Math.min(1, onWallHours / totalLit) : 0;
    const bon = Math.round(2 + 4 * exposureRatio); // 2 → 6 depending on exposure
    if (bon > 0) {
      score += bon;
      add('sun', 'Sunshine bonus', +bon, `${Math.round(sunHours)}h sun overall · wall lit for ${onWallHours.toFixed(1)}h`);
    }
  }

  // — Cloud cover callout —
  // Surface an 'overcast' reason when heavy daytime cloud is suppressing what
  // would otherwise be a sun bonus or sun-trap. Only fires when:
  //   • cloudMean is available
  //   • it's meaningfully overcast (>65% mean daytime cloud)
  //   • the wall would geometrically see sun (aspect is concrete, not all-day shade)
  //   • it's a day where sun matters: cool or mild temp, not already raining
  // Three tiers: mostly overcast (65-80%), heavily overcast (80-90%), fully overcast (90%+).
  if (cloudMean != null && cloudMean > 65 && hasConcreteAspect(crag.aspect) && crag.shade !== 'all-day') {
    const noRain = (day.precipProb ?? 0) < 50;
    const sunMatters = t < 22; // hot days don't need sun callout
    if (noRain && sunMatters) {
      if (cloudMean > 90) {
        reasons.push('fully overcast');
        add('sun', 'Overcast', 0, `${Math.round(cloudMean)}% mean daytime cloud cover — wall in full overcast, no useful sun`);
      } else if (cloudMean > 80) {
        reasons.push('overcast');
        add('sun', 'Overcast', 0, `${Math.round(cloudMean)}% mean daytime cloud — heavy cloud suppressing sun on wall`);
      } else {
        reasons.push('mostly cloudy');
        add('sun', 'Mostly cloudy', 0, `${Math.round(cloudMean)}% mean daytime cloud — sun limited, aspect less relevant`);
      }
    }
  }

  // — Climate anomaly detection (v59.17) —
  // Compare today’s forecast against the 10-year monthly norm for this crag.
  // An anomalously good day gets a bonus + ‘rare window’ chip; anomalously bad
  // gets a small additional penalty. Only fires when a profile exists.
  if (_norm) {
    const tForecast  = day.tMax ?? t;
    const rhForecast = day.climbHumidity?.meanRh ?? null;
    const wForecast  = day.wind ?? 0;

    // Score each signal: positive = better than normal, negative = worse
    const tempAnomaly = normTMax != null ? tForecast - normTMax : 0;
    const rhAnomaly   = (normRh != null && rhForecast != null) ? normRh - rhForecast : 0; // positive = drier than norm
    const windAnomaly = normWind != null ? normWind - wForecast : 0; // positive = calmer than norm

    // Thresholds for ‘notable’ anomaly (each signal independently)
    const tempGood  = tempAnomaly  >=  4;  // 4°C+ warmer than norm in winter, or cooler in summer
    const tempBad   = tempAnomaly  <= -5;  // 5°C+ colder than norm
    const rhGood    = rhAnomaly    >= 12;  // 12%+ drier than norm
    const rhBad     = rhAnomaly    <= -12; // 12%+ wetter than norm
    const windGood  = windAnomaly  >= 10;  // 10+ km/h calmer than norm
    const windBad   = windAnomaly  <= -15; // 15+ km/h windier than norm

    // ‘Rare window’: all three signals positive, or two strongly positive
    const goodSignals = [tempGood, rhGood, windGood].filter(Boolean).length;
    const badSignals  = [tempBad,  rhBad,  windBad ].filter(Boolean).length;

    if (goodSignals >= 2) {
      // Scale bonus: 2 signals = +5, all 3 = +10
      const bon = goodSignals === 3 ? 10 : 5;
      score += bon;
      reasons.push('rare window');
      const notes = [];
      if (tempGood)  notes.push(`${Math.round(Math.abs(tempAnomaly))}° above norm`);
      if (rhGood)    notes.push(`${Math.round(rhAnomaly)}% drier than usual`);
      if (windGood)  notes.push(`${Math.round(windAnomaly)} km/h calmer than usual`);
      add('climate', 'Rare window', +bon,
        `Unusually good for ${_month} at ${crag.name}: ${notes.join(', ')}`);
    } else if (badSignals >= 2) {
      const pen = badSignals === 3 ? 8 : 4;
      score -= pen;
      const notes = [];
      if (tempBad)   notes.push(`${Math.round(Math.abs(tempAnomaly))}° below norm`);
      if (rhBad)     notes.push(`${Math.round(Math.abs(rhAnomaly))}% wetter than usual`);
      if (windBad)   notes.push(`${Math.round(Math.abs(windAnomaly))} km/h windier than usual`);
      add('climate', 'Worse than usual', -pen,
        `Notably poor for ${_month} at ${crag.name}: ${notes.join(', ')}`);
    }
  }

  // Apply humidity delta last so bonuses earlier in the function can't absorb it.
  if (_humidDelta !== 0) {
    score += _humidDelta;
    add('humidity', 'Humidity', _humidDelta,
      _humidDelta < 0
        ? `${_humidLabel} — high RH${(_humidLabel === 'muggy') ? ' + warm temps' : ''} hurts friction`
        : `${_humidLabel} — low RH boosts friction`);
  }

  // — Penalty integrity cap —
  // A crag that earned any score penalty cannot claim a perfect 100.
  // If penalties fired but bonuses compensated back to 100, cap at 99
  // so the score honestly reflects that something is working against it.
  const hasPenalty = contributions.some(c => c.delta < 0);
  const rawFinal = Math.max(0, Math.min(100, Math.round(score)));
  const finalScore = (hasPenalty && rawFinal === 100) ? 99 : rawFinal;

  // Sort contributions: penalties first (most impactful negative), then bonuses.
  // This ensures penalty reasons surface at the top of the breakdown even
  // when bonuses are numerically larger — critical for transparency.
  contributions.sort((a, b) => {
    // Penalties always before bonuses
    if (a.delta < 0 && b.delta >= 0) return -1;
    if (a.delta >= 0 && b.delta < 0) return 1;
    // Within same sign: largest absolute delta first
    return Math.abs(b.delta) - Math.abs(a.delta);
  });

  // Reasons: always include penalty reasons, then fill remaining slots with bonuses.
  // This prevents penalties from being silently buried behind high-impact bonuses.
  const penaltyReasons = reasons.filter(r =>
    contributions.some(c => c.delta < 0 && (c.detail?.includes(r) || c.label?.toLowerCase().includes(r.toLowerCase().split(' ')[0])))
  );
  const otherReasons = reasons.filter(r => !penaltyReasons.includes(r));
  const surfacedReasons = [...new Set([...penaltyReasons, ...otherReasons])].slice(0, 3);

  return {
    score: finalScore,
    reasons: surfacedReasons,
    contributions,
  };
}

// Build ranked list per day. Returns { 'YYYY-MM-DD': [{crag, score, reasons, day}] }
export function rankByDay(forecasts, dayDates) {
  const ranked = {};
  for (const date of dayDates) {
    const rows = [];
    for (const id in forecasts) {
      const fc = forecasts[id];
      const dayIdx = fc.days.findIndex(d => d.date === date);
      if (dayIdx === -1) continue;
      const day = fc.days[dayIdx];
      const prevDay = dayIdx > 0 ? fc.days[dayIdx - 1] : null;
      const nextDay = dayIdx + 1 < fc.days.length ? fc.days[dayIdx + 1] : null;
      const { score, reasons, contributions } = scoreDay(fc.crag, day, prevDay, nextDay);
      rows.push({
        crag: fc.crag,
        day,
        prevDay,
        score,
        reasons,
        contributions,
        nowDryness: fc.nowDryness,
        lastRain: fc.lastRain,
        pastPrecip: fc.pastPrecip,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    ranked[date] = rows;
  }
  return ranked;
}

// Weekend-Away trip score: combines Fri/Sat/Sun into a single 0–100 score
// where the WORST day matters most. Formula: 0.5 * min + 0.3 * mean + 0.2 * median.
// Returns { 'cragId': { crag, tripScore, dailyScores: [{date, score, reasons, day}], worstDate, summary } }
export function rankWeekendTrip(forecasts, tripDates) {
  const out = {};
  for (const id in forecasts) {
    const fc = forecasts[id];
    if (fc.crag.trip !== 'weekend' && fc.crag.trip !== 'both') continue;
    const dailyScores = [];
    for (const date of tripDates) {
      const dayIdx = fc.days.findIndex(d => d.date === date);
      if (dayIdx === -1) continue;
      const day = fc.days[dayIdx];
      const prevDay = dayIdx > 0 ? fc.days[dayIdx - 1] : null;
      const nextDay = dayIdx + 1 < fc.days.length ? fc.days[dayIdx + 1] : null;
      const { score, reasons, contributions } = scoreDay(fc.crag, day, prevDay, nextDay);
      dailyScores.push({ date, score, reasons, contributions, day, prevDay });
    }
    if (!dailyScores.length) continue;
    const scores = dailyScores.map(d => d.score);
    const min = Math.min(...scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const tripScore = Math.round(0.5 * min + 0.3 * mean + 0.2 * median);
    const worst = dailyScores.reduce((a, b) => (a.score <= b.score ? a : b));
    out[id] = {
      crag: fc.crag,
      tripScore: Math.max(0, Math.min(100, tripScore)),
      dailyScores,
      worstDate: worst.date,
      worstScore: worst.score,
      nowDryness: fc.nowDryness,
      lastRain: fc.lastRain,
      pastPrecip: fc.pastPrecip,
    };
  }
  // Return as ranked array
  const arr = Object.values(out).sort((a, b) => b.tripScore - a.tripScore);
  return arr;
}

// Helpers
export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  return d.toLocaleDateString('en-AU', opts);
}

export function dayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'long' });
}

export function shortDayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'short' });
}

// Returns a YYYY-MM-DD string for a Date interpreted in Australia/Melbourne.
function melbourneDateString(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

// Returns today's date in Australia/Melbourne as a Date at midnight local.
function todayInMelbourne(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return new Date(fmt.format(now) + 'T00:00:00');
}

// Returns 7 dates: today + next 6 days, as YYYY-MM-DD strings.
export function weekDates(now = new Date()) {
  const today = todayInMelbourne(now);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}

// Get the dates that make up the relevant "weekend trip" window.
//
// Rules:
//   Mon–Thu  → the *upcoming* Fri + Sat + Sun (3 days, full weekend ahead)
//   Fri      → today (Fri) + Sat + Sun (3 days)
//   Sat      → today (Sat) + Sun (2 days — Friday is past, don't pretend)
//   Sun      → today (Sun) only (1 day — you've missed the trip window)
//
// We deliberately do NOT roll forward to next week on Sat/Sun — a weekend trip
// you can still leave for is more useful than one a week away.
export function weekendDates(now = new Date()) {
  // Today's date in Melbourne local time.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  // Map weekday name back to JS getDay() number (Sun=0..Sat=6).
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const todayDow = dayMap[get('weekday')];
  const todayDate = new Date(today + 'T00:00:00');

  // Offsets from today to the dates we want, by today's weekday.
  //   key = weekday number (0=Sun..6=Sat), value = array of day offsets
  const offsetsByDow = {
    1: [4, 5, 6], // Mon → next Fri, Sat, Sun
    2: [3, 4, 5], // Tue → next Fri, Sat, Sun
    3: [2, 3, 4], // Wed
    4: [1, 2, 3], // Thu
    5: [0, 1, 2], // Fri → today + Sat + Sun
    6: [0, 1],    // Sat → today + Sun
    0: [0],       // Sun → today only
  };
  const offsets = offsetsByDow[todayDow] || [0, 1, 2];

  return offsets.map(off => {
    const d = new Date(todayDate);
    d.setDate(todayDate.getDate() + off);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });
}

// Weather code → emoji + label (WMO codes from Open-Meteo)
export function weatherIcon(code) {
  if (code === 0) return { icon: '☀️', label: 'Clear' };
  if (code <= 2) return { icon: '🌤️', label: 'Mostly sunny' };
  if (code === 3) return { icon: '☁️', label: 'Overcast' };
  if (code >= 45 && code <= 48) return { icon: '🌫️', label: 'Fog' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { icon: '🌧️', label: 'Rain' };
  if (code >= 71 && code <= 77) return { icon: '🌨️', label: 'Snow' };
  if (code >= 80 && code <= 82) return { icon: '🌧️', label: 'Showers' };
  if (code >= 85 && code <= 86) return { icon: '🌨️', label: 'Snow showers' };
  if (code >= 95) return { icon: '⛈️', label: 'Thunderstorm' };
  return { icon: '🌥️', label: 'Mixed' };
}

export function scoreBand(score) {
  if (score >= 80) return { label: 'Excellent', color: 'success' };
  if (score >= 65) return { label: 'Good', color: 'primary' };
  if (score >= 50) return { label: 'Fair', color: 'warning' };
  if (score >= 30) return { label: 'Poor', color: 'warning' };
  return { label: 'Avoid', color: 'error' };
}
