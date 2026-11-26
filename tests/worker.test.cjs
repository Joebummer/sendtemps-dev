const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const env = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_KEY: 'test-only' };
const routes = [
  ['/checkin', 'POST', { crag_id: 'camels-hump', rock: 'dry' }],
  ['/subscribe', 'POST', { subscription: { endpoint: 'https://push.test/1', keys: { auth: 'test', p256dh: 'test' } } }],
  ['/subscribe', 'PATCH', { endpoint: 'https://push.test/1', favourites: ['camels-hump'] }],
  ['/subscribe', 'DELETE', { endpoint: 'https://push.test/1' }],
];
function request(route, method = 'GET', body, origin = 'https://climbable.app') {
  return new Request(`https://api.test${route}`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

for (const [route, method, body] of routes) {
  for (const status of [201, 204, 400, 401, 429, 500, 503, 'network']) {
    test(`${method} ${route}: database ${status}`, async () => {
      let calls = 0;
      const harness = await loadWorker(async (url, options) => {
        calls++;
        assert.ok(url.startsWith(env.SUPABASE_URL));
        assert.equal(options.method, method);
        if (status === 'network') throw new Error('private database details');
        return new Response(status === 204 ? null : 'private database details', { status });
      });
      const response = await harness.worker.fetch(request(route, method, body), env, harness.ctx);
      const success = typeof status === 'number' && status < 300;
      assert.equal(response.status, success ? 200 : 502);
      const result = await response.json();
      assert.equal(result.ok, success);
      assert.ok(!JSON.stringify(result).includes('private database details'));
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://climbable.app');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(calls, 1);
    });
  }
  test(`${method} ${route}: malformed JSON is a client error`, async () => {
    const { worker } = await loadWorker();
    const response = await worker.fetch(new Request(`https://api.test${route}`, { method, body: '{' }), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  });
}

test('forecast proxy: edge caching stays enabled, clients never cache on miss or hit', async () => {
  let calls = 0;
  const harness = await loadWorker(async () => { calls++; return Response.json({ daily: { time: [] } }); });
  const req = request('/forecast?latitude=-37&longitude=144');
  for (const expected of ['MISS', 'HIT']) {
    const response = await harness.worker.fetch(req, env, harness.ctx);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-SendTemps-Cache'), expected);
    assert.deepEqual(await response.json(), { daily: { time: [] } });
    await harness.flush();
  }
  assert.equal(calls, 1);
  assert.equal([...harness.entries.values()][0].headers.get('Cache-Control'), 'public, max-age=900');
});

test('scored forecast: cache hit overrides stored headers and uses current CORS origin', async () => {
  const harness = await loadWorker();
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../worker/src/index.js'), 'utf8');
  const version = source.match(/const SCORED_CACHE_VERSION = '([^']+)'/)[1];
  const key = `https://api.test/_cache/scored-region?region=VIC&date=2026-09-13&_cv=${version}`;
  const payload = { region: 'VIC', dates: ['2026-09-13'], tripDates: [], crags: {}, byDate: {}, weekendTrip: [], today: {} };
  harness.entries.set(key, Response.json({ payload, cragOrder: [] }, {
    headers: { 'Cache-Control': 'public, max-age=900', 'Access-Control-Allow-Origin': 'https://climbable.app' },
  }));
  const response = await harness.worker.fetch(request('/forecast/scored?schemaVersion=2&region=VIC', 'GET', undefined, 'https://sendtemps.app'), env, harness.ctx);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-SendTemps-Cache'), 'HIT');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://sendtemps.app');
  assert.deepEqual(await response.json(), { ...payload, tripDates: ['2026-09-13'],
    schemaVersion: 2, forecastMeta: { retrievedAt: null, ageSeconds: null, calendarTimezone: 'Australia/Melbourne', stale: false, source: 'HIT' } });
  assert.equal(harness.entries.get(key).headers.get('Cache-Control'), 'public, max-age=900');
  for (const schema of ['', '&schemaVersion=1']) {
    const legacy = await harness.worker.fetch(request(`/forecast/scored?region=VIC${schema}`), env, harness.ctx);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get('X-Climbable-Schema-Version'), '1');
    assert.deepEqual(await legacy.json(), { ...payload, tripDates: ['2026-09-13'] });
  }
});

test('scored wire format keeps legacy envelopes and integer fields stable without losing internal precision', async () => {
  const { wire } = await loadWorker();
  const hour = { hour: 9, score: 71, temp: 14.4, recoveryProgressHours: 2.75,
    weightedProb: 72.4, scoreContext: [1.5, 90, 100], wetRockCondition: { activeRain: true, cap: 60 } };
  const row = { score: 71, timezone: 'Australia/Perth', localToday: '2026-09-13',
    scoreWindow: { average: 71, hourlyAverage: 71.4, usability: { wetHours: 1 } },
    day: { date: '2026-09-13', dailyContext: { climbTemps: {} }, elevationSource: 'provider' } };
  const payload = { region: 'WA', dates: ['2026-09-13'], tripDates: ['2026-09-13'],
    crags: { test: { timezone: 'Australia/Perth', elevation: 532 } },
    byDate: { '2026-09-13': [row] }, weekendTrip: [],
    today: { test: { todayDate: '2026-09-13', todayHourly: [hour], daylight: true } } };
  const meta = { retrievedAt: '2026-09-13T02:00:00Z', ageSeconds: 0, stale: false };
  const old = JSON.parse(wire.serializeScoredResponse(payload, meta));
  assert.deepEqual(Object.keys(old).sort(), ['region', 'dates', 'tripDates', 'crags', 'byDate', 'weekendTrip', 'today'].sort());
  assert.deepEqual(old.byDate['2026-09-13'][0], { score: 71, scoreWindow: { average: 71, hourlyAverage: 71 }, day: { date: '2026-09-13' } });
  assert.deepEqual(old.today.test.todayHourly[0], { hour: 9, score: 71, temp: 14.4,
    recoveryProgressHours: 2, weightedProb: 72, wetRockCondition: { cap: 60 } });
  assert.deepEqual(old.crags.test, { elevation: 532 });
  const modern = JSON.parse(wire.serializeScoredResponse(payload, meta, 2));
  assert.equal(modern.schemaVersion, 2);
  assert.deepEqual(modern.forecastMeta, meta);
  assert.equal(modern.forecast, undefined, 'reserved legacy envelope key is never used for metadata');
  assert.equal(modern.byDate['2026-09-13'][0].timezone, 'Australia/Perth');
  assert.equal(modern.byDate['2026-09-13'][0].scoreWindow.hourlyAverage, 71.4);
  assert.equal(modern.today.test.todayHourly[0].recoveryProgressHours, 2.75);
  for (const body of [old, modern]) {
    assert.ok(!JSON.stringify(body).includes('scoreContext'));
    assert.ok(!JSON.stringify(body).includes('dailyContext'));
  }
  assert.equal(hour.recoveryProgressHours, 2.75);
  assert.deepEqual(hour.scoreContext, [1.5, 90, 100], 'serialization never mutates cached calculations');
});

test('unsupported scored schemas stop before any provider access', async () => {
  const harness = await loadWorker();
  for (const schema of ['0', '3', '2.0', '', '2&schemaVersion=1']) {
    const response = await harness.worker.fetch(request(`/forecast/scored?region=VIC&schemaVersion=${schema}`), env, harness.ctx);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unsupported schemaVersion' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(harness.entries.size, 0);
});

test('forecast proxy preserves upstream failure status and does not cache it', async () => {
  const harness = await loadWorker(async () => new Response('rate limited', { status: 429 }));
  const response = await harness.worker.fetch(request('/forecast?latitude=-37&longitude=144'), env, harness.ctx);
  assert.equal(response.status, 429);
  await harness.flush();
  assert.equal(harness.entries.size, 0);
});

test('forecast proxy falls back to the free provider when the paid provider fails', async () => {
  const key = 'server-only-key';
  const harness = await loadWorker(async input => {
    const url = new URL(input);
    if (url.hostname === 'customer-api.open-meteo.com') {
      assert.equal(url.searchParams.get('apikey'), key);
      return new Response(`Bad request ${key}`, { status: 503 });
    }
    assert.equal(url.hostname, 'api.open-meteo.com');
    assert.equal(url.searchParams.has('apikey'), false);
    return Response.json({ daily: { time: [] } });
  });
  const response = await harness.worker.fetch(request('/forecast?latitude=-37&longitude=144&apikey=client-key'),
    { OPEN_METEO_API_KEY: key }, harness.ctx);
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(key));
});

test('forecast proxy falls back when the paid provider drops the response body', async () => {
  let freeCalls = 0;
  const harness = await loadWorker(async input => {
    const url = new URL(input);
    if (url.hostname === 'customer-api.open-meteo.com') {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error('upstream stream dropped')); },
      }));
    }
    freeCalls++;
    return Response.json({ daily: { time: ['2026-09-27'] } });
  });
  const response = await harness.worker.fetch(request('/forecast?latitude=-37&longitude=144'),
    { OPEN_METEO_API_KEY: 'server-only-key' }, harness.ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { daily: { time: ['2026-09-27'] } });
  assert.equal(freeCalls, 1);
});
