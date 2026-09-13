const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCrags, loadCrags } = require('../scripts/validate-crags.cjs');
const valid = () => ({ id: 'parent', name: 'Parent', state: 'VIC', lat: -37, lon: 144, elevation: 0 });

for (const file of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
  test(`${file}: all records satisfy the data contract`, async () => {
    assert.deepEqual(validateCrags(await loadCrags(file)), []);
  });
}
for (const elevation of [undefined, null, '950', NaN, Infinity]) {
  test(`reject invalid elevation ${String(elevation)} on parents and subcrags`, () => {
    for (const parentId of [undefined, 'parent']) {
      const records = [valid(), { ...valid(), id: 'child', parentId, elevation }];
      assert.ok(validateCrags(records).some(error => error.includes('elevation')));
    }
  });
}
test('allow zero elevation and valid parent references', () => {
  assert.deepEqual(validateCrags([valid(), { ...valid(), id: 'child', parentId: 'parent' }]), []);
});
test('reject duplicate IDs, bad coordinates, missing parents and cycles', () => {
  assert.ok(validateCrags([valid(), valid()]).some(e => e.includes('duplicate')));
  assert.ok(validateCrags([{ ...valid(), lat: 91, lon: null }]).length >= 2);
  assert.ok(validateCrags([{ ...valid(), parentId: 'absent' }]).some(e => e.includes('unknown parent')));
  assert.ok(validateCrags([{ ...valid(), parentId: 'parent' }]).some(e => e.includes('cycle')));
});
