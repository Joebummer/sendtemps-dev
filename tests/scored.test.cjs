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

test('marine conditions progressively penalise and cap committing sea cliffs', async () => {
  const harness = await loadWorker();
  const condition = harness.forecasts.marineCondition;
  const extreme = { id: 'fortescue-totem-pole', marineHazard: 'extreme' };
  const high = { id: 'cape-raoul-main', marineHazard: 'high' };

  const ordinary = condition({ id: 'fortescue-main' }, { waveHeight: 4, wind: 60 });
  assert.equal(ordinary.penalty, 0);
  assert.equal(ordinary.cap, 100);
  assert.equal(ordinary.label, null);
  assert.equal(ordinary.detail, null);
  assert.equal(condition(extreme, { waveHeight: 0.8, wavePeriod: 8, wind: 10 }).cap, 100);
  assert.equal(condition(extreme, { waveHeight: 2.1, wavePeriod: 8, wind: 10 }).cap, 60);
  assert.equal(condition(extreme, { waveHeight: 3.1, wavePeriod: 8, wind: 10 }).cap, 35);
  assert.equal(condition(extreme, { waveHeight: 0.8, wind: 15 * 1.852 }).cap, 70);
  assert.equal(condition(high, { waveHeight: 0.8, wind: 15 * 1.852 }).cap, 90);
  assert.equal(condition(extreme, { waveHeight: 1.7, wavePeriod: 14, tideLevel: 0.9, wind: 5 }).cap, 60);
});

test('best window prefers five hours, supports poor days and short late-day strips', async () => {
  const harness = await loadWorker();
  const bestWindow = harness.forecasts.bestWindow;
  const hours = [40, 45, 50, 55, 58, 57, 30].map((score, hour) => ({ score, hour: hour + 10 }));
  const window = bestWindow(hours);
  assert.equal(window.count, 5);
  assert.equal(window.start, 11);
  assert.equal(window.end, 16);
  assert.equal(Math.round(window.avg), 53);
  assert.equal(window.runAvg, window.avg);
  assert.equal(window.runHours, window.count);
  assert.equal(window.runStart, window.start);
  assert.equal(window.runEnd, window.end);

  const late = bestWindow([{ score: 72, hour: 18 }]);
  assert.equal(late.count, 1);
  assert.equal(late.start, 18);
  assert.equal(late.end, 19);
  assert.equal(late.avg, 72);
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

function marineFixture(url, overrides = {}) {
  const params = new URL(url).searchParams;
  const dates = Array.from({ length: 8 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 13 + i)).toISOString().slice(0, 10));
  const hours = dates.flatMap(date => Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`));
  const values = {
    wave_height: 0.8, wave_period: 8, swell_wave_height: 0.7,
    swell_wave_period: 8, swell_wave_direction: 180, sea_level_height_msl: 0,
    ...overrides,
  };
  const hourly = {
    time: hours,
    ...Object.fromEntries(params.get('hourly').split(',').map(key => [key, hours.map(() => values[key])])),
  };
  return params.get('latitude').split(',').map(() => ({ hourly }));
}

function fixtureForUrl(url, marineOverrides = {}) {
  return new URL(url).hostname === 'marine-api.open-meteo.com'
    ? marineFixture(url, marineOverrides)
    : weatherFixture(url);
}

test('TAS pipeline applies high-swell caps only to configured marine crags', async () => {
  const harness = await loadWorker(async url =>
    Response.json(fixtureForUrl(url, { wave_height: 2.5, swell_wave_height: 2.3 })));
  const forecasts = await harness.forecasts.fetchAllForecasts('TAS');
  for (const id of ['fortescue-totem-pole', 'fortescue-candlestick', 'cape-raoul-main']) {
    const forecast = forecasts[id];
    assert.ok(forecast.todayHourly.length > 0, id);
    assert.ok(forecast.todayHourly.every(hour => hour.score <= 60), id);
    assert.ok(forecast.todayHourly.every(hour => hour.marineCondition.label === 'high swell'), id);
    const dayIndex = forecast.days.findIndex(day => day.date === forecast.todayDate);
    const daily = harness.forecasts.scoreDay(
      forecast.crag,
      forecast.days[dayIndex],
      forecast.days[dayIndex - 1],
      forecast.days[dayIndex + 1],
    );
    assert.ok(daily.score <= 60, id);
    assert.ok(daily.reasons.includes('high swell'), id);
  }
  assert.ok(forecasts['fortescue-main'].todayHourly.some(hour => hour.score > 60));
});

test('marine provider failure leaves the weather forecast available', async () => {
  const harness = await loadWorker(async url =>
    new URL(url).hostname === 'marine-api.open-meteo.com'
      ? new Response('unavailable', { status: 503 })
      : Response.json(weatherFixture(url)));
  const forecasts = await harness.forecasts.fetchAllForecasts('TAS');
  assert.ok(forecasts['fortescue-totem-pole'].todayHourly.length > 0);
  assert.ok(forecasts['fortescue-main'].todayHourly.length > 0);
});

for (const region of ['VIC', 'TAS', 'NSW', 'ACT', 'NT', 'ALL']) {
  test(`${region}: real scoring pipeline preserves the response contract and cache payload`, async () => {
    let calls = 0;
    const harness = await loadWorker(async url => {
      assert.ok(['api.open-meteo.com', 'marine-api.open-meteo.com'].includes(new URL(url).hostname));
      calls++;
      return Response.json(fixtureForUrl(url));
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

      const todayRow = body.byDate[body.dates[0]].find(row => row.cragId === crag.id);
      const todayWindow = body.today[crag.id].todayBestWindow;
      const todayClosed = todayRow.contributions.some(c => c.category === 'closure');
      if (todayWindow && !todayClosed) {
        assert.equal(todayRow.score, Math.round(todayWindow.avg), `${crag.id} today score matches best window`);
        assert.equal(todayRow.scoreBasis, 'best-hourly-window');
        assert.equal(todayRow.scoreWindow.average, todayRow.score);
        assert.ok(todayRow.contributions.some(c => c.category === 'window'));
        assert.equal(todayWindow.runAvg, todayWindow.avg);
        assert.equal(todayWindow.runHours, todayWindow.count);
        assert.equal(todayWindow.runStart, todayWindow.start);
        assert.equal(todayWindow.runEnd, todayWindow.end);
      } else if (todayClosed) {
        assert.equal(todayRow.scoreBasis, 'closure');
        assert.ok(body.today[crag.id].todayHourly.every(hour => hour.score === 0));
      }

      const tomorrowRow = body.byDate[body.dates[1]].find(row => row.cragId === crag.id);
      const tomorrowWindow = body.today[crag.id].tomorrowBestWindow;
      const tomorrowClosed = tomorrowRow.contributions.some(c => c.category === 'closure');
      if (tomorrowWindow && !tomorrowClosed) {
        assert.equal(tomorrowRow.score, Math.round(tomorrowWindow.avg), `${crag.id} tomorrow score matches best window`);
        assert.equal(tomorrowRow.scoreBasis, 'best-hourly-window');
        assert.equal(tomorrowRow.scoreWindow.average, tomorrowRow.score);
        assert.ok(tomorrowRow.contributions.some(c => c.category === 'window'));
        assert.equal(tomorrowWindow.runAvg, tomorrowWindow.avg);
        assert.equal(tomorrowWindow.runHours, tomorrowWindow.count);
        assert.equal(tomorrowWindow.runStart, tomorrowWindow.start);
        assert.equal(tomorrowWindow.runEnd, tomorrowWindow.end);
      } else if (tomorrowClosed) {
        assert.equal(tomorrowRow.scoreBasis, 'closure');
        assert.ok(body.today[crag.id].tomorrowHourly.every(hour => hour.score === 0));
      }
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
    const expectedCalls = ['TAS', 'ALL'].includes(region) ? 2 : 1;
    assert.equal(calls, expectedCalls);

    // The unoptimised two-argument path remains our score-equivalence oracle.
    // Compare every trip field and ordering, not just the aggregate score.
    const baseline = await loadWorker(async url => Response.json(fixtureForUrl(url)));
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
    assert.equal(calls, expectedCalls, 'trip changes must not download or score regional weather again');
    assert.equal(harness.entries.size, 2, 'query variants share one fresh and one fallback regional cache key');
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
  const harness = await loadWorker(async url => { calls++; return Response.json(fixtureForUrl(url)); });
  async function get(region) {
    const response = await harness.worker.fetch(new Request(`https://api.test/forecast/scored?region=${region}`), {}, harness.ctx);
    assert.equal(response.status, 200);
    await harness.flush();
    return response;
  }
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal((await get('TAS')).headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal(calls, 3);
  harness.setNow('2026-09-13T02:14:59Z');
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'HIT');
  harness.setNow('2026-09-13T02:15:00Z');
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal(calls, 4);
  harness.setNow('2026-09-13T13:59:00Z'); // 23:59 Melbourne
  await get('NSW');
  harness.setNow('2026-09-13T14:01:00Z'); // next local day, still inside TTL
  const next = await get('NSW');
  assert.equal(next.headers.get('X-SendTemps-Cache'), 'MISS');
  assert.equal((await next.json()).dates[0], '2026-09-14');
  assert.equal(calls, 6);
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

test('weather requests deduplicate coordinates while preserving every crag', async () => {
  const crags = (await loadCrags('worker/src/lib/crags.js')).filter(c => c.state === 'VIC');
  const unique = new Set(crags.map(c => `${c.lat},${c.lon}`));
  assert.ok(unique.size < crags.length);
  const harness = await loadWorker(async url => {
    const params = new URL(url).searchParams;
    const coords = params.get('latitude').split(',').map((lat, i) => `${lat},${params.get('longitude').split(',')[i]}`);
    assert.equal(coords.length, unique.size);
    assert.deepEqual(new Set(coords), unique);
    return Response.json(weatherFixture(url));
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('VIC');
  assert.equal(Object.keys(forecasts).length, crags.length);
  for (const crag of crags) assert.ok(forecasts[crag.id].todayHourly.length, crag.id);
});

test('provider rate limits use a bounded fallback without extending its age', async () => {
  let unavailable = false;
  const harness = await loadWorker(async url => unavailable
    ? new Response('rate limited', { status: 429 })
    : Response.json(weatherFixture(url)));
  const req = new Request('https://api.test/forecast/scored?region=NT');
  const fresh = await harness.worker.fetch(req, {}, harness.ctx);
  assert.equal(fresh.status, 200);
  const original = await fresh.json();
  await harness.flush();
  unavailable = true;
  harness.setNow('2026-09-13T02:16:00Z');
  const fallback = await harness.worker.fetch(req, {}, harness.ctx);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('X-SendTemps-Cache'), 'STALE');
  assert.ok(fallback.headers.get('Warning').includes('stale'));
  assert.deepEqual(await fallback.json(), original);
  await harness.flush();
  harness.setNow('2026-09-13T03:01:00Z');
  const expired = await harness.worker.fetch(req, {}, harness.ctx);
  assert.equal(expired.status, 502);
  assert.match((await expired.json()).error, /429/);
});
