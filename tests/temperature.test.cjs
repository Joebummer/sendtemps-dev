const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadWorker } = require('./helpers.cjs');
const { loadCrags } = require('../scripts/validate-crags.cjs');

async function loadForecast(relative) {
  const context = vm.createContext({ Date, Intl, console, URL, setTimeout, clearTimeout,
    fetch: () => { throw new Error('Unexpected network'); } });
  const modules = new Map();
  async function load(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(
      await fs.readFile(file, 'utf8'), { context, identifier: file }));
    return modules.get(file);
  }
  const root = await load(path.resolve(__dirname, '..', relative));
  await root.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await root.evaluate();
  return root.namespace;
}

const date = '2026-07-15';
function hourly(profile) {
  const values = Array.from({ length: 24 }, (_, h) => typeof profile === 'function' ? profile(h) : profile);
  return {
    time: values.map((_, h) => date + 'T' + String(h).padStart(2, '0') + ':00'),
    temperature_2m: values, apparent_temperature: [...values],
    cloudcover: values.map(() => 0),
  };
}
function dayFor(f, crag, profile) {
  const hours = hourly(profile);
  return {
    date, tMin: Math.min(...hours.temperature_2m), tMax: Math.max(...hours.temperature_2m),
    tFeel: Math.max(...hours.apparent_temperature),
    climbTemps: f.computeClimbTemps(crag, hours, date),
    precipSum: 0, precipProb: 0, precipHours: 0, wind: 8, windAvg: 8,
    sunshine: 28800, sunHoursOnWall: 8, sunHoursOnWallCool: 3,
    sunHoursOnWallWarm: 5, cloudMean: 0,
    morningDryness: 100, afternoonDryness: 100, dayDryness: 100,
    climbHumidity: { meanRh: 40, hoursDry: 12, hoursHumid: 0, muggyHours: 0 },
  };
}
function hourAt(t, extra = {}) {
  return { temp: t, apparentTemp: t, precip: 0, precipProb: 0, cloud: 0,
    wind: 8, dryness: 100, sunOnWall: true, sunAlt: 40, ...extra };
}
function heatTotal(result) {
  return -result.contributions.filter(c => ['Ambient heat', 'Solar heat'].includes(c.label))
    .reduce((sum, c) => sum + c.delta, 0);
}

test('warm-performance callouts are concise, unambiguous and cannot score 99', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const route = { idealTemp: [8, 22], discipline: 'routes', shade: 'mixed' };
  const boulder = { ...route, discipline: 'bouldering' };

  assert.equal(f.scoreHour(route, hourAt(16)), 100);
  assert.ok(f.scoreHour(route, hourAt(17)) <= 90);
  assert.ok(f.scoreHour(boulder, hourAt(17)) <= 88);
  assert.ok(f.scoreHour(boulder, hourAt(17)) < f.scoreHour(route, hourAt(17)));

  const warm = f.scoreDay(route, dayFor(f, route, 17), null, null);
  assert.ok(warm.score <= 90);
  assert.ok(warm.reasons.includes('too warm for hard climbing'));
  assert.ok(!warm.reasons.some(reason => reason.startsWith('warm for hard climbing')));
  assert.ok(!warm.reasons.some(reason => reason.includes('°C avg')));

  const varied = f.scoreDay(route, dayFor(f, route, h => h % 2 ? 16.5 : 15.5), null, null);
  assert.ok(varied.reasons.includes('temp varies'));
  assert.ok(!varied.reasons.includes('temperature varies through the day'));

  const window = { start: 10, end: 15, count: 5, avg: 100 };
  const rankedWarm = f.rankByDay({ warm: {
    crag: route, days: [dayFor(f, route, 17)], todayDate: date,
    todayBestWindow: window, nowDryness: 100, pastPrecip: [],
  } }, [date])[date][0];
  assert.equal(rankedWarm.score, 90);
  assert.ok(!rankedWarm.reasons.some(reason => reason.startsWith('best window avg')));

  const rankedVaried = f.rankByDay({ varied: {
    crag: route, days: [dayFor(f, route, h => h % 2 ? 16.5 : 15.5)], todayDate: date,
    todayBestWindow: window, nowDryness: 100, pastPrecip: [],
  } }, [date])[date][0];
  assert.equal(rankedVaried.score, 98);
  assert.ok(!rankedVaried.reasons.some(reason => reason.startsWith('best window avg')));

  const parent = { ...route, id: 'parent' };
  const child = { ...route, id: 'child', parentId: 'parent' };
  const grouped = f.rankByDay({
    parent: { crag: parent, days: [dayFor(f, parent, 17)], todayDate: 'other' },
    child: { crag: child, days: [dayFor(f, child, 16)], todayDate: 'other' },
  }, [date])[date];
  const parentRow = grouped.find(row => row.crag.id === 'parent');
  const childRow = grouped.find(row => row.crag.id === 'child');
  assert.deepEqual(parentRow.reasons, childRow.reasons);
  assert.ok(!parentRow.reasons.includes('too warm for hard climbing'));
});

for (const file of ['worker/src/lib/forecast.js']) {
  test(file + ': all Blue Mountains records, -5 to 25 degrees and bonus protection', async () => {
    const f = await loadForecast(file);
    const blue = (await loadCrags('worker/src/lib/crags.js')).filter(c =>
      c.id === 'bluemtns-main' || c.parentId === 'bluemtns-main');
    assert.equal(blue.length, 30);
    for (const crag of blue) {
      const scores = [-5, 0, 5, 10, 15, 20, 25].map(t => {
        const result = f.scoreDay(crag, dayFor(f, crag, t), null, null);
        assert.ok(Number.isFinite(result.score) && result.score >= 0 && result.score <= 100);
        const hourlyScore = f.scoreHour(crag, hourAt(t), 0, 0, 0, 40);
        if (t <= 0) {
          assert.ok(result.score < 60, crag.id + ': freezing day ' + result.score);
          assert.ok(hourlyScore < 60, crag.id + ': freezing hour ' + hourlyScore);
        }
        return result.score;
      });
      assert.ok(scores[0] < scores[1] && scores[1] < scores[2], crag.id + ': cold severity');
      assert.ok(scores[2] < scores[4], crag.id + ': mild weather should beat 5 degrees');
      if (crag.idealTemp[1] < 25) assert.ok(scores[6] < scores[4], crag.id + ': hot side');
    }
  });

  test(file + ': overnight frost does not spoil an ideal climbing day', async () => {
    const f = await loadForecast(file);
    const crag = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'bluemtns-shipley');
    const mild = dayFor(f, crag, 15);
    const frost = dayFor(f, crag, h => h < 8 || h >= 20 ? -5 : 15);
    assert.equal(frost.tMin, -5);
    assert.equal(frost.climbTemps.hoursInRange, mild.climbTemps.hoursInRange);
    assert.equal(f.scoreDay(crag, frost, null, null).score, f.scoreDay(crag, mild, null, null).score);
  });

  test(file + ': one hot hour is less costly than sustained heat, with a useful morning', async () => {
    const f = await loadForecast(file);
    const crag = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'bluemtns-shipley');
    const spike = f.scoreDay(crag, dayFor(f, crag, h => h === 15 ? 30 : 15), null, null);
    const sustained = f.scoreDay(crag, dayFor(f, crag, 30), null, null);
    assert.ok(spike.score > sustained.score + 20);
    assert.ok(heatTotal(spike) < heatTotal(sustained));
    const strip = Array.from({ length: 12 }, (_, i) => {
      const h = i + 8, t = h === 15 ? 30 : 15;
      return { hour: h, temp: t, score: f.scoreHour(crag, hourAt(t)) };
    });
    const window = f.bestWindow(strip);
    assert.ok(window, 'morning window should survive a brief afternoon spike');
    assert.ok(f.scoreHour(crag, hourAt(30)) < f.scoreHour(crag, hourAt(15)));
  });

  test(file + ': ambient heat persists in shade, solar heat follows exposure', async () => {
    const f = await loadForecast(file);
    const base = { idealTemp: [10, 19], heatCap: 20 };
    const exposed = f.heatPenalty({ ...base, heatExposure: 'exposed' }, 26, 1);
    const partial = f.heatPenalty({ ...base, heatExposure: 'partial' }, 26, 1);
    const sheltered = f.heatPenalty({ ...base, heatExposure: 'sheltered' }, 26, 1);
    const shade = f.heatPenalty({ ...base, heatExposure: 'sheltered' }, 26, 0);
    assert.equal(exposed.ambient, partial.ambient);
    assert.equal(exposed.ambient, sheltered.ambient);
    assert.ok(exposed.solar > partial.solar && partial.solar > sheltered.solar);
    assert.ok(shade.ambient > 0);
    assert.equal(shade.solar, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(f.heatPenalty(base, 26, 1))), JSON.parse(JSON.stringify(exposed)));
    const cap = f.heatPenalty(base, 20, 1);
    const justOver = f.heatPenalty(base, 20.01, 1);
    assert.equal(cap.ambient + cap.solar, 0);
    assert.ok(justOver.ambient + justOver.solar < 0.1, 'no cliff at heatCap');
    const crag = { ...base, shade: 'all-day', heatExposure: 'sheltered' };
    assert.equal(f.scoreHour(crag, hourAt(26)), f.scoreHour(crag, hourAt(26, { sunOnWall: false })));
  });

  test(file + ': extremes cannot cancel into an ideal mean; missing data stays finite', async () => {
    const f = await loadForecast(file);
    const crag = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'bluemtns-shipley');
    const alternating = dayFor(f, crag, h => h % 2 ? 30 : 0);
    assert.equal(alternating.climbTemps.meanApparent, 15);
    assert.ok(f.scoreDay(crag, alternating, null, null).score <
      f.scoreDay(crag, dayFor(f, crag, 15), null, null).score - 20);
    const missing = dayFor(f, crag, 0);
    delete missing.climbTemps;
    assert.ok(f.scoreDay(crag, missing, null, null).score < 60);
    const invalid = hourly(15);
    invalid.apparent_temperature[9] = NaN;
    invalid.temperature_2m[10] = null;
    const ct = f.computeClimbTemps(crag, invalid, date);
    assert.equal(ct.climbHours, 10);
    assert.ok(Number.isFinite(ct.meanApparent));
  });
}

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


test('forecast pipeline applies elevation once to hourly cells, temperature bins and daily means', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const f of data) {
      for (const key of ['temperature_2m', 'apparent_temperature']) f.hourly[key].fill(10);
      for (const key of ['temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max']) f.daily[key].fill(10);
    }
    return Response.json(data);
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('NSW');
  for (const id of ['bluemtns-shipley', 'bluemtns-bowenscreek', 'bluemtns-thefreezer', 'bluemtns-bell-shady', 'westside-main']) {
    const f = forecasts[id];
    const correction = Math.max(0, f.crag.elevation - 400) / 1000 * 6.5;
    const expected = 10 - correction;
    const day = f.days.find(d => d.date === '2026-09-13');
    assert.ok(Math.abs(day.climbTemps.meanApparent - expected) < 1e-9);
    assert.ok(Math.abs(day.tFeel - expected) < 1e-9);
    assert.ok(f.todayHourly.length > 0);
    for (const hour of f.todayHourly) {
      assert.ok(Math.abs(hour.apparentTemp - expected) < 1e-9, id + ': hourly correction');
      assert.ok(Math.abs(hour.temp - expected) < 1e-9, id + ': air correction');
    }
    if (correction > 0) {
      assert.equal(day.climbTemps.hoursInRange, 0, id + ': bins use corrected temperatures');
      assert.equal(day.climbTemps.hoursCold, day.climbTemps.climbHours);
    } else {
      assert.equal(day.climbTemps.hoursInRange, day.climbTemps.climbHours);
    }
  }
});

test('Westside evening heat cannot score 95–99 when feels-like is 21–22 degrees', async () => {
  for (const file of ['worker/src/lib/forecast.js']) {
    const f = await loadForecast(file);
    const westside = (await loadCrags('worker/src/lib/crags.js')).filter(c => c.id.startsWith('westside-'));
    assert.equal(westside.length, 3);
    for (const crag of westside) {
      const scores = [21, 22].map(t => f.scoreHour(crag,
        hourAt(t, { sunOnWall: false, sunAlt: -5, cloud: 45 }), 0, 0, 45, 43));
      assert.ok(scores[0] <= 86 && scores[1] <= 81, crag.id + ': heat penalties survive bonuses');
      assert.ok(scores[1] < scores[0]);
      // Cooler feels-like must not excuse warm air.
      assert.equal(f.scoreHour(crag, hourAt(22, { apparentTemp: 18, sunOnWall: false, sunAlt: -5, cloud: 45 }), 0, 0, 45, 43), scores[1]);
      const shade = dayFor(f, crag, 22);
      shade.climbTemps.temperatureSamples.forEach(sample => { sample.solarFraction = 0; });
      const result = f.scoreDay(crag, shade, null, null);
      assert.ok(result.contributions.some(c => c.label === 'Ambient heat' && c.delta < 0));
      assert.ok(!result.contributions.some(c => c.label === 'Solar heat'));
      assert.ok(!result.reasons.includes('sun-baked aspect'));
    }
  }
});

test('temperature protection applies across the dataset, including crags without heat caps', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const crags = await loadCrags('worker/src/lib/crags.js');
  for (const crag of crags) {
    const below = crag.idealTemp[0] - 10;
    const above = crag.idealTemp[1] + 10;
    for (const t of [below, above]) {
      const hour = f.scoreHour(crag, hourAt(t), 0, 0, 0, 40);
      assert.ok(hour <= 60, crag.id + ': serious temperature mismatch cannot score highly');
    }
    if (!Number.isFinite(crag.heatCap)) {
      const shaded = f.heatPenalty(crag, above, 0);
      const sunny = f.heatPenalty(crag, above, 1);
      assert.equal(shaded.ambient, 0);
      assert.equal(shaded.solar, 0);
      assert.ok(sunny.solar > 0);
    }
  }
});

test('Westside live evening air temperatures retain heat penalties despite cooler feels-like', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const crags = (await loadCrags('worker/src/lib/crags.js')).filter(c => c.id.startsWith('westside-'));
  for (const crag of crags) {
    for (const [air, feel, expected] of [[22.3, 20.3, 79], [21, 19, 86]]) {
      const score = f.scoreHour(crag, hourAt(air, {
        apparentTemp: feel, sunOnWall: false, sunAlt: -4, cloud: 18,
      }), 0, 8, 45.3, 43);
      assert.equal(score, expected, crag.id + ': observed evening fixture');
      const weather = hourly(air);
      weather.apparent_temperature.fill(feel);
      const day = dayFor(f, crag, air);
      day.climbTemps = f.computeClimbTemps(crag, weather, date);
      assert.equal(day.climbTemps.hoursInRange, 0);
      assert.equal(day.climbTemps.hoursHot, day.climbTemps.climbHours);
      const result = f.scoreDay(crag, day, null, null);
      assert.ok(result.score <= score);
      assert.ok(result.contributions.some(c => c.label === 'Ambient heat' && c.delta < 0));
    }
  }
});

test('delta T and spooge model distinguish warm clammy air from dry or genuinely wet rock', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  assert.ok(Math.abs(f.deltaT(20, 90) - 1.2) < 0.2);
  assert.ok(Math.abs(f.deltaT(20, 50) - 6.3) < 0.2);

  const crag = { idealTemp: [10, 24], aspect: 'S' };
  const clammy = f.spoogePenalty(crag, hourAt(20, {
    humidity: 90, wind: 5, windGust: 5, windExposure: 'lee', dryness: 100,
  }));
  const coolClammy = f.spoogePenalty(crag, hourAt(10, {
    humidity: 90, wind: 5, windGust: 5, windExposure: 'lee', dryness: 100,
  }));
  const breezy = f.spoogePenalty(crag, hourAt(20, {
    humidity: 90, wind: 20, windGust: 20, windExposure: 'onshore', dryness: 100,
  }));
  const dry = f.spoogePenalty(crag, hourAt(20, {
    humidity: 50, wind: 5, windGust: 5, windExposure: 'lee', dryness: 100,
  }));
  const wetRock = f.spoogePenalty(crag, hourAt(20, {
    humidity: 90, wind: 5, windGust: 5, windExposure: 'lee', dryness: 80,
  }));

  assert.ok(clammy > 5 && clammy <= 6, 'warm, still and saturated should approach the cap');
  assert.ok(coolClammy > 0 && coolClammy < clammy, 'cool saturated air produces less sweat load');
  assert.ok(breezy > 0 && breezy < clammy, 'exposed wind should clear some moisture');
  assert.equal(dry, 0, 'adequate delta T should not be penalised');
  assert.equal(wetRock, 0, 'wet-rock penalty owns materially wet conditions');
});

test('hourly scores use spooge instead of a day-average RH penalty', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const crag = { idealTemp: [10, 24], aspect: 'S' };
  const base = { sunOnWall: null, sunAlt: 40, cloud: 20, dryness: 100,
    wind: 5, windGust: 5, windExposure: 'lee' };
  const dry = f.scoreHour(crag, hourAt(20, { ...base, humidity: 50 }), 0, 0, 20, 90);
  const clammy = f.scoreHour(crag, hourAt(20, { ...base, humidity: 90 }), 0, 0, 20, 50);
  assert.equal(dry, 100);
  assert.equal(clammy, 94, 'the conservative first version is capped at six points');
});

test('daily air-moisture contribution uses averaged hourly spooge and respects wet suppression', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const crag = { id: 'test', name: 'Test', idealTemp: [10, 24], aspect: 'S', rockType: 'sandstone' };
  const makeDay = climbHumidity => ({
    date, tMin: 18, tMax: 20, tFeel: 20,
    climbTemps: { climbHours: 10, hoursInRange: 10, meanTemp: 20, meanApparent: 20,
      temperatureSamples: Array.from({ length: 10 }, (_, hour) => ({ hour: hour + 8, air: 20, apparent: 20, solarFraction: 0 })) },
    climbHumidity, precipSum: 0, precipProb: 0, precipHours: 0,
    rainWindows: [], wind: 5, windAvg: 5, cloudMean: 20, sunshine: 0,
    morningDryness: 100, afternoonDryness: 100, dayDryness: 100,
  });
  const muggy = f.scoreDay(crag, makeDay({ climbHours: 10, meanDeltaT: 1.2,
    spoogePenalty: 5.6, spoogeHours: 10, wetSuppressedHours: 0 }), null, null);
  const crisp = f.scoreDay(crag, makeDay({ climbHours: 10, meanDeltaT: 6.3,
    spoogePenalty: 0, spoogeHours: 0, wetSuppressedHours: 0 }), null, null);
  const wetSuppressed = f.scoreDay(crag, makeDay({ climbHours: 10, meanDeltaT: 1.2,
    spoogePenalty: 0, spoogeHours: 0, wetSuppressedHours: 10 }), null, null);

  assert.equal(muggy.contributions.find(c => c.label === 'Air moisture')?.delta, -6);
  assert.equal(crisp.contributions.find(c => c.label === 'Air moisture')?.delta, 3);
  assert.ok(!wetSuppressed.contributions.some(c => c.label === 'Air moisture'));
});

test('heat uses air, cold retains wind chill, and missing readings fall back', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const crag = { idealTemp: [10, 18], heatCap: 20, heatExposure: 'partial' };
  assert.equal(f.temperaturePenalty(crag, 18, 22), 16);
  assert.equal(f.temperaturePenalty(crag, 25, 18), 0);
  assert.ok(f.temperaturePenalty(crag, 0, 12) > f.temperaturePenalty(crag, 12, 12));
  assert.equal(f.temperaturePenalty(crag, null, 22), 16);
  assert.equal(f.temperaturePenalty(crag, 22), 16);
  assert.equal(f.temperaturePenalty(crag, 22, null), 16);
});

test('feels-like heat starts continuously above 21 and preserves mild/cold scoring', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const c = { idealTemp: [10, 30], shade: 'all-day', lat: -37, lon: 144 };
  assert.equal(f.feelsLikeHeatPenalty(c, 21), 0);
  assert.ok(f.feelsLikeHeatPenalty(c, 21.01) < 0.05);
  for (const [feel, ceiling] of [[22,96], [23,92], [25,84], [31,60]]) {
    assert.equal(f.scoreHour(c, hourAt(20, { apparentTemp: feel, hour: 10, sunOnWall: false })), ceiling);
    const d = dayFor(f, c, 20);
    d.climbTemps.temperatureSamples.forEach(h => { h.apparent = feel; h.solarFraction = 0; });
    const result = f.scoreDay(c, d, null, null);
    assert.ok(result.score <= ceiling);
    assert.ok(result.contributions.some(x => x.label === 'Feels-like heat' && x.delta < 0));
  }
  assert.equal(f.feelsLikeHeatPenalty(c, null), 0);
  assert.equal(f.feelsLikeHeatPenalty(c, NaN), 0);
});

test('light relief is explicit, remains penalised and steepens beyond 26', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const cs = await loadCrags('worker/src/lib/crags.js');
  const light = cs.filter(c => c.warmWeatherRelief === 'light');
  assert.equal(light.length, 11);
  for (const c of light) {
    assert.equal(f.feelsLikeHeatPenalty(c, 23, 10), 3, c.id);
    assert.equal(f.feelsLikeHeatPenalty(c, 26, 10), 7.5, c.id);
    assert.equal(f.feelsLikeHeatPenalty(c, 27, 10), 11.5, c.id);
    assert.ok(f.scoreHour(c, hourAt(23, { hour: 10 })) <= 97);
  }
  for (const id of ['arap-cgleft', 'bluemtns-thefreezer', 'bluemtns-bellsupercrag',
    'sand-river-colosseum-cave', 'gramps-hollowmtn', 'westside-main']) {
    assert.equal(f.feelsLikeHeatPenalty(cs.find(c => c.id === id), 23, 10), 8, id);
  }
});

test('West Flank relief is morning-only in hourly and daily calculations', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const c = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'gramps-westflank');
  const morning = f.scoreHour(c, hourAt(23, { hour: 11, sunOnWall: false }));
  const afternoon = f.scoreHour(c, hourAt(23, { hour: 12, sunOnWall: false }));
  assert.equal(morning, 97);
  assert.equal(afternoon, 92);
  assert.equal(f.scoreHour(c, hourAt(23, { sunOnWall: false })), afternoon,
    'unknown time must not grant morning relief');
  const d = dayFor(f, c, 23);
  assert.deepEqual(Array.from(d.climbTemps.temperatureSamples, x => x.hour),
    Array.from({ length: 12 }, (_, i) => i + 8));
  const result = f.scoreDay(c, d, null, null);
  const expected = (4 * 3 + 8 * 8) / 12;
  const entry = result.contributions.find(x => x.label === 'Feels-like heat');
  assert.equal(entry.delta, -Math.round(expected));
  assert.ok(result.score <= Math.floor(100 - expected));
  delete d.climbTemps;
  const fallback = f.scoreDay(c, d, null, null);
  assert.equal(fallback.contributions.find(x => x.label === 'Feels-like heat').delta, -8);
});

test('Boronia evening relief starts at 17, preserves air limits and averages by hour', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const c = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'bluemtns-boronia');
  assert.deepEqual(Array.from(c.idealTemp), [10, 20]);
  assert.equal(c.heatCap, 23);
  for (const hour of [undefined, null, NaN, -1, 24, 16, 16.99]) {
    assert.equal(f.feelsLikeHeatPenalty(c, 23, hour), 8);
  }
  for (const hour of [17, 18, 23]) {
    assert.equal(f.scoreHour(c, hourAt(20, { apparentTemp: 23, hour, sunOnWall: false })), 97);
    // Air heat above the existing ideal ceiling is stronger than light relief.
    assert.equal(f.scoreHour(c, hourAt(23, { hour, sunOnWall: false })), 88);
  }
  assert.equal(f.scoreHour(c, hourAt(20, { apparentTemp: 23, hour: 16, sunOnWall: false })), 92);
  const d = dayFor(f, c, 20);
  d.climbTemps.temperatureSamples.forEach(s => { s.apparent = 23; s.solarFraction = 0; });
  const result = f.scoreDay(c, d, null, null);
  const expected = (9 * 8 + 3 * 3) / 12;
  assert.equal(result.contributions.find(x => x.label === 'Feels-like heat').delta, -Math.round(expected));
  assert.ok(result.score <= Math.floor(100 - expected));
  delete d.climbTemps;
  d.tFeel = 23;
  assert.equal(f.scoreDay(c, d, null, null).contributions.find(x => x.label === 'Feels-like heat').delta, -8);
});

test('new heat windows apply only to their own hours in hourly and daily scoring', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const cs = await loadCrags('worker/src/lib/crags.js');
  for (const [id, start] of [['bluemtns-thefreezer', 12], ['gramps-tribute-lower', 16], ['bluemtns-bell-sunny', 17]]) {
    const c = cs.find(c => c.id === id);
    assert.equal(f.scoreHour(c, hourAt(20, { apparentTemp: 23, hour: start - 1, sunOnWall: false })), 92, id);
    assert.equal(f.scoreHour(c, hourAt(20, { apparentTemp: 23, hour: start, sunOnWall: false })), 97, id);
    for (const hour of [undefined, null, NaN, -1, 24]) assert.equal(f.feelsLikeHeatPenalty(c, 23, hour), 8, id);
    const d = dayFor(f, c, 20);
    d.climbTemps.temperatureSamples.forEach(s => { s.apparent = 23; s.solarFraction = 0; });
    const expected = ((start - 8) * 8 + (20 - start) * 3) / 12;
    const result = f.scoreDay(c, d, null, null);
    assert.equal(result.contributions.find(x => x.label === 'Feels-like heat').delta, -Math.round(expected), id);
    assert.ok(result.score <= Math.floor(100 - expected), id);
    // Relief cannot remove this sector's original air-temperature limit.
    const air = c.idealTemp[1] + 2;
    const heat = f.heatPenalty(c, air, 0).ambient;
    assert.ok(f.scoreHour(c, hourAt(air, { apparentTemp: 23, hour: start, sunOnWall: false })) <= Math.floor(100 - 8 - heat), id);
  }
  assert.equal(f.feelsLikeHeatPenalty(cs.find(c => c.id === 'bluemtns-bell-shady'), 23, 10), 3);
  for (const id of ['bluemtns-bellsupercrag', 'gramps-tribute', 'gramps-tribute-upper']) {
    assert.equal(f.feelsLikeHeatPenalty(cs.find(c => c.id === id), 23, 18), 8, id);
  }
});

test('air and feels-like heat overlap once while sun and wind penalties persist', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const c = { idealTemp: [10, 24], heatCap: 24, shade: 'mixed', lat: -37, lon: 144 };
  // 25 air: 4 distance + 1.5 ambient. 25 feel: 16. Total heat is 16, not 21.5.
  assert.equal(f.scoreHour(c, hourAt(25, { apparentTemp: 25, sunOnWall: false })), 84);
  const sunny = f.scoreHour(c, hourAt(25, { apparentTemp: 25, sunOnWall: true }));
  assert.ok(sunny < 84);
  assert.ok(f.scoreHour(c, hourAt(25, { apparentTemp: 25, sunOnWall: false, wind: 60 })) < 84);
  const d = dayFor(f, c, 25);
  d.climbTemps.temperatureSamples.forEach(h => { h.solarFraction = 0; });
  const entries = f.scoreDay(c, d, null, null).contributions;
  assert.equal(entries.find(x => x.label === 'Feels-like heat').delta, Math.round(-10.5));
});

test('brief feels-like heat is averaged per hour and does not cancel against cool hours', async () => {
  const f = await loadForecast('worker/src/lib/forecast.js');
  const c = { idealTemp: [10, 30], shade: 'all-day', lat: -37, lon: 144, trip: 'both' };
  const mixed = dayFor(f, c, 20);
  mixed.climbTemps.temperatureSamples.forEach((s,i) => { s.apparent = i < 6 ? 26 : 16; });
  const sustained = dayFor(f, c, 26);
  const m = f.scoreDay(c, mixed, null, null);
  const all = f.scoreDay(c, sustained, null, null);
  assert.equal(m.contributions.find(x => x.label === 'Feels-like heat').delta, -10);
  assert.equal(all.contributions.find(x => x.label === 'Feels-like heat').delta, -20);
  assert.ok(m.score > all.score);
});

test('Falcons Lookout allows 18C peak performance and 20C cragging', async () => {
  const { forecasts: f } = await loadWorker();
  const crags = await loadCrags('worker/src/lib/crags.js');
  const crag = crags.find(c => c.id === 'falcons-lookout');
  assert.deepEqual(Array.from(crag.idealTemp), [8, 20]);
  assert.equal(f.peakTemperatureUpper(crag), 18);
  assert.equal(f.temperaturePenalty(crag, 18, 18, 12), 0);
  assert.ok(f.temperaturePenalty(crag, 18.1, 18.1, 12) > 0);
  assert.equal(f.heatPenalty(crag, 20, 1).ambient, 0);
  assert.equal(f.heatPenalty(crag, 20, 1).solar, 0);
  assert.ok(f.heatPenalty(crag, 20.1, 1).ambient > 0);
  assert.ok(f.scoreHour(crag, hourAt(19)) <= 90);
  const daily = f.scoreDay(crag, dayFor(f, crag, 19));
  assert.ok(daily.score <= 90);
  for (const other of crags.filter(c => c.id !== crag.id)) {
    const [lo, hi] = other.idealTemp;
    const relief = other.warmWeatherRelief === 'light' || other.shade === 'all-day' || other.heatExposure === 'sheltered';
    assert.equal(f.peakTemperatureUpper(other), Math.min(hi, Math.max(16, lo + 6) + (relief ? 2 : 0)), other.id);
  }
});

test('The Balcony retains hot-weather relief throughout its shaded day', async () => {
  const { forecasts: f } = await loadWorker();
  const crag = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'cathedral-balcony');
  assert.equal(crag.shade, 'all-day');
  assert.equal(crag.warmWeatherRelief, 'light');
  for (const hour of [8, 12, 16]) {
    assert.ok(f.feelsLikeHeatPenalty(crag, 24, hour) < f.feelsLikeHeatPenalty({ ...crag, warmWeatherRelief: undefined }, 24, hour));
  }
});
