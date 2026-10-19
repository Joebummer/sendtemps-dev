const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const req = (query = '', origin = 'https://climbable.app') => new Request(
  `https://api.test/forecast?latitude=-37&longitude=144${query}`,
  { headers: { Origin: origin, 'CF-Connecting-IP': '203.0.113.1' } });

function limiter(budget) {
  let calls = 0;
  return { limit: async () => ({ success: ++calls <= budget }), get calls() { return calls; } };
}

test('public request limit returns retry guidance and preflight needs no allowance', async () => {
  const harness = await loadWorker();
  const gate = limiter(0);
  const env = { PUBLIC_API_LIMITER: gate };
  const blocked = await harness.worker.fetch(req(), env, harness.ctx);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal(blocked.headers.get('Cache-Control'), 'no-store');
  assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), 'https://climbable.app');
  const preflight = await harness.worker.fetch(new Request(req(), { method: 'OPTIONS' }), env, harness.ctx);
  assert.equal(preflight.status, 200);
  assert.equal(gate.calls, 1);
});

test('upstream allowance counts actual paid/free attempts and cannot be bypassed by fallback', async () => {
  let calls = 0;
  const harness = await loadWorker(async () => { calls++; return new Response(null, { status: 503 }); });
  const gate = limiter(1);
  const response = await harness.worker.fetch(req(), {
    OPEN_METEO_API_KEY: 'test-private-key', WEATHER_REQUEST_LIMITER: gate,
  }, harness.ctx);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(calls, 1, 'free fallback must obtain its own allowance');
  assert.ok(!(await response.text()).includes('test-private-key'));
  assert.equal(harness.entries.size, 0);
});

test('cached proxy forecasts survive exhausted upstream allowance', async () => {
  let calls = 0;
  const harness = await loadWorker(async () => { calls++; return Response.json({ forecast: true }); });
  const gate = limiter(1);
  const env = { WEATHER_REQUEST_LIMITER: gate };
  assert.equal((await harness.worker.fetch(req(), env, harness.ctx)).status, 200);
  const cached = await harness.worker.fetch(req('&cachebuster=123&apikey=ignored'), env, harness.ctx);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get('X-SendTemps-Cache'), 'HIT');
  assert.equal(calls, 1);
  assert.equal(gate.calls, 1);
});

test('simultaneous proxy misses share one buffered result and keep CORS separate', async () => {
  let calls = 0;
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  const harness = await loadWorker(async () => { calls++; await pause; return Response.json({ forecast: true }); });
  const requests = Array.from({ length: 8 }, (_, i) => harness.worker.fetch(
    req(`&cachebuster=${i}`, i % 2 ? 'https://sendtemps.app' : 'https://climbable.app'), {}, harness.ctx));
  release();
  const responses = await Promise.all(requests);
  assert.equal(calls, 1);
  for (let i = 0; i < responses.length; i++) {
    assert.equal(responses[i].status, 200);
    assert.equal(responses[i].headers.get('Access-Control-Allow-Origin'), i % 2 ? 'https://sendtemps.app' : 'https://climbable.app');
    assert.deepEqual(await responses[i].json(), { forecast: true });
  }
});

test('query order and unsupported amplification options cannot create paid cache variants', async () => {
  let calls = 0;
  const harness = await loadWorker(async input => {
    calls++;
    const url = new URL(input);
    assert.equal(url.searchParams.has('models'), false);
    assert.equal(url.searchParams.has('start_date'), false);
    assert.equal(url.searchParams.get('apikey'), 'server-only-key');
    return Response.json({ forecast: true });
  });
  const env = { OPEN_METEO_API_KEY: 'server-only-key' };
  await harness.worker.fetch(req('&models=all&start_date=1900-01-01'), env, harness.ctx);
  const response = await harness.worker.fetch(new Request('https://api.test/forecast?longitude=144&apikey=attacker-key&latitude=-37'), env, harness.ctx);
  assert.equal(response.headers.get('X-SendTemps-Cache'), 'HIT');
  assert.equal(calls, 1);
  for (const key of harness.entries.keys()) assert.ok(!key.includes('key'));
});

test('oversized, invalid and excessive weather requests stop before provider access', async () => {
  const harness = await loadWorker();
  const invalid = [
    'latitude=NaN&longitude=144', 'latitude=91&longitude=144',
    'latitude=-37&longitude=181', 'latitude=-37,-38&longitude=144',
    'latitude=-37&longitude=144&forecast_days=16',
    'latitude=-37&longitude=144&past_days=30',
    'latitude=-37&longitude=144&forecast_days=1.5',
    'latitude=-37&longitude=144&hourly=' + Array(41).fill('temperature_2m').join(','),
    'latitude=-37&longitude=144&timezone=auto,auto',
    'latitude=-37&longitude=144&elevation=1,2',
    'latitude=' + Array(1000).fill('-37').join(',') + '&longitude=' + Array(1000).fill('144').join(','),
  ];
  for (const query of invalid) {
    const response = await harness.worker.fetch(new Request('https://api.test/forecast?' + query), {}, harness.ctx);
    assert.equal(response.status, 400, query.slice(0, 100));
  }
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


test('simultaneous scored requests share a regional job across trip and origin variants', async () => {
  let calls = 0;
  const harness = await loadWorker(async input => { calls++; return Response.json(weatherFixture(input)); });
  const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => harness.worker.fetch(
    new Request(`https://api.test/forecast/scored?region=NT&unused=${i}&tripStart=2026-09-1${i + 3}&tripEnd=2026-09-20`),
    { WEATHER_REQUEST_LIMITER: limiter(30) }, harness.ctx)));
  assert.equal(calls, 1);
  for (const response of responses) assert.equal(response.status, 200);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(bodies[0].byDate, bodies[4].byDate);
  assert.notDeepEqual(bodies[0].tripDates, bodies[4].tripDates);
});

test('upstream limit serves scored fallback, then returns 429 once fallback expires', async () => {
  let calls = 0;
  const harness = await loadWorker(async input => { calls++; return Response.json(weatherFixture(input)); });
  const env = { WEATHER_REQUEST_LIMITER: limiter(1) };
  const request = new Request('https://api.test/forecast/scored?region=NT');
  const first = await harness.worker.fetch(request, env, harness.ctx);
  const original = await first.json();
  assert.equal(first.status, 200);
  harness.setNow('2026-09-13T02:16:00Z');
  const stale = await harness.worker.fetch(request, env, harness.ctx);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('X-SendTemps-Cache'), 'STALE');
  assert.deepEqual(await stale.json(), original);
  harness.setNow('2026-09-13T03:01:00Z');
  const expired = await harness.worker.fetch(request, env, harness.ctx);
  assert.equal(expired.status, 429);
  assert.equal(expired.headers.get('Retry-After'), '60');
  assert.equal(calls, 1);
});

test('failed refresh is released so a subsequent request can recover', async () => {
  let calls = 0;
  const harness = await loadWorker(async () => {
    if (++calls === 1) throw new Error('private provider failure');
    return Response.json({ recovered: true });
  });
  assert.equal((await harness.worker.fetch(req(), {}, harness.ctx)).status, 502);
  const recovered = await harness.worker.fetch(req(), {}, harness.ctx);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { recovered: true });
});
