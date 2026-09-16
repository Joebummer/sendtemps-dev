const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const { loadCrags, validateCrags } = require('../scripts/validate-crags.cjs');

test('Candlestick chasm penalty starts gently below 15 knots and escalates in SSW winds', async () => {
  const harness = await loadWorker();
  const candlestick = {
    id: 'fortescue-candlestick',
    windHazard: { bearing: 202.5, tolerance: 22.5 },
  };
  const penalty = harness.forecasts.directionalWindPenalty;

  assert.equal(penalty(candlestick, 202.5, 12 * 1.852), 0);
  assert.equal(penalty(candlestick, 202.5, 14 * 1.852), 2);
  assert.equal(penalty(candlestick, 202.5, 15 * 1.852), 8);
  assert.equal(penalty(candlestick, 202.5, 18 * 1.852), 10);
  assert.equal(penalty(candlestick, 202.5, 20 * 1.852), 15);
  assert.equal(penalty(candlestick, 90, 25 * 1.852), 0);
  assert.equal(penalty({ id: 'fortescue-moai' }, 202.5, 25 * 1.852), 0);
});

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

for (const region of ['VIC', 'TAS', 'NSW', 'ACT', 'NT', 'ALL']) {
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

    // The unoptimised two-argument path remains our score-equivalence oracle.
    // Compare every trip field and ordering, not just the aggregate score.
    const baseline = await loadWorker(async url => Response.json(weatherFixture(url)));
    const forecasts = await baseline.forecasts.fetchAllForecasts(region);
    for (const query of [
      '', '&tripStart=2026-09-18&tripEnd=2026-09-20',
      '&tripEnd=2026-09-18&tripStart=2026-09-20',
      '&tripStart=2026-09-15&tripEnd=2026-09-15',
      '&tripStart=2026-09-13&tripEnd=2026-09-22',
      '&tripStart=invalid&tripEnd=2026-09-20',
    ]) {
      const response = await harness.worker.fetch(new Request(`https://api.test/forecast/scored?region=${region.toLowerCase()}${query}&unused=ignored`), {}, harness.ctx);
      assert.equal(response.headers.get('X-SendTemps-Cache'), 'HIT');
      const actual = await response.json();
      const expectedTrip = baseline.forecasts.rankWeekendTrip(forecasts, actual.tripDates)
        .map(({ crag, ...rest }) => ({ cragId: crag.id, ...rest }));
      assert.deepEqual(actual.weekendTrip, JSON.parse(JSON.stringify(expectedTrip)));
      assert.deepEqual(actual.byDate, body.byDate);
    }
    assert.equal(calls, 1, 'trip changes must not download or score regional weather again');
    assert.equal(harness.entries.size, 1, 'query variants must share the same regional cache key');
  });
}

test('invalid regions are rejected before cache or network access', async () => {
  let calls = 0;
  const harness = await loadWorker(async () => { calls++; throw new Error('unexpected network'); });
  for (const region of ['INVALID', 'VIIC', ' VIC ', '__proto__']) {
    const response = await harness.worker.fetch(new Request(`https://api.test/forecast/scored?region=${encodeURIComponent(region)}`), {}, harness.ctx);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid region' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(calls, 0);
  assert.equal(harness.entries.size, 0);
});

test('region separation, expiry and midnight rollover cannot reuse the wrong dataset', async () => {
  let calls = 0;
  const harness = await loadWorker(async url => { calls++; return Response.json(weatherFixture(url)); });
  async function get(region) {
    const response = await harness.worker.fetch(new Request(`https://api.test/forecast/scored?region=${region}`), {}, harness.ctx);
    assert.equal(response.status, 200);
    await harness.flush();
    return response;
  }
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal((await get('TAS')).headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal(calls, 2);
  harness.setNow('2026-09-13T02:14:59Z');
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'HIT');
  harness.setNow('2026-09-13T02:15:00Z');
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal(calls, 3);
  harness.setNow('2026-09-13T13:59:00Z'); // 23:59 Melbourne
  await get('NSW');
  harness.setNow('2026-09-13T14:01:00Z'); // next local day, still inside TTL
  const next = await get('NSW');
  assert.equal(next.headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal((await next.json()).dates[0], '2026-09-14');
  assert.equal(calls, 5);
});

test('failed weather fetches never populate the regional cache', async () => {
  const harness = await loadWorker(async () => new Response('unavailable', { status: 503 }));
  const response = await harness.worker.fetch(new Request('https://api.test/forecast/scored?region=NSW'), {}, harness.ctx);
  assert.equal(response.status, 502);
  await harness.flush();
  assert.equal(harness.entries.size, 0);
});

test('heat exposure scales only solar heat and preserves ambient heat in shade', async () => {
  const harness = await loadWorker(async url => Response.json(weatherFixture(url)));
  const forecast = (await harness.forecasts.fetchAllForecasts('VIC'))['mt-beckworth'];
  const day = structuredClone(forecast.days.find(item => item.date === '2026-09-13'));
  day.climbTemps.temperatureSamples = [{ air: 26, apparent: 18, solarFraction: 1 }];
  const penalties = heatExposure => {
    const result = harness.forecasts.scoreDay(
      { ...forecast.crag, heatCap: 20, heatExposure }, day, null, null,
    );
    return Object.fromEntries(result.contributions.map(item => [item.label, item.delta]));
  };
  assert.equal(penalties('exposed')['Solar heat'], -9);
  assert.equal(penalties('partial')['Solar heat'], -6);
  assert.equal(penalties('sheltered')['Solar heat'], -4);
  assert.equal(penalties(undefined)['Solar heat'], -9);
  for (const exposure of ['exposed', 'partial', 'sheltered', undefined])
    assert.equal(penalties(exposure)['Ambient heat'], -9);
});
