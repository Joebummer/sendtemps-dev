const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const { loadCrags } = require('../scripts/validate-crags.cjs');

test('Falcons observed 1 pm shade overrides solar exposure and preserves heat limits', async () => {
  const { forecasts: f } = await loadWorker();
  const crags = await loadCrags('worker/src/lib/crags.js');
  const c = crags.find(c => c.id === 'falcons-lookout');
  assert.equal(c.shadeFromHour, 13);
  assert.equal(c.peakTempMax, 18);
  assert.equal(c.heatCap, 20);
  assert.equal(f.sunOnCrag(c, 45, 50, 12), true);
  assert.equal(f.sunOnCrag(c, 45, 50, 13), false);
  assert.equal(f.sunOnCrag(c, 45, 50, 17), false);
  assert.equal(f.sunOnCrag({ ...c, shadeFromHour: undefined }, 45, 50, 13), true);
  for (const date of ['2026-01-15', '2026-07-15']) {
    const hourly = {
      time: Array.from({length: 24}, (_, h) => date + 'T' + String(h).padStart(2, '0') + ':00'),
      temperature_2m: Array(24).fill(24),
      apparent_temperature: Array(24).fill(24),
      cloudcover: Array(24).fill(0),
    };
    const temps = f.computeClimbTemps(c, hourly, date);
    const samples = temps.temperatureSamples;
    assert.ok(samples.length > 0);
    assert.ok(samples.filter(s => s.hour >= 13).every(s => s.solarFraction === 0));
  }
});
