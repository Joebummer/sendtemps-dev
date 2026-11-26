const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker, withoutForecastAge } = require('./helpers.cjs');
const { loadCrags, validateCrags } = require('../scripts/validate-crags.cjs');

test('session scoring keeps cool mornings independent of hot afternoons', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      forecast.hourly.time.forEach((iso, i) => {
        const h = Number(iso.slice(11, 13));
        forecast.hourly.temperature_2m[i] = h < 12 ? 12 : 28;
        forecast.hourly.apparent_temperature[i] = h < 12 ? 12 : 28;
      });
    }
    return Response.json(data);
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('NSW');
  const fc = forecasts['westside-main'];
  for (const date of [fc.tomorrowDate, '2026-09-15']) {
    const row = harness.forecasts.rankByDay(forecasts, [date])[date]
      .find(r => r.crag.id === 'westside-main');
    assert.equal(row.scoreBasis, 'best-hourly-window');
    assert.equal(row.scoreWindow.start, 7);
    assert.equal(row.scoreWindow.end, 12);
    assert.equal(row.day.climbTemps.meanTemp, 12);
    assert.equal(row.score, Math.round(fc.bestWindows[date].avg));
    assert.ok(row.score > 90, 'an ideal cool session escapes the afternoon heat cap');
    assert.ok(row.reasons.some(r => r.startsWith('temp ideal')));
    assert.ok(!row.reasons.some(r => /too warm|temp varies|hot \(/.test(r)));
    assert.ok(!row.contributions.some(c => c.category === 'temp' && c.delta < 0));
  }
});

test('days 1–3 use sessions and days 4–8 use daily estimates with trip and parent consistency', async () => {
  let calls = 0;
  const harness = await loadWorker(async url => { calls++; return Response.json(weatherFixture(url)); });
  const response = await harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=NSW&tripStart=2026-09-13&tripEnd=2026-09-22'), {}, harness.ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls, 1, 'all ten days reuse the one batched weather request');
  for (const [dayIndex, date] of body.dates.entries()) {
    const rows = body.byDate[date];
    for (const row of rows) {
      if (row.contributions.some(c => c.category === 'closure')) {
        assert.equal(row.scoreBasis, 'closure');
        continue;
      }
      if (dayIndex >= 3 && dayIndex <= 7) {
        assert.equal(row.scoreBasis, 'daily-estimate', `${row.cragId} ${date}`);
        assert.equal(row.scoreWindow, null);
        assert.ok(!row.contributions.some(c => c.category === 'window'));
        assert.ok(row.day.climbTemps.climbHours > 5);
      } else {
        assert.equal(row.scoreBasis, 'best-hourly-window', `${row.cragId} ${date}`);
        assert.equal(row.scoreWindow.hours, 5);
        assert.equal(row.scoreWindow.end - row.scoreWindow.start, 5);
        assert.equal(row.scoreWindow.average, row.score);
        assert.equal(row.scoreWindow.provisional, dayIndex > 1);
        assert.equal(row.day.climbTemps.climbHours, 5);
      }
      if (row.bestSubcragId) {
        const child = rows.find(r => r.cragId === row.bestSubcragId);
        for (const key of ['score', 'scoreWindow', 'reasons', 'day']) assert.deepEqual(row[key], child[key]);
      }
    }
  }
  for (const trip of body.weekendTrip) {
    const scores = trip.dailyScores.map(d => {
      assert.equal(d.score, body.byDate[d.date].find(r => r.cragId === trip.cragId).score);
      return d.score;
    }).sort((a, b) => a - b);
    const median = scores.length % 2 ? scores[(scores.length - 1) / 2]
      : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2;
    assert.equal(trip.tripScore, Math.round(0.5 * scores[0] + 0.3 * scores.reduce((a, b) => a + b, 0) / scores.length + 0.2 * median));
  }
});

test('days 4–8 keep daily rain penalties even with a dry five-hour morning or stored window', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      forecast.hourly.time.forEach((iso, i) => {
        if (iso.startsWith('2026-09-16') && Number(iso.slice(11, 13)) >= 13 && Number(iso.slice(11, 13)) < 19) {
          forecast.hourly.precipitation[i] = 1.02;
          forecast.hourly.precipitation_probability[i] = 81;
          forecast.hourly.weathercode[i] = 80;
        }
      });
      const di = forecast.daily.time.indexOf('2026-09-16');
      forecast.daily.precipitation_sum[di] = 6.12;
      forecast.daily.precipitation_probability_max[di] = 81;
      forecast.daily.precipitation_hours[di] = 6;
      forecast.daily.weathercode[di] = 80;
    }
    return Response.json(data);
  });
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['camels-hump'];
  // Single-date and out-of-order queries must use the horizon from today,
  // rather than the position in the requested list (or the past-weather list).
  for (const date of ['2026-09-20', '2026-09-16', '2026-09-17']) {
    assert.equal(fc.bestWindows[date], undefined);
    fc.bestWindows[date] = { ...fc.tomorrowBestWindow, avg: 100 };
    const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [date])[date][0];
    const di = fc.days.findIndex(day => day.date === date);
    const expected = harness.forecasts.scoreDay(fc.crag, fc.days[di], fc.days[di - 1], fc.days[di + 1]);
    assert.equal(row.scoreBasis, 'daily-estimate');
    assert.equal(row.score, expected.score);
    assert.deepEqual(row.day, fc.days[di]);
    assert.deepEqual(row.reasons, expected.reasons);
    assert.deepEqual(row.contributions, expected.contributions);
    assert.equal(row.scoreWindow, null);
    if (date === '2026-09-16') {
      assert.equal(row.day.precipProb, 81);
      assert.equal(row.day.precipSum, 6.12);
      assert.ok(row.score < Math.round(fc.tomorrowBestWindow.avg), 'daily rain cannot be hidden by a dry morning');
      assert.ok(row.contributions.some(c => c.category === 'precip' && c.delta < 0));
    }
  }
  for (const date of ['2026-09-14', '2026-09-15', '2026-09-21']) {
    const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [date])[date][0];
    assert.equal(row.scoreBasis, 'best-hourly-window');
    assert.equal(row.score, Math.round(fc.bestWindows[date].avg));
  }
  fc.crag = { ...fc.crag, closedAll: true };
  for (const date of ['2026-09-15', '2026-09-16']) {
    const closed = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [date])[date][0];
    assert.equal(closed.scoreBasis, 'closure');
    assert.equal(closed.score, 0);
  }
});

test('session scoring falls back when future hourly fields are null or insufficient', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      forecast.hourly.time.forEach((iso, i) => {
        if (iso === '2026-09-14T09:00') forecast.hourly.temperature_2m[i] = null;
        if (iso.startsWith('2026-09-15') || iso.startsWith('2026-09-21')) forecast.hourly.precipitation[i] = null;
        if (iso.startsWith('2026-09-22') && ![7, 8, 9, 10].includes(Number(iso.slice(11, 13))))
          forecast.hourly.temperature_2m[i] = null;
      });
    }
    return Response.json(data);
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('NSW');
  for (const date of ['2026-09-15', '2026-09-21', '2026-09-22']) {
    const rows = harness.forecasts.rankByDay(forecasts, [date])[date];
    for (const row of rows) {
      assert.ok(Number.isFinite(row.score));
      if (row.contributions.some(c => c.category === 'closure')) continue;
      assert.equal(row.scoreBasis, 'daily-estimate-no-hourly-data');
      assert.equal(row.scoreWindow, null);
    }
  }
  const fc = forecasts['westside-main'];
  assert.ok(fc.tomorrowHourly.every(h => Number.isFinite(h.score)));
  assert.ok(!fc.tomorrowHourly.some(h => h.hour === 9), 'a missing hour is omitted without breaking numeric native scores');
  assert.equal(fc.tomorrowBestWindow.count, 5);
  assert.equal(fc.tomorrowBestWindow.end - fc.tomorrowBestWindow.start, 5);
  fc.crag = { ...fc.crag, closedAll: true };
  assert.equal(harness.forecasts.rankByDay({ [fc.crag.id]: fc }, ['2026-09-22'])['2026-09-22'][0].scoreBasis, 'closure');
});

test('session scoring rejects gaps and keeps temperature ceilings tied to the selected hours', async () => {
  const { bestWindow } = (await loadWorker()).forecasts;
  const gap = [7, 8, 9, 10, 12, 13].map(hour => ({ hour, score: 100 }));
  assert.equal(bestWindow(gap, null, 5), null);
  assert.equal(bestWindow([{ hour: 7, score: null }]), null);
  assert.equal(bestWindow([7, 8, 9, 10].map(hour => ({ hour, score: 100 })), null, 5), null);
  const crag = { idealTemp: [10, 19], peakTempMax: 18, trip: 'both', discipline: 'sport' };
  const window = temp => bestWindow([7, 8, 9, 10, 11].map(hour => ({
    hour, score: 100, temp, apparentTemp: temp,
  })), crag, 5);
  assert.equal(window(12).avg, 100);
  assert.equal(window(18.4).avg, 98);
  assert.equal(window(18.4).temperatureCap, 98);
  assert.equal(window(19).avg, 90);
  assert.equal(window(19).hourlyAvg, 100);
});

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

test('best window excludes 6am while preserving it in the hourly strip', async () => {
  const harness = await loadWorker();
  const bestWindow = harness.forecasts.bestWindow;
  const hours = [
    { score: 100, hour: 6 },
    { score: 20, hour: 7 },
    { score: 30, hour: 8 },
    { score: 40, hour: 9 },
    { score: 50, hour: 10 },
    { score: 60, hour: 11 },
    { score: 10, hour: 12 },
  ];

  const window = bestWindow(hours);
  assert.equal(hours[0].hour, 6, 'the display source still includes 6am');
  assert.equal(window.count, 5);
  assert.equal(window.start, 7);
  assert.equal(window.end, 12);
  assert.deepEqual(window.hours.map(hour => hour.hour), [7, 8, 9, 10, 11]);
  assert.equal(window.avg, 40);
});

test('Falcons Lookout uses its faster conglomerate recovery without sandstone warnings', async () => {
  const harness = await loadWorker();
  const crags = await loadCrags('worker/src/lib/crags.js');
  const falcons = crags.find(c => c.id === 'falcons-lookout');
  assert.ok(falcons);
  assert.equal(falcons.rockType, 'conglomerate');
  assert.equal(harness.forecasts.rainRecoveryHours(falcons, 5), 5);
  assert.equal(harness.forecasts.rainRecoveryHours({ rockType: 'conglomerate' }, 5), 14);
  assert.equal(harness.forecasts.wetRockCondition(falcons, {
    precip: 0, rainEventMm: 5, hoursSinceRain: 7,
  }).cap, 100);
  assert.ok(harness.forecasts.wetRockCondition({ rockType: 'conglomerate' }, {
    precip: 0, rainEventMm: 5, hoursSinceRain: 11,
  }).cap < 100);

  const wetHarness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      const index = forecast.hourly.time.indexOf('2026-09-14T07:00');
      forecast.hourly.precipitation[index] = 10;
    }
    return Response.json(data);
  });
  const fc = (await wetHarness.forecasts.fetchAllForecasts('VIC'))['falcons-lookout'];
  const day = fc.days.find(d => d.date === '2026-09-14');
  assert.equal(day.rockReadiness.status, 'drying', 'the best daylight session still includes recovery after heavy dawn rain');
  assert.match(day.rockReadiness.label, /Conglomerate drying/);
  assert.doesNotMatch(day.rockReadiness.advisory, /sandstone/i);
});

test('Falcons Lookout dries after rain in overcast conditions', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const { hourly } of data) {
      hourly.cloudcover.fill(100);
      hourly.shortwave_radiation.fill(0);
      hourly.precipitation[hourly.time.indexOf('2026-09-14T07:00')] = 2;
    }
    return Response.json(data);
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('VIC');
  const falcons = forecasts['falcons-lookout'];
  const byHour = hour => falcons.tomorrowHourly.find(cell => cell.hour === hour);
  assert.equal(byHour(7).wetRockCondition.cap, 20);
  assert.ok(byHour(10).wetRockCondition);
  assert.equal(byHour(11).wetRockCondition, undefined);
  assert.ok(byHour(18).dryness >= 88);
});

test('Falcons Lookout sheds substantial rain overnight even under overcast skies', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const { hourly } of data) {
      hourly.cloudcover.fill(100);
      hourly.shortwave_radiation.fill(0);
      hourly.relative_humidity_2m.fill(86);
      const rain = hourly.time.indexOf('2026-09-13T20:00');
      hourly.precipitation[rain] = 6.9;
    }
    return Response.json(data);
  });
  const falcons = (await harness.forecasts.fetchAllForecasts('VIC'))['falcons-lookout'];
  const morning = falcons.tomorrowHourly.find(h => h.hour === 8);
  assert.ok(morning.dryness >= 85);
  assert.equal(morning.wetRockCondition, undefined);
});

test('rain recovery exempts sandstone events below 1 mm and scales heavier rain by rock type', async () => {
  const harness = await loadWorker();
  const recovery = harness.forecasts.rainRecoveryHours;

  assert.equal(recovery({ rockType: 'granite' }, 0.1), 1);
  assert.equal(recovery({ rockType: 'granite' }, 0.5), 2);
  assert.equal(recovery({ rockType: 'granite' }, 2), 4);
  assert.equal(recovery({ rockType: 'sandstone' }, 0.05), 0);
  assert.equal(recovery({ rockType: 'sandstone' }, 0.1), 0);
  assert.equal(recovery({ rockType: 'sandstone (soft)' }, 0.1), 0);
  for (const mm of [0.11, 0.2, 0.5, 0.9, 0.99]) {
    assert.equal(recovery({ rockType: 'sandstone' }, mm), 0, `${mm} mm stays exempt`);
  }
  const accumulated = Array(10).fill(0.1).reduce((sum, mm) => sum + mm, 0);
  assert.equal(recovery({ rockType: 'sandstone' }, accumulated), 7);
  assert.equal(recovery({ rockType: 'sandstone' }, 1), 7);
  assert.equal(recovery({ rockType: 'sandstone' }, 2), 9);
  assert.equal(recovery({ rockType: 'sandstone' }, 5), 14);
  assert.equal(recovery({ rockType: 'sandstone' }, 5.1), 14);
  assert.equal(recovery({ rockType: 'sandstone' }, 10), 21);
  assert.equal(recovery({ rockType: 'sandstone' }, 20), 27);
  assert.equal(recovery({ rockType: 'sandstone (soft)' }, 0.5), 0);
});

test('exposed sandstone has shorter provisional recovery, while sheltered rock stays conservative', async () => {
  const { rainRecoveryHours, wetRockCondition } = (await loadWorker()).forecasts;
  const exposed = { rockType: 'sandstone', dryRating: 5 };
  const typical = { rockType: 'sandstone', dryRating: 3 };
  const sheltered = { rockType: 'sandstone', dryRating: 2 };
  for (const [rain, oldHours, fastHours, typicalHours] of [
    [1, 7, 6, 7], [5, 14, 11, 13], [10, 21, 17, 19],
  ]) {
    assert.equal(rainRecoveryHours(exposed, rain), fastHours);
    assert.equal(rainRecoveryHours(typical, rain), typicalHours);
    assert.equal(rainRecoveryHours(sheltered, rain), oldHours);
    assert.equal(wetRockCondition(exposed, { precip: rain, rainEventMm: rain,
      currentEventMm: rain, recoveryProgressHours: 0 }).cap, 0,
      'active substantial rain must remain unsafe');
    assert.equal(wetRockCondition(exposed, { precip: 0, rainEventMm: rain,
      recoveryProgressHours: fastHours }).cap, 100);
    assert.ok(wetRockCondition(exposed, { precip: 0, rainEventMm: rain,
      recoveryProgressHours: fastHours / 2 }).cap <= 90);
  }
});

test('daily API exposes weather quality separately from sandstone rock-readiness', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      const index = forecast.hourly.time.indexOf('2026-09-14T08:00');
      forecast.hourly.precipitation[index] = 5;
    }
    return Response.json(data);
  });
  const forecast = (await harness.forecasts.fetchAllForecasts('VIC'))['gramps-westflank'];
  const recovering = forecast.days.find(d => d.date === '2026-09-14');
  assert.ok(recovering.rockReadiness);
  assert.match(recovering.rockReadiness.advisory, /Do not climb sandstone/);
  const row = harness.forecasts.rankByDay(
    { [forecast.crag.id]: forecast }, ['2026-09-14'])['2026-09-14'][0];
  assert.ok(Number.isFinite(row.weatherScore));
  assert.equal(row.weatherScoreBasis, 'best-hourly-window');
  assert.ok(['wet', 'drying', 'forecast-dry'].includes(row.rockReadiness.status));
  assert.equal(row.rockReadiness.status, recovering.rockReadiness.status);
  assert.ok(row.score <= 100);
});

test('substantial rain recovery eases once exposed, fast-drying rock has dried', async () => {
  const { wetRockCondition } = (await loadWorker()).forecasts;
  const exposed = { rockType: 'granite', dryRating: 4 };
  const morning = { precip: 0, hoursSinceRain: 9, rainEventMm: 6.9, dryness: 95 };
  assert.equal(wetRockCondition(exposed, morning).cap, 97);
  assert.equal(wetRockCondition({ ...exposed, heatExposure: 'sheltered' }, morning).cap, 90);
  assert.equal(wetRockCondition(exposed, { ...morning, dryness: 65 }).cap, 90);
  assert.equal(wetRockCondition(exposed, { ...morning, precip: 0.1 }).cap, 60);
});

test('Cathedral sandstone earns partial drying credit on a dry, overcast night', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const { hourly } of data) {
      hourly.cloudcover.fill(100);
      hourly.shortwave_radiation.fill(0);
      const rain = hourly.time.indexOf('2026-09-13T20:00');
      hourly.precipitation[rain] = 3;
    }
    return Response.json(data);
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('VIC');
  const overnight = id => {
    const forecast = forecasts[id];
    return forecast.drynessSeries[forecast.hourly.time.indexOf('2026-09-14T06:00')];
  };
  assert.equal(overnight('cathedral-balcony').recoveryProgressHours, 5);
  assert.equal(overnight('gramps-westflank').recoveryProgressHours, 0);
  assert.equal(forecasts['cathedral-balcony'].tomorrowHourly.find(h => h.hour === 6)
    .wetRockCondition.label, 'sandstone drying after rain');
});

test('light rain lifts the post-rain ceiling only on fast-drying rock', async () => {
  const { wetRockCondition } = (await loadWorker()).forecasts;
  const granite = { rockType: 'granite' };
  const conglomerate = { rockType: 'conglomerate' };
  const recovery = (crag, mm, hours) => wetRockCondition(crag, {
    precip: 0, rainEventMm: mm, hoursSinceRain: hours,
  }).cap;
  assert.equal(recovery(granite, 0.5, 1), 93);
  assert.equal(recovery(granite, 0.5, 2), 99);
  assert.equal(recovery(granite, 0.5, 3), 100);
  assert.equal(recovery(granite, 1, 3), 96);
  assert.equal(recovery(granite, 2, 5), 100);
  assert.equal(recovery(conglomerate, 0.5, 5), 100);
  assert.equal(recovery({ ...conglomerate, dryingHalfLifeHours: 8 }, 0.5, 4), 99);
});

test('wet-rock caps distinguish fresh sandstone from fast-drying granite', async () => {
  const harness = await loadWorker();
  const condition = harness.forecasts.wetRockCondition;
  const sandstone = { rockType: 'sandstone' };
  const granite = { rockType: 'granite' };

  assert.equal(condition(sandstone, { precip: 0.1, rainEventMm: 0.1 }).cap, 100);
  for (const mm of [0.2, 0.5, 0.99]) {
    assert.equal(condition(sandstone, { precip: mm, rainEventMm: mm }).cap, 100);
  }
  assert.equal(condition(sandstone, { precip: 1, rainEventMm: 1 }).cap, 0);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 8, recoveryProgressHours: 0, rainEventMm: 0.1,
  }).cap, 100);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 0, recoveryProgressHours: 0, rainEventMm: 1,
  }).cap, 25);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 8, recoveryProgressHours: 1, rainEventMm: 1,
  }).cap, 50);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 2, recoveryProgressHours: 2, rainEventMm: 0.1,
  }).cap, 100);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 8, recoveryProgressHours: 8, rainEventMm: 1,
  }).cap, 100);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 9, recoveryProgressHours: 9, rainEventMm: 1,
  }).cap, 100);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 20, recoveryProgressHours: 17, rainEventMm: 5,
  }).cap, 100);
  assert.equal(condition(sandstone, {
    precip: 0, hoursSinceRain: 21, recoveryProgressHours: 18, rainEventMm: 5,
  }).cap, 100);

  assert.equal(condition(granite, { precip: 0.1, rainEventMm: 0.1 }).cap, 60);
  assert.equal(condition(granite, { precip: 0, hoursSinceRain: 1, rainEventMm: 0.1 }).cap, 99);
  assert.equal(condition(granite, { precip: 0, hoursSinceRain: 2, rainEventMm: 0.1 }).cap, 100);
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

test('hourly rain retains probability risk when drizzle or heavier rain is added', async () => {
  const { scoreHour } = (await loadWorker()).forecasts;
  const crag = { rockType: 'granite', idealTemp: [8, 20], aspect: 'NW', discipline: 'routes' };
  for (const probability of [0, 31, 61, 87, 100]) {
    const hour = { hour: 10, temp: 14, apparentTemp: 14, wind: 10, humidity: 80,
      precipProb: probability, cloud: 100, dryness: 30, sunOnWall: false,
      rainEventMm: 54, currentEventMm: 54, hoursSinceRain: 3, recoveryProgressHours: 3 };
    const scores = [0, 0.05, 0.2, 0.3, 1, 1.1, 5].map(precip =>
      scoreHour(crag, { ...hour, precip }, 4, probability, 100));
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] <= scores[i - 1],
      `${probability}% risk: increasing rain must not improve ${scores}`);
  }
});

test('hourly rain intensity is continuous at the old thresholds and remains severity-sensitive', async () => {
  const { scoreHour } = (await loadWorker()).forecasts;
  const crag = { rockType: 'trachyte', idealTemp: [8, 22], aspect: 'mixed' };
  const hour = { hour: 13, temp: 14, apparentTemp: 14, wind: 15, humidity: 98,
    precipProb: 92, cloud: 100, dryness: 30, sunOnWall: null,
    wetRockCondition: { cap: 60 }, // Hold rock state fixed to isolate rain intensity.
    rainEventMm: 10, currentEventMm: 10, hoursSinceRain: 0, recoveryProgressHours: 0 };
  const score = precip => scoreHour(crag, { ...hour, precip }, 4, 98, 100);
  for (const boundary of [0.2, 1, 2, 5, 10]) {
    assert.ok(Math.abs(score(boundary - 0.001) - score(boundary + 0.001)) <= 1,
      `${boundary} mm/h must not create a scoring cliff`);
  }
  assert.ok(score(0.9) - score(1.2) <= 7, 'nearby shower amounts cannot create a 35-point jump');
  assert.ok(score(0.9) > score(1.2));
  assert.ok(score(1.2) > score(3.1), 'heavier rain still materially worsens conditions');
  const sequence = Array.from({ length: 201 }, (_, i) => score(i / 20));
  for (let i = 1; i < sequence.length; i++) assert.ok(sequence[i] <= sequence[i - 1]);
  assert.ok(score(5) <= 15, 'heavy rain remains poor');
});

test('rain probability and neighbouring rain risk have no cliffs or score reversals', async () => {
  const { scoreHour } = (await loadWorker()).forecasts;
  const crag = { idealTemp: [8, 22], rockType: 'granite', aspect: 'mixed' };
  const hour = { hour: 12, temp: 14, apparentTemp: 14, wind: 10, humidity: 50,
    precip: 0, dryness: 100, sunOnWall: null };
  for (const neighbours of [0, 0.5, 2, 4]) {
    const scores = Array.from({ length: 1001 }, (_, i) =>
      scoreHour(crag, { ...hour, precipProb: i / 10 }, neighbours, 100, 0));
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] <= scores[i - 1], 'rising probability cannot improve an hour');
      assert.ok(scores[i - 1] - scores[i] <= 1, 'probability changes have no scoring cliffs');
    }
  }
});

test('new drizzle cannot erase a stronger physical wetness deduction', async () => {
  const { scoreHour } = (await loadWorker()).forecasts;
  const crag = { idealTemp: [8, 22], rockType: 'trachyte', aspect: 'mixed' };
  for (const dryness of [20, 30, 60, 90]) {
    const hour = { hour: 12, temp: 14, apparentTemp: 14, wind: 10, humidity: 98,
      precipProb: 80, dryness, sunOnWall: null, rainEventMm: 0.2,
      currentEventMm: 0.2, hoursSinceRain: 6, recoveryProgressHours: 6 };
    assert.ok(scoreHour(crag, { ...hour, precip: 0.05, hoursSinceRain: 0,
      recoveryProgressHours: 0 }, 4, 98, 100) <= scoreHour(crag, { ...hour, precip: 0 }, 4, 98, 100));
  }
});

test('daily-estimate rain probability is continuous around 30 and 60 percent', async () => {
  const { scoreDay } = (await loadWorker()).forecasts;
  const crag = { idealTemp: [8, 22], rockType: 'granite', aspect: 'mixed' };
  const day = { date: '2026-11-30', tMax: 14, tMin: 10, tFeel: 14,
    precipSum: 0, precipHours: 0, wind: 5, sunshine: 0, dayDryness: 100 };
  const scores = Array.from({ length: 101 }, (_, precipProb) => scoreDay(crag, { ...day, precipProb }).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1]);
    assert.ok(scores[i - 1] - scores[i] <= 1);
  }
});

test('winter session selection respects daylight and short remaining days', async () => {
  const harness = await loadWorker(async url => Response.json(weatherFixture(url)));
  const f = harness.forecasts;
  const crag = { idealTemp: [8, 22], lat: -37.3947, lon: 144.5547, rockType: 'trachyte' };
  assert.equal(f.remainingDaylightHours(crag, '2026-06-21', 17), 0);
  assert.ok(f.remainingDaylightHours(crag, '2026-06-21', 15) < 5);
  const dark = [15, 16, 17, 18, 19].map(hour => ({ hour, score: 99, sunAlt: -10 }));
  assert.equal(f.bestWindow(dark, crag, 5), null);
  const fc = (await f.fetchAllForecasts('VIC'))['camels-hump'];
  for (const w of Object.values(fc.bestWindows).filter(Boolean)) {
    assert.ok(w.hours.every(h => h.daylight && h.sunAlt > 0));
  }
});

test('missing marine data is explicitly incomplete and cannot produce a good conditions score', async () => {
  const harness = await loadWorker(async url => new URL(url).hostname.includes('marine')
    ? new Response(null, { status: 503 }) : Response.json(weatherFixture(url)));
  const forecasts = await harness.forecasts.fetchAllForecasts('TAS');
  const fc = forecasts['fortescue-totem-pole'];
  const row = harness.forecasts.rankByDay(forecasts, [fc.tomorrowDate])[fc.tomorrowDate]
    .find(r => r.crag.id === fc.crag.id);
  assert.ok(row.score <= 64);
  assert.ok(row.reasons.includes('marine conditions unavailable'));
  assert.ok(fc.tomorrowHourly.every(h => h.marineCondition.availability === 'unavailable'));
  const calm = harness.forecasts.marineCondition(fc.crag, {
    waveHeight: 0, wavePeriod: 0, swellHeight: 0, swellPeriod: 0, wind: 0 });
  assert.equal(calm.availability, 'available', 'numeric zero is genuine calm data');
  assert.equal(calm.availabilityCap, 100);
  const partial = harness.forecasts.marineCondition(fc.crag, { waveHeight: 3, wind: 5 });
  assert.equal(partial.availability, 'partial');
  assert.ok(partial.cap <= 35, 'missing data cannot suppress an observed large swell');
});

test('interrupted windows disclose wet hours and the longest usable run', async () => {
  const f = (await loadWorker()).forecasts;
  const crag = { idealTemp: [8, 22], rockType: 'granite' };
  const hours = [7, 8, 9, 10, 11].map(hour => ({ hour, temp: 14, apparentTemp: 14,
    score: hour === 9 ? 20 : 90, precip: hour === 9 ? 2 : 0,
    precipProb: hour === 9 ? 90 : 10, dryness: 100, rainEventMm: 0 }));
  const w = f.bestWindow(hours, crag, 5);
  assert.equal(w.usability.interrupted, true);
  assert.equal(w.usability.wetHours, 1);
  assert.equal(w.usability.usableHours, 4);
  assert.equal(w.usability.longestUsableRun, 2);
  assert.match(w.usability.label, /Rain in 1\/5h/);
});

test('saved forecasts reselect only remaining daylight hours and disclose forecast age', async () => {
  const harness = await loadWorker(async url => Response.json(weatherFixture(url)));
  const request = new Request('https://api.test/forecast/scored?region=VIC');
  const response = await harness.worker.fetch(request, {}, harness.ctx);
  const initial = await response.json();
  await harness.flush();
  harness.setNow('2026-09-13T05:00:00Z'); // 3 pm Melbourne; use the original payload without refetching.
  const remaining = harness.forecasts.revalidateScoredToday(initial);
  for (const row of remaining.byDate['2026-09-13']) {
    if (row.scoreWindow) assert.ok(row.scoreWindow.start >= 15);
    assert.ok(remaining.today[row.cragId].todayHourly.every(h => h.hour >= 15));
    if (row.scoreWindow) assert.equal(100 + row.contributions.reduce((s, c) => s + c.delta, 0), row.score);
  }
  harness.setNow('2026-09-13T11:00:00Z'); // 9 pm: old morning windows must disappear.
  const night = harness.forecasts.revalidateScoredToday(initial);
  assert.ok(night.byDate['2026-09-13'].every(row => row.scoreWindow === null));
  assert.ok(night.byDate['2026-09-13'].filter(row => row.scoreBasis !== 'closure')
    .every(row => row.reasons.includes('No daylight window remaining')));
  assert.ok(initial.forecast.retrievedAt);
  assert.equal(initial.forecast.ageSeconds, 0);
});

test('a separate small granite shower retains unfinished heavy-rain recovery', async () => {
  const harness = await loadWorker(async url => {
    const forecasts = weatherFixture(url);
    for (const forecast of forecasts) {
      const at = hour => forecast.hourly.time.indexOf(`2026-09-14T${hour}:00`);
      forecast.hourly.precipitation[at('06')] = 54;
      forecast.hourly.precipitation[at('10')] = 0.2;
    }
    return Response.json(forecasts);
  });
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['youyangs-royaltywalls'];
  const at = hour => fc.tomorrowHourly.find(h => h.hour === hour);
  assert.equal(at(9).rainEventMm, 54);
  assert.equal(at(10).currentEventMm, 0.2, 'separate shower remains separately identifiable');
  assert.equal(at(10).rainEventMm, 54, 'unfinished heavy event is retained');
  assert.equal(at(10).recoveryProgressHours, 0, 'new moisture restarts recovery');
  assert.equal(at(11).wetRockCondition.recoveryHours, harness.forecasts.rainRecoveryHours(fc.crag, 54));
  assert.ok(at(11).wetRockCondition.cap < 90, 'one dry hour after drizzle cannot erase the heavy event');
});

test('Royalty Walls session explains actual rain, probabilities and hourly score without a window bonus', async () => {
  const harness = await loadWorker(async url => {
    const forecasts = weatherFixture(url);
    for (const forecast of forecasts) {
      forecast.hourly.time.forEach((iso, i) => {
        if (!iso.startsWith('2026-09-15')) return;
        const hour = Number(iso.slice(11, 13));
        forecast.hourly.temperature_2m[i] = hour < 12 ? 17.5 : 30;
        forecast.hourly.apparent_temperature[i] = hour < 12 ? 16 : 30;
        forecast.hourly.cloudcover[i] = 100;
        forecast.hourly.precipitation_probability[i] = hour < 7 ? 100 : hour < 12 ? [87, 80, 77, 75, 71][hour - 7] : 40;
        forecast.hourly.precipitation[i] = hour === 6 ? 31.7 : hour === 10 ? 0.2 : 0;
      });
      const di = forecast.daily.time.indexOf('2026-09-15');
      forecast.daily.precipitation_sum[di] = 31.9;
      forecast.daily.precipitation_probability_max[di] = 100;
    }
    return Response.json(forecasts);
  });
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['youyangs-royaltywalls'];
  const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, ['2026-09-15'])['2026-09-15'][0];
  assert.equal(row.scoreWindow.start, 7);
  assert.equal(row.scoreWindow.end, 12);
  assert.equal(row.day.climbRain.sum, 0.2);
  assert.equal(row.day.climbRain.peakProb, 87);
  assert.equal(row.day.climbRain.weightedProb, 78);
  assert.equal(row.score, Math.round(fc.bestWindows['2026-09-15'].hours.reduce((sum, h) => sum + h.score, 0) / 5));
  assert.equal(100 + row.contributions.reduce((sum, c) => sum + c.delta, 0), row.score);
  assert.ok(!row.contributions.some(c => c.category === 'window' || c.label === 'Sweet spot match' || c.label === 'Sunshine bonus'));
  assert.ok(row.contributions.filter(c => c.category === 'precip').every(c =>
    /0.2mm during 7:00–12:00/.test(c.detail) && /87% peak/.test(c.detail) && /78% average/.test(c.detail)));
  assert.match(row.contributions.find(c => c.label === 'Temperature').detail, /penalty above 16°C air/);
  assert.equal(row.weatherScoreBasis, 'best-hourly-window');
  const day = fc.days.find(d => d.date === '2026-09-15');
  assert.equal(day.climbRain.sum, 0.2, 'broader daily climbing hours exclude overnight rain exactly');
  assert.ok(day.climbRain.peakProb >= day.climbRain.weightedProb);
});

test('session breakdowns reconcile across all crags under mixed rain, heat, cold and marine limits', async () => {
  const harness = await loadWorker(async url => {
    const forecasts = fixtureForUrl(url, { wave_height: 3, swell_wave_height: 2.8 });
    for (const forecast of forecasts) {
      if (!forecast.daily) continue;
      forecast.hourly.time.forEach((iso, i) => {
        const hour = Number(iso.slice(11, 13));
        const day = Number(iso.slice(8, 10));
        const air = [-3, 12, 17.5, 23.7, 30][(hour + day) % 5];
        forecast.hourly.temperature_2m[i] = air;
        forecast.hourly.apparent_temperature[i] = air - 2.3;
        forecast.hourly.relative_humidity_2m[i] = [45, 80, 95][hour % 3];
        forecast.hourly.precipitation[i] = [0, 0, 0.2, 2, 0][(hour + day) % 5];
        forecast.hourly.precipitation_probability[i] = [10, 35, 75, 100][hour % 4];
        forecast.hourly.cloudcover[i] = [0, 40, 100][hour % 3];
      });
    }
    return Response.json(forecasts);
  });
  const forecasts = await harness.forecasts.fetchAllForecasts('ALL');
  const dates = ['2026-09-13', '2026-09-14', '2026-09-15'];
  const ranked = harness.forecasts.rankByDay(forecasts, dates);
  for (const date of dates) for (const row of ranked[date]) {
    if (row.scoreBasis !== 'best-hourly-window') continue;
    assert.equal(100 + row.contributions.reduce((sum, c) => sum + c.delta, 0), row.score,
      `${row.crag.id} ${date}: all actual factors and limits reconcile`);
    assert.ok(row.day.climbRain.peakProb >= row.day.climbRain.weightedProb);
    assert.ok(!row.contributions.some(c => c.category === 'window'));
    assert.equal(row.weatherScoreBasis, 'best-hourly-window');
    const fc = forecasts[row.bestSubcragId || row.crag.id];
    const marineLabels = fc.bestWindows[date]?.hours.map(h => h.marineCondition?.label).filter(Boolean) || [];
    if (marineLabels.includes('high swell')) assert.ok(row.reasons.includes('high swell'));
  }
});

function lightRainFixture(url) {
  const forecasts = weatherFixture(url);
  for (const forecast of forecasts) {
    for (const hour of [14, 15]) {
      const index = forecast.hourly.time.indexOf(`2026-09-14T${hour}:00`);
      forecast.hourly.precipitation[index] = 0.1;
      forecast.hourly.precipitation_probability[index] = 20;
      forecast.hourly.weathercode[index] = 51;
    }
    const dayIndex = forecast.daily.time.indexOf('2026-09-14');
    forecast.daily.precipitation_sum[dayIndex] = 0.2;
    forecast.daily.precipitation_probability_max[dayIndex] = 20;
    forecast.daily.precipitation_hours[dayIndex] = 2;
    forecast.daily.weathercode[dayIndex] = 51;
  }
  return forecasts;
}

function cathedralTraceFixture(url, mm = 0.1) {
  const forecasts = weatherFixture(url);
  for (const forecast of forecasts) {
    const rainIndex = forecast.hourly.time.indexOf('2026-09-14T12:00');
    forecast.hourly.precipitation[rainIndex] = mm;
    forecast.hourly.weathercode[rainIndex] = 51;
    const dayIndex = forecast.daily.time.indexOf('2026-09-14');
    forecast.daily.precipitation_sum[dayIndex] = mm;
    forecast.daily.weathercode[dayIndex] = 51;
  }
  return forecasts;
}

test('a noon 0.2 mm shower at Cathedral Ranges starts no sandstone cap or recovery clock', async () => {
  const harness = await loadWorker(async url => Response.json(cathedralTraceFixture(url, 0.2)));
  const cathedral = (await harness.forecasts.fetchAllForecasts('VIC'))['cathedral-main'];
  const byHour = hour => cathedral.tomorrowHourly.find(cell => cell.hour === hour);

  assert.equal(cathedral.days.find(day => day.date === '2026-09-14').precipSum, 0.2);
  for (const hour of [12, 13, 14, 15, 16]) {
    assert.ok(byHour(hour).score > 0, `a single trace must not zero ${hour}:00`);
    assert.equal(byHour(hour).wetRockCondition, undefined);
    const index = cathedral.hourly.time.indexOf(`2026-09-14T${hour}:00`);
    assert.equal(cathedral.drynessSeries[index].hoursSinceRain, null);
    assert.equal(cathedral.drynessSeries[index].recoveryProgressHours, null);
  }
});

test('nearby sandstone rain accumulates into a 1 mm event', async () => {
  const harness = await loadWorker(async url => {
    const forecasts = cathedralTraceFixture(url, 0.9);
    for (const f of forecasts) {
      f.hourly.precipitation[f.hourly.time.indexOf('2026-09-14T13:00')] = 0.1;
    }
    return Response.json(forecasts);
  });
  const cathedral = (await harness.forecasts.fetchAllForecasts('VIC'))['cathedral-main'];
  const byHour = hour => cathedral.tomorrowHourly.find(cell => cell.hour === hour);
  assert.ok(byHour(12).score > 0, 'the initial 0.9 mm remains exempt');
  assert.equal(byHour(13).score, 0, 'the combined 1 mm event triggers the cap');
  assert.equal(byHour(14).wetRockCondition.recoveryHours,
    harness.forecasts.rainRecoveryHours(cathedral.crag, 1));
});

test('an isolated trace cannot replace an unfinished heavier sandstone recovery', async () => {
  const harness = await loadWorker(async url => {
    const forecasts = cathedralTraceFixture(url);
    for (const f of forecasts) {
      f.hourly.precipitation[f.hourly.time.indexOf('2026-09-14T08:00')] = 1;
    }
    return Response.json(forecasts);
  });
  const cathedral = (await harness.forecasts.fetchAllForecasts('VIC'))['cathedral-main'];
  for (const hour of [12, 13]) {
    const index = cathedral.hourly.time.indexOf(`2026-09-14T${hour}:00`);
    assert.equal(cathedral.drynessSeries[index].rainEventMm, 1);
    const dryingHour = cathedral.tomorrowHourly.find(cell => cell.hour === hour);
    assert.ok(dryingHour.wetRockCondition, 'the heavier event remains in recovery');
    assert.ok(dryingHour.score <= dryingHour.wetRockCondition.cap);
  }
});

test('separate sandstone traces do not accumulate after more than two dry hours', async () => {
  const harness = await loadWorker(async url => {
    const forecasts = cathedralTraceFixture(url);
    for (const f of forecasts) {
      f.hourly.precipitation[f.hourly.time.indexOf('2026-09-14T16:00')] = 0.1;
    }
    return Response.json(forecasts);
  });
  const cathedral = (await harness.forecasts.fetchAllForecasts('VIC'))['cathedral-main'];
  for (const hour of [12, 16, 17]) {
    const cell = cathedral.tomorrowHourly.find(cell => cell.hour === hour);
    assert.ok(cell.score > 0);
    assert.equal(cell.wetRockCondition, undefined);
  }
});

function sandstoneRecoveryFixture(url) {
  const forecasts = weatherFixture(url);
  for (const forecast of forecasts) {
    for (let i = 0; i < forecast.hourly.time.length; i++) {
      const hour = Number(forecast.hourly.time[i].slice(11, 13));
      forecast.hourly.shortwave_radiation[i] = hour >= 7 && hour < 20 ? 300 : 0;
    }
    const rainIndex = forecast.hourly.time.indexOf('2026-09-13T18:00');
    forecast.hourly.precipitation[rainIndex] = 1;
    const drizzleIndex = forecast.hourly.time.indexOf('2026-09-13T20:00');
    forecast.hourly.precipitation[drizzleIndex] = 0.1;
    for (const hour of [7, 8]) {
      const index = forecast.hourly.time.indexOf(`2026-09-14T${String(hour).padStart(2, '0')}:00`);
      forecast.hourly.relative_humidity_2m[index] = 85;
    }
  }
  return forecasts;
}

test('destination weather, score and hourly strip use the same best-subcrag forecast', async () => {
  const harness = await loadWorker(async url => {
    const params = new URL(url).searchParams;
    const lats = params.get('latitude').split(',');
    const lons = params.get('longitude').split(',');
    const forecasts = weatherFixture(url).map((f, i) => {
      const copy = structuredClone(f);
      const mm = lats[i] === '-37.3667' && lons[i] === '145.7333' ? 0.1 : 0.2;
      copy.hourly.precipitation[copy.hourly.time.indexOf('2026-09-14T12:00')] = mm;
      copy.daily.precipitation_sum[copy.daily.time.indexOf('2026-09-14')] = mm;
      return copy;
    });
    return Response.json(forecasts);
  });
  const response = await harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=VIC'), {}, harness.ctx,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const rows = body.byDate['2026-09-14'];
  const parent = rows.find(r => r.cragId === 'cathedral-main');
  const best = rows.find(r => r.cragId === parent.bestSubcragId);
  assert.equal(parent.day.precipSum, 0.2, 'daily rain matches the selected subcrag');
  for (const key of ['day', 'prevDay', 'score', 'scoreBasis', 'scoreWindow', 'reasons', 'contributions']) {
    assert.deepEqual(parent[key], best[key], key);
  }
  assert.deepEqual(body.today[parent.cragId].tomorrowHourly, body.today[best.cragId].tomorrowHourly);
  assert.equal(body.today[parent.cragId].tomorrowHourly.find(h => h.hour === 12).precip, 0.2);
});

test('a destination closure cannot be replaced by open child conditions', async () => {
  const harness = await loadWorker(async url => Response.json(weatherFixture(url)));
  const forecasts = await harness.forecasts.fetchAllForecasts('VIC');
  forecasts['cathedral-main'].crag = { ...forecasts['cathedral-main'].crag, closedAll: true };
  const parent = harness.forecasts.rankByDay(forecasts, ['2026-09-14'])['2026-09-14']
    .find(row => row.crag.id === 'cathedral-main');
  assert.equal(parent.score, 0);
  assert.equal(parent.scoreBasis, 'closure');
  assert.equal(parent.bestSubcragId, undefined);
  assert.ok(parent.contributions.some(c => c.category === 'closure'));
});

test('sandstone recovery resets in drizzle and pauses overnight and in high humidity', async () => {
  const harness = await loadWorker(async url => Response.json(sandstoneRecoveryFixture(url)));
  const forecasts = await harness.forecasts.fetchAllForecasts('NSW');
  const westside = forecasts['westside-main'];
  const sample = iso => {
    const index = westside.hourly.time.indexOf(iso);
    return westside.drynessSeries[index].recoveryProgressHours;
  };

  assert.equal(sample('2026-09-13T18:00'), 0);
  assert.equal(sample('2026-09-13T19:00'), 1);
  assert.equal(sample('2026-09-13T20:00'), 0);
  assert.equal(sample('2026-09-14T06:00'), 0);
  assert.equal(sample('2026-09-14T07:00'), 0);
  assert.equal(sample('2026-09-14T08:00'), 0);
  assert.ok(sample('2026-09-14T09:00') > 0);
  for (const hour of [6, 7, 8]) {
    const cell = westside.tomorrowHourly.find(h => h.hour === hour);
    assert.ok(cell.wetRockCondition, 'recovery remains active');
    assert.equal(cell.wetRockCondition.cap, 25, 'no productive drying credit yet');
    assert.ok(cell.score <= 25);
  }
  const afternoon = westside.tomorrowHourly.find(hour => hour.hour === 14);
  assert.ok(afternoon.wetRockCondition, 'the heavier event still needs recovery');
  assert.ok(afternoon.score <= afternoon.wetRockCondition.cap);
});

test('isolated sub-1 mm shower does not restart a substantial sandstone recovery', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      forecast.hourly.precipitation[forecast.hourly.time.indexOf('2026-09-14T08:00')] = 5;
      forecast.hourly.precipitation[forecast.hourly.time.indexOf('2026-09-14T14:00')] = 0.2;
    }
    return Response.json(data);
  });
  const westside = (await harness.forecasts.fetchAllForecasts('NSW'))['westside-main'];
  const at = hour => westside.drynessSeries[westside.hourly.time.indexOf(
    `2026-09-14T${String(hour).padStart(2, '0')}:00`)];
  assert.equal(at(13).rainEventMm, 5);
  assert.ok(at(13).recoveryProgressHours > 0);
  assert.equal(at(14).rainEventMm, 5, 'new light shower does not extend the old rain total');
  assert.equal(at(14).recoveryProgressHours, at(13).recoveryProgressHours,
    'light rain pauses rather than resets effective drying progress');
  assert.equal(at(15).rainEventMm, 5);
  assert.ok(at(15).recoveryProgressHours >= at(14).recoveryProgressHours);
});

test('daily sandstone retains physical wetness when it is stronger than the recovery ceiling', async () => {
  const harness = await loadWorker();
  const crag = { ...harness.crags?.find?.(c => c.id === 'gramps-main'),
    id: 'test-sandstone', rockType: 'sandstone', idealTemp: [8, 22],
    aspect: 'mixed', shade: 'mixed', bestIn: 'mild', dryRating: 3 };
  const baseline = {
    date: '2026-09-16', tMax: 17, tMin: 10, tFeel: 17, precipSum: 0,
    precipProb: 0, precipHours: 0, wind: 8, sunshine: 20000,
    rainWindows: [], climbTemps: { climbHours: 0 }, morningDryness: 50,
    afternoonDryness: 50, dayDryness: 50, wetRockCap: 60,
  };
  const recovered = harness.forecasts.scoreDay(crag, baseline);
  const withoutCap = harness.forecasts.scoreDay(crag, { ...baseline, wetRockCap: 100 });
  assert.ok(recovered.contributions.some(c => c.label === 'Rock dryness'),
    'a recovery ceiling cannot erase a stronger physical wetness constraint');
  assert.ok(withoutCap.contributions.some(c => c.label === 'Rock dryness'),
    'physical dryness penalty remains when no recovery ceiling applies');
  assert.ok(recovered.score <= 60);
});

test('days 4–8 moderate shower penalty only for a safe dry period', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      for (const hour of [15, 16, 17]) {
        const i = forecast.hourly.time.indexOf(
          `2026-09-16T${String(hour).padStart(2, '0')}:00`);
        forecast.hourly.precipitation[i] = 0.5;
        forecast.hourly.precipitation_probability[i] = 75;
      }
      const di = forecast.daily.time.indexOf('2026-09-16');
      forecast.daily.precipitation_sum[di] = 1.5;
      forecast.daily.precipitation_probability_max[di] = 75;
      forecast.daily.precipitation_hours[di] = 3;
    }
    return Response.json(data);
  });
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['camels-hump'];
  const day = fc.days.find(d => d.date === '2026-09-16');
  assert.equal(day.longRangeDrySession, true);
  const withDrySession = harness.forecasts.scoreDay(fc.crag, day);
  const withoutDrySession = harness.forecasts.scoreDay(fc.crag, {
    ...day, longRangeDrySession: false,
  });
  assert.ok(withDrySession.score > withoutDrySession.score);
  assert.ok(withDrySession.contributions.some(c => c.label === 'Usable dry period'));
  assert.ok(withDrySession.contributions.some(c => c.category === 'precip' && c.delta < 0),
    'dry period never erases daily shower risk');
  const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, ['2026-09-16'])['2026-09-16'][0];
  assert.equal(row.scoreBasis, 'daily-estimate');
  assert.equal(row.scoreWindow, null);
});

test('0.2 mm events skip sandstone recovery while granite retains its dry-hour interval', async () => {
  const rainyHarness = await loadWorker(async url => Response.json(lightRainFixture(url)));
  const forecasts = await rainyHarness.forecasts.fetchAllForecasts('NSW');
  const westside = forecasts['westside-main'];
  const granite = forecasts['gara-gorge-main'];

  const westRain = westside.tomorrowHourly.find(hour => hour.hour === 15);
  const westFirstDry = westside.tomorrowHourly.find(hour => hour.hour === 16);
  assert.ok(westRain.score > 0);
  assert.ok(westFirstDry.score > 0);
  assert.equal(westRain.wetRockCondition, undefined);
  assert.equal(westFirstDry.wetRockCondition, undefined);

  const graniteFirstDry = granite.tomorrowHourly.find(hour => hour.hour === 16);
  const graniteRecovered = granite.tomorrowHourly.find(hour => hour.hour === 17);
  assert.equal(graniteFirstDry.wetRockCondition.recoveryHours, 1);
  assert.equal(graniteFirstDry.wetRockCondition.cap, 99);
  assert.ok(graniteFirstDry.score > 79 && graniteFirstDry.score <= 99);
  assert.equal(graniteRecovered.wetRockCondition, undefined);
  assert.ok(graniteRecovered.score >= 80);
});

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

test('destination hourly strips follow the subcrag selected for the headline', async () => {
  const harness = await loadWorker(async url => Response.json(fixtureForUrl(url)));
  const response = await harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=VIC'), {}, harness.ctx);
  assert.equal(response.status, 200);
  const body = await response.json();

  for (const parentId of ['gramps-main', 'buffalo-main']) {
    const todayRow = body.byDate[body.dates[0]].find(row => row.cragId === parentId);
    const tomorrowRow = body.byDate[body.dates[1]].find(row => row.cragId === parentId);
    assert.ok(todayRow.bestSubcragId, `${parentId} has a selected subcrag today`);
    assert.ok(tomorrowRow.bestSubcragId, `${parentId} has a selected subcrag tomorrow`);
    assert.equal(body.today[parentId].todayBestSubcragId, todayRow.bestSubcragId);
    assert.equal(body.today[parentId].tomorrowBestSubcragId, tomorrowRow.bestSubcragId);
    assert.deepEqual(
      body.today[parentId].todayHourly,
      body.today[todayRow.bestSubcragId].todayHourly,
    );
    assert.deepEqual(
      body.today[parentId].tomorrowHourly,
      body.today[tomorrowRow.bestSubcragId].tomorrowHourly,
    );
  }
});

test('Wollongong destinations and sectors reach the scored API with matching parent hourly strips', async () => {
  let weatherCalls = 0;
  const harness = await loadWorker(async url => {
    assert.equal(new URL(url).hostname, 'api.open-meteo.com');
    weatherCalls++;
    return Response.json(weatherFixture(url));
  });
  const response = await harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=NSW'), {}, harness.ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  const groups = { 'mt-keira-main': 2, 'scarborough-main': 3, 'coalcliff-main': 5 };
  const records = Object.values(body.crags).filter(crag => groups[crag.id] || groups[crag.parentId]);
  assert.equal(records.length, 13);
  assert.deepEqual(validateCrags(records), []);
  assert.equal(weatherCalls, 1, 'all NSW sectors share one batched weather request');
  for (const [parentId, count] of Object.entries(groups)) {
    const children = records.filter(crag => crag.parentId === parentId);
    assert.equal(children.length, count);
    for (const date of body.dates) {
      for (const crag of [body.crags[parentId], ...children]) {
        const row = body.byDate[date].find(row => row.cragId === crag.id);
        assert.ok(row && Number.isFinite(row.score), `${crag.id}: scored on ${date}`);
      }
    }
    for (const [index, prefix] of [[0, 'today'], [1, 'tomorrow']]) {
      const row = body.byDate[body.dates[index]].find(row => row.cragId === parentId);
      assert.ok(children.some(crag => crag.id === row.bestSubcragId));
      assert.equal(body.today[parentId][`${prefix}BestSubcragId`], row.bestSubcragId);
      assert.deepEqual(body.today[parentId][`${prefix}Hourly`], body.today[row.bestSubcragId][`${prefix}Hourly`]);
    }
  }
  assert.equal(body.crags['mt-keira-west'].aspect, 'W');
  assert.equal(body.crags['mt-keira-south'].aspect, 'S');
  assert.equal(body.crags['scarborough-kennys'].aspect, 'E');
  assert.match(body.crags['mt-keira-main'].accessStatus, /west- and south-facing/);
  assert.equal(body.crags['coalcliff-main'].marineHazard, undefined);
  await harness.flush();
});

for (const mm of [0.2, 1]) {
  test(`Wollongong sandstone preserves the existing rain-event threshold at ${mm} mm`, async () => {
    const harness = await loadWorker(async url => Response.json(cathedralTraceFixture(url, mm)));
    const forecasts = await harness.forecasts.fetchAllForecasts('NSW');
    const additions = Object.values(forecasts).filter(forecast =>
      /^(mt-keira-|scarborough-|coalcliff-)/.test(forecast.crag.id));
    assert.equal(additions.length, 13);
    for (const forecast of additions) {
      const cell = forecast.tomorrowHourly.find(hour => hour.hour === 13);
      if (mm < 1) {
        assert.ok(cell.score > 0, `${forecast.crag.id}: trace rain does not trigger lockout`);
        assert.equal(cell.wetRockCondition, undefined);
      } else {
        assert.ok(cell.wetRockCondition, `${forecast.crag.id}: meaningful rain retains wet-rock recovery`);
        assert.ok(cell.score <= cell.wetRockCondition.cap);
      }
    }
  });
}

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
    assert.deepEqual(Object.keys(body).sort(), ['region', 'dates', 'tripDates', 'crags', 'byDate', 'weekendTrip', 'today', 'forecast'].sort());
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
        assert.ok(!todayRow.contributions.some(c => c.category === 'window'));
        assert.equal(100 + todayRow.contributions.reduce((sum, c) => sum + c.delta, 0), todayRow.score);
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
        assert.ok(!tomorrowRow.contributions.some(c => c.category === 'window'));
        assert.equal(100 + tomorrowRow.contributions.reduce((sum, c) => sum + c.delta, 0), tomorrowRow.score);
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
    assert.deepEqual(withoutForecastAge(await second.json()), withoutForecastAge(body));
    const expectedCalls = ['TAS', 'ALL'].includes(region) ? 2 : 1;
    assert.equal(calls, expectedCalls);

    // The uncached two-argument path must use the same sessions and rollups.
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
  assert.equal((await get('NSW')).headers.get('X-SendTemps-Cache'), 'STALE');
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

test('expired regional cache serves same-day fallback before background refresh resolves', async () => {
  let release;
  let delay = false;
  const harness = await loadWorker(async url => {
    if (delay) await new Promise(resolve => { release = resolve; });
    return Response.json(weatherFixture(url));
  });
  const req = new Request('https://api.test/forecast/scored?region=NT');
  const first = await harness.worker.fetch(req, {}, harness.ctx);
  const original = await first.json();
  await harness.flush();
  harness.setNow('2026-09-13T02:16:00Z');
  delay = true;
  const raced = await Promise.race([
    harness.worker.fetch(req, {}, harness.ctx).then(response => ({ response })),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 100)),
  ]);
  assert.ok(!raced.timedOut, 'stale response should not await the provider');
  assert.equal(raced.response.headers.get('X-SendTemps-Cache'), 'STALE');
  const saved = await raced.response.json();
  assert.equal(saved.forecast.stale, true);
  assert.equal(saved.forecast.ageSeconds, 16 * 60);
  assert.deepEqual(withoutForecastAge(saved), withoutForecastAge(original));
  release();
  await harness.flush();
  const refreshed = await harness.worker.fetch(req, {}, harness.ctx);
  assert.equal(refreshed.headers.get('X-SendTemps-Cache'), 'HIT');
});

test('stalled regional refresh returns retryable errors and releases its shared slot', async () => {
  let calls = 0;
  let releaseFirst;
  const harness = await loadWorker(async url => {
    calls++;
    if (calls === 1) await new Promise(resolve => { releaseFirst = resolve; });
    return Response.json(weatherFixture(url));
  });
  const get = () => harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=NT'), {}, harness.ctx,
  );
  const responses = await Promise.all([get(), get()]);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '5');
  }
  assert.equal(calls, 1, 'concurrent misses share one provider call');
  await harness.flush();
  try {
    const recovered = await get();
    assert.equal(recovered.status, 200);
    assert.equal(calls, 2);
  } finally {
    releaseFirst();
  }
});

test('scheduled snapshots survive a provider outage and Melbourne midnight on a cold edge', async () => {
  const beforeMidnight = '2026-09-13T13:55:00Z';
  const objects = new Map();
  const bucket = {
    put: async (key, value) => objects.set(key, value),
    get: async key => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)) } : null,
  };
  const env = { FORECAST_SNAPSHOTS: bucket };
  const publisher = await loadWorker(async url => Response.json(weatherFixture(url)), beforeMidnight);
  // Slot zero publishes ALL. The snapshot itself uses the clock at execution.
  const event = { cron: '*/2 * * * *', scheduledTime: 0 };
  await publisher.worker.scheduled(event, env);
  const request = new Request('https://climbable.test/forecast/scored?region=ALL');
  let providerCalls = 0;
  const edge = await loadWorker(async () => {
    providerCalls++;
    return new Response(null, { status: 503 });
  }, beforeMidnight);
  await assert.rejects(edge.worker.scheduled(event, env), /refresh failed/);
  providerCalls = 0;
  const fresh = await edge.worker.fetch(request, env, edge.ctx);
  assert.equal(fresh.headers.get('X-SendTemps-Cache'), 'SNAPSHOT');
  assert.equal(fresh.headers.get('X-Climbable-Forecast-Updated-At'), beforeMidnight.slice(0, -1) + '.000Z');
  const previous = await fresh.json();
  edge.setNow('2026-09-13T14:05:00Z');
  const rollover = await edge.worker.fetch(request, env, edge.ctx);
  assert.equal(rollover.headers.get('X-SendTemps-Cache'), 'SNAPSHOT-STALE');
  const current = await rollover.json();
  assert.equal(current.dates[0], '2026-09-14');
  assert.equal(current.byDate['2026-09-13'], undefined);
  const crag = Object.keys(previous.today)[0];
  assert.deepEqual(current.today[crag].todayHourly, previous.today[crag].tomorrowHourly);
  assert.deepEqual(current.today[crag].tomorrowHourly, []);
  assert.equal(providerCalls, 0);
  edge.setNow('2026-09-14T04:00:00Z');
  assert.equal((await edge.worker.fetch(request, env, edge.ctx)).status, 502);
  assert.ok(providerCalls > 0);
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
  assert.deepEqual(withoutForecastAge(await fallback.json()), withoutForecastAge(original));
  await harness.flush();
  harness.setNow('2026-09-13T03:01:00Z');
  const expired = await harness.worker.fetch(req, {}, harness.ctx);
  assert.equal(expired.status, 502);
  assert.match((await expired.json()).error, /429/);
});

test('paid weather and marine requests use the server secret without exposing it', async () => {
  const hosts = new Set();
  const key = 'test-only-paid-key';
  const harness = await loadWorker(async input => {
    const url = new URL(input);
    hosts.add(url.hostname);
    assert.equal(url.searchParams.get('apikey'), key);
    assert.ok(url.hostname.startsWith('customer-'));
    url.hostname = url.hostname.replace('customer-', '');
    return Response.json(fixtureForUrl(url.toString()));
  });
  const response = await harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=TAS'),
    { OPEN_METEO_API_KEY: key }, harness.ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(hosts, new Set(['customer-api.open-meteo.com', 'customer-marine-api.open-meteo.com']));
  assert.ok(!(await response.text()).includes(key));
  await harness.flush();
  for (const [cacheKey, cached] of harness.entries) {
    assert.ok(!cacheKey.includes(key));
    assert.ok(!(await cached.clone().text()).includes(key));
  }
});

test('provider network errors redact the API key', async () => {
  const key = 'test-only-private-key';
  const harness = await loadWorker(async url => { throw new Error(`Request failed: ${url}`); });
  const response = await harness.worker.fetch(
    new Request('https://api.test/forecast/scored?region=NT'),
    { OPEN_METEO_API_KEY: key }, harness.ctx);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes(key));
  assert.match(body, /Weather provider request failed/);
});

test('global drying calibration shortens recovery across rock types while retaining rain severity', async () => {
  const { rainRecoveryHours, wetRockCondition } = (await loadWorker()).forecasts;
  for (const [rockType, oldHours] of [
    ['granite', 8], ['rhyolite', 8], ['basalt', 9], ['dolerite', 10],
    ['quartzite', 11], ['marble', 12], ['trachyte', 14],
    ['conglomerate', 18], ['limestone', 20], ['tuff', 28], ['sandstone', 18],
  ]) {
    const crag = { rockType };
    const hours = rainRecoveryHours(crag, 5);
    assert.ok(hours < oldHours, `${rockType} recovers sooner`);
    assert.ok(rainRecoveryHours(crag, 20) > hours, `${rockType} retains heavier-rain recovery`);
    const caps = Array.from({ length: hours + 2 }, (_, h) => wetRockCondition(crag, {
      precip: 0, rainEventMm: 5, hoursSinceRain: h, recoveryProgressHours: h,
    }).cap);
    assert.ok(caps.every((cap, i) => cap >= 0 && cap <= 100 && (!i || cap >= caps[i - 1])),
      `${rockType} improves monotonically during recovery`);
    assert.equal(caps.at(-1), 100);
    assert.ok(wetRockCondition(crag, { precip: 5, rainEventMm: 5 }).cap <= 60,
      `${rockType} keeps active-rain ceiling`);
  }
});

test('hourly moisture uses the stronger physical wetness or recovery constraint', async () => {
  const { scoreHour } = (await loadWorker()).forecasts;
  const crag = { rockType: 'granite', idealTemp: [10, 20], aspect: 'N' };
  const hour = { hour: 10, temp: 15, apparentTemp: 15, humidity: 60, wind: 5,
    precip: 0, precipProb: 0, cloud: 50, sunOnWall: null,
    wetRockCondition: { cap: 90 } };
  assert.ok(scoreHour(crag, { ...hour, dryness: 20 }) <=
    scoreHour(crag, { ...hour, dryness: 100 }));
  assert.equal(scoreHour(crag, { ...hour, dryness: 20, wetRockCondition: { cap: 70 } }), 70,
    'take the stronger constraint rather than summing a 20-point deduction and a 30-point cap deficit');
  assert.ok(scoreHour(crag, { ...hour, dryness: 20 }) <= 90);
});


test('Falcons cloudy forecast retains physical sun exposure without a shade-refuge label', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const forecast of data) {
      forecast.hourly.cloudcover.fill(100);
      forecast.hourly.temperature_2m.fill(24);
      forecast.hourly.apparent_temperature.fill(28);
    }
    return Response.json(data);
  });
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['falcons-lookout'];
  const d = fc.days.find(d => d.date === fc.tomorrowDate);
  assert.equal(d.sunHoursOnWall, 0);
  assert.ok(d.geometricSunHoursOnWall > 0);
  const row = harness.forecasts.rankByDay({ 'falcons-lookout': fc }, [fc.tomorrowDate])[fc.tomorrowDate][0];
  assert.ok(!row.reasons.includes('shaded refuge'));
  assert.ok(row.score <= 79);
  assert.equal(row.day.temperaturePeriod, 'session');
});

test('session moisture tags and breakdown use scored hours instead of a soaked morning', async () => {
  const harness = await loadWorker(async url => Response.json(weatherFixture(url)));
  const original = (await harness.forecasts.fetchAllForecasts('VIC'))['youyangs-flatrock'];
  for (const offset of [0, 1, 2, 8]) {
    const date = new Date(Date.parse(original.todayDate) + offset * 86400000).toISOString().slice(0, 10);
    const hours = original.bestWindows[date].hours.map((hour, i) => ({ ...hour,
      hour: 15 + i, dryness: 85 + i, precip: 0, rainEventMm: 14,
      hoursSinceRain: 30, recoveryProgressHours: 30, wetRockCondition: undefined,
    }));
    const fc = { ...original,
      days: original.days.map(day => day.date === date ? { ...day,
        morningDryness: 23, afternoonDryness: 75, wetRockCap: 25,
        wetRockLabel: 'granite wet', wetRockDetail: 'stale daily recovery',
      } : day),
      bestWindows: { ...original.bestWindows, [date]: {
        start: 15, end: 20, count: 5, avg: 87, hours,
      } },
    };
    const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [date])[date][0];
    assert.equal(row.score, 87);
    assert.equal(row.day.sessionDryness, 85);
    assert.equal(row.day.morningDryness, 23, 'raw morning forecast remains available');
    assert.ok(!row.reasons.some(reason => /rock soaked|rock wet|still drying|granite wet/.test(reason)));
    const dryness = row.contributions.find(c => c.category === 'dryness');
    assert.equal(dryness.delta, -5);
    assert.match(dryness.detail, /85\/100/);
    assert.equal(row.day.wetRockCap, undefined, 'stale daily cap must be removed');
    assert.equal(row.rockReadiness.status, 'forecast-dry');
  }

  const date = new Date(Date.parse(original.todayDate) + 3 * 86400000).toISOString().slice(0, 10);
  const fc = { ...original, days: original.days.map(day => day.date === date
    ? { ...day, morningDryness: 23, afternoonDryness: 75, wetRockCap: undefined } : day) };
  const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [date])[date][0];
  assert.equal(row.scoreBasis, 'daily-estimate');
  assert.ok(row.reasons.includes('rock soaked'), 'daily estimates retain their whole-day dryness context');
});

test('session moisture readiness retains wet-rock constraints within the selected window', async () => {
  const harness = await loadWorker(async url => Response.json(weatherFixture(url)));
  const original = (await harness.forecasts.fetchAllForecasts('VIC'))['youyangs-flatrock'];
  const date = original.tomorrowDate;
  for (const [rockType, cap, status] of [['granite', 60, 'wet'], ['sandstone', 0, 'wet']]) {
    const hours = original.bestWindows[date].hours.map(hour => ({ ...hour,
      dryness: 20, precip: 1, rainEventMm: 5, currentEventMm: 5,
      hoursSinceRain: 0, recoveryProgressHours: 0, wetRockCondition: undefined,
    }));
    const fc = { ...original, crag: { ...original.crag, rockType },
      days: original.days.map(day => day.date === date ? { ...day,
        morningDryness: 100, afternoonDryness: 100, wetRockCap: undefined,
      } : day),
      bestWindows: { ...original.bestWindows,
        [date]: { ...original.bestWindows[date], hours, avg: cap } },
    };
    const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [date])[date][0];
    assert.equal(row.day.wetRockCap, cap);
    assert.equal(row.rockReadiness.status, status);
    assert.ok(row.reasons.includes(`${rockType} wet`));
    assert.ok(row.contributions.some(c => c.label === 'Rock dryness'),
      'physical moisture remains represented under a recovery ceiling');
  }
});

test('West Flank stays shaded until 2 pm and ends shaded heat relief at that boundary', async () => {
  const { forecasts: f } = await loadWorker();
  for (const path of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
    const crag = (await loadCrags(path)).find(c => c.id === 'gramps-westflank');
    assert.equal(crag.shadeUntilHour, 14);
    assert.match(crag.sunOnWall, /2 pm/);
    for (const hour of [9, 12, 13, 13.99]) {
      assert.equal(f.sunOnCrag(crag, 270, 50, hour), false, `${path}: shaded at ${hour}`);
      assert.equal(f.peakTemperatureUpper(crag, hour), f.peakTemperatureUpper(crag, 11));
    }
    assert.equal(f.sunOnCrag(crag, 270, 50, 14), true);
    assert.equal(f.sunOnCrag(crag, 270, 50, 15), true);
    assert.equal(f.sunOnCrag(crag, 90, 50, 14), false, 'after 2 pm sun still depends on geometry');
    assert.equal(f.sunOnCrag(crag, 270, 0, 14), false, 'night is never treated as sunny');
    assert.ok(f.peakTemperatureUpper(crag, 13) > f.peakTemperatureUpper(crag, 14));
    const weather = { temp: 24, apparentTemp: 24, humidity: 50, wind: 8,
      windDir: 270, windExposure: 'parallel', precip: 0, precipProb: 0,
      cloud: 20, dryness: 100, sunAlt: 50 };
    const score = hour => f.scoreHour(crag, { ...weather, hour,
      sunOnWall: f.sunOnCrag(crag, 270, 50, hour) });
    assert.equal(score(13), score(11), 'shade and heat relief extend through 1 pm');
    assert.ok(score(13) > score(14), 'afternoon sun and loss of relief affect the score');
  }
});

test('all Grampians crags lighten residual drying but preserve active rain and recent-rain warnings', async () => {
  const f = (await loadWorker()).forecasts;
  for (const path of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
    const crags = await loadCrags(path);
    const grampians = crags.filter(c => c.id.startsWith('gramps-'));
    assert.equal(grampians.length, 29);
    for (const crag of grampians) {
      assert.equal(crag.residualDryingPenaltyFactor, 0.24, crag.id);
      const overnight = { precip: 0, rainEventMm: 15, currentEventMm: 15,
        hoursSinceRain: 14, recoveryProgressHours: 0, dryness: 32 };
      const regular = { ...crag }; delete regular.residualDryingPenaltyFactor;
      assert.equal(f.wetRockCondition(regular, overnight).cap, 25);
      const adjusted = f.wetRockCondition(crag, overnight);
      assert.equal(adjusted.cap, 82, crag.id);
      assert.equal(adjusted.recoveryHours, f.rainRecoveryHours(regular, 15),
        'lighter penalty does not pretend the recovery warning has finished');
      assert.equal(adjusted.label, 'recent rain – check for seepage');
      assert.match(adjusted.detail, /15.0mm/);
      assert.equal(f.wetRockCondition(crag, { ...overnight, precip: 2 }).cap, 0,
        'active substantial rain retains its full cap');
      assert.equal(f.wetRockCondition(crag, { ...overnight, hoursSinceRain: 0 }).cap, 25,
        'fresh rain must earn a complete dry hour before relief');
    }
    assert.ok(crags.filter(c => !c.id.startsWith('gramps-')).every(c =>
      c.residualDryingPenaltyFactor === undefined), 'other regions retain their calibration');
  }
});

test('Grampians pipeline keeps recent rain visible with substantially lighter drying scores', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const { hourly } of data) {
      hourly.precipitation[hourly.time.indexOf('2026-09-13T19:00')] = 15;
      hourly.cloudcover.fill(100);
      hourly.shortwave_radiation.fill(0);
      hourly.relative_humidity_2m.fill(82);
    }
    return Response.json(data);
  });
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['gramps-westflank'];
  const morning = fc.tomorrowHourly.find(h => h.hour === 9);
  assert.equal(morning.recoveryProgressHours, 0);
  assert.equal(morning.wetRockCondition.cap, 82);
  assert.ok(morning.score > 70);
  const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [fc.tomorrowDate])[fc.tomorrowDate][0];
  assert.ok(row.reasons.includes('recent rain – check for seepage'));
  assert.ok(!row.reasons.includes('rock soaked'));
  assert.equal(row.rockReadiness.status, 'drying');
  assert.match(row.rockReadiness.advisory, /Do not climb sandstone that is damp/);
});

test('humidity descriptions remain humid when wet-rock scoring suppresses the air penalty', async () => {
  const { describeHumidity, deltaT, spoogePenalty } = (await loadWorker()).forecasts;
  const crag = { rockType: 'sandstone' };
  assert.equal(spoogePenalty(crag, { temp: 22, humidity: 85, wind: 5, dryness: 30 }), 0);
  assert.equal(describeHumidity(85, 22, deltaT(22, 85)), 'muggy');
  assert.equal(describeHumidity(85, 18, deltaT(18, 85)), 'moist air');
  assert.equal(describeHumidity(65, 19.5, deltaT(19.5, 65)), 'moist air');
  assert.equal(describeHumidity(null, 20, 3), null);
});

test('current, session and climbing-day humidity stay separate without changing the score', async () => {
  const harness = await loadWorker(async url => {
    const data = weatherFixture(url);
    for (const { hourly } of data) {
      hourly.time.forEach((iso, i) => {
        hourly.relative_humidity_2m[i] = Number(iso.slice(11, 13)) < 12 ? 85 : 45;
      });
      hourly.precipitation[hourly.time.indexOf('2026-09-13T19:00')] = 15;
    }
    return Response.json(data);
  }, '2026-09-14T00:00:00Z'); // 10 am Melbourne
  const fc = (await harness.forecasts.fetchAllForecasts('VIC'))['gramps-westflank'];
  const row = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [fc.todayDate])[fc.todayDate][0];
  assert.equal(row.day.currentHumidity.relativeHumidity, 85);
  assert.equal(row.day.currentHumidity.label, 'moist air');
  assert.equal(row.day.currentHumidity.source, 'forecast');
  assert.equal(row.day.currentHumidity.hour, 10);
  assert.equal(Math.round(row.day.climbHumidity.meanRh), 58);
  assert.equal(row.day.climbHumidity.period, 'climbing-day');
  const selected = fc.bestWindows[fc.todayDate].hours;
  const meanRh = selected.reduce((sum, h) => sum + h.humidity, 0) / selected.length;
  assert.equal(row.day.sessionHumidity.relativeHumidity, meanRh);
  assert.equal(row.day.sessionHumidity.startHour, row.scoreWindow.start);
  assert.equal(row.day.sessionHumidity.endHour, row.scoreWindow.end);
  assert.ok(row.reasons.includes(row.day.sessionHumidity.label), 'score reason describes the selected session');
  assert.ok(!row.reasons.includes('comfortable'));
  assert.equal(row.score, Math.round(fc.bestWindows[fc.todayDate].avg),
    'descriptive humidity fields do not change the hourly score');

  const tomorrow = harness.forecasts.rankByDay({ [fc.crag.id]: fc }, [fc.tomorrowDate])[fc.tomorrowDate][0];
  assert.equal(tomorrow.day.currentHumidity, undefined, 'future forecasts must never claim a current value');
});
