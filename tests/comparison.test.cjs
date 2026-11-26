const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const path = '/forecast/compare?cragId=camels-hump&date=2026-09-13';
const request = suffix => new Request(`https://api.test${suffix}`);
function fixture(models = ['ecmwf_ifs', 'gfs_global', 'icon_global', 'ukmo_global_deterministic_10km']) {
  const hourly = { time: ['2026-09-13T10:00', '2026-09-13T11:00'] };
  for (const id of models) {
    for (const [variable, value] of Object.entries({ temperature_2m: 15, relative_humidity_2m: 65,
      wind_speed_10m: 12, precipitation: 0 })) {
      hourly[`${variable}_${id}`] = [value, value];
    }
  }
  return { hourly };
}
test('comparison preserves destination-local hours across a DST transition', async () => {
  const harness = await loadWorker(async input => {
    assert.equal(new URL(input).searchParams.get('timeformat'), 'unixtime');
    const data = fixture();
    data.hourly.time = [Date.parse('2026-10-03T20:00:00Z') / 1000, Date.parse('2026-10-03T21:00:00Z') / 1000];
    data.utc_offset_seconds = 36000; // Request before the daylight saving transition.
    return Response.json(data);
  }, '2026-10-02T01:00:00Z');
  const response = await harness.worker.fetch(request('/forecast/compare?cragId=camels-hump&date=2026-10-04'), {});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).models[0].hours.map(h => h.time), ['2026-10-04T07:00', '2026-10-04T08:00']);
});
test('comparison batches trusted coordinates, omits unusable models and caches canonical model sets', async () => {
  let calls = 0;
  const harness = await loadWorker(async input => {
    calls++;
    const url = new URL(input);
    assert.equal(url.searchParams.get('models'), 'ecmwf_ifs,gfs_global,icon_global,ukmo_global_deterministic_10km');
    assert.ok(Number(url.searchParams.get('elevation')) > 0);
    assert.equal(url.searchParams.get('timezone'), 'Australia/Melbourne');
    assert.equal(url.searchParams.get('start_date'), '2026-09-13');
    assert.equal(url.searchParams.get('end_date'), '2026-09-13');
    assert.equal(url.searchParams.get('daily'), null);
    return Response.json(fixture(['ecmwf_ifs', 'gfs_global']));
  });
  const responses = await Promise.all([harness.worker.fetch(request(path), {}, harness.ctx),
    harness.worker.fetch(request(path), {}, harness.ctx)]);
  const body = await responses[0].json();
  assert.equal(responses[0].status, 200);
  assert.equal(body.models.length, 2);
  assert.deepEqual(body.unavailableModels, ['icon_global', 'ukmo_global_deterministic_10km']);
  assert.equal(body.models[0].hours[0].precipitationMm, 0);
  assert.equal(body.models[0].hours[0].feelsLikeC, null);
  const cached = await harness.worker.fetch(request(`${path}&models=ukmo_global_deterministic_10km,gfs_global,icon_global,ecmwf_ifs`), {}, harness.ctx);
  assert.equal(cached.headers.get('X-SendTemps-Cache'), 'HIT');
  assert.equal(cached.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls, 1);
  assert.equal([...harness.entries.values()][0].headers.get('Cache-Control'), 'public, max-age=1200');
});
test('comparison rejects invalid inputs before upstream requests', async () => {
  const harness = await loadWorker();
  for (const suffix of ['&models=unknown', '&models=', '&latitude=-1', '&date=2026-09-13']) {
    assert.equal((await harness.worker.fetch(request(path + suffix), {})).status, 400);
  }
  for (const date of ['2026-09-12', '2026-09-16', '2026-09-31', '2026-09-14garbage']) {
    assert.equal((await harness.worker.fetch(request(path.replace('2026-09-13', date)), {})).status, 400);
  }
  assert.equal((await harness.worker.fetch(request(path.replace('camels-hump', 'missing')), {})).status, 404);
});
test('comparison accepts day +2 and unsuffixed single model fields', async () => {
  const harness = await loadWorker(async () => Response.json({ hourly: {
    time: ['2026-09-15T12:00'], temperature_2m: [17], relative_humidity_2m: [70],
    wind_speed_10m: [4], precipitation: [0],
  } }));
  const response = await harness.worker.fetch(request(path.replace('2026-09-13', '2026-09-15') + '&models=gfs_global'), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models[0].hours.length, 1);
});
test('comparison uses local midnight for date boundaries', async () => {
  const harness = await loadWorker(undefined, '2026-09-12T15:00:00Z');
  // Melbourne has already reached the 13th, even though UTC is the 12th.
  const response = await harness.worker.fetch(request(path.replace('2026-09-13', '2026-09-12')), {});
  assert.equal(response.status, 400);
});
test('comparison failures, null data and malformed provider bodies are not cached', async () => {
  for (const upstream of [() => Response.json({ hourly: { time: ['2026-09-13T10:00'], temperature_2m: [null] } }),
    () => new Response('private details', { status: 500 }), () => new Response('{')]) {
    const harness = await loadWorker(upstream);
    const response = await harness.worker.fetch(request(path), {});
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'forecast_unavailable');
    assert.equal(harness.entries.size, 0);
  }
});
test('comparison respects shared provider limit and keeps credentials private', async () => {
  const harness = await loadWorker();
  const response = await harness.worker.fetch(request(path), {
    OPEN_METEO_API_KEY: 'private-key', WEATHER_REQUEST_LIMITER: { limit: async () => ({ success: false }) },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.ok(!(await response.text()).includes('private-key'));
});

test('comparison defaults to four models including ECMWF HRES 9 km and ICON Global', async () => {
  const harness = await loadWorker(async () => Response.json(fixture()));
  const response = await harness.worker.fetch(request(path), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.models.length, 4);
  assert.deepEqual(body.unavailableModels, []);
  assert.equal(body.models.find(model => model.id === 'icon_global').displayName, 'DWD ICON Global');
  assert.equal(body.models.find(model => model.id === 'ecmwf_ifs').displayName, 'ECMWF IFS HRES 9 km');
  assert.ok(!body.models.some(model => model.id === 'jma_gsm' || model.id === 'ecmwf_ifs025'));
});
test('comparison accepts optional and legacy models individually and rejects more than six entries', async () => {
  for (const id of ['icon_global', 'jma_gsm', 'ecmwf_ifs025', 'ecmwf_ifs']) {
    const harness = await loadWorker(async () => Response.json(fixture([id])));
    const response = await harness.worker.fetch(request(path + '&models=' + id), {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).models[0].id, id);
  }
  const harness = await loadWorker();
  const response = await harness.worker.fetch(request(path + '&models=' + Array(7).fill('gfs_global').join(',')), {});
  assert.equal(response.status, 400);
});
