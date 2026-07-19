/**
 * SendTemps API Worker
 * - POST /subscribe  — saves a Web Push subscription to Supabase
 * - DELETE /subscribe — removes a subscription (unsubscribe)
 * - Cron trigger (0 21 * * * UTC = 7am AEST) — checks VIC crags for rare windows
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
    false,
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

async function saveSubscription(env, sub, state) {
  return supabaseRequest(env, 'POST', '/push_subscriptions', {
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    state: state || 'VIC',
  });
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

// ─── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': 'https://sendtemps.app',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://sendtemps.app',
    'Content-Type': 'application/json',
  };

  if (pathname === '/subscribe' && request.method === 'POST') {
    const { subscription, state } = await request.json();
    await saveSubscription(env, subscription, state);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  if (pathname === '/subscribe' && request.method === 'DELETE') {
    const { endpoint } = await request.json();
    await deleteSubscription(env, endpoint);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  return new Response('Not found', { status: 404 });
}

// ─── Cron handler ─────────────────────────────────────────────────────────────

async function handleCron(env) {
  const windows = await checkRareWindows();
  if (windows.length === 0) return; // silent exit

  const title = '✦ Rare window in Victoria';
  const body = windows.join('\n') + '\n\nCheck sendtemps.app for the full forecast.';
  const payload = JSON.stringify({ title, body, url: 'https://sendtemps.app/' });

  const subscriptions = await getAllSubscriptions(env);
  const vicSubs = subscriptions.filter(s => s.state === 'VIC' || !s.state);

  for (const sub of vicSubs) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await sendWebPush(pushSub, payload, env);
    } catch (e) {
      // Subscription expired — clean it up
      if (e.status === 410 || e.status === 404) {
        await deleteSubscription(env, sub.endpoint);
      }
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(event, env) {
    await handleCron(env);
  },
};
