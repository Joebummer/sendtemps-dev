// Keep the installed app on the established, unversioned response contract.
// Cache/scoring internals and opt-in metadata must not alter that contract.
const privateFields = new Set(['dailyContext', 'scoreContext']);
const extensions = new Set([
  'timezone', 'localToday', 'todayDate', 'tomorrowDate', 'daylight', 'usability',
  'availability', 'availabilityCap', 'activeRain', 'elevationSource', 'forecastStale',
]);

export function serializeScoredResponse(payload, forecastMeta, schemaVersion = 1) {
  const { region, dates, tripDates, crags, byDate, weekendTrip, today } = payload;
  const legacy = { region, dates, tripDates, crags, byDate, weekendTrip, today };
  // Avoid a `forecast` metadata key: clients may use it to detect a legacy
  // forecast envelope. New metadata has a distinct name and is opt-in.
  const body = schemaVersion === 2 ? { ...legacy, schemaVersion: 2, forecastMeta } : legacy;
  return JSON.stringify(body, (key, value) => {
    if (privateFields.has(key) || (schemaVersion === 1 && extensions.has(key))) return undefined;
    // Preserve integer wire fields for installed decoders. Calculations and
    // human-readable recovery details keep their precise values internally;
    // version 2 exposes the unrounded numeric values for new consumers.
    if (schemaVersion === 1 && Number.isFinite(value)) {
      if (key === 'recoveryProgressHours') return Math.floor(value);
      if (key === 'hourlyAverage' || key === 'hourlyAvg' || key === 'weightedProb') return Math.round(value);
    }
    return value;
  });
}
