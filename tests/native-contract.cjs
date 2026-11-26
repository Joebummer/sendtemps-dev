const assert = require('node:assert/strict');
const models = require('./fixtures/native-scored-contract.json');

// Public wire requirements transcribed from SendTemps-iOS's actual Codable
// models, inspected in Dropbox on 27 Nov 2026. Unknown keys are ignored, as
// JSONDecoder does. This checks types/required keys, not native rendering.
function assertNativeContract(value, type = 'ScoredForecastResponse', path = '$') {
  if (type.endsWith('?')) {
    if (value == null) return;
    return assertNativeContract(value, type.slice(0, -1), path);
  }
  if (type === 'JSONValue') return;
  if (type.startsWith('[')) {
    const inner = type.slice(1, -1).trim();
    if (inner.startsWith('String:')) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path}: expected ${type}`);
      for (const [key, child] of Object.entries(value)) assertNativeContract(child, inner.slice(7).trim(), `${path}.${key}`);
    } else {
      assert.ok(Array.isArray(value), `${path}: expected ${type}`);
      value.forEach((child, index) => assertNativeContract(child, inner, `${path}[${index}]`));
    }
  } else if (models[type]) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path}: expected ${type}`);
    for (const [key, fieldType] of Object.entries(models[type])) assertNativeContract(value[key], fieldType, `${path}.${key}`);
  } else {
    const valid = type === 'String' ? typeof value === 'string'
      : type === 'Bool' ? typeof value === 'boolean'
        : type === 'Int' ? Number.isSafeInteger(value)
          : type === 'Double' ? typeof value === 'number' && Number.isFinite(value) : false;
    assert.ok(valid, `${path}: expected ${type}, received ${String(value)}`);
  }
}
module.exports = { assertNativeContract };
