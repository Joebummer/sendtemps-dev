const vm = require('node:vm');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

// Load the real Worker ES modules without changing the Eleventy package type.
// Every outbound request is intercepted; unexpected network calls fail tests.
async function loadWorker(fetchMock, now = '2026-09-13T02:00:00Z') {
  const entries = new Map();
  const pending = [];
  const context = vm.createContext({
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return new Date(now).getTime(); }
    },
    Request, Response, URL, URLSearchParams, TextEncoder, TextDecoder,
    console, setTimeout, clearTimeout,
    fetch: fetchMock || (() => { throw new Error('Unexpected network request'); }),
    caches: { default: {
      match: async key => entries.get(key.url)?.clone(),
      put: async (key, response) => { entries.set(key.url, response.clone()); },
    } },
  });
  const modules = new Map();
  async function load(file) {
    if (!modules.has(file)) {
      modules.set(file, new vm.SourceTextModule(await readFile(file, 'utf8'), { context, identifier: file }));
    }
    return modules.get(file);
  }
  const root = path.join(__dirname, '..', 'worker/src/index.js');
  const worker = await load(root);
  await worker.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await worker.evaluate();
  return {
    worker: worker.namespace.default, entries,
    ctx: { waitUntil: promise => pending.push(promise) },
    flush: () => Promise.all(pending.splice(0)),
    forecasts: modules.get(path.join(__dirname, '..', 'worker/src/lib/forecast.js')).namespace,
  };
}

module.exports = { loadWorker };
