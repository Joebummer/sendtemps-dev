const { readFile } = require('node:fs/promises');
const path = require('node:path');

function validateCrags(crags) {
  if (!Array.isArray(crags) || !crags.length) return ['CRAGS must be a non-empty array'];
  const errors = [];
  const ids = new Set();
  for (const [index, crag] of crags.entries()) {
    if (!crag || typeof crag !== 'object') {
      errors.push(`record ${index}: must be an object`);
      continue;
    }
    const label = crag.id || `record ${index}`;
    for (const field of ['id', 'name', 'state']) {
      if (typeof crag[field] !== 'string' || !crag[field].trim()) errors.push(`${label}: missing ${field}`);
    }
    if (ids.has(crag.id)) errors.push(`${label}: duplicate id`);
    ids.add(crag.id);
    for (const [field, min, max] of [['lat', -90, 90], ['lon', -180, 180]]) {
      if (!Number.isFinite(crag[field]) || crag[field] < min || crag[field] > max) {
        errors.push(`${label}: invalid ${field}`);
      }
    }
    // Required for every crag and subcrag, including elevation zero.
    if (!Number.isFinite(crag.elevation)) errors.push(`${label}: elevation must be a finite number`);
    if (!Array.isArray(crag.idealTemp) || crag.idealTemp.length !== 2 ||
        !crag.idealTemp.every(Number.isFinite) || crag.idealTemp[0] >= crag.idealTemp[1]) {
      errors.push(`${label}: idealTemp must be two increasing finite numbers`);
    }
    if (crag.heatCap != null && !Number.isFinite(crag.heatCap)) {
      errors.push(`${label}: heatCap must be a finite number`);
    }
    if (crag.discipline != null && !['bouldering', 'routes', 'mixed'].includes(crag.discipline)) {
      errors.push(`${label}: invalid discipline`);
    }
    if (crag.warmWeatherRelief != null && !['light', 'morning', 'evening'].includes(crag.warmWeatherRelief)) {
      errors.push(`${label}: invalid warmWeatherRelief`);
    }
    if (crag.heatExposure != null && !['exposed', 'partial', 'sheltered'].includes(crag.heatExposure)) {
      errors.push(`${label}: invalid heatExposure`);
    }
  }
  const byId = new Map(crags.filter(Boolean).map(crag => [crag.id, crag]));
  for (const crag of crags.filter(Boolean)) {
    const seen = new Set([crag.id]);
    let current = crag;
    while (current.parentId != null) {
      if (!byId.has(current.parentId)) {
        errors.push(`${crag.id}: unknown parent ${current.parentId}`);
        break;
      }
      if (seen.has(current.parentId)) {
        errors.push(`${crag.id}: parent cycle`);
        break;
      }
      seen.add(current.parentId);
      current = byId.get(current.parentId);
    }
  }
  return errors;
}

async function loadCrags(relativePath) {
  const source = await readFile(path.join(__dirname, '..', relativePath), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return module.CRAGS;
}

async function main() {
  for (const file of ['worker/src/lib/crags.js', 'webapp/crags.js']) {
    const crags = await loadCrags(file);
    const errors = validateCrags(crags);
    if (errors.length) {
      console.error(`${file}\n${errors.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`${file}: ${crags.length} crags valid, all elevations numeric`);
    }
  }
}

module.exports = { validateCrags, loadCrags };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
