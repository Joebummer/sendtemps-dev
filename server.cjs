// Minimal SendTemps backend: pageview counter + stats endpoint.
// Static files are served from S3 by the pplx.app proxy — this server
// only handles /api/* routes. Database lives at ./data.db (auto-snapshotted
// across redeploys).

const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 5000;
const DB_PATH = path.join(__dirname, 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    visitor TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS hits_day_idx ON hits(day);
  CREATE INDEX IF NOT EXISTS hits_visitor_idx ON hits(visitor);
`);

const insertHit = db.prepare('INSERT INTO hits (ts, day, visitor) VALUES (?, ?, ?)');
const totalQ = db.prepare('SELECT COUNT(*) AS n FROM hits');
const uniqueQ = db.prepare('SELECT COUNT(DISTINCT visitor) AS n FROM hits');
const todayQ = db.prepare('SELECT COUNT(*) AS n FROM hits WHERE day = ?');
const dailyQ = db.prepare(`
  SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques
  FROM hits
  WHERE day >= ?
  GROUP BY day
  ORDER BY day ASC
`);

function todayInMelbourne() {
  // Australia/Melbourne ISO date (YYYY-MM-DD)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dayNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/hit') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2048) req.destroy();
    });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const visitor = String(data.visitor || '').slice(0, 64) || 'anon';
        insertHit.run(Date.now(), todayInMelbourne(), visitor);
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { ok: false });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const total = totalQ.get().n;
    const uniques = uniqueQ.get().n;
    const today = todayQ.get(todayInMelbourne()).n;
    const since = dayNDaysAgo(29);
    const daily = dailyQ.all(since);
    json(res, 200, { total, uniques, today, daily });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`SendTemps API listening on :${PORT}`);
});
