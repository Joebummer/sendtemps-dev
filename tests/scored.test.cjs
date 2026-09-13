const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const { loadCrags, validateCrags } = require('../scripts/validate-crags.cjs');

function weatherFixture(url) {
  const params = new URL(url).searchParams;
  const dates = Array.from({ length: 14 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 9 + i)).toISOString().slice(0, 10));
  const hours = dates.flatMap(date => Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`));
  const values = {
    temperature_2m_max: 20, temperature_2m_min: 10, apparent_temperature_max: 19,
    precipitation_sum: 0, precipitation_probability_max: 0, precipitation_hours: 0,
    windspeed_10m_max: 10, sunshine_duration: 28800, weathercode: 0,
    precipitation: 0, precipitation_probability: 0, temperature_2m: 18,
    apparent_temperature: 17, relative_humidity_2m: 50, windspeed_10m: 8,
    winddirection_10m: 180, windgusts_10m: 12, cloudcover: 20, shortwave_radiation: 300,
  };
  const section = (name, time) => ({ time, ...Object.fromEntries(params.get(name).split(',').map(key => {
    assert.ok(key in values, `fixture missing ${key}`);
    return [key, time.map(() => values[key])];
  })) });
  const forecast = { daily: section('daily', dates), hourly: section('hourly', hours) };
  return params.get('latitude').split(',').map(() => forecast);
}

for (const region of ['VIC', 'TAS', 'NSW', 'ALL']) {
  test(`${region}: real scoring pipeline preserves the response contract and cache payload`, async () => {
    let calls = 0;
    const harness = await loadWorker(async url => {
      assert.equal(new URL(url).hostname, 'api.open-meteo.com');
      calls++;
      return Response.json(weatherFixture(url));
    });
    const req = new Request(`https://api.test/forecast/scored?region=${region}&tripStart=2026-09-18&tripEnd=2026-09-20`);
    const first = await harness.worker.fetch(req, {}, harness.ctx);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'no-store');
    assert.equal(first.headers.get('X-SendTemps-Cache'), 'MISS');
    const body = await first.json();
    const expected = (await loadCrags('worker/src/lib/crags.js')).filter(c => region === 'ALL' || c.state === region);
    assert.deepEqual(Object.keys(body).sort(), ['region', 'dates', 'tripDates', 'crags', 'byDate', 'weekendTrip', 'today'].sort());
    assert.equal(body.region, region);
    assert.equal(body.dates.length, 10);
    assert.deepEqual(body.tripDates, ['2026-09-18', '2026-09-19', '2026-09-20']);
    assert.equal(Object.keys(body.crags).length, expected.length);
    assert.deepEqual(validateCrags(Object.values(body.crags)), []);
    for (const date of body.dates) {
      const rows = body.byDate[date];
      assert.equal(rows.length, expected.length);
      for (const [i, row] of rows.entries()) {
        assert.ok(body.crags[row.cragId]);
        assert.ok(Number.isFinite(row.score) && row.score >= 0 && row.score <= 100);
        assert.equal(row.day.date, date);
        assert.ok(Array.isArray(row.reasons));
        if (i) assert.ok(rows[i - 1].score >= row.score);
      }
    }
    for (const crag of expected) {
      assert.ok(body.today[crag.id]);
      assert.ok(Array.isArray(body.today[crag.id].tomorrowHourly));
    }
    assert.ok(body.weekendTrip.length > 0);
    for (const trip of body.weekendTrip) {
      assert.ok(body.crags[trip.cragId]);
      assert.ok(Number.isFinite(trip.tripScore));
      for (const day of trip.dailyScores) {
        assert.equal(day.score, body.byDate[day.date].find(row => row.cragId === trip.cragId).score);
      }
    }
    await harness.flush();
    assert.equal([...harness.entries.values()][0].headers.get('Cache-Control'), 'public, max-age=900');
    const second = await harness.worker.fetch(req, {}, harness.ctx);
    assert.equal(second.headers.get('Cache-Control'), 'no-store');
    assert.equal(second.headers.get('X-SendTemps-Cache'), 'HIT');
    assert.deepEqual(await second.json(), body);
    assert.equal(calls, 1);
  });
}
