/**
 * SendTemps API Worker
 * - POST /subscribe   — saves a Web Push subscription to Supabase
 * - PATCH /subscribe  — updates favourites + thresholds for an existing subscription
 * - DELETE /subscribe — removes a subscription (unsubscribe)
 * - Cron trigger (0 21 * * * UTC = 7am AEST):
 *     1. Checks VIC crags for rare windows (state-wide alert)
 *     2. Checks each subscriber's favourited crags against their score threshold
 */

// ─── VAPID helpers (Web Push without npm) ────────────────────────────────────

function base64urlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr) {
  let binary = '';
  arr.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function makeVapidJwt(subject, publicKeyB64, privateKeyB64, audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 12 * 3600, sub: subject };

  const enc = new TextEncoder();
  const toSign = `${uint8ArrayToBase64url(enc.encode(JSON.stringify(header)))}.${uint8ArrayToBase64url(enc.encode(JSON.stringify(payload)))}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyB64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    enc.encode(toSign)
  );

  return `${toSign}.${uint8ArrayToBase64url(new Uint8Array(sig))}`;
}

function pemToDer(b64url) {
  // Our private key is raw base64url — convert to PKCS8 DER wrapper
  const rawKey = base64urlToUint8Array(b64url);
  // PKCS8 header for P-256
  const header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20
  ]);
  const der = new Uint8Array(header.length + rawKey.length);
  der.set(header);
  der.set(rawKey, header.length);
  return der.buffer;
}

async function sendWebPush(subscription, payload, env) {
  const { endpoint, keys: { p256dh, auth } } = subscription;
  const audience = new URL(endpoint).origin;

  const jwt = await makeVapidJwt(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    audience
  );

  // Encrypt payload using Web Push encryption (RFC 8291)
  const encrypted = await encryptPayload(payload, p256dh, auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body: encrypted,
  });

  return res;
}

async function encryptPayload(payloadStr, p256dhB64, authB64) {
  const enc = new TextEncoder();
  const payload = enc.encode(payloadStr);

  const receiverPublicKey = await crypto.subtle.importKey(
    'raw',
    base64urlToUint8Array(p256dhB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,  // must be extractable for HKDF info string
    []
  );

  const authSecret = base64urlToUint8Array(authB64);

  // Generate sender key pair
  const senderKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  const senderPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderKeyPair.publicKey)
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiverPublicKey },
      senderKeyPair.privateKey,
      256
    )
  );

  // Salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF to derive content encryption key + nonce
  const prk = await hkdf(authSecret, sharedSecret, concat(enc.encode('WebPush: info\x00'), new Uint8Array(await crypto.subtle.exportKey('raw', receiverPublicKey)), senderPublicKeyRaw), 32);
  const contentKey = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\x00'), 12);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);

  // Pad payload
  const padded = new Uint8Array(payload.length + 2);
  padded.set(payload);
  padded[payload.length] = 0x02; // delimiter

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
  );

  // Build aes128gcm record
  const header = new Uint8Array(16 + 4 + 1 + senderPublicKeyRaw.length);
  header.set(salt);
  // rs = 4096
  header[16] = 0x00; header[17] = 0x00; header[18] = 0x10; header[19] = 0x00;
  header[20] = senderPublicKeyRaw.length;
  header.set(senderPublicKeyRaw, 21);

  return concat(header, ciphertext);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  ));
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseRequest(env, method, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function saveSubscription(env, sub, state, favourites, thresholds) {
  // Upsert on endpoint so re-subscribes after SW updates overwrite the stale row
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      state: state || 'VIC',
      favourites: favourites || [],
      thresholds: thresholds || {},
    }),
  });
  return res;
}

async function updateSubscriptionFavourites(env, endpoint, favourites, thresholds) {
  return supabaseRequest(
    env,
    'PATCH',
    `/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { favourites: favourites || [], thresholds: thresholds || {} }
  );
}

async function deleteSubscription(env, endpoint) {
  return supabaseRequest(env, 'DELETE', `/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, null);
}

async function getAllSubscriptions(env) {
  const res = await supabaseRequest(env, 'GET', '/push_subscriptions?select=*', null);
  return res.json();
}

// ─── Rare window detection ────────────────────────────────────────────────────

const VIC_CRAGS = [
  { name: 'Mt Arapiles',         lat: -36.7556, lon: 141.8403, normTMax: 11.6, normRh: 78.2, normWind: 20.9 },
  { name: 'Grampians Stapylton', lat: -37.1389, lon: 142.5217, normTMax: 11.5, normRh: 83.5, normWind: 16.2 },
  { name: 'Grampians Taipan',    lat: -36.9036, lon: 142.4131, normTMax: 10.4, normRh: 80.8, normWind: 18.9 },
  { name: 'Mt Buffalo',          lat: -36.7367, lon: 146.8153, normTMax:  4.4, normRh: 83.8, normWind:  9.5 },
  { name: 'Cathedral Ranges',    lat: -37.3667, lon: 145.7333, normTMax:  7.9, normRh: 86.6, normWind: 13.9 },
  { name: 'You Yangs',           lat: -37.9489, lon: 144.4297, normTMax: 12.7, normRh: 75.6, normWind: 22.8 },
  { name: 'Harcourt',            lat: -36.9977, lon: 144.3049, normTMax:  8.3, normRh: 82.2, normWind: 19.9 },
  { name: 'Mt Beckworth',        lat: -37.3022, lon: 143.7356, normTMax: 10.5, normRh: 82.7, normWind: 20.8 },
  { name: "Camel's Hump",        lat: -37.3947, lon: 144.5547, normTMax:  7.9, normRh: 86.6, normWind: 13.9 },
  { name: 'Falcons Lookout',     lat: -37.6736, lon: 144.4322, normTMax: 12.7, normRh: 75.6, normWind: 22.8 },
];

function seasonalAdjust(normTMax) {
  const month = new Date().getMonth() + 1; // 1-12
  // July = baseline (0), Jan = +8, Apr/Oct = ~0
  const offset = Math.round(8 * Math.sin((month - 7) * Math.PI / 6));
  return normTMax + offset;
}

async function checkRareWindows() {
  const windows = [];

  for (const crag of VIC_CRAGS) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${crag.lat}&longitude=${crag.lon}&daily=temperature_2m_max,relative_humidity_2m_mean,wind_speed_10m_max&forecast_days=7&timezone=Australia%2FMelbourne`;
    const res = await fetch(url);
    const data = await res.json();
    const { time, temperature_2m_max, relative_humidity_2m_mean, wind_speed_10m_max } = data.daily;

    const adjTMax = seasonalAdjust(crag.normTMax);

    for (let i = 0; i < time.length; i++) {
      const tempAnomaly = temperature_2m_max[i] - adjTMax;
      const rhAnomaly   = crag.normRh - relative_humidity_2m_mean[i];
      const windAnomaly = crag.normWind - wind_speed_10m_max[i];

      const signals = [
        tempAnomaly >= 4,
        rhAnomaly   >= 12,
        windAnomaly >= 10,
      ];
      const count = signals.filter(Boolean).length;

      if (count >= 2) {
        const date = new Date(time[i]);
        const label = date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
        const parts = [];
        if (signals[0]) parts.push(`+${tempAnomaly.toFixed(1)}°C warmer`);
        if (signals[1]) parts.push(`${rhAnomaly.toFixed(0)}% drier`);
        if (signals[2]) parts.push(`${windAnomaly.toFixed(0)} km/h calmer`);
        windows.push(`${crag.name} — ${label}: ${parts.join(', ')}`);
      }
    }
  }

  return windows;
}

// ─── Beta access codes ───────────────────────────────────────────────────────────

async function handleRedeem(env, url, corsHeaders, ctx) {
  const code = (url.searchParams.get('code') || '').trim();
  if (!code) {
    return new Response(JSON.stringify({ ok: false, error: 'missing code' }), { status: 400, headers: corsHeaders });
  }

  const res = await supabaseRequest(
    env,
    'GET',
    `/access_codes?code=eq.${encodeURIComponent(code)}&select=code,tier,expires_at,active,redeemed_count&limit=1`,
    null
  );

  if (!res.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'lookup failed' }), { status: 502, headers: corsHeaders });
  }

  const rows = await res.json();
  const row = rows[0];

  const valid = row && row.active && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
  if (!valid) {
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: corsHeaders });
  }

  // For single-use codes (label contains 'Single-use'), deactivate on first redemption.
  // Multi-use codes (owner, interstate-beta) keep active=true.
  const isSingleUse = (row.label || '').toLowerCase().includes('single-use');
  const trackUsage = supabaseRequest(env, 'PATCH', `/access_codes?code=eq.${encodeURIComponent(code)}`, {
    redeemed_count: (row.redeemed_count || 0) + 1,
    last_redeemed_at: new Date().toISOString(),
    ...(isSingleUse ? { active: false } : {}),
  }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(trackUsage);
  else await trackUsage;

  return new Response(
    JSON.stringify({ ok: true, tier: row.tier, expires_at: row.expires_at }),
    { status: 200, headers: corsHeaders }
  );
}

// ─── Forecast proxy + edge cache ──────────────────────────────────────────────

const FORECAST_CACHE_TTL = 900; // 15 minutes — forecasts don't need to be fresher than this

async function handleForecastProxy(request, url, corsHeaders, ctx) {
  const cache = caches.default;
  // The query string (batched crag lat/lons) is identical for every client
  // viewing the same region filter on the same app version, so this key is
  // shared across all of them — one cache entry per region (VIC, TAS, …, or
  // ALL) rather than one giant shared entry for the whole country.
  const cacheKey = new Request(url.toString(), { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
    res.headers.set('X-SendTemps-Cache', 'HIT');
    return res;
  }

  const upstreamUrl = `https://api.open-meteo.com/v1/forecast?${url.searchParams.toString()}`;
  const upstream = await fetch(upstreamUrl);

  if (!upstream.ok) {
    // Upstream is failing (e.g. 429) and we have nothing cached yet — pass the
    // status through so the client's existing retry/backoff still applies.
    return new Response(await upstream.text(), { status: upstream.status, headers: corsHeaders });
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Cache-Control': `public, max-age=${FORECAST_CACHE_TTL}`,
      'X-SendTemps-Cache': 'MISS',
    },
  });

  // Store for the next request without delaying this one.
  if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  else await cache.put(cacheKey, response.clone());

  return response;
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': 'https://sendtemps.app',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://sendtemps.app',
    'Content-Type': 'application/json',
  };

  // GET /forecast — proxies the Open-Meteo call all clients make on load,
  // with an edge cache in front of it. Without this, every phone/iPad hits
  // Open-Meteo directly and gets subject to Open-Meteo's own per-IP rate
  // limit — which bites unpredictably depending on the device's network
  // (mobile carrier NAT, iCloud Private Relay egress pool, etc.), so one
  // device can 429 while another on the same wifi is fine. Proxying through
  // here means every client shares one cached response per ~15 min window,
  // fetched from Cloudflare's own IPs instead of the client's.
  if (pathname === '/forecast' && request.method === 'GET') {
    return handleForecastProxy(request, url, corsHeaders, ctx);
  }

  // GET /redeem?code=XXXX — validates a beta-access code against the
  // access_codes table and reports the tier it unlocks. No accounts/billing
  // yet, so this is what app.js calls when someone opens a link like
  // sendtemps.app/?code=INTERSTATE-BETA to hand out Pro access for testing.
  if (pathname === '/redeem' && request.method === 'GET') {
    return handleRedeem(env, url, corsHeaders, ctx);
  }

  if (pathname === '/subscribe' && request.method === 'POST') {
    const { subscription, state, favourites, thresholds } = await request.json();
    await saveSubscription(env, subscription, state, favourites, thresholds);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  if (pathname === '/subscribe' && request.method === 'PATCH') {
    const { endpoint, favourites, thresholds } = await request.json();
    await updateSubscriptionFavourites(env, endpoint, favourites, thresholds);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  // Test endpoint — triggers favourite alerts for the calling subscription
  // POST { endpoint } — looks up the sub in Supabase and fires alerts immediately
  if (pathname === '/test-push' && request.method === 'POST') {
    const { endpoint } = await request.json();
    const allSubs = await getAllSubscriptions(env);
    const sub = allSubs.find(s => s.endpoint === endpoint);
    if (!sub) return new Response(JSON.stringify({ ok: false, error: 'subscription not found' }), { status: 404, headers: corsHeaders });

    const favs = Array.isArray(sub.favourites) ? sub.favourites : [];
    const thresholds = sub.thresholds || {};
    const results = [];

    for (const cragId of favs) {
      const coords = CRAG_COORDS[cragId];
      if (!coords) { results.push({ cragId, status: 'unknown id' }); continue; }
      const threshold = thresholds[cragId] ?? 75;
      const score = await getCragScoreToday(coords.lat, coords.lon);
      results.push({ cragId, name: coords.name, score, threshold, willAlert: score >= threshold });
    }

    const hits = results.filter(r => r.willAlert);
    if (hits.length) {
      const title = hits.length === 1
        ? `${hits[0].name} is looking good today`
        : `${hits.length} of your pinned crags are looking good today`;
      const body = hits.map(r => `${r.name} — ${r.score}/100`).join('\n') + '\n\nCheck the full forecast at sendtemps.app';
      const payload = JSON.stringify({ title, body, url: 'https://sendtemps.app/' });
      const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      await sendWebPush(pushSub, payload, env);
    }

    return new Response(JSON.stringify({ ok: true, results, pushed: hits.length > 0 }), { headers: corsHeaders });
  }

  // GET /checkins/:cragId — last 7 days of check-ins for a crag
  if (pathname.startsWith('/checkins/') && request.method === 'GET') {
    const cragId = decodeURIComponent(pathname.slice('/checkins/'.length));
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await supabaseRequest(
      env, 'GET',
      `/checkins?crag_id=eq.${encodeURIComponent(cragId)}&climbed_date=gte.${since}&select=rock,temp_feel,climbed_date&order=climbed_date.desc`,
      null
    );
    const rows = await res.json();
    const count = rows.length;
    const mode = (arr, key) => {
      const freq = {};
      arr.forEach(r => { freq[r[key]] = (freq[r[key]] || 0) + 1; });
      return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const rock = mode(rows, 'rock');
    const temp = mode(rows, 'temp_feel');
    const lastDate = rows[0]?.climbed_date ?? null;
    return new Response(JSON.stringify({ count, rock, temp, lastDate }), { headers: corsHeaders });
  }

  // Debug endpoint — returns raw error from push attempt
  if (pathname === '/debug-push' && request.method === 'POST') {
    const { endpoint } = await request.json();
    const allSubs = await getAllSubscriptions(env);
    const sub = allSubs.find(s => s.endpoint === endpoint);
    if (!sub) return new Response(JSON.stringify({ error: 'sub not found' }), { headers: corsHeaders });
    try {
      const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      const payload = JSON.stringify({ title: 'Debug test', body: 'Push debug', url: 'https://sendtemps.app/' });
      const res = await sendWebPush(pushSub, payload, env);
      const body = await res.text();
      return new Response(JSON.stringify({ status: res.status, body, vapid_subject: env.VAPID_SUBJECT || 'MISSING' }), { headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { headers: corsHeaders });
    }
  }

  if (pathname === '/checkin' && request.method === 'POST') {
    const { crag_id, crag_name, climbed_date, month, app_score, rock, temp_feel } = await request.json();
    await supabaseRequest(env, 'POST', '/checkins', {
      crag_id, crag_name, climbed_date, month, app_score, rock, temp_feel,
    });
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  if (pathname === '/subscribe' && request.method === 'DELETE') {
    const { endpoint } = await request.json();
    await deleteSubscription(env, endpoint);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  return new Response('Not found', { status: 404 });
}

// ─── Favourite score lookup ───────────────────────────────────────────────────
// Simplified scoring proxy: fetch today's tMax, precip, wind for a crag lat/lon
// and produce a rough 0-100 score comparable to the app's scoring model.
// Not a full replica — used only to detect threshold crossings.
async function getCragScoreToday(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,precipitation_sum,precipitation_probability_max,windspeed_10m_max&forecast_days=1&timezone=Australia%2FMelbourne`;
    const res = await fetch(url);
    const data = await res.json();
    const d = data.daily;
    const tMax = d.temperature_2m_max[0];
    const precip = d.precipitation_sum[0];
    const precipProb = d.precipitation_probability_max[0];
    const wind = d.windspeed_10m_max[0];

    // Heuristic score — penalty-only model starting from 100.
    // Matches the app's directional intent: good days lose few/no points.
    let score = 100;
    // Temperature penalties
    if (tMax < 8 || tMax > 38) score -= 40;
    else if (tMax < 12 || tMax > 35) score -= 20;
    else if (tMax < 15 || tMax > 32) score -= 8;
    // Rain penalties
    if (precip > 5) score -= 40;
    else if (precip > 2) score -= 25;
    else if (precip > 0.5) score -= 12;
    // Rain probability penalty
    if (precipProb > 70) score -= 15;
    else if (precipProb > 40) score -= 8;
    // Wind penalties
    if (wind > 50) score -= 20;
    else if (wind > 35) score -= 12;
    else if (wind > 25) score -= 5;
    return Math.max(0, Math.min(100, Math.round(score)));
  } catch { return null; }
}

// Crag ID → lat/lon map for favourite lookups.
// IDs match crags.js exactly. Sub-crags inherit their parent's coords.
const CRAG_COORDS = {
  // ── VIC ──
  'arap-main':         { lat: -36.7556, lon: 141.8403, name: 'Mt Arapiles' },
  'gramps-main':       { lat: -37.1389, lon: 142.5217, name: 'Grampians' },
  'gramps-stapylton':  { lat: -37.1389, lon: 142.5217, name: 'Mt Stapylton' },
  'gramps-taipan':     { lat: -36.9036, lon: 142.4131, name: 'Taipan Wall' },
  'buffalo-main':      { lat: -36.7367, lon: 146.8153, name: 'Mt Buffalo' },
  'cathedral-main':    { lat: -37.3667, lon: 145.7333, name: 'Cathedral Ranges' },
  'youyangs-main':     { lat: -37.9489, lon: 144.4297, name: 'You Yangs' },
  'mt-beckworth':      { lat: -37.3022, lon: 143.7356, name: 'Mt Beckworth' },
  'camels-hump':       { lat: -37.3947, lon: 144.5547, name: "Camel's Hump" },
  'falcons-lookout':   { lat: -37.6736, lon: 144.4322, name: 'Falcons Lookout' },
  'mt-alexander':      { lat: -36.9977, lon: 144.3049, name: 'Mt Alexander' },
  'staughton-vale':    { lat: -37.7972, lon: 144.3308, name: 'Staughton Vale' },
  'harcourt-dogrocks': { lat: -37.0089, lon: 144.3049, name: 'Dog Rocks' },
  'harcourt-wabbitwocks': { lat: -37.0023, lon: 144.3049, name: 'Wabbit Wocks' },
  'harcourt-scorpionrocks': { lat: -36.9977, lon: 144.3049, name: 'Scorpion Rocks' },
  // ── TAS ──
  'ben-lomond-main':   { lat: -41.530,  lon: 147.650,  name: 'Ben Lomond' },
  'freycinet-main':    { lat: -42.2076, lon: 148.290,  name: 'Freycinet' },
  'mtwellington-main': { lat: -42.9084, lon: 147.234,  name: 'Kunanyi / Mt Wellington' },
  'sand-river-main':   { lat: -42.515,  lon: 147.710,  name: 'Sand River' },
  'fortescue-main':    { lat: -43.1394, lon: 148.006,  name: 'Fortescue Bay' },
  'cape-raoul-main':   { lat: -43.2346, lon: 147.795,  name: 'Cape Raoul' },
  // ── NSW ──
  'nowra-main':        { lat: -34.8704, lon: 150.601,  name: 'Nowra' },
  'bluemtns-main':     { lat: -33.632,  lon: 150.317,  name: 'Blue Mountains' },
  'booroomba-main':    { lat: -35.5576, lon: 148.817,  name: 'Booroomba Rocks' },
  'bungonia-main':     { lat: -34.7961, lon: 149.950,  name: 'Bungonia Gorge' },
  'pointperp-main':    { lat: -35.094,  lon: 150.800,  name: 'Point Perpendicular' },
  'lindfield-main':    { lat: -33.7688, lon: 151.179,  name: 'Lindfield Rocks' },
  // ── SA ──
  'morialta-main':     { lat: -34.9043, lon: 138.700,  name: 'Morialta' },
  'norton-summit':     { lat: -34.9229, lon: 138.717,  name: 'Norton Summit' },
  'onkaparinga-main':  { lat: -35.1623, lon: 138.567,  name: 'Onkaparinga' },
  'moonarie-main':     { lat: -31.6129, lon: 138.633,  name: 'Moonarie' },
  'warren-gorge':      { lat: -32.186,  lon: 138.350,  name: 'Warren Gorge' },
  'waitpinga':         { lat: -35.6181, lon: 138.550,  name: 'Waitpinga Cliffs' },
  'second-valley':     { lat: -35.5101, lon: 138.217,  name: 'Second Valley' },
  // ── WA ──
  'wa-mountain-quarry':  { lat: -31.913, lon: 116.100, name: 'Mountain Quarry' },
  'wa-wungong':          { lat: -32.199, lon: 116.031, name: 'Wungong Valley' },
  'wa-roleystone':       { lat: -32.132, lon: 116.070, name: 'Roleystone' },
  'wa-mt-cooke':         { lat: -32.416, lon: 116.309, name: 'Mt Cooke' },
  'wa-wilyabrup':        { lat: -33.805, lon: 115.001, name: 'Wilyabrup' },
  'wa-bobs-hollow':      { lat: -34.064, lon: 115.001, name: "Bob's Hollow" },
  'wa-mt-frankland':     { lat: -34.886, lon: 116.673, name: 'Mt Frankland' },
  'wa-albany':           { lat: -35.033, lon: 118.074, name: 'Albany' },
  'wa-west-cape-howe':   { lat: -35.109, lon: 117.621, name: 'West Cape Howe' },
  'wa-porongurup':       { lat: -34.685, lon: 117.885, name: 'Porongurup Range' },
  'wa-stirling-ranges':  { lat: -34.391, lon: 118.037, name: 'Stirling Ranges' },
  'wa-eaglestone':       { lat: -31.083, lon: 118.242, name: 'Eaglestone Rocks' },
  'wa-kalbarri':         { lat: -27.669, lon: 114.393, name: 'Kalbarri' },
};

// ─── Cron handler ─────────────────────────────────────────────────────────────

async function handleCron(env) {
  const subscriptions = await getAllSubscriptions(env);

  // 1. Rare window alerts (VIC state-wide)
  const windows = await checkRareWindows();
  if (windows.length > 0) {
    const title = '✦ Rare window in Victoria';
    const body = windows.join('\n') + '\n\nCheck sendtemps.app for the full forecast.';
    const payload = JSON.stringify({ title, body, url: 'https://sendtemps.app/' });
    const vicSubs = subscriptions.filter(s => s.state === 'VIC' || !s.state);
    for (const sub of vicSubs) {
      const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await sendWebPush(pushSub, payload, env);
      } catch (e) {
        if (e?.status === 410 || e?.status === 404) await deleteSubscription(env, sub.endpoint);
      }
    }
  }

  // 2. Favourite crag alerts — per subscriber, per pinned crag
  for (const sub of subscriptions) {
    const favs = Array.isArray(sub.favourites) ? sub.favourites : [];
    const thresholds = sub.thresholds || {};
    if (!favs.length) continue;

    const hits = [];
    for (const cragId of favs) {
      const coords = CRAG_COORDS[cragId];
      if (!coords) continue;
      const threshold = thresholds[cragId] ?? 75;
      const score = await getCragScoreToday(coords.lat, coords.lon);
      if (score !== null && score >= threshold) {
        hits.push(`${coords.name} — scoring ${score}/100 today`);
      }
    }

    if (!hits.length) continue;

    const title = hits.length === 1
      ? `${hits[0].name} is looking good today`
      : `${hits.length} of your pinned crags are looking good today`;
    const body = hits.map(r => `${r.name} — ${r.score}/100`).join('\n') + '\n\nCheck the full forecast at sendtemps.app';
    const payload = JSON.stringify({ title, body, url: 'https://sendtemps.app/' });
    const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await sendWebPush(pushSub, payload, env);
    } catch (e) {
      if (e?.status === 410 || e?.status === 404) await deleteSubscription(env, sub.endpoint);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(event, env) {
    await handleCron(env);
  },
};
// redeployed 2026-07-19T09:04:27Z — VAPID_SUBJECT added
// added GET /forecast edge-cached proxy — fixes per-device Open-Meteo 429s
