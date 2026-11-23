import { CRAGS } from './crags.js';
import { fetchOpenMeteo } from './forecast.js';

const MODELS = {
  ecmwf_ifs: 'ECMWF IFS HRES 9 km',
  ecmwf_ifs025: 'ECMWF IFS 0.25°',
  gfs_global: 'NOAA GFS Global',
  icon_global: 'DWD ICON Global',
  jma_gsm: 'JMA GSM',
  ukmo_global_deterministic_10km: 'UK Met Office Global 10 km',
};
const DEFAULT_MODELS = ['ecmwf_ifs', 'gfs_global', 'icon_global', 'ukmo_global_deterministic_10km'];
const VARIABLES = {
  temperatureC: 'temperature_2m',
  feelsLikeC: 'apparent_temperature',
  humidityPercent: 'relative_humidity_2m',
  windSpeedKmh: 'wind_speed_10m',
  windDirectionDegrees: 'wind_direction_10m',
  precipitationMm: 'precipitation',
  cloudCoverPercent: 'cloud_cover',
};
const TIMEZONES = {
  VIC: 'Australia/Melbourne', NSW: 'Australia/Sydney', ACT: 'Australia/Sydney',
  TAS: 'Australia/Hobart', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide',
  WA: 'Australia/Perth', NT: 'Australia/Darwin',
};
const inflight = new Map();
const TTL = 1200;

function json(body, status, headers, extra = {}) {
  return Response.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store', ...extra } });
}
function error(code, message, status, headers) {
  return json({ error: { code, message } }, status, headers,
    status === 429 ? { 'Retry-After': '60' } : {});
}
function localDate(timezone) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function normalize(data, modelIds, date) {
  const hourly = data?.hourly;
  if (!Array.isArray(hourly?.time)) return [];
  return modelIds.flatMap(id => {
    const hours = hourly.time.flatMap((time, index) => {
      if (typeof time !== 'string' || !time.startsWith(`${date}T`) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time)) return [];
      const row = { time };
      for (const [field, variable] of Object.entries(VARIABLES)) {
        // Open-Meteo suffixes fields for multiple models. Single-model
        // responses may use either suffixed or plain variable names.
        const values = hourly[`${variable}_${id}`] ??
          (modelIds.length === 1 ? hourly[variable] : undefined);
        const value = values?.[index];
        row[field] = typeof value === 'number' && Number.isFinite(value) ? value : null;
      }
      // A temperature alone cannot support a useful climbing comparison.
      if ([row.temperatureC, row.humidityPercent, row.windSpeedKmh, row.precipitationMm]
        .some(value => value === null)) return [];
      return [row];
    });
    return hours.length ? [{ id, displayName: MODELS[id], hours }] : [];
  });
}

export async function handleComparison(url, headers, env) {
  const allowed = new Set(['cragId', 'date', 'models']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      return error('invalid_parameters', 'Use cragId, date and optional models once each', 400, headers);
    }
  }
  const crag = CRAGS.find(item => item.id === url.searchParams.get('cragId'));
  if (!crag) return error('unknown_crag', 'Unknown cragId', 404, headers);
  if (![crag.lat, crag.lon, crag.elevation].every(Number.isFinite)) {
    return error('crag_unavailable', 'Crag location is unavailable', 503, headers);
  }
  const timezone = TIMEZONES[crag.state];
  if (!timezone) return error('crag_unavailable', 'Crag timezone is unavailable', 503, headers);
  const today = localDate(timezone);
  const lastDate = new Date(`${today}T00:00:00Z`);
  lastDate.setUTCDate(lastDate.getUTCDate() + 2);
  const date = url.searchParams.get('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date < today || date > lastDate.toISOString().slice(0, 10)) {
    return error('invalid_date', `date must be between ${today} and ${lastDate.toISOString().slice(0, 10)}`, 400, headers);
  }
  const requested = url.searchParams.has('models') ? url.searchParams.get('models').split(',') : DEFAULT_MODELS;
  if (!requested.length || requested.length > Object.keys(MODELS).length || requested.some(id => !Object.hasOwn(MODELS, id))) {
    return error('invalid_models', 'Select up to six supported model IDs', 400, headers);
  }
  const modelIds = [...new Set(requested)].sort();
  const cacheUrl = new URL('/_cache/comparison-v1', url.origin);
  cacheUrl.search = new URLSearchParams({ cragId: crag.id, date, models: modelIds.join(','),
    lat: crag.lat, lon: crag.lon, elevation: crag.elevation, timezone }).toString();
  const cacheKey = new Request(cacheUrl);
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return json(await cached.json(), 200, headers, { 'X-SendTemps-Cache': 'HIT' });
    if (!inflight.has(cacheKey.url)) {
      const pending = (async () => {
        const params = new URLSearchParams({ latitude: crag.lat, longitude: crag.lon,
          elevation: crag.elevation, timezone, start_date: date, end_date: date,
          hourly: Object.values(VARIABLES).join(','), models: modelIds.join(','),
          temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' });
        const response = await fetchOpenMeteo(`https://api.open-meteo.com/v1/forecast?${params}`,
          env.OPEN_METEO_API_KEY, env.WEATHER_REQUEST_LIMITER);
        if (!response.ok) {
          const failure = new Error('Weather provider failed');
          failure.status = response.status;
          throw failure;
        }
        const models = normalize(await response.json(), modelIds, date);
        if (!models.length) throw new Error('No usable model data');
        const body = { schemaVersion: 1, cragId: crag.id, date, timezone,
          latitude: crag.lat, longitude: crag.lon, elevationM: crag.elevation,
          generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL * 1000).toISOString(),
          valueType: 'raw_weather', models,
          unavailableModels: modelIds.filter(id => !models.some(model => model.id === id)),
          attribution: { name: 'Open-Meteo', url: 'https://open-meteo.com/',
            licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/' } };
        await caches.default.put(cacheKey, Response.json(body, { headers: { 'Cache-Control': `public, max-age=${TTL}` } }));
        return body;
      })();
      inflight.set(cacheKey.url, pending);
      // Cleanup is attached once, and rejection remains handled by the caller.
      pending.then(() => inflight.delete(cacheKey.url), () => inflight.delete(cacheKey.url));
    }
    return json(await inflight.get(cacheKey.url), 200, headers, { 'X-SendTemps-Cache': 'MISS' });
  } catch (failure) {
    return failure.status === 429
      ? error('rate_limited', 'Please retry shortly', 429, headers)
      : error('forecast_unavailable', 'Comparison forecast is temporarily unavailable', 502, headers);
  }
}
