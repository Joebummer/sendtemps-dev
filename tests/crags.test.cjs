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

test('Canberra coverage agrees across databases, marketing counts and map', async () => {
  const fs = require('node:fs');
  const client = await loadCrags('webapp/crags.js');
  const server = await loadCrags('worker/src/lib/crags.js');
  const additions = client.filter(c => /^(orroral-|gibraltar-|snake-rock-|coree-|red-rocks-|kambah-rocks)/.test(c.id));
  assert.equal(additions.length, 19);
  for (const crag of additions) assert.deepEqual(server.find(c => c.id === crag.id), crag);
  const parents = client.filter(c => !c.parentId);
  assert.equal(client.length, 307);
  assert.equal(parents.length, 76);
  assert.deepEqual(parents.filter(c => c.state === 'ACT').map(c => c.id).sort(),
    ['booroomba-main', 'gibraltar-main', 'kambah-rocks', 'orroral-main', 'red-rocks-main', 'snake-rock-main']);
  assert.equal(client.find(c => c.id === 'coree-main').state, 'NSW');
  assert.match(client.find(c => c.id === 'red-rocks-main').accessStatus, /1 August to 31 December/);
  const map = fs.readFileSync('src/_includes/coverage-map.njk', 'utf8');
  for (const region of ['VIC', 'NSW', 'ACT', 'TAS', 'QLD', 'SA', 'WA']) {
    const count = parents.filter(c => c.state === region).length;
    assert.match(map, new RegExp(`data-state="${region.toLowerCase()}"[^>]*data-count="${count}"`));
  }
  assert.match(fs.readFileSync('content/home.yaml', 'utf8'), /76 destinations across 6 states and the ACT/);
});
