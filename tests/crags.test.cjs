const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCrags, loadCrags } = require('../scripts/validate-crags.cjs');
const valid = () => ({ id: 'parent', name: 'Parent', state: 'VIC', lat: -37, lon: 144, elevation: 0, idealTemp: [10, 20] });

test('hot-weather sectors preserve hierarchy, catalogue parity and original thermal limits', async () => {
  const server = await loadCrags('worker/src/lib/crags.js');
  const client = await loadCrags('webapp/crags.js');
  const pairs = [['bluemtns-bell-shady', 'bluemtns-bellsupercrag'], ['bluemtns-bell-sunny', 'bluemtns-bellsupercrag'],
    ['gramps-tribute-upper', 'gramps-tribute'], ['gramps-tribute-lower', 'gramps-tribute']];
  for (const [id, combined] of pairs) {
    const c = server.find(c => c.id === id), parent = server.find(c => c.id === combined);
    assert.deepEqual(c, client.find(c => c.id === id));
    assert.equal(c.parentId, parent.parentId);
    assert.deepEqual(c.idealTemp, parent.idealTemp);
    assert.equal(c.heatCap, parent.heatCap);
    assert.equal(c.accessStatus, parent.accessStatus);
    assert.ok(Number.isFinite(c.elevation));
  }
  for (const cs of [server, client]) {
    const freezer = cs.find(c => c.id === 'bluemtns-thefreezer');
    assert.equal(freezer.elevation, 1009);
    assert.deepEqual(freezer.idealTemp, [10, 26]);
    assert.equal(freezer.heatCap, 28);
    assert.equal(freezer.warmWeatherRelief, 'afternoon');
    assert.match(freezer.notes, /Cosmic County/);
    assert.doesNotMatch(freezer.notes, /Bowens/);
    assert.equal(cs.find(c => c.id === 'bluemtns-bellsupercrag').shade, 'mixed');
  }
});

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
  assert.equal(client.length, 323);
  assert.equal(parents.length, 79);
  assert.deepEqual(parents.filter(c => c.state === 'ACT').map(c => c.id).sort(),
    ['booroomba-main', 'gibraltar-main', 'kambah-rocks', 'orroral-main', 'red-rocks-main', 'snake-rock-main']);
  assert.equal(client.find(c => c.id === 'coree-main').state, 'NSW');
  assert.match(client.find(c => c.id === 'red-rocks-main').accessStatus, /1 August to 31 December/);
  const map = fs.readFileSync('src/_includes/coverage-map.njk', 'utf8');
  for (const region of ['VIC', 'NSW', 'ACT', 'TAS', 'QLD', 'SA', 'WA', 'NT']) {
    const count = parents.filter(c => c.state === region).length;
    assert.match(map, new RegExp(`data-state="${region.toLowerCase()}"[^>]*data-count="${count}"`));
  }
  assert.match(fs.readFileSync('content/home.yaml', 'utf8'), /79 destinations across all 6 states, the ACT and NT/);
});


test('NT destinations and sectors agree across databases and have numeric elevations', async () => {
  const client = (await loadCrags('webapp/crags.js')).filter(c => c.state === 'NT');
  const server = (await loadCrags('worker/src/lib/crags.js')).filter(c => c.state === 'NT');
  assert.equal(client.length, 12);
  assert.equal(client.filter(c => !c.parentId).length, 3);
  assert.deepEqual(server, client);
  assert.deepEqual(validateCrags(server), []);
  for (const crag of server.filter(c => c.parentId)) {
    assert.ok(server.some(parent => parent.id === crag.parentId && !parent.parentId));
  }
  for (const crag of server.filter(c => c.id.includes('hayes-creek'))) {
    assert.match(crag.accessStatus, /closed/);
  }
  for (const crag of server.filter(c => c.id.includes('second-pool'))) {
    assert.match(crag.accessStatus, /not permitted/);
  }
});

test('Westside uses its cool bouldering temperature profile in both datasets', async () => {
  for (const file of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
    const crags = await loadCrags(file);
    const westside = crags.filter(crag => crag.id === 'westside-main' || crag.parentId === 'westside-main');
    assert.deepEqual(westside.map(crag => crag.id).sort(), [
      'westside-boulder', 'westside-delos-descent', 'westside-main',
    ]);
    for (const crag of westside) {
      assert.deepEqual(crag.idealTemp, [10, 18], file + ': ' + crag.id);
      assert.equal(crag.heatCap, 20, file + ': ' + crag.id);
    }
  }
});

const auditedBoulderingProfiles = {
  'mt-beckworth': [[10, 18], 20, 'mixed', 'exposed'],
  'black-hill': [[10, 18], 20, 'mixed', 'exposed'],
  'gramps-stapylton': [[6, 18], 20, 'mixed', 'exposed'],
  'gramps-trackside': [[6, 18], 20, 'bouldering', 'partial'],
  'gramps-andersens-west': [[6, 18], 20, 'bouldering', 'partial'],
  'kooyoora-sundial': [[8, 18], 20, 'bouldering', 'exposed'],
  'kooyoora-area-1': [[8, 18], 20, 'bouldering', 'exposed'],
  'wa-eaglestone': [[8, 18], 20, 'mixed', 'exposed'],
  'mt-kooyoora': [[8, 20], 22, 'bouldering', 'partial'],
  'kooyoora-melvilles-caves': [[8, 20], 22, 'mixed', 'partial'],
  'kooyoora-black-spot': [[8, 18], 20, 'bouldering', 'exposed'],
  'gramps-venus-baths': [[6, 18], 20, 'bouldering', 'partial'],
  'beechworth-gorge': [[8, 20], 22, 'bouldering', 'partial'],
  'youyangs-main': [[10, 20], 22, 'mixed', 'partial'],
  'youyangs-royaltywalls': [[8, 20], 20, 'routes', 'exposed'],
  'youyangs-adamblock': [[8, 18], 20, 'mixed', 'partial'],
  'youyangs-urinalwall': [[8, 20], 20, 'routes', 'exposed'],
  'youyangs-bigrock': [[10, 20], 20, 'routes', 'exposed'],
  'youyangs-northwesternoutcrop': [[8, 20], 22, 'routes', 'partial'],
  'lindfield-main': [[10, 19], 20, 'bouldering', 'sheltered'],
  'sissy-crag': [[10, 19], 20, 'bouldering', 'partial'],
  'berowra': [[10, 19], 20, 'mixed', 'exposed'],
  'barrenjoey': [[10, 19], 20, 'mixed', 'partial'],
  'narrabeen-slabs': [[10, 19], 20, 'routes', 'sheltered'],
  'wahroonga-rocks': [[10, 19], 20, 'mixed', 'partial'],
  'tunks-park': [[10, 19], 20, 'bouldering', 'sheltered'],
  'queens-park': [[10, 19], 20, 'bouldering', 'partial'],
  'the-frontline': [[10, 19], 20, 'bouldering', 'sheltered'],
  'the-hideaway': [[10, 19], 20, 'bouldering', 'partial'],
  'junkyard-cave': [[10, 19], 20, 'mixed', 'sheltered'],
  'westside-main': [[10, 18], 20, 'bouldering', 'partial'],
  'westside-boulder': [[10, 18], 20, 'bouldering', 'partial'],
  'westside-delos-descent': [[10, 18], 20, 'bouldering', 'sheltered'],
};

test('audited bouldering profiles agree across both datasets', async () => {
  for (const file of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
    const crags = new Map((await loadCrags(file)).map(crag => [crag.id, crag]));
    for (const [id, [idealTemp, heatCap, discipline, heatExposure]] of Object.entries(auditedBoulderingProfiles)) {
      const crag = crags.get(id);
      assert.ok(crag, `${file}: missing ${id}`);
      assert.deepEqual(crag.idealTemp, idealTemp, `${file}: ${id} idealTemp`);
      assert.equal(crag.heatCap, heatCap, `${file}: ${id} heatCap`);
      assert.equal(crag.discipline, discipline, `${file}: ${id} discipline`);
      assert.equal(crag.heatExposure, heatExposure, `${file}: ${id} heatExposure`);
    }
  }
});

test('Blue Mountains profiles reject freezing conditions with a 10 degree minimum', async () => {
  for (const file of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
    const blue = (await loadCrags(file)).filter(crag =>
      crag.id === 'bluemtns-main' || crag.parentId === 'bluemtns-main');
    assert.equal(blue.length, 30, `${file}: Blue Mountains record count`);
    for (const crag of blue) {
      assert.ok(crag.idealTemp[0] >= 10, `${file}: ${crag.id} minimum`);
    }
    assert.deepEqual(blue.find(crag => crag.id === 'bluemtns-mtyork-shady').idealTemp, [15, 28]);
  }
});

test('reject malformed temperature and bouldering metadata', () => {
  for (const crag of [
    { ...valid(), idealTemp: [18, 10] },
    { ...valid(), idealTemp: [10, null] },
    { ...valid(), idealTemp: [10] },
    { ...valid(), heatCap: '20' },
    { ...valid(), discipline: 'sport' },
    { ...valid(), heatExposure: 'sunny' },
  ]) assert.ok(validateCrags([crag]).length > 0);
});
