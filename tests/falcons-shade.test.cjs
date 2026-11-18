const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers.cjs');
const { loadCrags } = require('../scripts/validate-crags.cjs');

test('Falcons remains an exposed sun trap after 1 pm and preserves its heat limits', async () => {
  const { forecasts: f } = await loadWorker();
  const c = (await loadCrags('worker/src/lib/crags.js')).find(c => c.id === 'falcons-lookout');
  assert.equal(c.shade, 'none');
  assert.equal(c.shadeFromHour, undefined);
  assert.equal(c.peakTempMax, 18);
  assert.equal(c.heatCap, 20);
  for (const hour of [12, 13, 17]) assert.equal(f.sunOnCrag(c, 45, 50, hour), true);
});
