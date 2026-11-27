const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const captured = require('./fixtures/grampians-2026-11-28.json');

function weatherFixture(url, rain, conditions = {}) {
  const params = new URL(url).searchParams;
  const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 9 + i)).toISOString().slice(0, 10));
  const time = dates.flatMap(date => Array.from({ length: 24 }, (_, hour) => `${date}T${String(hour).padStart(2, '0')}:00`));
  const values = { temperature_2m: 18, apparent_temperature: 17, relative_humidity_2m: 55,
    windspeed_10m: 20, winddirection_10m: 315, windgusts_10m: 25, cloudcover: 20, weathercode: 0,
    ...conditions };
  const hourly = { time };
  for (const key of params.get('hourly').split(',')) hourly[key] = time.map(iso => {
    if (key === 'precipitation') return rain(iso);
    if (key === 'precipitation_probability') return rain(iso) ? 90 : 0;
    if (key === 'shortwave_radiation') return conditions.shortwave_radiation ?? (Number(iso.slice(11, 13)) >= 7 && Number(iso.slice(11, 13)) < 20 ? 500 : 0);
    if (key === 'sunshine_duration') return Number(iso.slice(11, 13)) >= 7 && Number(iso.slice(11, 13)) < 20 && values.cloudcover < 80 ? 3000 : 0;
    assert.ok(key in values, `unexpected hourly field ${key}`);
    return values[key];
  });
  const dailyValues = { temperature_2m_max: 18, temperature_2m_min: 10, apparent_temperature_max: 17,
    windspeed_10m_max: values.windspeed_10m, sunshine_duration: 28800, weathercode: 0 };
  const daily = { time: dates };
  for (const key of params.get('daily').split(',')) daily[key] = dates.map(date => {
    const amounts = time.filter(iso => iso.startsWith(date)).map(rain);
    if (key === 'precipitation_sum') return amounts.reduce((a, b) => a + b, 0);
    if (key === 'precipitation_probability_max') return amounts.some(Boolean) ? 90 : 0;
    if (key === 'precipitation_hours') return amounts.filter(Boolean).length;
    assert.ok(key in dailyValues, `unexpected daily field ${key}`);
    return dailyValues[key];
  });
  return params.get('latitude').split(',').map(() => ({ hourly, daily }));
}

async function forecast(rain, conditions) {
  const h = await loadWorker(async url => Response.json(weatherFixture(url, rain, conditions)));
  const forecasts = await h.forecasts.fetchAllForecasts('VIC');
  return { ...h, fc: forecasts['gramps-taipan'] };
}
const at = (fc, hour) => fc.tomorrowHourly.find(h => h.hour === hour);

test('adaptive relief responds continuously to surface dryness and productive drying, not a six-hour timer', async () => {
  const { wetRockCondition } = (await loadWorker()).forecasts;
  const crag = captured.crag;
  const state = { precip: 0, rainEventMm: 31.1, currentEventMm: 31.1,
    hoursSinceRain: 1, recoveryProgressHours: 1, dryness: 12 };
  assert.ok(wetRockCondition(crag, state).cap < 60, 'freshly saturated rock cannot immediately earn the full regional discount');
  assert.equal(wetRockCondition(crag, { ...state, hoursSinceRain: 10, recoveryProgressHours: 0 }).cap, 25,
    'elapsed humid hours cannot replace productive drying');
  assert.ok(wetRockCondition(crag, { ...state, dryness: 85, rainEventMm: 1.1 }).cap > 80,
    'a light shower on a nearly dry surface can recover in one productive hour');
  let last = 0;
  for (let dryness = 0; dryness <= 100; dryness++) {
    const cap = wetRockCondition(crag, { ...state, dryness }).cap;
    assert.ok(cap >= last && cap <= 100);
    if (dryness) assert.ok(cap - last <= 1, 'there is no new surface-dryness scoring cliff');
    last = cap;
  }
  const before = wetRockCondition(crag, { ...state, hoursSinceRain: 0.999, recoveryProgressHours: 0.999 }).cap;
  const after = wetRockCondition(crag, { ...state, hoursSinceRain: 1.001, recoveryProgressHours: 1.001 }).cap;
  assert.ok(Math.abs(after - before) <= 1, 'the old one-hour regional switch is gone');
  assert.ok(wetRockCondition(crag, { ...state, dryness: undefined }).cap <= wetRockCondition(crag, state).cap,
    'unknown surface moisture is never assumed dry');
});

test('captured 28 November Taipan case recovers gradually while active showers remain poor', async () => {
  const f = (await loadWorker()).forecasts;
  const hours = structuredClone(captured.hours);
  const peak = Math.max(...hours.map(h => h.precipProb));
  const cloud = hours.reduce((s, h) => s + h.cloud, 0) / hours.length;
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    const neighbours = hours.slice(Math.max(0, i - 2), Math.min(hours.length, i + 3))
      .filter(n => n !== h).reduce((s, n) => s + Math.max(0, Math.min(1, n.precipProb / 60)), 0);
    delete h.wetRockCondition;
    h.wetRockCondition = f.wetRockCondition(captured.crag, h);
    h.score = f.scoreHour(captured.crag, h, neighbours, peak, cloud);
  }
  const score = hour => hours.find(h => h.hour === hour).score;
  assert.equal(score(10), 0);
  assert.ok(score(11) >= 25 && score(11) < 60);
  assert.ok(score(11) < score(12) && score(12) <= score(13));
  assert.ok(score(13) < 77);
  assert.equal(score(15), 0);
  const window = f.bestWindow(hours, captured.crag, 5);
  assert.ok(window.avg < captured.bestWindow.avg);
  assert.equal(window.usability.interrupted, true);
  assert.equal(window.usability.wetHours, 2);
});

test('a completed clock cannot clear known remaining surface wetness', async () => {
  const f = (await loadWorker()).forecasts;
  for (const rockType of ['sandstone', 'granite']) {
    const crag = { ...captured.crag, rockType };
    const recovery = f.rainRecoveryHours(crag, 15);
    const state = { precip: 0, rainEventMm: 15, currentEventMm: 15,
      hoursSinceRain: recovery + 5, recoveryProgressHours: recovery + 5, dryness: 30 };
    assert.ok(f.wetRockCondition(crag, state).cap < 100, rockType);
    assert.ok(f.wetRockCondition(crag, state).label);
    assert.equal(f.wetRockCondition(crag, { ...state, dryness: 90 }).cap, 100);
  }
});

test('small showers recover sooner than heavy rain under identical drying weather', async () => {
  const light = await forecast(iso => iso === '2026-09-14T06:00' ? 1.1 : 0);
  const heavy = await forecast(iso => iso === '2026-09-14T06:00' ? 31.1 : 0);
  assert.ok(at(light.fc, 9).dryness > at(heavy.fc, 9).dryness);
  assert.ok(at(light.fc, 9).score > at(heavy.fc, 9).score);
  assert.equal(at(light.fc, 12).wetRockCondition, undefined,
    'a light event can finish its existing recovery without an added six-hour wait');
  assert.ok(at(heavy.fc, 12).wetRockCondition);
  assert.ok(at(light.fc, 7).wetRockCondition.cap > at(heavy.fc, 7).wetRockCondition.cap);
});

test('sunny moving dry air clears wetness faster than humid calm overcast conditions', async () => {
  const rain = iso => iso === '2026-09-14T06:00' ? 15 : 0;
  const good = await forecast(rain);
  const stalled = await forecast(rain, { relative_humidity_2m: 95, windspeed_10m: 2,
    windgusts_10m: 2, cloudcover: 100, shortwave_radiation: 0 });
  assert.ok(at(good.fc, 12).dryness > at(stalled.fc, 12).dryness);
  assert.ok(at(good.fc, 12).recoveryProgressHours > at(stalled.fc, 12).recoveryProgressHours);
  assert.ok(at(good.fc, 12).wetRockCondition.cap > at(stalled.fc, 12).wetRockCondition.cap);
  assert.equal(at(stalled.fc, 12).wetRockCondition.cap, 25);
});

test('a later qualifying sandstone shower retains an unfinished heavier event and cannot improve readiness', async () => {
  const rain = iso => iso === '2026-09-14T06:00' ? 31.1 : 0;
  const dry = await forecast(rain);
  const shower = await forecast(iso => iso === '2026-09-14T13:00' ? 1.6 : rain(iso));
  assert.equal(at(shower.fc, 13).rainEventMm, 31.1);
  assert.equal(at(shower.fc, 13).currentEventMm, 1.6);
  assert.equal(at(shower.fc, 13).recoveryProgressHours, 0);
  assert.equal(at(shower.fc, 14).wetRockCondition.recoveryHours, shower.forecasts.rainRecoveryHours(shower.fc.crag, 31.1));
  for (let hour = 14; hour <= 19; hour++) {
    assert.ok(at(shower.fc, hour).dryness <= at(dry.fc, hour).dryness);
    assert.ok(at(shower.fc, hour).wetRockCondition.cap <= (at(dry.fc, hour).wetRockCondition?.cap ?? 100));
    assert.ok(at(shower.fc, hour).score <= at(dry.fc, hour).score);
  }
});

test('completed historical rain does not inflate a new small event', async () => {
  const { fc } = await forecast(iso => iso === '2026-09-10T08:00' ? 5 : iso === '2026-09-14T13:00' ? 1.6 : 0);
  assert.equal(at(fc, 13).rainEventMm, 1.6);
});

test('a later shower retains wetness even after the nominal productive clock has completed', async () => {
  const { fc, forecasts: f } = await forecast(iso => iso === '2026-09-14T06:00' ? 31.1
    : iso === '2026-09-15T16:00' ? 1.6 : 0,
  { relative_humidity_2m: 75, windspeed_10m: 12, windgusts_10m: 12, shortwave_radiation: 100 });
  const index = fc.hourly.time.indexOf('2026-09-15T16:00');
  const previous = fc.drynessSeries[index - 1];
  assert.ok(previous.recoveryProgressHours >= f.rainRecoveryHours(fc.crag, 31.1));
  assert.ok(previous.dryness < 70);
  assert.equal(fc.drynessSeries[index].rainEventMm, 31.1);
});

test('isolated sub-1 mm sandstone rain retains its exception and still affects physical wetness', async () => {
  const { fc } = await forecast(iso => iso === '2026-09-14T09:00' ? 0.5 : 0);
  assert.equal(at(fc, 9).wetRockCondition, undefined);
  assert.equal(at(fc, 10).wetRockCondition, undefined);
  assert.ok(at(fc, 9).dryness < 100);
  assert.ok(at(fc, 9).score < 100);
});
