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
  const response = await harness.worker.fetch(request('/forecast/scored?region=VIC', 'GET', undefined, 'https://sendtemps.app'), env, harness.ctx);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-SendTemps-Cache'), 'HIT');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://sendtemps.app');
  assert.deepEqual(await response.json(), { ...payload, tripDates: ['2026-09-13'] });
  assert.equal(harness.entries.get(key).headers.get('Cache-Control'), 'public, max-age=900');
});

test('forecast proxy preserves upstream failure status and does not cache it', async () => {
  const harness = await loadWorker(async () => new Response('rate limited', { status: 429 }));
  const response = await harness.worker.fetch(request('/forecast'), env, harness.ctx);
  assert.equal(response.status, 429);
  await harness.flush();
  assert.equal(harness.entries.size, 0);
});

test('forecast proxy uses only the configured paid key and redacts upstream errors', async () => {
  const key = 'server-only-key';
  const harness = await loadWorker(async input => {
    const url = new URL(input);
    assert.equal(url.hostname, 'customer-api.open-meteo.com');
    assert.equal(url.searchParams.get('apikey'), key);
    return new Response(`Bad request ${key}`, { status: 401 });
  });
  const response = await harness.worker.fetch(request('/forecast?apikey=client-key'),
    { OPEN_METEO_API_KEY: key }, harness.ctx);
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes(key));
});
