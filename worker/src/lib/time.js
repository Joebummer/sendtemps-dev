// All civil dates and planning hours belong to the crag, independent of the
// requesting phone, Worker host or a different state's daylight saving rules.
export const TIMEZONES = {
  VIC: 'Australia/Melbourne', NSW: 'Australia/Sydney', ACT: 'Australia/Sydney',
  TAS: 'Australia/Hobart', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide',
  NT: 'Australia/Darwin', WA: 'Australia/Perth',
};
export const timezoneForCrag = crag => crag?.timezone || TIMEZONES[crag?.state] || TIMEZONES.VIC;
export const regionTimezone = region => TIMEZONES[region] || TIMEZONES.VIC;
const formatters = new Map();
const partsCache = new Map();
function localParts(date, timezone) {
  const key = `${timezone}:${date.getTime()}`;
  if (partsCache.has(key)) return partsCache.get(key);
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const parts = Object.fromEntries(formatters.get(timezone).formatToParts(date)
    .filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  if (partsCache.size >= 8192) partsCache.delete(partsCache.keys().next().value);
  partsCache.set(key, parts);
  return parts;
}
export function localDate(date = new Date(), timezone = TIMEZONES.VIC) {
  const p = localParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function localIsoHour(date = new Date(), timezone = TIMEZONES.VIC) {
  const p = localParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
export const localHour = (date = new Date(), timezone = TIMEZONES.VIC) => Number(localParts(date, timezone).hour);
export function addDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
const timestampCache = new Map();
export function localHourToDate(iso, timezone = TIMEZONES.VIC) {
  const key = `${timezone}:${iso}`;
  if (timestampCache.has(key)) return new Date(timestampCache.get(key));
  const naive = Date.parse(`${iso}Z`);
  let timestamp = naive;
  // Resolve fractional offsets and daylight saving using the offset at the
  // candidate instant. Climbing hours never use the ambiguous 2 am fallback.
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localParts(new Date(timestamp), timezone);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const next = naive - (asUtc - timestamp);
    if (next === timestamp) break;
    timestamp = next;
  }
  if (timestampCache.size >= 8192) timestampCache.delete(timestampCache.keys().next().value);
  timestampCache.set(key, timestamp);
  return new Date(timestamp);
}

// Unix provider timestamps avoid its fixed-offset ISO behaviour across DST.
// Keep absolute instants alongside civil hours, including repeated night hours.
export function normalizeProviderTimes(raw, timezone) {
  if (typeof raw.hourly?.time?.[0] !== 'number') return raw;
  const hourly = { ...raw.hourly, timeUtc: raw.hourly.time.map(t => t * 1000),
    time: raw.hourly.time.map(t => localIsoHour(new Date(t * 1000), timezone)) };
  const daily = raw.daily ? { ...raw.daily, time: raw.daily.time.map(t =>
    typeof t === 'number' ? new Date((t + (raw.utc_offset_seconds ?? 0)) * 1000).toISOString().slice(0, 10) : t) } : undefined;
  // Provider daily aggregates use one fixed offset. Re-aggregate only dates
  // affected by a DST transition from the actual, locally grouped hours.
  if (daily) for (let di = 0; di < daily.time.length; di++) {
    const date = daily.time[di];
    const indices = hourly.time.flatMap((t, i) => t.startsWith(date) ? [i] : []);
    if (!indices.length) continue;
    const shifted = indices.some(i => {
      const civil = Date.parse(`${hourly.time[i]}Z`);
      return civil - hourly.timeUtc[i] !== (raw.utc_offset_seconds ?? 0) * 1000;
    });
    if (!shifted) continue;
    const aggregate = (field, fn) => {
      const values = indices.map(i => hourly[field]?.[i]);
      return values.every(Number.isFinite) ? fn(values) : null;
    };
    const sum = values => values.reduce((a, b) => a + b, 0);
    for (const [target, source, fn] of [
      ['temperature_2m_max', 'temperature_2m', v => Math.max(...v)],
      ['temperature_2m_min', 'temperature_2m', v => Math.min(...v)],
      ['apparent_temperature_max', 'apparent_temperature', v => Math.max(...v)],
      ['precipitation_sum', 'precipitation', sum],
      ['precipitation_probability_max', 'precipitation_probability', v => Math.max(...v)],
      ['precipitation_hours', 'precipitation', v => v.filter(x => x > 0).length],
      ['windspeed_10m_max', 'windspeed_10m', v => Math.max(...v)],
      ['sunshine_duration', 'sunshine_duration', sum],
      ['weathercode', 'weathercode', v => Math.max(...v)],
    ]) if (daily[target]) daily[target] = daily[target].map((v, i) => i === di ? aggregate(source, fn) : v);
  }
  return { ...raw, hourly, ...(daily ? { daily } : {}) };
}
