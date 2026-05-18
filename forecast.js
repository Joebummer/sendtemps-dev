// Open-Meteo forecast fetching + scoring
// API: https://open-meteo.com/en/docs — free, no key, CORS-enabled

import { CRAGS } from './crags.js?v=22';

const API = 'https://api.open-meteo.com/v1/forecast';

// Fetch one batched request for ALL crags at once — Open-Meteo accepts comma-separated coords.
export async function fetchAllForecasts() {
  const lats = CRAGS.map(c => c.lat).join(',');
  const lons = CRAGS.map(c => c.lon).join(',');
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
      'relative_humidity_2m',
      'windspeed_10m',
      'cloudcover',
      'shortwave_radiation',
      'weathercode',
    ].join(','),
    timezone: 'Australia/Melbourne',
    forecast_days: '8',
    past_days: '4',
  });

  const url = `${API}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast API error ${res.status}`);
  const data = await res.json();

  // Open-Meteo returns either a single object (one location) or an array (multiple).
  const list = Array.isArray(data) ? data : [data];

  // Map each crag to its forecast object
  const byId = {};
  CRAGS.forEach((crag, i) => {
    const f = list[i];
    if (!f) return;
    // Compute hourly rock-dryness series for the whole hourly window.
    // This consumes past_days=4 of recent rain history plus 8 forecast days.
    const drynessSeries = computeDrynessSeries(crag, f.hourly);
    // Current dryness = the value at the hour closest to "now".
    const nowDryness = currentDryness(f.hourly, drynessSeries);
    byId[crag.id] = {
      crag,
      hourly: f.hourly,
      drynessSeries,
      nowDryness,
      lastRain: findLastSignificantRain(f.hourly),
      days: f.daily.time.map((date, di) => ({
        date,
        tMax: f.daily.temperature_2m_max[di],
        tMin: f.daily.temperature_2m_min[di],
        tFeel: f.daily.apparent_temperature_max[di],
        precipSum: f.daily.precipitation_sum[di],
        precipProb: f.daily.precipitation_probability_max[di],
        precipHours: f.daily.precipitation_hours[di],
        wind: f.daily.windspeed_10m_max[di],
        sunshine: f.daily.sunshine_duration[di], // seconds
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
    const cloud = hourly.cloudcover?.[i] ?? 50;
    const swRad = hourly.shortwave_radiation?.[i] ?? 0;

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

    // Wind factor — strong wind doubles drying.
    const windFactor = 1 + Math.min(1.5, wind / 25);

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

// Cutoff hour after which rain doesn't matter (you're not climbing in the dark).
// Day trips: 6pm. Weekend trips: 8pm (later light at the destination + post-climb wind-down).
function climbCutoffHour(crag) {
  return (crag.trip === 'weekend' || crag.trip === 'both') ? 20 : 18;
}

// Returns { sum, peakProb } for rain that falls during climbable hours only (before cutoff).
// If a window straddles the cutoff, only the portion before cutoff is counted (proportional).
function climbableRain(day, cutoffH) {
  const windows = day.rainWindows || [];
  if (!windows.length) {
    return { sum: day.precipSum || 0, peakProb: day.precipProb || 0, allAfterDark: false };
  }
  let sumBefore = 0;
  let peakBefore = 0;
  let sumAfter = 0;
  for (const w of windows) {
    const span = Math.max(1, w.endHour - w.startHour);
    if (w.endHour <= cutoffH) {
      sumBefore += w.totalMm;
      peakBefore = Math.max(peakBefore, w.peakProb);
    } else if (w.startHour >= cutoffH) {
      sumAfter += w.totalMm;
    } else {
      // Straddles: split proportionally by hours.
      const beforeFrac = (cutoffH - w.startHour) / span;
      sumBefore += w.totalMm * beforeFrac;
      sumAfter += w.totalMm * (1 - beforeFrac);
      // If the peak hour is before cutoff, count its prob.
      if (w.peakHour < cutoffH) peakBefore = Math.max(peakBefore, w.peakProb);
    }
  }
  // If we identified climbable rain, use it. If everything is after dark and nothing before,
  // peakBefore stays 0 and sumBefore is ~0 — those values flow into scoring.
  const allAfterDark = sumBefore < 0.2 && sumAfter >= 0.2;
  return { sum: sumBefore, peakProb: peakBefore, allAfterDark, sumAfter };
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
    return { score: 0, reasons: [label] };
  }
  if (Array.isArray(crag.closedMonths) && crag.closedMonths.length) {
    const month = new Date(day.date + 'T12:00:00').getMonth() + 1; // 1–12
    if (crag.closedMonths.includes(month)) {
      const label = crag.closureReason ? `closed — ${crag.closureReason}` : 'closed (seasonal)';
      return { score: 0, reasons: [label] };
    }
  }
  let score = 100;
  const reasons = [];

  // — Effective precipitation: only rain during climbable hours counts —
  const cutoffH = climbCutoffHour(crag);
  const climb = climbableRain(day, cutoffH);
  // We can ignore late rain if it's all after the cutoff AND tomorrow morning is dry.
  const skipLateRain = climb.allAfterDark && nextMorningDry(nextDay);
  const effectiveSum = skipLateRain ? climb.sum : (day.precipSum || 0);
  const effectiveProb = skipLateRain ? climb.peakProb : (day.precipProb || 0);

  // — Temperature scoring —
  const [idealMin, idealMax] = crag.idealTemp;
  const t = day.tFeel ?? day.tMax;
  if (t < idealMin) {
    const diff = idealMin - t;
    score -= Math.min(30, diff * 3);
    if (diff > 5) reasons.push(`cold (${Math.round(t)}°C)`);
  } else if (t > idealMax) {
    const diff = t - idealMax;
    score -= Math.min(40, diff * 4);
    if (diff > 3) reasons.push(`hot (${Math.round(t)}°C)`);
  } else {
    reasons.push(`temp ideal (${Math.round(t)}°C)`);
  }

  // — Aspect × heat interaction —
  // North-facing walls bake in warm weather; south-facing stay cool.
  // Sun hours scale the penalty/bonus: a cloudy 28°C day matters less than a sunny one.
  const sunHours = (day.sunshine ?? 0) / 3600;
  const sunFactor = Math.max(0.4, Math.min(1, sunHours / 8)); // 0.4 (cloudy) → 1.0 (8h+ sun)

  // Hot zone (>22°C): full aspect signal. Mid-warm zone (18-22°C): half-strength.
  if (t > 22) {
    if (crag.aspect === 'N' || crag.aspect === 'NW' || crag.aspect === 'NE') {
      score -= Math.round(12 * sunFactor);
      reasons.push('sun-baked aspect');
    }
    if (crag.aspect === 'W') {
      // West catches afternoon sun specifically — slightly less than full N exposure.
      score -= Math.round(8 * sunFactor);
      if (t > 25) reasons.push('afternoon sun-trap');
    }
    if (crag.shade === 'all-day' || crag.aspect === 'S') {
      score += Math.round(8 * sunFactor);
      reasons.push('shaded refuge');
    }
    // Morning shade helps on hot days (you can climb the cool morning then bail).
    if (crag.shade === 'afternoon') {
      score += Math.round(3 * sunFactor);
    }
  } else if (t > 18) {
    // Mid-warm zone — half-strength signal. Sunny aspects start to feel hot.
    if (crag.aspect === 'N' || crag.aspect === 'NW') {
      score -= Math.round(5 * sunFactor);
    }
    if (crag.shade === 'all-day' || crag.aspect === 'S') {
      score += Math.round(3 * sunFactor);
    }
  }
  if (t < 8) {
    if (crag.aspect === 'N' || crag.aspect === 'NE') {
      score += Math.round(6 * sunFactor);
      reasons.push('sun-trap aspect');
    }
    if (crag.shade === 'all-day' || crag.aspect === 'S') {
      score -= Math.round(8 * sunFactor);
      reasons.push('cold & shaded');
    }
  } else if (t < 12) {
    // Cool zone — gentle preference for sunny aspects.
    if (crag.aspect === 'N' || crag.aspect === 'NE') {
      score += Math.round(3 * sunFactor);
    }
    if (crag.shade === 'all-day') {
      score -= Math.round(3 * sunFactor);
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
  } else {
    // Adjacent categories (cold↔cool, cool↔mild, mild↔warm) — no penalty.
    // Two steps apart (cold↔mild, cool↔warm, cold↔warm) — small penalty.
    const order = ['cold', 'cool', 'mild', 'warm'];
    const dist = Math.abs(order.indexOf(dayCategory) - order.indexOf(crag.bestIn));
    if (dist >= 2) score -= 4;
    if (dist === 3) score -= 2; // cold↔warm: full mismatch
  }

  // — Precipitation (climbable hours only) —
  if (effectiveSum > 5) {
    score -= 60;
    reasons.push('rain expected');
  } else if (effectiveSum > 1) {
    score -= 30;
    reasons.push('showers likely');
  } else if (effectiveProb > 60) {
    score -= 20;
    reasons.push(`${Math.round(effectiveProb)}% rain chance`);
  } else if (effectiveProb > 30) {
    score -= 8;
  }
  if (skipLateRain && climb.sumAfter > 0.5) {
    reasons.push('rain after dark only');
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
  if (day.wind > 50) {
    score -= 15;
    reasons.push('very windy');
  } else if (day.wind > 35) {
    score -= 5;
  } else if (day.wind > 15 && day.wind < 30 && prevWasWetDuringDay) {
    score += 4; // helpful drying wind
    reasons.push('drying wind');
  }

  // — Sunshine bonus on cool days, weighted by aspect —
  // Sun on a north-facing wall in winter is gold. On a south-facing wall, less so.
  if (sunHours > 6 && t < 18) {
    if (crag.aspect === 'N' || crag.aspect === 'NE' || crag.aspect === 'NW') score += 5;
    else if (crag.aspect === 'S' || crag.shade === 'all-day') score += 1;
    else score += 3;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 3),
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
      const { score, reasons } = scoreDay(fc.crag, day, prevDay, nextDay);
      rows.push({
        crag: fc.crag,
        day,
        prevDay,
        score,
        reasons,
        nowDryness: fc.nowDryness,
        lastRain: fc.lastRain,
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
      const { score, reasons } = scoreDay(fc.crag, day, prevDay, nextDay);
      dailyScores.push({ date, score, reasons, day, prevDay });
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
