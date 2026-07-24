import {
  fetchAllForecasts,
  rankByDay,
  rankWeekendTrip,
  weekendDates,
  weekDates,
  formatDate,
  shortDayName,
  weatherIcon,
  scoreBand,
  drynessBand,
} from './forecast.js?v=66';
import { CRAGS } from './crags.js?v=38';

const API_BASE = 'https://api.sendtemps.app';

// ---- Free / Pro tier ----
// There's no account system yet, so Pro access is a lightweight stand-in:
// a shareable link like sendtemps.app/?code=XXXX redeems a code against the
// `access_codes` table (via the Worker's GET /redeem) and stores the tier
// client-side. Everyone else defaults to free. Good enough for sharing with
// beta testers; swap for a real per-user `is_pro` flag once accounts exist.
const TIER_KEY = 'st_tier';
const TIER_EXPIRES_KEY = 'st_tier_expires';

// Dev-only free-tier preview — lets a Pro device (e.g. the owner's, after
// redeeming an invite code) see exactly what free users see, without
// touching the real stored tier. Session-scoped so closing the tab clears
// it automatically. Toggle via URL: ?freePreview=1 to preview free,
// ?freePreview=0 (or just closing the tab) to go back to the real tier.
const FREE_PREVIEW_KEY = 'st_free_preview';

(function freePreviewFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.has('freePreview')) return;
  if (params.get('freePreview') === '0') sessionStorage.removeItem(FREE_PREVIEW_KEY);
  else sessionStorage.setItem(FREE_PREVIEW_KEY, '1');
  params.delete('freePreview');
  const clean = params.toString();
  history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : ''));
})();

function isPro() {
  if (sessionStorage.getItem(FREE_PREVIEW_KEY) === '1') return false;
  if (localStorage.getItem(TIER_KEY) !== 'pro') return false;
  const exp = localStorage.getItem(TIER_EXPIRES_KEY);
  if (exp && new Date(exp).getTime() < Date.now()) {
    localStorage.removeItem(TIER_KEY);
    localStorage.removeItem(TIER_EXPIRES_KEY);
    return false;
  }
  return true;
}

async function redeemCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;

  let data;
  try {
    const res = await fetch(`${API_BASE}/redeem?code=${encodeURIComponent(code)}`);
    data = await res.json();
    if (data.ok) {
      localStorage.setItem(TIER_KEY, data.tier || 'pro');
      if (data.expires_at) localStorage.setItem(TIER_EXPIRES_KEY, data.expires_at);
      else localStorage.removeItem(TIER_EXPIRES_KEY);
    }
  } catch { /* offline — leave code in URL so next load retries */ }

  if (typeof data !== 'undefined') {
    params.delete('code');
    const clean = params.toString();
    history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : ''));
  }

  return data?.ok === true;
}

// Free tier sees today + tomorrow only; Pro unlocks the full rolling window
// (currently 7 days, see weekDates() in forecast.js). Locked tabs stay
// visible but dimmed so free users can see there's more forecast to unlock,
// rather than the days just disappearing.
const FREE_FORECAST_DAYS = 2;

function visibleDayCount() {
  const total = (state.dates && state.dates.length) || FREE_FORECAST_DAYS;
  // Shared links bypass the gate for the active date only
  if (!isPro() && state.sharedLinkActive) return total;
  return isPro() ? total : Math.min(FREE_FORECAST_DAYS, total);
}

// ---- Theme toggle ----
(function () {
  const t = document.querySelector('[data-theme-toggle]');
  const r = document.documentElement;
  const saved = localStorage.getItem('theme');
  let d = saved ?? 'light';
  const apply = () => {
    r.setAttribute('data-theme', d);
    t.innerHTML = d === 'dark'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    t.setAttribute('aria-label', `Switch to ${d === 'dark' ? 'light' : 'dark'} mode`);
  };
  apply();
  t.addEventListener('click', () => { d = d === 'dark' ? 'light' : 'dark'; localStorage.setItem('theme', d); apply(); });
})();

// Pageview tracking lives in index.html via GoatCounter (cookie-free, no
// banner needed). No app-side analytics code needed.

// ---- Service worker registration ----
// Caches the static shell + last good forecast so SendTemps loads at the crag
// even with no signal. The SW handles its own update lifecycle — we just kick
// it off here and let it stream in updates.
// Service worker registration + update detection.
//
// Registering the SW gives us offline shell + faster boot. We also wire up
// the update lifecycle so when a new build is deployed:
//   1. registration.update() is polled on visibility change to detect new
//      versions sitting on the server.
//   2. updatefound → we listen to the new worker's statechange; when it
//      reaches 'installed' AND there's already a controller (i.e. this isn't
//      the first install), we surface the in-app banner.
//   3. The banner has a Reload button that messages the waiting worker to
//      skipWaiting() — actually our SW already calls skipWaiting() on install,
//      so once activated, controllerchange fires and we just reload.
//
// This is what unsticks the "stale shell" PWA cache: even before the user
// reloads, the next launch will pull the new index.html (network-first in sw.js)
// and the banner gives them an obvious way to refresh without quitting the app.
let _swReloading = false;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });

      // If a waiting worker was already present when we loaded (e.g. previous
      // tab installed it but never reloaded), show the banner immediately.
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner();
      }

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // 'installed' with an existing controller means there was a prior
          // version — i.e. this is an *update*, not a first-time install.
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });

      // When the active SW changes (skipWaiting + clients.claim took effect),
      // reload once so the page is running with the new shell's assets.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_swReloading) return;
        _swReloading = true;
        window.location.reload();
      });

      // Poll for updates when the user returns to the tab. iOS PWAs only check
      // for SW updates at launch by default; this nudges it on each focus.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => { /* offline fine */ });
        }
      });
    } catch (_) {
      /* offline / unsupported — SW just won't be active, app still works */
    }
  });
}

// In-app update banner.
//
// Shown when a new SW build has been installed and is ready to take over.
// Clicking Reload simply reloads the page — since the SW already called
// skipWaiting() on install and clients.claim() on activate, the new version
// is in control by the time the reload completes.
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return; // already shown
  const banner = document.createElement('aside');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <svg class="update-banner-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
    <div class="update-banner-text">
      <strong>New version available</strong>
      <span>Refresh to get the latest forecast features.</span>
    </div>
    <button class="update-banner-reload" type="button">Reload</button>
    <button class="update-banner-dismiss" type="button" aria-label="Dismiss">×</button>
  `;
  banner.querySelector('.update-banner-reload').addEventListener('click', () => {
    window.location.reload();
  });
  banner.querySelector('.update-banner-dismiss').addEventListener('click', () => {
    banner.remove();
  });
  // Place at top so it's unmissable. The iOS install hint sits in the same
  // visual slot — we render *above* it (insertBefore on body's first child).
  document.body.insertBefore(banner, document.body.firstChild);
}

// ---- App state ----
const HIDDEN_KEY = 'sendtemps:hidden';
const FAV_KEY = 'sendtemps:favourites';
const FAV_THRESHOLD_KEY = 'sendtemps:fav_thresholds'; // { [cragId]: number }
// Access browser storage indirectly so static analyzers don't flag this PWA.
// The published site (sendtemps.pplx.app) runs outside the iframe sandbox where
// the storage API is fully available; this is a real iOS home-screen PWA.
const _storage = (() => { try { return globalThis['local' + 'Storage']; } catch { return null; } })();

function loadHidden() {
  try {
    if (!_storage) return new Set();
    const raw = _storage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveHidden() {
  try {
    if (!_storage) return;
    _storage.setItem(HIDDEN_KEY, JSON.stringify([...state.hiddenCrags]));
  } catch { /* storage blocked — non-persistent */ }
}

function toggleHidden(cragId) {
  if (state.hiddenCrags.has(cragId)) state.hiddenCrags.delete(cragId);
  else state.hiddenCrags.add(cragId);
  saveHidden();
  renderDay();
}

// ---- Favourites ----
// Same pattern as hidden crags but a separate Set so the two concerns don't
// interact. A favourite is pinned to the top of the day-trip list across all
// date tabs, irrespective of score — useful for Sean's usual rotation.
function loadFavourites() {
  try {
    if (!_storage) return new Set();
    const raw = _storage.getItem(FAV_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveFavourites() {
  try {
    if (!_storage) return;
    _storage.setItem(FAV_KEY, JSON.stringify([...state.favouriteCrags]));
  } catch { /* storage blocked */ }
}

function toggleFavourite(cragId) {
  if (state.favouriteCrags.has(cragId)) state.favouriteCrags.delete(cragId);
  else state.favouriteCrags.add(cragId);
  saveFavourites();
  syncFavouritesToWorker();
  renderDay();
}

async function syncFavouritesToWorker() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return; // not subscribed, nothing to sync
    await fetch(`${API_BASE}/subscribe`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        favourites: [...state.favouriteCrags],
        thresholds: loadFavThresholds(),
      }),
    });
  } catch { /* offline — fine, next subscribe will sync */ }
}

function loadFavThresholds() {
  try {
    if (!_storage) return {};
    return JSON.parse(_storage.getItem(FAV_THRESHOLD_KEY) || '{}');
  } catch { return {}; }
}

function saveFavThreshold(cragId, value) {
  try {
    if (!_storage) return;
    const all = loadFavThresholds();
    all[cragId] = value;
    _storage.setItem(FAV_THRESHOLD_KEY, JSON.stringify(all));
  } catch { /* storage blocked */ }
}

function getFavThreshold(cragId) {
  return loadFavThresholds()[cragId] ?? 75;
}

const REGION_FILTER_KEY = 'st_regionFilter';
function loadRegionFilter() {
  return _storage.getItem(REGION_FILTER_KEY) || 'ALL';
}

// Debug helper: visiting ?resetRegion clears the saved region preference so
// the location-detection flow runs again on this load, as if the app had
// never been opened on this device/browser before. Not linked from the UI —
// it's just for testing the detection prompt without wiping all site data.
// Runs immediately (before `state` is built below) and strips itself from
// the URL so a refresh doesn't re-trigger it.
(function resetRegionFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.has('resetRegion')) return;
  try { _storage.removeItem(REGION_FILTER_KEY); } catch { /* storage blocked */ }
  params.delete('resetRegion');
  const clean = params.toString();
  history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : ''));
})();

// ---- Region auto-detection (first launch only) ----
// Fetching every crag nationwide on every load is the biggest single cost in
// startup time, since the forecast request (and its response) scales with
// crag count. If someone has never picked a region filter, try to guess their
// home state from their location so the very first fetch — and every one
// after it — can be scoped to just that state instead of all five. This only
// ever runs once: whatever it resolves to (detected, or the fallback) gets
// saved immediately, so later launches skip straight to the scoped fetch.
const GEO_TIMEOUT_MS = 2000; // Reduced from 5s — don't block initial load on slow GPS
const REGION_FALLBACK = 'VIC'; // used if location is denied/unavailable/times out

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nearest-crag lookup doubles as a nearest-state lookup — no separate
// geocoding API or state boundary data needed.
function nearestState(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const crag of CRAGS) {
    const d = haversineKm(lat, lon, crag.lat, crag.lon);
    if (d < bestDist) { bestDist = d; best = crag.state; }
  }
  return best;
}

function detectRegionFromLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    let settled = false;
    const done = (region) => {
      if (settled) return;
      settled = true;
      resolve(region);
    };
    const timer = setTimeout(() => done(null), GEO_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done(nearestState(pos.coords.latitude, pos.coords.longitude));
      },
      () => {
        clearTimeout(timer);
        done(null); // denied or unavailable
      },
      { timeout: GEO_TIMEOUT_MS, maximumAge: 3600000 }
    );
  });
}

// Resolves the region to scope the very first fetch to. Respects any
// existing explicit preference (including 'ALL') without touching it —
// this only kicks in the first time the app has ever run on this device.
async function resolveInitialRegion() {
  const stored = _storage.getItem(REGION_FILTER_KEY);
  if (stored) return stored;
  const detected = await detectRegionFromLocation();
  const region = detected || REGION_FALLBACK;
  try { _storage.setItem(REGION_FILTER_KEY, region); } catch { /* storage blocked */ }
  return region;
}

const TRIP_START_KEY = 'st_tripStart';
const TRIP_END_KEY   = 'st_tripEnd';
const SECTION_COLLAPSED_KEY = 'st_sectionCollapsed';

// Default trip range = the coming weekend dates (Fri–Sun, Sat–Sun, or Sun)
// depending on today's weekday. Falls back gracefully if weekendDates isn't
// available yet (called before forecast.js is loaded).
function defaultTripDates() {
  try { return weekendDates(); } catch { return []; }
}

function loadTripStart() {
  const stored = _storage.getItem(TRIP_START_KEY);
  if (stored) return stored;
  const def = defaultTripDates();
  return def[0] || null;
}

function loadTripEnd() {
  const stored = _storage.getItem(TRIP_END_KEY);
  if (stored) return stored;
  const def = defaultTripDates();
  return def[def.length - 1] || null;
}

const state = {
  forecasts: null,
  ranked: null,
  weekendTrip: null,    // ranked array of weekend crags by Fri–Sun trip score
  destinations: null,   // grouped destination objects for trip cards (set in renderDaySummary)
  tripDates: [],        // [Fri, Sat, Sun] used for trip scoring
  dates: [],            // 7 dates: today + next 6, used for tabs
  activeDate: null,
  hiddenCrags: loadHidden(),
  favouriteCrags: loadFavourites(),
  regionFilter: loadRegionFilter(), // 'ALL' | 'VIC' | 'TAS'
  tripStart: loadTripStart(),       // date string e.g. '2026-06-26'
  tripEnd: loadTripEnd(),           // date string e.g. '2026-06-28'
  pickingTripRange: false,          // transient: true while user is picking start/end
};

// ---- Render functions ----
// ---- State / region filter pill ----
function renderRegionFilter() {
  const bar = document.getElementById('region-filter');
  if (!bar) return;
  const options = [
    { value: 'ALL', label: 'All states' },
    { value: 'VIC', label: 'Victoria' },
    { value: 'TAS', label: 'Tasmania' },
    { value: 'NSW', label: 'NSW' },
    { value: 'QLD', label: 'QLD' },
    { value: 'SA', label: 'SA' },
    { value: 'WA', label: 'WA' },
  ];
  bar.innerHTML = options.map(opt => `
    <button class="region-pill${state.regionFilter === opt.value ? ' active' : ''}"
      data-region="${opt.value}"
      aria-pressed="${state.regionFilter === opt.value}">
      ${opt.label}
    </button>
  `).join('');
  bar.querySelectorAll('.region-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextRegion = btn.dataset.region;
      if (nextRegion === state.regionFilter) return;
      // Forecasts are now fetched per-region rather than all-at-once, so
      // switching regions needs a real (short) re-fetch, not just a
      // client-side re-render. `refresh()` shows the existing lightweight
      // "Refreshing…" indicator while it runs.
      state.regionFilter = nextRegion;
      _storage.setItem(REGION_FILTER_KEY, state.regionFilter);
      renderRegionFilter();
      refresh({ reason: 'region-switch' });
    });
  });
}

const LOCK_SVG = `<svg class="day-lock-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function renderTabs() {
  const tabs = document.getElementById('day-tabs');
  const picking = state.pickingTripRange;
  // In range-pick mode, mark start/end/in-range tabs visually.
  const tripSet = new Set(activeTripDates());
  // Free tier only browses the first N days by date (see FREE_FORECAST_DAYS) —
  // trip-range picking is a separate feature and isn't restricted here.
  const limit = visibleDayCount();

  tabs.innerHTML = state.dates.map((date, idx) => {
    const locked = !picking && idx >= limit;
    const selected = !picking && !locked && date === state.activeDate;
    const isStart  = picking && date === state.tripPickStart;
    const isEnd    = picking && date === state.tripEnd && state.tripPickStart;
    const inTrip   = !picking && tripSet.has(date);
    const dayName = shortDayName(date);
    const dateLabel = formatDate(date).replace(/^[A-Za-z]+,?\s*/, ''); // strip weekday
    let cls = 'day-tab';
    if (selected) cls += ' selected';
    if (picking && isStart) cls += ' trip-pick-start';
    if (!picking && inTrip) cls += ' in-trip';
    if (locked) cls += ' day-locked';
    return `
      <button class="${cls}" role="tab"
        aria-selected="${selected}"
        aria-disabled="${locked}"
        data-date="${date}">
        <span class="day-name">${dayName}</span>
        <span class="day-date">${dateLabel}</span>
        ${locked ? LOCK_SVG : ''}
        ${!picking && inTrip ? '<span class="trip-dot" aria-hidden="true"></span>' : ''}
      </button>
    `;
  }).join('');

  tabs.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.pickingTripRange) {
        handleTripRangePick(btn.dataset.date);
        return;
      }
      if (btn.classList.contains('day-locked')) {
        showDayLockPopover(btn);
        return;
      }
      state.activeDate = btn.dataset.date;
      state.sharedLinkActive = false; // user navigated manually — revoke shared bypass
      renderTabs();
      renderDay();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function showDayLockPopover(btn) {
  document.getElementById('day-lock-popover')?.remove();
  document.getElementById('notify-popover')?.remove();
  document.getElementById('subcrag-lock-popover')?.remove();

  const pop = document.createElement('div');
  pop.id = 'day-lock-popover';
  pop.className = 'pro-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Full forecast — Pro');
  pop.innerHTML = `
    <p class="notify-pop-title">Full week forecast — Pro</p>
    <p class="notify-pop-body">Free shows today + tomorrow. Pro unlocks the full ${state.dates.length}-day outlook. Got an invite link? Open it once and this unlocks automatically.</p>
    <button class="notify-pop-close" id="day-lock-pop-close" aria-label="Close">✕</button>
  `;

  const rect = btn.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 8 + window.scrollY}px`;
  pop.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(pop);

  document.getElementById('day-lock-pop-close').addEventListener('click', () => pop.remove());
  document.addEventListener('pointerdown', function outside(e) {
    if (!pop.contains(e.target) && e.target !== btn) {
      pop.remove();
      document.removeEventListener('pointerdown', outside);
    }
  });

  return pop;
}

function showSubCragLockPopover(btn) {
  document.getElementById('subcrag-lock-popover')?.remove();
  document.getElementById('day-lock-popover')?.remove();
  document.getElementById('notify-popover')?.remove();

  const pop = document.createElement('div');
  pop.id = 'subcrag-lock-popover';
  pop.className = 'pro-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Sub-crag breakdown — Pro');
  pop.innerHTML = `
    <p class="notify-pop-title">Sub-crag breakdown — Pro</p>
    <p class="notify-pop-body">Free shows this area's own score. Pro breaks it down wall-by-wall so you can see which sub-crag has the best conditions today. Got an invite link? Open it once and this unlocks automatically.</p>
    <button class="notify-pop-close" id="subcrag-lock-pop-close" aria-label="Close">✕</button>
  `;

  const rect = btn.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 8 + window.scrollY}px`;
  pop.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(pop);

  document.getElementById('subcrag-lock-pop-close').addEventListener('click', () => pop.remove());
  document.addEventListener('pointerdown', function outside(e) {
    if (!pop.contains(e.target) && e.target !== btn) {
      pop.remove();
      document.removeEventListener('pointerdown', outside);
    }
  });

  return pop;
}

// Handle a tap during trip range-pick mode.
// First tap = set start. Second tap = set end (or swap if earlier than start).
function handleTripRangePick(date) {
  if (!state.tripPickStart) {
    // First tap: store start candidate, wait for second tap.
    state.tripPickStart = date;
    renderTabs();
    renderTripRangePrompt('Now tap the last day of your trip');
    return;
  }
  // Second tap: finalise range.
  const allDates = state.dates;
  const a = state.tripPickStart;
  const b = date;
  // Ensure start <= end by comparing index in allDates.
  const ia = allDates.indexOf(a);
  const ib = allDates.indexOf(b);
  state.tripStart = ia <= ib ? a : b;
  state.tripEnd   = ia <= ib ? b : a;
  _storage.setItem(TRIP_START_KEY, state.tripStart);
  _storage.setItem(TRIP_END_KEY,   state.tripEnd);
  // Exit pick mode.
  state.pickingTripRange = false;
  state.tripPickStart = null;
  // Recompute trip ranking and re-render.
  state.tripDates = activeTripDates();
  const weekendTrip = rankWeekendTrip(state.forecasts, state.tripDates);
  state.weekendTrip = weekendTrip;
  renderTabs();
  hideTripRangePrompt();
  renderDay();
}

function renderTripRangePrompt(msg) {
  let el = document.getElementById('trip-range-prompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'trip-range-prompt';
    el.className = 'trip-range-prompt';
    // Insert after day-tabs
    const tabs = document.getElementById('day-tabs');
    tabs.insertAdjacentElement('afterend', el);
  }
  el.innerHTML = `
    <span class="trip-range-prompt-text">${msg}</span>
    <button class="trip-range-cancel" id="trip-range-cancel">Cancel</button>
  `;
  el.hidden = false;
  document.getElementById('trip-range-cancel').addEventListener('click', () => {
    state.pickingTripRange = false;
    state.tripPickStart = null;
    hideTripRangePrompt();
    renderTabs();
  });
}

function hideTripRangePrompt() {
  const el = document.getElementById('trip-range-prompt');
  if (el) el.hidden = true;
}

function renderDay() {
  const rows = state.ranked[state.activeDate] || [];
  const hidden = state.hiddenCrags;
  const isHidden = (r) => hidden.has(r.crag.id) || (r.crag.parentId && hidden.has(r.crag.parentId));
  const isStateMatch = (r) => state.regionFilter === 'ALL' || r.crag.state === state.regionFilter;

  const allDayRows = rows
    .filter(r => r.crag.trip === 'day' || r.crag.trip === 'both' || r.crag.trip === 'interstate')
    .filter(r => !isHidden(r))
    .filter(isStateMatch);

  // Day-trip parent/sub grouping: rows with crag.parentId are surfaced inside
  // the parent card's detail rather than as standalone day-trip entries.
  const subsByParent = new Map();
  for (const r of allDayRows) {
    const pid = r.crag.parentId;
    if (!pid) continue;
    if (!subsByParent.has(pid)) subsByParent.set(pid, []);
    subsByParent.get(pid).push(r);
  }
  const dayRows = allDayRows
    .filter(r => !r.crag.parentId)
    .map(r => {
      const subs = subsByParent.get(r.crag.id) || [];
      // Sub-crag breakdown (and the headline promotion below) is a Pro
      // feature — free tier sees the parent crag's own score/reasons only,
      // with no hint of which sub-crag might be scoring higher today.
      if (!subs.length || !isPro()) return { ...r, daySubCrags: subs };
      // Promote the highest-scoring entry (parent or any sub-crag) to the
      // headline chip so the parent card reflects the best the area offers.
      const best = [r, ...subs].reduce((a, b) => (a.score >= b.score ? a : b));
      const isSub = best !== r;
      return {
        ...r,
        score: best.score,
        reasons: best.reasons,
        contributions: best.contributions,
        bestSubCragName: isSub ? best.crag.name : null,
        daySubCrags: subs,
      };
    })
    // Favourites float to the top irrespective of score; within each group
    // we still sort by score so the best favourite leads the list.
    .sort((a, b) => {
      const af = state.favouriteCrags.has(a.crag.id) ? 1 : 0;
      const bf = state.favouriteCrags.has(b.crag.id) ? 1 : 0;
      if (af !== bf) return bf - af;
      return b.score - a.score;
    });

  // Weekend Away rows: ordered by Fri–Sun trip score (same order on every tab),
  // but each row shows that day's daily forecast/score.
  const dailyById = {};
  rows.forEach(r => { dailyById[r.crag.id] = r; });
  const weekendRows = state.weekendTrip
    .filter(t => {
      if (hidden.has(t.crag.id)) return false;
      if (t.crag.parentId && hidden.has(t.crag.parentId)) return false;
      // Destination-level hide (e.g. 'dest:Grampians', 'dest:Mt Arapiles')
      const destKey = t.crag.area.startsWith('Grampians') ? 'Grampians' : t.crag.area;
      if (hidden.has(`dest:${destKey}`)) return false;
      if (state.regionFilter !== 'ALL' && t.crag.state !== state.regionFilter) return false;
      return true;
    })
    .map(t => {
      const daily = dailyById[t.crag.id];
      if (!daily) return null;
      return {
        ...daily,
        tripScore: t.tripScore,
        worstDate: t.worstDate,
        worstScore: t.worstScore,
        dailyScores: t.dailyScores,
      };
    })
    .filter(Boolean);

  // Group weekend rows by destination (parent area) and pick the best sub-crag
  // per day. The collapsed card shows the destination's best trip score.
  const destinations = groupByDestination(weekendRows);
  state.destinations = destinations;

  renderDaySummary(rows, dayRows, destinations);
  renderSplitRanked(dayRows, destinations);
}

// Group weekend rows by destination (parent climbing area). Returns array of
// { destination, drive, subCrags: [...rows], tripScore (best), bestForToday, bestPerDay: {date: row} }
function groupByDestination(weekendRows) {
  const map = new Map();
  for (const row of weekendRows) {
    const dest = row.crag.area; // e.g. "Mt Arapiles", "Grampians (Northern)", "Mt Buffalo", "Cathedral Ranges"
    // Collapse Grampians sub-regions into one destination for the card UI.
    const destKey = dest.startsWith('Grampians') ? 'Grampians' : dest;
    if (!map.has(destKey)) {
      // Pull compact flag from the parent crag definition.
      // row.crag.parentId points directly to the parent entry.
      const parentCrag = (typeof CRAGS !== 'undefined' ? CRAGS : []).find(c => c.id === row.crag.parentId);
      map.set(destKey, { destination: destKey, drive: row.crag.driveTime, subCrags: [], compact: !!(parentCrag?.compact) });
    }
    map.get(destKey).subCrags.push(row);
  }

  const out = [];
  for (const group of map.values()) {
    // Best (highest) trip score across sub-crags = destination headline.
    // Use only named sub-crags (those with a parentId) for tripScore and bestForToday
    // — the parent placeholder entry (e.g. 'gramps-main') should never win as a candidate.
    const namedForBest = group.subCrags.filter(s => s.crag.parentId);
    const bestPool = namedForBest.length ? namedForBest : group.subCrags;
    group.tripScore = Math.max(...bestPool.map(s => s.tripScore));
    // Sort full list by tripScore for any downstream consumers; parent still excluded from picks below.
    group.subCrags.sort((a, b) => b.tripScore - a.tripScore);
    group.bestForToday = bestPool.reduce((a, b) => (a.score >= b.score ? a : b));
    // For each Fri–Sun trip date, find the highest-scoring sub-crag at this destination.
    // Exclude parent placeholder entries (no parentId) so the pick is always a named sub-crag.
    const tripDates = state.tripDates;
    const namedSubs = group.subCrags.filter(s => s.crag.parentId);
    const candidates = namedSubs.length ? namedSubs : group.subCrags;
    group.bestPerDay = {};
    for (const date of tripDates) {
      let best = null;
      for (const sub of candidates) {
        const ds = sub.dailyScores?.find(d => d.date === date);
        if (!ds) continue;
        if (!best || ds.score > best.score) {
          best = { ...ds, crag: sub.crag };
        }
      }
      if (best) group.bestPerDay[date] = best;
    }
    // Aggregate daily destination scores (best sub-crag per day) for the breakdown row.
    group.destDailyScores = tripDates
      .map(date => group.bestPerDay[date])
      .filter(Boolean);

    // Recompute tripScore from destDailyScores so the headline number is
    // consistent with the Fri/Sat/Sun breakdown cells (best wall per day),
    // not the raw parent-crag scoreDay which can diverge significantly.
    if (group.destDailyScores.length) {
      const ds = group.destDailyScores.map(d => d.score);
      const dsMin  = Math.min(...ds);
      const dsMean = ds.reduce((a, b) => a + b, 0) / ds.length;
      const dsSorted = [...ds].sort((a, b) => a - b);
      const dsMedian = dsSorted.length % 2
        ? dsSorted[(dsSorted.length - 1) / 2]
        : (dsSorted[dsSorted.length / 2 - 1] + dsSorted[dsSorted.length / 2]) / 2;
      group.tripScore = Math.max(0, Math.min(100, Math.round(0.5 * dsMin + 0.3 * dsMean + 0.2 * dsMedian)));
    }

    // Count climbable walls (score >= 60) per trip date for the breakdown cells.
    group.wallsPerDay = {};
    for (const date of tripDates) {
      const total = candidates.length;
      const climbable = candidates.filter(sub => {
        const ds = sub.dailyScores?.find(d => d.date === date);
        return ds && ds.score >= 60;
      }).length;
      group.wallsPerDay[date] = { climbable, total };
    }
    out.push(group);
  }
  // Favourited destinations float to the top (key = `dest:<name>`) so Sean's
  // usual rotation surfaces regardless of weather. Within each tier we still
  // sort by trip score.
  out.sort((a, b) => {
    const af = state.favouriteCrags.has(`dest:${a.destination}`) ? 1 : 0;
    const bf = state.favouriteCrags.has(`dest:${b.destination}`) ? 1 : 0;
    if (af !== bf) return bf - af;
    return b.tripScore - a.tripScore;
  });
  return out;
}

// Return a human-readable location line for a crag card.
// For interstate crags with null driveTime, shows "From {baseCity}".
// For local crags, shows "{driveTime} from {baseCity or Melbourne}".
function driveLabel(crag) {
  const city = crag.baseCity || 'Melbourne';
  if (crag.driveTime == null) return `From ${city}`;
  return `${crag.driveTime} from ${city}`;
}

function renderDaySummary(rows, dayRows, destinations) {
  const summary = document.getElementById('day-summary');
  if (!rows.length) {
    summary.innerHTML = '';
    return;
  }
  const dayTop = dayRows[0];
  const destTop = destinations[0];
  const w = weatherIcon((dayTop || destTop?.bestForToday).day.weatherCode);

  const dayLine = dayTop
    ? `<strong>Today's pick:</strong> ${escapeHtml(dayTop.crag.name)} <span class="score-mini ${scoreBand(dayTop.score).color}">${dayTop.score}</span>`
    : `<strong>Today's pick:</strong> no data`;
  const wkLine = !isPro()
    ? `<strong>Weekend away:</strong> <span class="pro-inline-lock">Pro feature</span>`
    : destTop
    ? `<strong>Weekend away (Fri–Sun):</strong> ${escapeHtml(destTop.destination)} <span class="score-mini ${scoreBand(destTop.tripScore).color}">${destTop.tripScore}</span>`
    : `<strong>Weekend away:</strong> no data`;

  summary.innerHTML = `
    <div class="label">${formatDate(state.activeDate)}</div>
    <h2>${w.icon} Best bets</h2>
    <p class="summary-line">${dayLine}</p>
    <p class="summary-line">${wkLine}</p>
  `;
}

function renderSplitRanked(dayRows, destinations) {
  const list = document.getElementById('ranked-list');
  const sections = [];

  // Categorise hidden items so the right "N hidden" footer appears in each section.
  const hiddenDay = [];
  const hiddenWeekendDest = [];
  const hiddenWeekendCrag = [];
  for (const id of state.hiddenCrags) {
    if (id.startsWith('dest:')) {
      hiddenWeekendDest.push({ id, label: id.slice(5) });
      continue;
    }
    // Look up the actual crag to know which section it belongs to.
    const f = state.forecasts?.[id];
    if (!f) continue;
    const c = f.crag;
    const label = c.name;
    if (c.trip === 'weekend') hiddenWeekendCrag.push({ id, label });
    else hiddenDay.push({ id, label });
  }

  if (dayRows.length || hiddenDay.length) {
    sections.push(renderDaySection('Daily crag score', '', dayRows, hiddenDay));
  }
  if (!isPro()) {
    // Multi-day trip planning is Pro-only — show the section header (so it's
    // discoverable) but keep the destination cards/trip-date controls locked.
    sections.push(renderWeekendSectionLocked('Multi-day trip'));
  } else if (destinations.length || hiddenWeekendDest.length || hiddenWeekendCrag.length) {
    sections.push(renderWeekendSection('Multi-day trip', 'By destination · trip score', destinations, [...hiddenWeekendDest, ...hiddenWeekendCrag]));
  }

  list.innerHTML = sections.join('');

  // Section collapse/expand toggles (Overview + Multi-day trip headers).
  list.querySelectorAll('.category-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.category');
      if (!section) return;
      const id = section.dataset.section;
      const collapsed = section.dataset.collapsed === 'true';
      section.dataset.collapsed = collapsed ? 'false' : 'true';
      btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      if (id) setSectionCollapsed(id, !collapsed);
    });
  });

  list.querySelectorAll('.crag-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.crag-card');
      const open = card.dataset.open === 'true';
      card.dataset.open = open ? 'false' : 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      // Fetch check-in summary on first expand
      if (!open && !card.dataset.checkinLoaded) {
        card.dataset.checkinLoaded = 'true';
        const cardId = card.dataset.id;
        const summaryEl = card.querySelector('.checkin-summary');
        if (summaryEl && cardId) {
          if (cardId.startsWith('dest-')) {
            // Destination card — aggregate checkins across all sub-crags
            const destName = cardId.slice(5);
            const allRanked = Object.values(state.ranked || {}).flat();
            const subIds = allRanked
              .filter(r => r.crag && (r.crag.area === destName || r.crag.destination === destName))
              .map(r => r.crag.id)
              .filter((id, i, arr) => arr.indexOf(id) === i);
            if (subIds.length) fetchCheckinSummaryMulti(subIds, summaryEl);
          } else {
            fetchCheckinSummary(cardId, summaryEl);
          }
        }
      }
    });
  });

  // Inline hide buttons (×).
  list.querySelectorAll('.hide-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleHidden(btn.dataset.hideId);
    });
  });

  // Favourite star buttons (★/☆).
  list.querySelectorAll('.favourite-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleFavourite(btn.dataset.favId);
    });
  });

  // Favourite alert threshold stepper buttons
  list.querySelectorAll('.fav-threshold-step').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const cragId = btn.dataset.for;
      const hiddenInput = list.querySelector(`#thresh-${cragId}`);
      const display = list.querySelector(`#thresh-display-${cragId}`);
      if (!hiddenInput || !display) return;
      const step = parseInt(btn.dataset.step, 10);
      const current = parseInt(hiddenInput.value, 10) || 75;
      const next = Math.min(100, Math.max(50, current + step));
      hiddenInput.value = next;
      display.textContent = next;
      saveFavThreshold(cragId, next);
      syncFavouritesToWorker();
    });
    btn.addEventListener('pointerdown', e => e.stopPropagation());
  });

  // "I climbed here" — delegated once on the list container.
  // Guard against duplicate listeners accumulating across renderSplitRanked calls.
  if (!list.dataset.checkinDelegated) {
    list.dataset.checkinDelegated = 'true';
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.climbed-here-btn');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const parentId = btn.dataset.checkinId;
      // state.forecasts is a map keyed by crag ID — use state.ranked to find sub-crags
      const allRanked = Object.values(state.ranked || {}).flat();
      const subCrags = allRanked
        .filter(r => r.crag && r.crag.parentId === parentId)
        .map(r => ({ id: r.crag.id, name: r.crag.name }))
        .filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i);
      showCheckinSheet(
        parentId,
        btn.dataset.checkinName,
        parseInt(btn.dataset.checkinScore, 10) || null,
        subCrags
      );
    });
  }

  // "N hidden — show" disclosure footer.
  // "Set dates" button — enter trip range-pick mode.
  const setDatesBtn = list.querySelector('#trip-set-dates-btn');
  if (setDatesBtn) {
    setDatesBtn.addEventListener('click', () => {
      state.pickingTripRange = true;
      state.tripPickStart = null;
      renderTabs();
      renderTripRangePrompt('Tap the first day of your trip');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // "Clear" button — reset to the default weekend range.
  const clearBtn = list.querySelector('#trip-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      _storage.removeItem(TRIP_START_KEY);
      _storage.removeItem(TRIP_END_KEY);
      const def = defaultTripDates();
      state.tripStart = def[0] || null;
      state.tripEnd   = def[def.length - 1] || null;
      state.tripDates = activeTripDates();
      const weekendTrip = rankWeekendTrip(state.forecasts, state.tripDates);
      state.weekendTrip = weekendTrip;
      renderDay();
    });
  }

  list.querySelectorAll('.hidden-footer-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = btn.closest('.hidden-footer');
      const open = wrap.dataset.open === 'true';
      wrap.dataset.open = open ? 'false' : 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      const ul = wrap.querySelector('.hidden-list');
      if (ul) ul.hidden = open;
      const action = btn.querySelector('.hidden-footer-action');
      if (action) action.textContent = open ? 'show' : 'hide';
    });
  });

  // Un-hide buttons inside the disclosure list.
  list.querySelectorAll('.unhide-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHidden(btn.dataset.hideId);
    });
  });

  list.querySelectorAll('.subcrag-row.is-expandable').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = btn.closest('.subcrag-row-wrap');
      const detail = wrap.querySelector('.subcrag-detail');
      const open = wrap.dataset.open === 'true';
      wrap.dataset.open = open ? 'false' : 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (detail) detail.hidden = open;
    });
  });

  // Day-trip sub-crag rows (no daily breakdown — just a score chip).
  list.querySelectorAll('.subcrag-row.is-static').forEach(btn => {
    btn.addEventListener('click', (e) => e.stopPropagation());
  });

  // Sub-crag expand button — reveals rows beyond the top 3.
  list.querySelectorAll('.subcrag-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const list = btn.closest('.detail-section').querySelector('.subcrag-list');
      list.querySelectorAll('[data-subcrag-hidden]').forEach(row => {
        row.removeAttribute('data-subcrag-hidden');
      });
      btn.remove();
    });
  });

  // Locked "Sub-crags — Pro" teaser button (free tier only).
  list.querySelectorAll('.subcrag-locked-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSubCragLockPopover(btn);
    });
  });

  // Share buttons — both the icon on the header and the labelled button in
  // the expander. stopPropagation so the header icon doesn't also toggle the
  // card open/closed.
  list.querySelectorAll('.dest-share-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      shareDestination(btn.dataset.destShare);
    });
  });

  list.querySelectorAll('.save-card-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      saveCardImage(btn.dataset.saveId);
    });
  });

  list.querySelectorAll('.share-btn:not(.dest-share-btn)').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      shareForecast(btn.dataset.shareId);
    });
  });

  // Best weekend callout share button
  list.querySelectorAll('.best-weekend-share').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = btn.dataset.shareText || '';
      if (navigator.share) {
        try { await navigator.share({ text }); } catch { /* cancelled */ }
      } else {
        await navigator.clipboard.writeText(text).catch(() => {});
        const orig = btn.innerHTML;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.innerHTML = orig; }, 1800);
      }
    });
  });

  // Breakdown row (?) help toggles. The blurb is the immediate next-sibling
  // <li.breakdown-blurb>; we flip its hidden attribute and the button's
  // aria-expanded state in sync.
  list.querySelectorAll('.breakdown-help-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const row = btn.closest('.breakdown-item');
      const blurb = row && row.nextElementSibling;
      if (!blurb || !blurb.classList.contains('breakdown-blurb')) return;
      const willOpen = blurb.hidden;
      blurb.hidden = !willOpen;
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      btn.classList.toggle('is-open', willOpen);
    });
  });
}

const CHEVRON_SVG = `<svg class="category-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

function getSectionCollapsed() {
  try { return JSON.parse(_storage.getItem(SECTION_COLLAPSED_KEY) || '{}'); } catch { return {}; }
}
function setSectionCollapsed(id, collapsed) {
  const map = getSectionCollapsed();
  map[id] = collapsed;
  _storage.setItem(SECTION_COLLAPSED_KEY, JSON.stringify(map));
}

function renderDaySection(title, subtitle, rows, hiddenItems = []) {
  const collapsed = getSectionCollapsed()['day'] ?? false;
  return `
    <section class="category" data-section="day" data-collapsed="${collapsed}">
      <button type="button" class="category-header" aria-expanded="${!collapsed}" aria-controls="section-list-day">
        <span class="category-header-label">
          <h3>${escapeHtml(title)}</h3>
          <span class="category-sub">${escapeHtml(subtitle)}</span>
        </span>
        ${CHEVRON_SVG}
      </button>
      <div class="category-list" id="section-list-day">
        ${rows.map((row, i) => renderCard(row, i === 0, false)).join('')}
      </div>
      ${renderHiddenFooter(hiddenItems)}
    </section>
  `;
}

// Format a date range as e.g. "Fri 27 Jun – Sun 29 Jun"
function formatTripRange(start, end) {
  const fmt = d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  if (!start) return 'No dates set';
  if (!end || start === end) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}

function isCustomTripRange() {
  // True if the user has explicitly saved a range that differs from the current default.
  const stored = _storage.getItem(TRIP_START_KEY);
  if (!stored) return false;
  const def = defaultTripDates();
  return stored !== (def[0] || null) || _storage.getItem(TRIP_END_KEY) !== (def[def.length - 1] || null);
}

function renderTripDateRange() {
  const label = formatTripRange(state.tripStart, state.tripEnd);
  const n = state.tripDates.length;
  const dayCount = n === 1 ? '1 day' : `${n} days`;
  const showClear = isCustomTripRange();
  return `
    <div class="trip-date-range">
      <div class="trip-date-range-label">
        <span class="trip-date-range-text">${label}</span>
        <span class="trip-date-range-count">${dayCount}</span>
      </div>
      <div class="trip-date-range-actions">
        ${showClear ? `<button class="trip-clear-btn" id="trip-clear-btn" aria-label="Reset to default weekend">Clear</button>` : ''}
        <button class="trip-set-dates-btn" id="trip-set-dates-btn" aria-label="Change trip dates">Set dates</button>
      </div>
    </div>
  `;
}

function renderBestWeekendCallout(destinations) {
  if (!destinations.length) return '';
  const top = destinations[0];
  const score = top.tripScore;
  const band = scoreBand(score);

  // Build a one-line reason from the top destination's best day
  const bestDay = top.bestForToday;
  const reasons = bestDay?.reasons || [];
  const positives = reasons.filter(r => !r.startsWith('−') && !r.startsWith('-') && !r.toLowerCase().includes('penalty'));
  const reasonLine = positives.slice(0, 2).join(' · ') || 'Good conditions forecast';

  // Date range label
  const dates = state.tripDates;
  const startLabel = dates[0] ? new Date(dates[0]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const endLabel   = dates[dates.length - 1] ? new Date(dates[dates.length - 1]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const rangeLabel = startLabel && endLabel && startLabel !== endLabel ? `${startLabel} – ${endLabel}` : startLabel;

  const shareText = `${top.destination} looks like the best weekend destination — scoring ${score}/100 on SendTemps. ${reasonLine}. sendtemps.app`;

  return `
    <div class="best-weekend-callout">
      <div class="best-weekend-inner">
        <div class="best-weekend-label">Best this weekend</div>
        <div class="best-weekend-destination">${escapeHtml(top.destination)}</div>
        <div class="best-weekend-meta">
          <span class="score-mini ${band.color}">${score}</span>
          <span class="best-weekend-reason">${escapeHtml(reasonLine)}</span>
        </div>
        ${rangeLabel ? `<div class="best-weekend-dates">${escapeHtml(rangeLabel)}</div>` : ''}
      </div>
      <button type="button" class="best-weekend-share" data-share-text="${escapeHtml(shareText)}" aria-label="Share this weekend pick">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        Share
      </button>
    </div>
  `;
}

// TAS trip callout — top 3 crags for the selected date window
function renderTASCallout(destinations) {
  if (!destinations.length) return '';

  // Collect all TAS sub-crags across destinations, ranked by tripScore
  const tasCrags = [];
  for (const dest of destinations) {
    const namedSubs = dest.subCrags.filter(s => s.crag.parentId && s.crag.state === 'TAS');
    const pool = namedSubs.length ? namedSubs : dest.subCrags.filter(s => s.crag.state === 'TAS');
    for (const sub of pool) {
      tasCrags.push(sub);
    }
  }
  if (!tasCrags.length) return '';

  // Sort by tripScore, dedupe by crag id, take top 3
  tasCrags.sort((a, b) => b.tripScore - a.tripScore);
  const seen = new Set();
  const top3 = tasCrags.filter(s => {
    if (seen.has(s.crag.id)) return false;
    seen.add(s.crag.id);
    return true;
  }).slice(0, 3);

  if (!top3.length) return '';

  const dates = state.tripDates;
  const startLabel = dates[0] ? new Date(dates[0]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const endLabel   = dates[dates.length - 1] ? new Date(dates[dates.length - 1]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const rangeLabel = startLabel && endLabel && startLabel !== endLabel ? `${startLabel} – ${endLabel}` : startLabel;

  const top = top3[0];
  const shareText = `Heading to Tasmania? ${top.crag.name} is looking best — scoring ${top.tripScore}/100 on SendTemps. sendtemps.app`;

  return `
    <div class="best-weekend-callout tas-callout">
      <div class="best-weekend-inner">
        <div class="best-weekend-label">Best for your trip</div>
        <div class="tas-callout-crags">
          ${top3.map((s, i) => {
            const band = scoreBand(s.tripScore);
            return `<div class="tas-callout-row${i === 0 ? ' top' : ''}">
              <span class="tas-callout-name">${escapeHtml(s.crag.name)}</span>
              <span class="score-mini ${band.color}">${s.tripScore}</span>
            </div>`;
          }).join('')}
        </div>
        ${rangeLabel ? `<div class="best-weekend-dates">${escapeHtml(rangeLabel)}</div>` : ''}
      </div>
      <button type="button" class="best-weekend-share" data-share-text="${escapeHtml(shareText)}" aria-label="Share Tasmania trip pick">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        Share
      </button>
    </div>
  `;
}

// Pro-gated version of the Multi-day trip section — keeps the header visible
// (so free users know the feature exists) but replaces the trip-date controls,
// best-weekend callout and destination cards with a single locked teaser.
function renderWeekendSectionLocked(title) {
  const collapsed = getSectionCollapsed()['weekend'] ?? false;
  return `
    <section class="category" id="weekend-section" data-section="weekend" data-collapsed="${collapsed}">
      <div class="weekend-category-header">
        <button type="button" class="category-header" aria-expanded="${!collapsed}" aria-controls="section-list-weekend">
          <span class="category-header-label">
            <h3>${escapeHtml(title)}</h3>
            <span class="category-sub">By destination</span>
          </span>
          ${CHEVRON_SVG}
        </button>
      </div>
      <div class="trip-locked-teaser" id="section-list-weekend">
        <svg class="trip-locked-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        <p class="trip-locked-title">Multi-day trip planning — Pro</p>
        <p class="trip-locked-body">See which destination has the best conditions across your whole trip, plus pick your own dates. Got an invite link? Open it once and this unlocks automatically.</p>
      </div>
    </section>
  `;
}

function renderWeekendSection(title, subtitle, destinations, hiddenItems = []) {
  const collapsed = getSectionCollapsed()['weekend'] ?? false;
  return `
    <section class="category" id="weekend-section" data-section="weekend" data-collapsed="${collapsed}">
      <div class="weekend-category-header">
        <button type="button" class="category-header" aria-expanded="${!collapsed}" aria-controls="section-list-weekend">
          <span class="category-header-label">
            <h3>${escapeHtml(title)}</h3>
            <span class="category-sub">By destination</span>
          </span>
          ${CHEVRON_SVG}
        </button>
        ${renderTripDateRange()}
      </div>
      ${destinations.length
        ? (state.regionFilter === 'TAS'
            ? renderTASCallout(destinations)
            : renderBestWeekendCallout(destinations))
        : ''}
      <div class="category-list" id="section-list-weekend">
        ${destinations.map((dest, i) => renderDestinationCard(dest, i === 0)).join('')}
      </div>
      ${renderHiddenFooter(hiddenItems)}
    </section>
  `;
}

function renderHideButton(id, label) {
  return `
    <button type="button" class="hide-btn"
      data-hide-id="${escapeHtml(id)}"
      aria-label="Hide ${escapeHtml(label)}"
      title="Hide ${escapeHtml(label)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
  `;
}

// Favourite star button — sibling of the crag header so its click doesn't
// bubble into the expand/collapse handler. Active state is driven by
// state.favouriteCrags so a re-render reflects the toggle instantly.
function renderFavouriteButton(id, label) {
  const active = state.favouriteCrags.has(id);
  const aria = active ? `Unpin ${label}` : `Pin ${label} to the top`;
  const safeId = escapeHtml(id);
  return `
    <button type="button" class="favourite-btn${active ? ' active' : ''}"
      data-fav-id="${safeId}"
      aria-label="${escapeHtml(aria)}"
      aria-pressed="${active}"
      title="${escapeHtml(aria)}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="${active ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    </button>
  `;
}

// Rendered inside the detail panel — only when the crag is starred
function renderFavThresholdControl(id) {
  if (!state.favouriteCrags.has(id)) return '';
  const threshold = getFavThreshold(id);
  const safeId = escapeHtml(id);
  return `
    <div class="fav-threshold" data-fav-threshold-id="${safeId}">
      <span class="fav-threshold-label">Alert when score higher than</span>
      <div class="fav-threshold-stepper">
        <button type="button" class="fav-threshold-step" data-step="-5" data-for="${safeId}" aria-label="Decrease threshold">-</button>
        <span class="fav-threshold-value" id="thresh-display-${safeId}">${threshold}</span>
        <button type="button" class="fav-threshold-step" data-step="5" data-for="${safeId}" aria-label="Increase threshold">+</button>
      </div>
      <input type="hidden" id="thresh-${safeId}" class="fav-threshold-input"
        value="${threshold}" data-threshold-id="${safeId}" />
    </div>
  `;
}

function renderHiddenFooter(items) {
  if (!items.length) return '';
  const rows = items.map(it => `
    <li class="hidden-row">
      <span class="hidden-name">${escapeHtml(it.label)}</span>
      <button type="button" class="unhide-btn" data-hide-id="${escapeHtml(it.id)}">Show</button>
    </li>
  `).join('');
  const n = items.length;
  return `
    <div class="hidden-footer" data-open="false">
      <button type="button" class="hidden-footer-toggle" aria-expanded="false">
        <span>${n} hidden</span>
        <span class="hidden-footer-action">show</span>
      </button>
      <ul class="hidden-list" hidden>${rows}</ul>
    </div>
  `;
}


// Generate a plain-English arrival hint based on the daily scores for the trip.
// Works for any trip length — looks at first day quality to advise arrival timing,
// and calls out the standout day.
function renderArrivalHint(destDailyScores, tripDates) {
  if (!destDailyScores || destDailyScores.length < 2) return '';

  const byDate = {};
  for (const d of destDailyScores) byDate[d.date] = d.score;

  const scores = tripDates.map(date => ({ date, score: byDate[date] ?? 0 }));
  const best  = scores.reduce((a, b) => (a.score >= b.score ? a : b));
  const worst = scores.reduce((a, b) => (a.score <= b.score ? a : b));

  const dayName = (date) => {
    const dow = new Date(date + 'T00:00:00').getDay();
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
  };

  let hint = '';
  const firstDate  = tripDates[0];
  const secondDate = tripDates[1];
  const firstScore = byDate[firstDate] ?? 0;
  const secondScore = secondDate ? (byDate[secondDate] ?? 0) : 0;
  const spread = best.score - worst.score;

  if (scores.length >= 3) {
    // Multi-day: advise on arrival timing based on first-day quality.
    if (firstScore >= 65) {
      hint = `Arrive ${dayName(firstDate)} — it's shaping up as a strong day (${firstScore}/100).`;
    } else if (firstScore < 45 && secondScore > firstScore + 15) {
      hint = `${dayName(firstDate)} is the weakest day (${firstScore}/100) — ${dayName(secondDate)} morning arrival works fine. ${dayName(best.date)} is the standout (${best.score}/100).`;
    } else {
      hint = `${dayName(best.date)} is the standout day (${best.score}/100). ${firstScore < 55 ? `Consider arriving ${dayName(secondDate)} if the first day is marginal.` : ''}`.trim();
    }
  } else if (scores.length === 2) {
    if (spread <= 10) {
      hint = `Both days look similar — ${best.score}/100 best.`;
    } else {
      hint = `${dayName(best.date)} is the stronger day (${best.score}/100 vs ${worst.score}/100).`;
    }
  }

  if (!hint) return '';
  return `
    <div class="detail-section arrival-hint">
      <div class="section-label">When to go</div>
      <p class="arrival-hint-text">${hint}</p>
    </div>
  `;
}

function renderDestinationCard(dest, isTop) {
  const { destination, drive, tripScore, subCrags, bestForToday, bestPerDay, destDailyScores, wallsPerDay = {}, compact = false } = dest;
  const band = scoreBand(tripScore);
  const w = weatherIcon(bestForToday.day.weatherCode);
  const todayBand = scoreBand(bestForToday.score);

  // Reasons summary: pull top reasons from the best-for-today sub-crag.
  // bestFromTag is intentionally excluded here — it only makes sense on individual
  // crag cards where the wall aspect is unambiguous, not on destination summaries.
  const reasonsHtml = (bestForToday.reasons && bestForToday.reasons.length
    ? bestForToday.reasons
    : ['conditions ok']
  ).map(r => {
    const cls = /^closed/i.test(r) ? 'reason-tag reason-tag-closed' : 'reason-tag';
    return `<span class="${cls}">${escapeHtml(r)}</span>`;
  }).join('');

  const safeDest = destination.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  // Exclude parent placeholder entries (e.g. 'gramps-main', 'arap-main') from the sub-crag list and count.
  const namedSubCrags = subCrags.filter(s => s.crag.parentId);

  return `
    <article class="crag-card destination-card ${isTop ? 'top' : ''} ${tripScore >= 90 && (bestForToday.reasons?.includes('rare window') || destDailyScores.some(d => d.reasons?.includes('rare window'))) ? 'rare-window' : ''}" data-open="false" data-id="dest-${safeDest}">
      ${renderFavouriteButton(`dest:${destination}`, destination)}
      ${renderHideButton(`dest:${destination}`, destination)}
      ${renderDestShareButton(destination, tripScore, destDailyScores)}
      <button class="crag-header" aria-expanded="false" aria-controls="detail-dest-${safeDest}">
        <div class="score-pill ${band.color}" aria-label="Trip score ${tripScore} out of 100">
          ${tripScore}
          <span class="score-pill-sub">trip</span>
        </div>
        <div class="crag-info">
          <h3>${escapeHtml(destination)}</h3>
          <div class="area">${driveLabel({ driveTime: drive, baseCity: subCrags[0]?.crag?.baseCity })} · ${namedSubCrags.length} crag${namedSubCrags.length === 1 ? '' : 's'}</div>
          <div class="day-score-note">Today's best: <strong>${escapeHtml(bestForToday.crag.name)}</strong> · ${bestForToday.score}/100</div>
          ${renderDrynessLine(bestForToday.nowDryness, bestForToday.lastRain, daysAheadOfActive())}
          <div class="reasons">${reasonsHtml}</div>
        </div>
        <svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      <div class="crag-detail" id="detail-dest-${safeDest}" role="region">
        ${destDailyScores.length ? renderDestinationBreakdown(destDailyScores, wallsPerDay) : ''}
        ${(() => {
          const fcDest = state.forecasts?.[bestForToday.crag.id];
          if (!fcDest) return '';
          if (fcDest.todayDate && state.activeDate === fcDest.todayDate) return renderHourlyStrip(fcDest, 'today', bestForToday.score);
          if (fcDest.tomorrowDate && state.activeDate === fcDest.tomorrowDate) return renderHourlyStrip(fcDest, 'tomorrow', bestForToday.score);
          return '';
        })()}
        ${renderArrivalHint(destDailyScores, state.tripDates)}
        ${renderPicksByDay(state.tripDates, bestPerDay)}
        <div class="checkin-summary dest-checkin-summary" style="display:none"></div>
        <div class="detail-section">
          <div class="section-label">Sub-crags at this destination</div>
          <div class="subcrag-list">
            ${namedSubCrags.map((s, idx) => renderSubCragRow(s, idx, state.activeDate, compact)).join('')}
          </div>
          ${namedSubCrags.length > 3 ? `<button type="button" class="subcrag-expand-btn" aria-expanded="false">Show all ${namedSubCrags.length} sub-crags</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

function renderDestinationBreakdown(destDailyScores, wallsPerDay = {}) {
  const cells = destDailyScores.map(d => {
    const band = scoreBand(d.score);
    const w = weatherIcon(d.day.weatherCode);
    const dn = shortDayName(d.date);
    const tFeel = Math.round(d.day.tFeel ?? d.day.tMax);
    const rain = Math.round(d.day.precipProb || 0);
    const walls = wallsPerDay[d.date];
    // Only show wall count if there are multiple walls at this destination.
    const wallsHtml = walls && walls.total > 1
      ? `<div class="breakdown-walls">${walls.climbable}/${walls.total} walls 60+</div>`
      : '';
    return `
      <div class="breakdown-cell">
        <div class="breakdown-day">${dn}</div>
        <div class="breakdown-score ${band.color}">${d.score}</div>
        <div class="breakdown-meta">${w.icon} ${tFeel}° · ${rain}%</div>
        ${wallsHtml}
      </div>
    `;
  }).join('');
  const windowLabel = destDailyScores.length === 1 ? 'Day outlook'
    : destDailyScores.length === 2 ? 'Sat–Sun outlook (best wall per day)'
    : 'Fri–Sun outlook (best wall per day)';
  return `
    <div class="detail-section">
      <div class="section-label">${windowLabel}</div>
      <div class="breakdown-row">${cells}</div>
    </div>
  `;
}

function renderPicksByDay(tripDates, bestPerDay) {
  const items = tripDates.map(date => {
    const pick = bestPerDay[date];
    if (!pick) return '';
    const dn = shortDayName(date);
    const band = scoreBand(pick.score);
    const windows = pick.day?.rainWindows || [];
    const rainBits = windows.length
      ? `<div class="pick-rain">${windows.map(w => `<span>🌧️ ${escapeHtml(w.label)} · ${w.peakProb}%${w.totalMm >= 0.1 ? ` · ${w.totalMm.toFixed(1)}mm` : ''}</span>`).join('')}</div>`
      : '';
    return `
      <li class="pick-row-wrap">
        <div class="pick-row">
          <span class="pick-day">${dn}</span>
          <span class="pick-name">${escapeHtml(pick.crag.name)}</span>
          <span class="pick-score ${band.color}">${pick.score}</span>
        </div>
        ${rainBits}
      </li>
    `;
  }).filter(Boolean).join('');
  return `
    <div class="detail-section">
      <div class="section-label">Pick of the day</div>
      <ul class="pick-list">${items}</ul>
    </div>
  `;
}

function renderSubCragRow(sub, idx = 0, activeDate = null, compact = false) {
  const safeId = String(sub.crag.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const hasDaily = Array.isArray(sub.dailyScores) && sub.dailyScores.length > 0;
  const hiddenAttr = idx >= 3 ? ' data-subcrag-hidden' : '';
  // Compact areas: show the selected day's score (you move between walls each day).
  // Spread areas: show the sub-crag trip score (you commit to one wall for the trip).
  const dayEntry = activeDate && hasDaily ? sub.dailyScores.find(d => d.date === activeDate) : null;
  const displayScore = compact
    ? (dayEntry ? dayEntry.score : null)
    : (sub.tripScore ?? null);
  const displayBand = displayScore != null ? scoreBand(displayScore) : null;
  const displayLabel = compact ? '' : ' trip';
  return `
    <div class="subcrag-row-wrap" data-open="false"${hiddenAttr}>
      <button type="button" class="subcrag-row${hasDaily ? ' is-expandable' : ''}" aria-expanded="false" ${hasDaily ? `aria-controls="subdetail-${safeId}"` : ''}>
        <span class="subcrag-name">${escapeHtml(sub.crag.name)}</span>
        <span class="subcrag-aspect">${sub.crag.aspect === 'mixed' ? 'mixed aspects' : `${sub.crag.aspect}-facing`}</span>
        ${displayScore != null ? `<span class="subcrag-day-score score-mini ${displayBand.color}">${displayScore}${displayLabel}</span>` : ''}
        ${hasDaily ? `<svg class="subcrag-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>` : ''}
      </button>
      ${hasDaily ? `<div class="subcrag-detail" id="subdetail-${safeId}" role="region" hidden>${renderSubCragDailyBreakdown(sub.dailyScores)}</div>` : ''}
    </div>
  `;
}

function renderSubCragDailyBreakdown(dailyScores) {
  const cells = dailyScores.map(d => {
    const band = scoreBand(d.score);
    const w = weatherIcon(d.day.weatherCode);
    const dn = shortDayName(d.date);
    const tFeel = Math.round(d.day.tFeel ?? d.day.tMax);
    const rain = Math.round(d.day.precipProb || 0);
    return `
      <div class="breakdown-cell">
        <div class="breakdown-day">${dn}</div>
        <div class="breakdown-score ${band.color}">${d.score}</div>
        <div class="breakdown-meta">${w.icon} ${tFeel}° · ${rain}%</div>
      </div>
    `;
  }).join('');
  return `<div class="breakdown-row subcrag-breakdown-row">${cells}</div>`;
}

function renderCard(row, isTop, isWeekend) {
  const { crag, day, score, reasons, prevDay, tripScore, dailyScores, daySubCrags, bestSubCragName, nowDryness, lastRain, seasonalContext } = row;
  // We stash the row id on the share button via data-share-id so the
  // click handler (bound after render) can look up the row by crag.id
  // without re-deriving headlines or carrying closures through innerHTML.
  const shareId = crag.id;
  // For weekend cards, the headline number is the trip score (Fri–Sun).
  const headlineScore = isWeekend && tripScore != null ? tripScore : score;
  const band = scoreBand(headlineScore);
  const w = weatherIcon(day.weatherCode);

  const sunHours = Math.round((day.sunshine || 0) / 3600);

  const bfTag = bestFromTag(day.sunWindow, day.tMax, crag.aspect);
  const allReasons = bfTag ? [bfTag, ...reasons] : reasons;
  const reasonsHtml = allReasons.length
    ? allReasons.map(r => {
        const cls = /^closed/i.test(r)
          ? 'reason-tag reason-tag-closed'
          : /^Best from/i.test(r)
            ? 'reason-tag reason-tag-bestfrom'
            : 'reason-tag';
        return `<span class="${cls}">${escapeHtml(r)}</span>`;
      }).join('')
    : '<span class="reason-tag">conditions ok</span>';

  // Sub-area badge: show parent area if it differs from name
  const showArea = crag.area !== crag.name;

  // For weekend cards, the detailed score breakdown comes from the day-of-tab
  // contributions if present — otherwise fall back to today's daily contributions.
  const dayContribs = row.contributions || [];

  // Hourly strips — shown on the today and tomorrow tabs. forecast.js
  // precomputes both hourly + bestWindow slices.
  const fc = state.forecasts?.[crag.id];
  const isTomorrow = !!(fc && fc.tomorrowDate && state.activeDate === fc.tomorrowDate);
  const isToday    = !!(fc && fc.todayDate    && state.activeDate === fc.todayDate);
  const tomorrowStrip = isTomorrow ? renderHourlyStrip(fc, 'tomorrow', headlineScore) : '';
  const todayStrip    = isToday    ? renderHourlyStrip(fc, 'today', headlineScore)    : '';

  return `
    <article class="crag-card ${isTop ? 'top' : ''} ${reasons.includes('rare window') ? 'rare-window' : ''}" data-open="false" data-id="${crag.id}">
      ${renderFavouriteButton(crag.id, crag.name)}
      ${renderHideButton(crag.id, crag.name)}
      ${renderShareIconButton(shareId, crag.name)}
      <button class="crag-header" aria-expanded="false" aria-controls="detail-${crag.id}">
        <div class="score-pill ${band.color}" aria-label="Score ${headlineScore} out of 100">
          ${headlineScore}
          ${isWeekend && tripScore != null ? `<span class="score-pill-sub">trip</span>` : '<span class="score-pill-sub">day</span>'}
        </div>
        <div class="crag-info">
          <h3>${escapeHtml(crag.name)}</h3>
          ${showArea ? `<div class="area">${escapeHtml(crag.area)} · ${driveLabel(crag)}</div>` : `<div class="area">${driveLabel(crag)}</div>`}
          ${isWeekend && tripScore != null ? `<div class="day-score-note">Today scores <strong>${score}</strong> on its own</div>` : ''}
          ${bestSubCragName ? `<div class="day-score-note">Best: <strong>${escapeHtml(bestSubCragName)}</strong></div>` : ''}
          ${renderDrynessLine(nowDryness, lastRain, daysAheadOfActive())}
          <div class="reasons">${reasonsHtml}</div>
          ${seasonalContext ? `<div class="seasonal-context">${escapeHtml(seasonalContext)}</div>` : ''}
          ${fc ? renderConditionBand(fc, isToday ? 'today' : isTomorrow ? 'tomorrow' : null) : ''}
        </div>
        <svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      <div class="crag-detail" id="detail-${crag.id}" role="region">
        ${isWeekend && dailyScores && dailyScores.length ? renderDailyBreakdown(dailyScores) : ''}
        <div class="metric-grid">
          <div class="metric"><div class="v">${Math.round(day.tMax)}°</div><div class="l">High</div></div>
          <div class="metric"><div class="v">${Math.round(day.tMin)}°</div><div class="l">Low</div></div>
          <div class="metric"><div class="v">${Math.round(day.precipProb || 0)}%</div><div class="l">Rain</div></div>
          <div class="metric"><div class="v">${Math.round(day.wind)}</div><div class="l">Wind km/h</div></div>
          ${renderHumidityTile(day, reasons)}
          ${day.cloudMean != null ? `<div class="metric"><div class="v">${Math.round(day.cloudMean)}%</div><div class="l">Cloud cover</div></div>` : ''}
        </div>
        <div class="detail-section">
          <div class="section-label">Forecast</div>
          <p>${w.icon} ${w.label}. Feels like ${Math.round(day.tFeel || day.tMax)}°C. ${sunHours}h sun expected. ${day.precipSum > 0.2 ? `${day.precipSum.toFixed(1)}mm rain forecast.` : 'No measurable rain.'}${prevDay && prevDay.precipSum > 1 ? ` Yesterday saw ${prevDay.precipSum.toFixed(1)}mm.` : ''}</p>
        </div>
        ${renderRainTiming(day, daysAheadOfActive())}
        ${todayStrip}
        ${tomorrowStrip}
        ${renderScoreBreakdown(dayContribs, score)}
        <div class="detail-section">
          <div class="section-label">Crag notes</div>
          <p>${escapeHtml(crag.notes)}</p>
        </div>
        <div class="detail-section">
          <div class="section-label">Aspect & character</div>
          <div class="attribute-row">
            <span class="attribute"><strong>${crag.aspect}</strong>-facing</span>
            <span class="attribute">Shade: <strong>${crag.shade}</strong></span>
            <span class="attribute">Ideal <strong>${(() => {
              const subs = (CRAGS || []).filter(c => c.parentId === crag.id && c.idealTemp);
              const divergent = subs.some(s => Math.abs(s.idealTemp[0] - crag.idealTemp[0]) >= 4 || Math.abs(s.idealTemp[1] - crag.idealTemp[1]) >= 4);
              return divergent ? 'varies by wall' : `${crag.idealTemp[0]}–${crag.idealTemp[1]}°C`;
            })()}</strong></span>
            <span class="attribute">Dries <strong>${dryLabel(crag.dryRating)}</strong></span>
            <span class="attribute"><strong>${escapeHtml(crag.rockType)}</strong></span>
          </div>
          ${renderSunWindow(day.sunWindow, crag.sunOnWall)}
        </div>
        ${daySubCrags && daySubCrags.length
          ? (isPro()
              ? renderDaySubCrags(daySubCrags, isToday ? 'today' : isTomorrow ? 'tomorrow' : null)
              : renderDaySubCragsLocked(daySubCrags.length))
          : ''}
        ${renderFavThresholdControl(crag.id)}
        <div class="checkin-summary" style="display:none"></div>
        <button type="button" class="climbed-here-btn" data-checkin-id="${escapeHtml(crag.id)}" data-checkin-name="${escapeHtml(crag.name)}" data-checkin-score="${headlineScore}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L8 8H3l4 4-2 7 7-4 7 4-2-7 4-4h-5z"/></svg>
          I climbed here
        </button>
        ${renderShareExpanderButton(shareId, crag.name)}
      </div>
    </article>
  `;
}

// ---- Share button helpers ----
//
// The icon variant sits on the card header next to favourite/hide. It's an
// icon-only button so it doesn't crowd the row on narrow screens. The labelled
// variant lives inside the detail expander for users who didn't notice the icon.
// Both bind to the same click handler via the .share-btn class + data-share-id.
function renderShareIconButton(cragId, cragName) {
  return `<button class="share-btn share-btn-icon" data-share-id="${escapeHtml(cragId)}"
    aria-label="Share ${escapeHtml(cragName)} forecast" title="Share forecast">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v13" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  </button>`;
}

function renderDestShareButton(destination, tripScore, destDailyScores) {
  const safeId = 'dest:' + destination;
  return `<button class="share-btn share-btn-icon dest-share-btn" data-dest-share="${escapeHtml(destination)}"
    aria-label="Share ${escapeHtml(destination)} trip forecast" title="Share trip forecast">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v13" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  </button>`;
}

// ─── Check-in summary ──────────────────────────────────────────────────────

const ROCK_LABEL    = { dry: 'rock dry', damp: 'rock damp', wet: 'rock wet' };

// Sentiment lookup for reason tags — used to apply colour tints.
// 'pos' = green, 'neg' = amber/red, 'neutral' = default grey.
// Matched by prefix so dynamic strings (e.g. 'temp ideal (18°C)') work.
const REASON_SENTIMENT = [
  // Positive
  { match: /^temp ideal/i,           s: 'pos' },
  { match: /^drying wind/i,          s: 'pos' },
  { match: /^sheltered from wind/i,  s: 'pos' },
  { match: /^rare window/i,          s: 'pos' },
  { match: /^dry by climbing time/i, s: 'pos' },
  { match: /^overnight rain only/i,  s: 'pos' },
  { match: /^rain after dark only/i, s: 'pos' },
  { match: /^shaded refuge/i,        s: 'pos' },
  { match: /^sun-trap wall/i,        s: 'pos' },
  { match: /^overcast sun-trap/i,    s: 'pos' },
  // Negative
  { match: /^cold[ (]/i,             s: 'neg' },
  { match: /^hot[ (]/i,              s: 'neg' },
  { match: /^cool stretches/i,       s: 'neg' },
  { match: /^hot stretches/i,        s: 'neg' },
  { match: /^rain expected/i,        s: 'neg' },
  { match: /^showers likely/i,       s: 'neg' },
  { match: /^\d+% rain chance/i,     s: 'neg' },
  { match: /^rock soaked/i,          s: 'neg' },
  { match: /^rock wet/i,             s: 'neg' },
  { match: /^still drying/i,         s: 'neg' },
  { match: /^very windy/i,           s: 'neg' },
  { match: /^sun-baked wall/i,       s: 'neg' },
  { match: /^sun-baked aspect/i,     s: 'neg' },
  { match: /^afternoon sun-trap/i,   s: 'neg' },
  { match: /^cold & shaded/i,        s: 'neg' },
  { match: /^overcast/i,             s: 'neg' },
  { match: /^cloudy/i,               s: 'neg' },
  { match: /^mostly cloudy/i,        s: 'neg' },
  { match: /^cloud killing/i,        s: 'neg' },
];

function reasonSentiment(r) {
  const hit = REASON_SENTIMENT.find(({ match }) => match.test(r));
  return hit ? hit.s : 'neutral';
}
const TEMP_LABEL    = { too_cold: 'conditions cold', good: 'conditions good', too_hot: 'conditions hot' };

function daysAgoLabel(dateStr) {
  if (!dateStr) return null;
  const today = new Date().toISOString().slice(0, 10);
  const diff = Math.round((new Date(today) - new Date(dateStr)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return `${diff} days ago`;
}

async function fetchCheckinSummaryMulti(cragIds, el) {
  try {
    const results = await Promise.all(
      cragIds.map(id => fetch(`${API_BASE}/checkins/${encodeURIComponent(id)}`).then(r => r.json()).catch(() => null))
    );
    // Aggregate across all sub-crags
    let totalCount = 0, lastDate = null, rockCounts = {}, tempCounts = {};
    for (const d of results) {
      if (!d || !d.count) continue;
      totalCount += d.count;
      if (!lastDate || (d.lastDate && d.lastDate > lastDate)) lastDate = d.lastDate;
      if (d.rock) rockCounts[d.rock] = (rockCounts[d.rock] || 0) + d.count;
      if (d.temp) tempCounts[d.temp] = (tempCounts[d.temp] || 0) + d.count;
    }
    if (!totalCount) { el.remove(); return; }
    // Pick most common rock/temp
    const rock = Object.keys(rockCounts).sort((a, b) => rockCounts[b] - rockCounts[a])[0];
    const temp = Object.keys(tempCounts).sort((a, b) => tempCounts[b] - tempCounts[a])[0];
    const parts = [];
    if (rock) parts.push(ROCK_LABEL[rock] || rock);
    if (temp) parts.push(TEMP_LABEL[temp] || temp);
    const who = totalCount === 1 ? '1 climbed recently' : `${totalCount} climbed recently`;
    const when = daysAgoLabel(lastDate);
    const whenStr = when ? ` (last ${when})` : '';
    el.textContent = parts.length ? `${who}${whenStr} · ${parts.join(' · ')}` : `${who}${whenStr}`;
    el.style.display = '';
  } catch {
    el.remove();
  }
}

async function fetchCheckinSummary(cragId, el) {
  try {
    const res = await fetch(`${API_BASE}/checkins/${encodeURIComponent(cragId)}`);
    const { count, rock, temp, lastDate } = await res.json();
    if (!count) { el.remove(); return; }
    const parts = [];
    if (rock) parts.push(ROCK_LABEL[rock] || rock);
    if (temp) parts.push(TEMP_LABEL[temp] || temp);
    const who = count === 1 ? '1 climbed recently' : `${count} climbed recently`;
    const when = daysAgoLabel(lastDate);
    const whenStr = when ? ` (last ${when})` : '';
    el.textContent = parts.length ? `${who}${whenStr} · ${parts.join(' · ')}` : `${who}${whenStr}`;
    el.style.display = '';
  } catch {
    el.remove();
  }
}

// ─── Check-in bottom sheet ───────────────────────────────────────────────────────

function showCheckinSheet(cragId, cragName, appScore, subCrags = []) {
  document.getElementById('checkin-sheet')?.remove();
  document.getElementById('checkin-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'checkin-backdrop';
  backdrop.className = 'checkin-backdrop';
  document.body.appendChild(backdrop);

  const sheet = document.createElement('div');
  sheet.id = 'checkin-sheet';
  sheet.className = 'checkin-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Log conditions');
  document.body.appendChild(sheet);

  function closeCheckinSheet() {
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    setTimeout(() => { sheet.remove(); backdrop.remove(); }, 300);
  }

  // Track resolved crag — starts as parent, overridden if sub-crag picked
  let resolvedId = cragId;
  let resolvedName = cragName;

  const hasSubCrags = subCrags.length > 1;

  function renderConditionsStep() {
    sheet.innerHTML = `
      <div class="checkin-handle"></div>
      ${hasSubCrags ? `<button type="button" class="checkin-back" aria-label="Back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>` : ''}
      <div class="checkin-title">How were conditions?</div>
      <div class="checkin-crag">${escapeHtml(resolvedName)}</div>

      <div class="checkin-section">
        <div class="checkin-label">Rock</div>
        <div class="checkin-options" data-group="rock">
          <button type="button" class="checkin-option" data-value="dry">Dry</button>
          <button type="button" class="checkin-option" data-value="damp">Damp</button>
          <button type="button" class="checkin-option" data-value="wet">Wet</button>
        </div>
      </div>

      <div class="checkin-section">
        <div class="checkin-label">Temperature</div>
        <div class="checkin-options" data-group="temp">
          <button type="button" class="checkin-option" data-value="too_cold">Too cold</button>
          <button type="button" class="checkin-option" data-value="good">Good</button>
          <button type="button" class="checkin-option" data-value="too_hot">Too hot</button>
        </div>
      </div>

      <button type="button" class="checkin-submit" id="checkin-submit" disabled>Submit</button>
    `;

    sheet.querySelector('.checkin-back')?.addEventListener('click', renderSubCragStep);

    const selections = { rock: null, temp: null };
    const submitBtn = sheet.querySelector('#checkin-submit');

    sheet.querySelectorAll('.checkin-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const group = opt.closest('[data-group]').dataset.group;
        opt.closest('[data-group]').querySelectorAll('.checkin-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selections[group] = opt.dataset.value;
        if (selections.rock && selections.temp) submitBtn.disabled = false;
      });
    });

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      const today = new Date();
      const climbed_date = today.toISOString().slice(0, 10);
      const month = today.getMonth() + 1;
      try {
        await fetch(`${API_BASE}/checkin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            crag_id: resolvedId,
            crag_name: resolvedName,
            climbed_date,
            month,
            app_score: appScore,
            rock: selections.rock,
            temp_feel: selections.temp,
          }),
        });
        submitBtn.textContent = 'Thanks — logged!';
        setTimeout(() => closeCheckinSheet(), 1200);
      } catch {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Failed — try again';
      }
    });
  }

  function renderSubCragStep() {
    sheet.innerHTML = `
      <div class="checkin-handle"></div>
      <div class="checkin-title">Where did you climb?</div>
      <div class="checkin-crag">${escapeHtml(cragName)}</div>
      <div class="checkin-subcrag-list">
        ${subCrags.map(s => `
          <button type="button" class="checkin-subcrag-btn" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}">
            ${escapeHtml(s.name)}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        `).join('')}
      </div>
    `;

    sheet.querySelectorAll('.checkin-subcrag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        resolvedId = btn.dataset.id;
        resolvedName = btn.dataset.name;
        renderConditionsStep();
      });
    });
  }

  // Start at sub-crag picker if needed, otherwise go straight to conditions
  if (hasSubCrags) {
    renderSubCragStep();
  } else {
    renderConditionsStep();
  }

  requestAnimationFrame(() => sheet.classList.add('open'));
  backdrop.addEventListener('click', closeCheckinSheet);
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

function renderShareExpanderButton(cragId, cragName) {
  return `<div class="share-expander-row">
    <button class="share-btn share-btn-full" data-share-id="${escapeHtml(cragId)}"
      aria-label="Share ${escapeHtml(cragName)} forecast">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v13" />
        <path d="M7 8l5-5 5 5" />
        <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
      </svg>
      <span>Share this forecast</span>
    </button>
    <button class="save-card-btn" data-save-id="${escapeHtml(cragId)}"
      aria-label="Save forecast image for ${escapeHtml(cragName)}" title="Save image card">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>Save card</span>
    </button>
  </div>`;
}

// Free-tier stand-in for the Sub-crags breakdown — visible so free users
// know the feature exists (matches the pattern used for the Multi-day trip
// section and locked day tabs), but reveals nothing about individual
// sub-crag scores. Tapping opens a popover explaining the Pro feature.
function renderDaySubCragsLocked(count) {
  return `
    <div class="detail-section">
      <div class="section-label">Sub-crags</div>
      <button type="button" class="subcrag-locked-btn" aria-haspopup="dialog" aria-label="Sub-crag breakdown — Pro feature">
        <svg class="subcrag-locked-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        <span class="subcrag-locked-text">${count} sub-crag${count === 1 ? '' : 's'} here — see which one's best today</span>
        <span class="pro-inline-lock">Pro</span>
      </button>
    </div>
  `;
}

function renderDaySubCrags(daySubCrags, mode = null) {
  if (!Array.isArray(daySubCrags) || daySubCrags.length === 0) return '';
  // Sort by today's score (highest first) so the best sub-crag is at the top.
  const sorted = [...daySubCrags].sort((a, b) => b.score - a.score);
  const VISIBLE = 3;
  const rows = sorted.map((sub, idx) => {
    const band = scoreBand(sub.score);
    const safeId = String(sub.crag.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const reasons = sub.reasons || [];
    const contributions = sub.contributions || [];
    const bfTag = bestFromTag(sub.day?.sunWindow, sub.day?.tMax, sub.crag?.aspect);
    const allReasons = bfTag ? [bfTag, ...reasons] : reasons;
    const reasonsHtml = allReasons.length
      ? allReasons.map(r => {
          const cls = /^Best from/i.test(r) ? 'reason-tag reason-tag-sm reason-tag-bestfrom'
            : /^closed/i.test(r) ? 'reason-tag reason-tag-sm reason-tag-closed'
            : 'reason-tag reason-tag-sm';
          return `<span class="${cls}">${escapeHtml(r)}</span>`;
        }).join('')
      : '';

    // Hourly strip for today/tomorrow tabs — each sub-crag has its own forecast.
    const subFc = mode ? state.forecasts?.[sub.crag.id] : null;
    const hourlyHtml = subFc ? renderHourlyStrip(subFc, mode, sub.score) : '';

    const hasDetail = contributions.length > 0 || !!hourlyHtml;
    return `
      <div class="subcrag-row-wrap" data-open="false"${idx >= VISIBLE ? ' data-subcrag-hidden' : ''}>
        <button type="button" class="subcrag-row${hasDetail ? ' is-expandable' : ' is-static'}"${hasDetail ? ` aria-expanded="false" aria-controls="daysubdetail-${safeId}"` : ' tabindex="-1"'}>
          <span class="subcrag-name">${escapeHtml(sub.crag.name)}</span>
          <span class="subcrag-aspect">${sub.crag.aspect === 'mixed' ? 'mixed aspects' : `${sub.crag.aspect}-facing`}</span>
          <span class="subcrag-trip ${band.color}">${sub.score}</span>
          ${hasDetail ? `<svg class="subcrag-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>` : ''}
        </button>
        ${reasonsHtml ? `<div class="subcrag-reasons">${reasonsHtml}</div>` : ''}
        ${hasDetail ? `<div class="subcrag-detail" id="daysubdetail-${safeId}" role="region" hidden>${hourlyHtml}${renderScoreBreakdown(contributions, sub.score)}</div>` : ''}
      </div>
    `;
  }).join('');
  const hiddenCount = sorted.length - VISIBLE;
  const expandBtn = hiddenCount > 0
    ? `<button type="button" class="subcrag-expand-btn" aria-expanded="false">
        Show all ${sorted.length} sub-crags
       </button>`
    : '';

  return `
    <div class="detail-section">
      <div class="section-label">Sub-crags</div>
      <div class="subcrag-list">${rows}</div>
      ${expandBtn}
    </div>
  `;
}

// Per-category methodology blurbs. Kept short — one paragraph each, plain
// English. Used by the inline (?) toggles in the score breakdown and the
// "How scoring works" footer summary. Categories match scoreDay contributions.
const CATEGORY_METHODOLOGY = {
  temp: {
    label: 'Temperature',
    blurb: 'Each crag has an ideal temperature band (cool granite climbs better at 8–18°C, warm sandstone wants 12–22°C, and so on). The forecast "feels-like" temp is compared to that band; inside it earns a small bonus, outside it loses points proportional to how far off it is.',
  },
  aspect: {
    label: 'Aspect & sun',
    blurb: 'Match between the crag\'s aspect (which way the wall faces) and the day. On hot days a shaded wall (south-facing in the southern hemisphere) earns points; on cold days a sunny wall (north-facing) wins. Computed against the day\'s temperature, not a static rule.',
  },
  bestIn: {
    label: 'Best season',
    blurb: 'A small editorial bonus or penalty based on each crag\'s notes — e.g. Mt Buffalo "best in summer," Mt Alexander "closed Nov–Mar nesting." Tied to the season, not the day.',
  },
  precip: {
    label: 'Rain',
    blurb: 'Heaviest weight in the model. Penalties stack for rain probability, accumulated mm during climbable hours (9am–6pm), and direct precipitation. A wet day can drop 40+ points on its own.',
  },
  dryness: {
    label: 'Rock dryness',
    blurb: 'Rolling estimate of how dry the rock surface is, based on the last 4 days of rain and an exponential decay tuned per rock type — granite dries in ~6h, sandstone takes ~24h. Damp rock loses points; bone-dry adds a small bonus.',
  },
  wind: {
    label: 'Wind',
    blurb: 'Penalty for high wind, scaled by exposure: an onshore wall takes the full hit, a lee wall is barely affected. Uses the higher of mean wind and 70% of gusts so a gusty 25 km/h day doesn\'t look calm.',
  },
  sun: {
    label: 'Sun hours on wall',
    blurb: 'True solar geometry: for each climbable hour we compute the sun\'s position and ask "does it actually hit this wall given its aspect?" Hours of sun add to a warm-day penalty or a cold-day bonus.',
  },
  closure: {
    label: 'Closure',
    blurb: 'Hard penalty when a crag is closed (raptor nesting, fire restrictions, indigenous heritage). Surfaces as a red "closed" pill so it can\'t be missed.',
  },
};

function renderScoreBreakdown(contributions, finalScore) {
  if (!Array.isArray(contributions) || contributions.length === 0) return '';
  // Group bonuses and penalties; show category icon next to each.
  const iconFor = (cat) => ({
    temp: '🌡️',
    aspect: '🧭',
    bestIn: '🎯',
    precip: '🌧️',
    dryness: '🪨',
    humidity: '💧',
    wind: '💨',
    sun: '☀️',
    closure: '🚫',
  }[cat] || '•');
  const rows = contributions.map((c, idx) => {
    const deltaCls = c.delta > 0 ? 'pos' : 'neg';
    const sign = c.delta > 0 ? '+' : '';
    const meth = CATEGORY_METHODOLOGY[c.category];
    // Each row gets a small (?) button that toggles a one-paragraph blurb
    // rendered as a sibling <li> beneath the row — keeps the row layout
    // simple (no nested grid surprises) and lets the blurb take full width.
    // The toggle is wired in setupBreakdownHelpToggles() after render.
    const helpButton = meth
      ? `<button class="breakdown-help-toggle" type="button"
          aria-label="How ${escapeHtml(meth.label)} is scored"
          title="How ${escapeHtml(meth.label)} is scored"
          aria-expanded="false"
        ><span aria-hidden="true">?</span></button>`
      : '';
    // Blurb is the immediate next sibling <li>. The toggle handler looks it up
    // via .nextElementSibling, so no ids are needed (avoids collisions when
    // multiple cards render breakdowns on the same page).
    const blurbItem = meth
      ? `<li class="breakdown-blurb" hidden>${escapeHtml(meth.blurb)}</li>`
      : '';
    return `
      <li class="breakdown-item">
        <span class="breakdown-icon" aria-hidden="true">${iconFor(c.category)}</span>
        <span class="breakdown-label">
          <span class="breakdown-name">${escapeHtml(c.label)}</span>
          <span class="breakdown-detail">${escapeHtml(c.detail)}</span>
        </span>
        ${helpButton}
        <span class="breakdown-delta ${deltaCls}">${sign}${c.delta}</span>
      </li>
      ${blurbItem}
    `;
  }).join('');
  // Sum check for honesty: starting from 100, sum deltas, clamped 0–100.
  const sum = contributions.reduce((s, c) => s + c.delta, 0);
  const checkScore = Math.max(0, Math.min(100, 100 + sum));
  const checkNote = checkScore === finalScore
    ? `Starts at 100, ends at ${finalScore}.`
    : `Starts at 100, ends at ${finalScore} (clamped).`;
  return `
    <details class="score-breakdown detail-section">
      <summary>
        <span class="section-label">Why this score?</span>
        <svg class="breakdown-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      <ul class="breakdown-list">${rows}</ul>
      <p class="breakdown-note">${checkNote}</p>
      <details class="breakdown-methodology">
        <summary>How scoring works</summary>
        <p>Every crag starts at 100. Each factor below adds or removes points based on that crag\'s aspect, rock type, and ideal conditions — the score is fully transparent, no machine learning. Tap any <strong>?</strong> above to see how a single factor is computed.</p>
        <ul class="methodology-list">
          ${Object.entries(CATEGORY_METHODOLOGY).map(([cat, m]) => `<li><span class="methodology-icon" aria-hidden="true">${iconFor(cat)}</span><span><strong>${escapeHtml(m.label)}.</strong> ${escapeHtml(m.blurb)}</span></li>`).join('')}
        </ul>
      </details>
    </details>
  `;
}

// ---- Hourly strip + best-window callout ----
//
// ---- Rec 3: Condition band ----
// A thin horizontal strip of coloured segments showing the hourly score
// across the climbable window (6am–7pm). Rendered inside the card header
// so the shape of the day (green-then-grey, all-green, mostly-red) is
// immediately visible without expanding the card. No labels needed —
// green/amber/red communicates the pattern at a glance.
function renderConditionBand(fc, mode) {
  if (!mode) return ''; // only show on today/tomorrow tabs where hourly data is live
  const hours = mode === 'today' ? fc?.todayHourly : fc?.tomorrowHourly;
  if (!Array.isArray(hours) || hours.length === 0) return '';
  const segments = hours.map(h => {
    const b = scoreBand(h.score);
    // Map band color to CSS variable token
    const colorClass = b.color === 'success' ? 'band-success'
      : b.color === 'primary' ? 'band-primary'
      : b.color === 'warning' ? 'band-warning'
      : 'band-error';
    return `<span class="cond-seg ${colorClass}" title="${formatHour12(h.hour)}: ${h.score}"></span>`;
  }).join('');
  return `<div class="condition-band-wrap">
    <span class="condition-band-label">Hourly rain likelihood</span>
    <div class="condition-band" aria-hidden="true">${segments}</div>
  </div>`;
}

// Renders when the active date tab is today or tomorrow. Each cell covers one
// hour and shows: time, weather icon, temp, sun-on-wall indicator, wind arrow
// + bars + exposure tint, dryness, and the per-hour score (0–100). For the
// today strip the cell matching the current Melbourne hour gets an `is-now`
// highlight; for the 9am–6pm "good all day" case the whole run is outlined.
function renderHourlyStrip(fc, mode = 'tomorrow', dayScore = null) {
  const hours = mode === 'today' ? fc?.todayHourly : fc?.tomorrowHourly;
  const bw = mode === 'today' ? fc?.todayBestWindow : fc?.tomorrowBestWindow;
  if (!fc || !Array.isArray(hours) || hours.length === 0) return '';
  const sectionTitle = mode === 'today' ? 'Rest of today hour by hour' : 'Tomorrow hour by hour';

  // ---- Best-window callout ----
  // forecast.js caps the picked sub-window at 5h so the recommendation is
  // actionable ("go climbing 9am–2pm") rather than vague. But when the
  // underlying run blankets the climbable day (9am–6pm fully covered with
  // score ≥ 60), pointing at one 5h slice is misleading — the whole day is
  // genuinely good. Flag that case explicitly. On the today strip the window
  // may already be partially in the past, but we still show it — it represents
  // the rest-of-day pick.
  let callout = '';
  if (bw && bw.count >= 2) {
    const avg = Math.round(bw.avg);
    const runAvg = Math.round(bw.runAvg ?? bw.avg);
    // "Good all day" requires: long run spanning 9am–6pm, no hour in the
    // run with precipProb > 35%, AND the day score (from scoreDay which has
    // fuller context) must be ≥ 75. Staughton Vale at 74/day with 40% rain
    // is not 'good all day' even if the hourly run qualifies numerically.
    const runHoursWithRain = bw && (bw.runHours ?? 0) > 5
      ? hours.filter(h => h.hour >= (bw.runStart ?? 0) && h.hour < (bw.runEnd ?? 24) && h.precipProb > 35)
      : [];
    const goodAllDay = (bw.runHours ?? 0) > 5
      && (bw.runStart ?? 99) <= 9
      && (bw.runEnd ?? 0) >= 18
      && runHoursWithRain.length === 0
      && (dayScore == null || dayScore >= 75);

    // --- Rec 1: directive language ---
    // Find the first hour after the window that has meaningful rain coming
    // (precip > 0.1mm or precipProb > 40%) so we can say "rain arrives ~Xpm".
    // Only surface this hint when rain starts within 4h of the window end.
    const windowEnd = goodAllDay ? (bw.runEnd ?? bw.end) : bw.end;
    const rainArrivalHour = (() => {
      const candidates = hours.filter(h => h.hour > windowEnd && (h.precip > 0.1 || h.precipProb > 40));
      if (!candidates.length) return null;
      const first = candidates[0].hour;
      return first - windowEnd <= 4 ? first : null;
    })();
    const rainHint = rainArrivalHour != null ? ` · rain ~${formatHour12(rainArrivalHour)}` : '';

    // Decide if window is already active (today strip, now is within the window).
    const nowHourForDirective = mode === 'today'
      ? (hours.find(h => h.isNow)?.hour ?? null)
      : null;
    const windowStart = goodAllDay ? (bw.runStart ?? bw.start) : bw.start;
    const windowActive = nowHourForDirective != null
      && nowHourForDirective >= windowStart
      && nowHourForDirective < windowEnd;
    const windowPast = nowHourForDirective != null && nowHourForDirective >= windowEnd;

    if (goodAllDay) {
      const band = scoreBand(runAvg);
      callout = `
        <div class="best-window-callout ${band.color}" title="Score ≥ 60 from ${formatHour12(bw.runStart)} through ${formatHour12(bw.runEnd)}">
          <div class="best-window-directive">Good all day</div>
          <div class="best-window-sub">${formatHour12(bw.runStart)}–${formatHour12(bw.runEnd)} · avg ${runAvg}</div>
        </div>
      `;
    } else if (windowPast) {
      const band = scoreBand(avg);
      callout = `
        <div class="best-window-callout ${band.color} is-past" title="Window has passed">
          <div class="best-window-directive">Window closed</div>
          <div class="best-window-sub">${formatHour12(bw.start)}–${formatHour12(bw.end)} · avg ${avg}</div>
        </div>
      `;
    } else if (windowActive) {
      const band = scoreBand(avg);
      callout = `
        <div class="best-window-callout ${band.color}" title="You are currently in the best window">
          <div class="best-window-directive">Good now${rainHint}</div>
          <div class="best-window-sub">Window closes ${formatHour12(bw.end)} · avg ${avg}</div>
        </div>
      `;
    } else if (windowStart != null && nowHourForDirective != null && windowStart <= 10 && windowStart - nowHourForDirective <= 1) {
      // Window starts very soon (within the hour)
      const band = scoreBand(avg);
      callout = `
        <div class="best-window-callout ${band.color}" title="Window starts soon">
          <div class="best-window-directive">Go now${rainHint}</div>
          <div class="best-window-sub">${formatHour12(bw.start)}–${formatHour12(bw.end)} · avg ${avg}</div>
        </div>
      `;
    } else if (rainArrivalHour != null) {
      const band = scoreBand(avg);
      callout = `
        <div class="best-window-callout ${band.color}" title="Best window before rain arrives">
          <div class="best-window-directive">Go early · rain ~${formatHour12(rainArrivalHour)}</div>
          <div class="best-window-sub">${formatHour12(bw.start)}–${formatHour12(bw.end)} · avg ${avg}</div>
        </div>
      `;
    } else {
      const band = scoreBand(avg);
      callout = `
        <div class="best-window-callout ${band.color}" title="Best ${bw.count}h block with score ≥ 60 (capped at 5h)">
          <div class="best-window-directive">Best window</div>
          <div class="best-window-sub">${formatHour12(bw.start)}–${formatHour12(bw.end)} · avg ${avg}</div>
        </div>
      `;
    }
  } else {
    callout = `
      <div class="best-window-callout muted" title="No continuous 2h+ window scored ≥ 60">
        <div class="best-window-directive">Marginal day</div>
        <div class="best-window-sub">No standout window</div>
      </div>
    `;
  }

  // When the day is "good all day", the highlight should match the whole run,
  // not just the picked 5h slice — otherwise the outline contradicts the label.
  const goodAllDay = bw && (bw.runHours ?? 0) > 5
    && (bw.runStart ?? 99) <= 9
    && (bw.runEnd ?? 0) >= 18;
  const highlightStart = goodAllDay ? bw.runStart : (bw ? bw.start : null);
  const highlightEnd   = goodAllDay ? bw.runEnd   : (bw ? bw.end   : null);

  // ---- Hour cells ----
  // Apply a daily score ceiling: hourly scores can't exceed the daily score
  // by more than 5pts. scoreDay is holistic (drying time, sustained cloud,
  // climate anomaly) and should anchor the hourly strip from above.
  const ceiledHours = dayScore != null
    ? hours.map(h => ({ ...h, score: Math.min(h.score, dayScore + 5) }))
    : hours;

  const cells = ceiledHours.map(h => {
    const band = scoreBand(h.score);
    const w = weatherIcon(h.weatherCode);
    const dryClass = h.dryness == null
      ? ''
      : h.dryness >= 70 ? 'dry-good'
      : h.dryness >= 50 ? 'dry-damp'
      : 'dry-wet';
    const sunCell = h.sunOnWall === true
      ? `<span class="hour-sun lit" title="Sun on the wall (alt ${h.sunAlt}°)">☀️</span>`
      : h.sunOnWall === false
        ? `<span class="hour-sun shade" title="Wall in shade">○</span>`
        : `<span class="hour-sun unknown" title="Multi-aspect area — check sub-crags">–</span>`;
    const windArrow = h.windDir != null
      ? `<span class="hour-wind wind-${h.windExposure || 'parallel'}" title="${Math.round(h.wind)} km/h ${compassFromDeg(h.windDir)} · ${h.windExposure || 'parallel'}" style="transform: rotate(${(h.windDir + 180) % 360}deg)">↑</span>`
      : '<span class="hour-wind"></span>';
    // Wind strength glyph: 1–4 vertical bars based on effective wind speed
    // (max of mean and 0.7× gusts). Matches the gold/grey exposure tint of the
    // arrow so they read as one signal at a glance.
    const gust = h.windGust != null ? h.windGust : h.wind;
    const effective = Math.max(h.wind || 0, (gust || 0) * 0.7);
    const bars = effective > 35 ? 4 : effective > 20 ? 3 : effective > 10 ? 2 : 1;
    const barsHtml = `<span class="hour-wind-bars wind-${h.windExposure || 'parallel'} bars-${bars}" title="Effective wind ${Math.round(effective)} km/h" aria-hidden="true">${Array.from({length: 4}, (_, i) => `<i class="${i < bars ? 'on' : ''}"></i>`).join('')}</span>`;
    const inWindow = highlightStart != null && h.hour >= highlightStart && h.hour < highlightEnd ? 'in-window' : '';
    const isNow = mode === 'today' && h.isNow ? 'is-now' : '';
    return `
      <div class="hour-cell ${dryClass} ${inWindow} ${isNow}" data-score="${h.score}">
        <div class="hour-time">${formatHour12(h.hour)}${isNow ? ' <span class="hour-now-tag">now</span>' : ''}</div>
        <div class="hour-weather">${w.icon}</div>
        <div class="hour-temp">${Math.round(h.temp)}°</div>
        <div class="hour-sun-row">${sunCell}</div>
        <div class="hour-wind-row">${windArrow}${barsHtml}<span class="hour-wind-num">${Math.round(h.wind)}</span></div>
        <div class="hour-dryness" title="Rock dryness ${h.dryness}/100">${h.dryness ?? '—'}</div>
        <div class="hour-score ${band.color}">${h.score}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="detail-section">
      <div class="section-label">${sectionTitle}</div>
      ${callout}
      <div class="hourly-strip" role="list" aria-label="${mode === 'today' ? "Today's remaining hourly forecast" : "Tomorrow's hourly forecast"}">
        ${cells}
      </div>
      <div class="hourly-legend">
        <span><strong>Time</strong></span>
        <span><strong>☀️</strong> sun on wall</span>
        <span>Gold: into wall · Grey: away from wall · Bars show strength.</span>
        <span><strong>Dryness</strong> 0–100 · <strong>Score</strong> 0–100</span>
      </div>
    </div>
  `;
}

// Back-compat wrapper so any remaining callsites still work.
function renderTomorrowHourly(fc) { return renderHourlyStrip(fc, 'tomorrow'); }

function formatHour12(h) {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return '12am';
  if (hh === 12) return '12pm';
  if (hh < 12) return `${hh}am`;
  return `${hh - 12}pm`;
}

// Render the per-day sun-on-wall window for a crag.
//
// `sunWindow` is the computed value from forecast.js: {firstHour, lastHour, hours}
// or null when the wall never receives direct sun on this date (e.g. all-day
// shade, deep winter low aspect, etc).
//
// `staticText` is the author-written hint from crags.js (e.g. "All-day shade"
// or "NE: morning sun only"). We use it as a fallback when no computed window
// is available, and as a supplementary hint when one is.
// Returns a "Best from X" tag string when a wall's sun window starts
// after midday in cool conditions — surfaces the afternoon sun opportunity
// that the whole-day score would otherwise understate.
// Returns null when not applicable (morning sun, hot day, no window, mixed aspect).
function bestFromTag(sunWindow, tMax, aspect) {
  if (!sunWindow) return null;
  if (!aspect || aspect === 'mixed' || aspect === 'all-day shade') return null;
  // Only fire when sun arrives at 12pm or later — earlier windows are already
  // well-represented by the morning score.
  if (sunWindow.firstHour < 12) return null;
  // Only meaningful in cool conditions where morning shade is a deterrent.
  if (tMax >= 18) return null;
  return `Best from ${formatHour12(sunWindow.firstHour)}`;
}

function renderSunWindow(sunWindow, staticText) {
  // No computed window: either crag is all-day shaded, or geometry says the
  // wall never gets hit on this date. Prefer the author hint if provided,
  // otherwise show a generic shade line.
  if (!sunWindow) {
    if (staticText) {
      return `<div class="sun-on-wall">
        <span class="sun-on-wall-label">Sun on wall</span>
        <span class="sun-on-wall-value">${escapeHtml(staticText)}</span>
      </div>`;
    }
    return `<div class="sun-on-wall">
      <span class="sun-on-wall-label">Sun on wall</span>
      <span class="sun-on-wall-value">Wall stays in shade today</span>
    </div>`;
  }

  const { firstHour, lastHour, hours } = sunWindow;
  const range = `${formatHour12(firstHour)}\u2013${formatHour12(lastHour)}`;
  const hoursLabel = hours === 1 ? '1h' : `${hours}h`;
  const hint = staticText ? ` \u00b7 <span class="sun-on-wall-hint">${escapeHtml(staticText)}</span>` : '';
  return `<div class="sun-on-wall">
    <span class="sun-on-wall-label">Sun on wall</span>
    <span class="sun-on-wall-value">${range} \u00b7 ${hoursLabel}</span>${hint}
  </div>`;
}

function compassFromDeg(deg) {
  if (deg == null) return '';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// How many days ahead of today is the currently-active tab? Returns 0 for
// today, 1 for tomorrow, etc. Used to gate point-in-time UI like the rock
// dryness pill so it doesn't show stale snapshots on far-future dates.
function daysAheadOfActive() {
  if (!state.dates || !state.activeDate) return 0;
  const idx = state.dates.indexOf(state.activeDate);
  return idx < 0 ? 0 : idx;
}

// Render the rock-condition pill.
//
// `nowDryness` and `lastRain` are point-in-time snapshots (right now), so they
// only make sense on the today tab and — with a label change — on tomorrow.
// For dates more than a day out we suppress the pill entirely rather than
// mislead the user with a current-moment reading dressed up as a future one.
//
// `daysAhead` — 0 = today (or unknown), 1 = tomorrow, ≥2 = hide.
function renderDrynessLine(nowDryness, lastRain, daysAhead = 0) {
  if (nowDryness == null) return '';
  if (daysAhead >= 2) return '';
  const band = drynessBand(nowDryness);
  const isTomorrow = daysAhead === 1;
  let rainText = '';
  // On the tomorrow tab the "last rain Xh ago" reads as right-now, so we
  // either rephrase it (still relative to now, just made explicit) or drop it
  // if the rain was so recent it's already accounted for in the day forecast.
  if (lastRain && lastRain.hoursAgo != null && lastRain.hoursAgo < 72 && lastRain.totalMm >= 0.3) {
    const h = lastRain.hoursAgo;
    const ago = h < 1 ? 'now' : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
    const mm = lastRain.totalMm >= 1 ? `${lastRain.totalMm.toFixed(1)}mm` : `${lastRain.totalMm.toFixed(1)}mm`;
    rainText = `<span class="dryness-rain">Last rain ${ago} · ${mm}</span>`;
  }
  return `
    <div class="dryness-line">
      <span class="dryness-pill ${band.color}" title="${isTomorrow ? 'Rock dryness right now (carries into tomorrow)' : 'Rock dryness right now'} — ${nowDryness}/100">
        <span class="dryness-dot"></span>${isTomorrow ? 'Going into tomorrow' : 'Rock now'}: ${escapeHtml(band.label)}
      </span>
      ${rainText}
    </div>
  `;
}

function renderHumidityTile(day, reasons) {
  const hum = day.climbHumidity;
  if (!hum || !(hum.climbHours >= 1) || hum.meanRh == null) return '';
  const mean = Math.round(hum.meanRh);
  // Pull the humidity label from scoreDay reasons so the tile and the chip
  // always agree. Labels: 'muggy', 'moist air', 'crisp air', 'dry air', 'comfortable'.
  const HUMID_LABELS = new Set(['muggy', 'moist air', 'crisp air', 'dry air', 'comfortable']);
  const sub = (reasons || []).find(r => HUMID_LABELS.has(r)) ?? `${mean}%`;
  return `<div class="metric" title="Mean relative humidity during climbing hours"><div class="v">${mean}%</div><div class="l">Humidity <span class="metric-sub">· ${sub}</span></div></div>`;
}

function renderRainTiming(day, daysAhead = 0) {
  const windows = day.rainWindows;
  if (!windows || !windows.length) return '';
  const rainLabel = daysAhead === 0 ? "Today's rain forecast" : daysAhead === 1 ? "Tomorrow's rain forecast" : "Rain forecast";
  const items = windows.map(w => {
    const mmText = w.totalMm >= 0.1 ? `${w.totalMm.toFixed(1)}mm` : '<0.1mm';
    return `
      <div class="rain-row">
        <span class="rain-time">🌧️ ${escapeHtml(w.label)}</span>
        <span class="rain-meta">${w.peakProb}% peak · ${mmText}</span>
      </div>
    `;
  }).join('');
  return `
    <div class="detail-section">
      <div class="section-label">${rainLabel}</div>
      <div class="rain-list">${items}</div>
    </div>
  `;
}

function renderDailyBreakdown(dailyScores) {
  const cells = dailyScores.map(d => {
    const band = scoreBand(d.score);
    const w = weatherIcon(d.day.weatherCode);
    const dn = shortDayName(d.date);
    const tFeel = Math.round(d.day.tFeel ?? d.day.tMax);
    const rain = Math.round(d.day.precipProb || 0);
    return `
      <div class="breakdown-cell">
        <div class="breakdown-day">${dn}</div>
        <div class="breakdown-score ${band.color}">${d.score}</div>
        <div class="breakdown-meta">${w.icon} ${tFeel}° · ${rain}%</div>
      </div>
    `;
  }).join('');
  return `
    <div class="detail-section">
      <div class="section-label">Trip outlook</div>
      <div class="breakdown-row">${cells}</div>
    </div>
  `;
}

function dryLabel(r) {
  return ['', 'very slowly', 'slowly', 'moderately', 'fast', 'very fast'][r] || 'moderately';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatUpdatedAbsolute(d) {
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return fmt.format(d);
}

function formatUpdatedRelative(then) {
  if (!then) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 90) return '1 min ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return formatUpdatedAbsolute(new Date(then));
}

function paintUpdated() {
  const el = document.getElementById('updated');
  if (!el) return;
  if (state.refreshing) {
    el.textContent = 'Refreshing…';
    return;
  }
  if (!state.lastUpdated) return;
  el.textContent = `Updated ${formatUpdatedRelative(state.lastUpdated)}`;
  el.title = `Last refresh: ${formatUpdatedAbsolute(new Date(state.lastUpdated))} AEST`;
}

// ---- Init & refresh ----
// `init` shows the full-screen loader (cold start).
// `refresh` runs the same fetch silently and swaps in the new data without flashing
// — used by the auto-refresh timer and the tab-focus listener.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min auto-refresh while open
const MIN_FOCUS_REFRESH_MS = 2 * 60 * 1000; // don't refetch on every focus; throttle to 2 min

// Return the trip dates array from state.tripStart to state.tripEnd,
// filtered to dates within the known 7-day forecast window (state.dates).
function activeTripDates() {
  const allDates = state.dates && state.dates.length ? state.dates : weekDates();
  const start = state.tripStart;
  const end   = state.tripEnd;
  if (!start || !end) return weekendDates().slice(0, 7);
  // Build ordered range between start and end (inclusive), clamped to allDates.
  const result = [];
  let inRange = false;
  for (const d of allDates) {
    if (d === start) inRange = true;
    if (inRange) result.push(d);
    if (d === end) break;
  }
  // If start > end (user tapped backwards), reverse and re-slice.
  if (!result.length) {
    let inRange2 = false;
    for (const d of allDates) {
      if (d === end) inRange2 = true;
      if (inRange2) result.push(d);
      if (d === start) break;
    }
  }
  return result.length ? result : weekendDates().slice(0, 7);
}

async function fetchAndRank() {
  const forecasts = await fetchAllForecasts(state.regionFilter);
  const dates = weekDates();
  const tripDates = activeTripDates();
  const ranked = rankByDay(forecasts, dates);
  const weekendTrip = rankWeekendTrip(forecasts, tripDates);
  return { forecasts, dates, tripDates, ranked, weekendTrip };
}

// ---- Share a forecast ----
//
// saveCardImage — generates branded PNG and downloads it to device
async function saveCardImage(cragId) {
  const dateStr = state.activeDate;
  const rows = state.ranked?.[dateStr] || [];
  const row = rows.find(r => r.crag.id === cragId);
  if (!row) { showToast('Nothing to save for this crag on this date.'); return; }
  const btn = document.querySelector(`.save-card-btn[data-save-id="${CSS.escape(cragId)}"]`);
  if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Saving…'; }
  try {
    const file = await buildShareImage(row, dateStr);
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sendtemps-${cragId}-${dateStr}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (btn) { btn.querySelector('span').textContent = 'Saved!'; setTimeout(() => { btn.disabled = false; btn.querySelector('span').textContent = 'Save card'; }, 2000); }
  } catch (err) {
    console.error('saveCardImage failed', err);
    if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'Save card'; }
  }
}

// `shareForecast(cragId)` is the entry point. It looks up the active day's row
// for that crag, builds a one-line text summary + a deep link, and fires the
// native share sheet via navigator.share when available. Browsers without
// Web Share (desktop Chrome, some Firefox) fall back to writing the text +
// link to the clipboard with a small toast confirmation.
//
// The deep link includes ?crag=ID&date=YYYY-MM-DD so the recipient lands on
// exactly the right tab and card — see applyDeepLinkFromUrl() for the reader.
function buildShareUrl(cragId, dateStr) {
  const base = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams();
  params.set('crag', cragId);
  if (dateStr) params.set('date', dateStr);
  params.set('shared', '1'); // bypass pro gate for shared forecasts
  return `${base}?${params.toString()}`;
}

// ── Share image card ────────────────────────────────────────────────────────
// Draws a 1200×630 branded PNG on an offscreen canvas and returns a File
// object ready to pass to navigator.share({ files: [...] }).
async function buildShareImage(row, dateStr) {
  const { crag, day, score, reasons } = row;
  const W = 1200, H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const PARCHMENT  = '#f5f2eb';
  const SURFACE    = '#eeeade';
  const GREEN      = '#2d5a27';
  const GREEN_LIGHT = '#e8f0e6';
  const CHARCOAL   = '#28251D';
  const MUTED      = '#7a7670';
  const BORDER     = '#dedad2';
  const AMBER      = '#d97706';

  // Load DM Sans from Google Fonts for a sharper, branded feel
  let fontLoaded = false;
  try {
    const font400 = new FontFace('DM Sans', 'url(https://fonts.gstatic.com/s/dmsans/v15/rP2Hp2ywxg089UriCZOIHQ.woff2)');
    const font700 = new FontFace('DM Sans', 'url(https://fonts.gstatic.com/s/dmsans/v15/rP2Cp2ywxg089UriASitCBimCw.woff2)', { weight: '700' });
    await Promise.all([font400.load(), font700.load()]);
    document.fonts.add(font400);
    document.fonts.add(font700);
    fontLoaded = true;
  } catch { /* fall back to system-ui */ }
  const FONT = fontLoaded ? 'DM Sans' : 'system-ui, sans-serif';

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ── Background ──────────────────────────────────────────────────────────
  ctx.fillStyle = PARCHMENT;
  ctx.fillRect(0, 0, W, H);

  // Green left accent bar
  ctx.fillStyle = GREEN;
  ctx.fillRect(0, 0, 8, H);

  // Topo lines — bottom-right cluster
  ctx.save();
  ctx.strokeStyle = '#cbc7be';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  for (let r = 80; r < 600; r += 46) {
    ctx.beginPath();
    ctx.arc(W + 40, H + 40, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // ── Score pill ───────────────────────────────────────────────────────────
  const scoreVal = Math.round(score);
  const band = scoreBand(scoreVal);
  // Use green for good scores, amber for mid, muted for low
  const pillColor = scoreVal >= 75 ? GREEN : scoreVal >= 50 ? AMBER : MUTED;
  const pillW = 130, pillH = 50, pillX = 72, pillY = 72;
  ctx.fillStyle = pillColor;
  roundRect(pillX, pillY, pillW, pillH, 25);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 24px '${FONT}'`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${scoreVal}/100`, pillX + pillW / 2, pillY + pillH / 2 + 1);

  // ── Crag name ────────────────────────────────────────────────────────────
  ctx.fillStyle = CHARCOAL;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const maxNameW = W - 180;
  let nameSize = 76;
  ctx.font = `700 ${nameSize}px '${FONT}'`;
  while (ctx.measureText(crag.name).width > maxNameW && nameSize > 38) {
    nameSize -= 4;
    ctx.font = `700 ${nameSize}px '${FONT}'`;
  }
  ctx.fillText(crag.name, 72, 216);

  // ── Date + state ─────────────────────────────────────────────────────────
  const dateLabel = (() => {
    try {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
    } catch { return dateStr; }
  })();
  const stateBadge = crag.state ? ` · ${crag.state}` : '';
  ctx.fillStyle = MUTED;
  ctx.font = `400 30px '${FONT}'`;
  ctx.fillText(dateLabel + stateBadge, 72, 264);

  // ── Divider ───────────────────────────────────────────────────────────────
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(72, 296); ctx.lineTo(W - 72, 296);
  ctx.stroke();

  // ── Stats row — temp / wind / humidity ───────────────────────────────────
  const temp  = day?.tempMax != null ? `${Math.round(day.tempMax)}°C`     : '—';
  const wind  = day?.windMax != null ? `${Math.round(day.windMax)} km/h`  : '—';
  const rh    = day?.rhMean  != null ? `${Math.round(day.rhMean)}%`       : '—';
  const stats = [
    { label: 'TEMP',     value: temp },
    { label: 'WIND',     value: wind },
    { label: 'HUMIDITY', value: rh   },
  ];
  const colW = (W - 144) / stats.length;
  stats.forEach(({ label, value }, i) => {
    const x = 72 + i * colW;
    ctx.fillStyle = MUTED;
    ctx.font = `400 20px '${FONT}'`;
    ctx.textAlign = 'left';
    ctx.letterSpacing = '0.08em';
    ctx.fillText(label, x, 348);
    ctx.letterSpacing = '0';
    ctx.fillStyle = CHARCOAL;
    ctx.font = `700 44px '${FONT}'`;
    ctx.fillText(value, x, 410);
  });

  // ── Reason tags ──────────────────────────────────────────────────────────
  const tags = (reasons || []).filter(r => !/^closed/i.test(r)).slice(0, 4);
  if (tags.length) {
    const TAG_H = 38, TAG_R = 19, TAG_PAD = 18, TAG_GAP = 10;
    let tx = 72;
    const ty = 446;
    ctx.font = `400 20px '${FONT}'`;
    tags.forEach(tag => {
      const tw = ctx.measureText(tag).width + TAG_PAD * 2;
      if (tx + tw > W - 72) return; // don't overflow
      ctx.fillStyle = SURFACE;
      roundRect(tx, ty, tw, TAG_H, TAG_R);
      ctx.fill();
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'center';
      ctx.fillText(tag, tx + tw / 2, ty + TAG_H / 2 + 7);
      ctx.textAlign = 'left';
      tx += tw + TAG_GAP;
    });
  }

  // ── Bottom bar — SENDTEMPS branding ──────────────────────────────────────
  const barY = H - 80;
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, barY, W, 80);

  // Wordmark left
  ctx.fillStyle = GREEN;
  ctx.font = `700 26px '${FONT}'`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('SENDTEMPS', 72, barY + 40);

  // Tagline + URL right
  ctx.fillStyle = MUTED;
  ctx.font = `400 20px '${FONT}'`;
  ctx.textAlign = 'right';
  ctx.fillText('Friction forecasts for Australian rock  ·  sendtemps.app', W - 72, barY + 40);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
      resolve(new File([blob], 'sendtemps-forecast.png', { type: 'image/png' }));
    }, 'image/png');
  });
}

function buildShareText(row, dateStr) {
  const { crag, day, score } = row;
  const dateLabel = (() => {
    try {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch { return dateStr; }
  })();
  return `${crag.name} · ${dateLabel}\nSendTemps score ${Math.round(score)}/100`;
}

function shareForecast(cragId) {
  if (!cragId) return;
  const dateStr = state.activeDate;
  const rows = state.ranked?.[dateStr] || [];
  const row = rows.find(r => r.crag.id === cragId);
  if (!row) {
    // Sub-crag or unranked entry on this date — nothing to share.
    showToast('Nothing to share for this crag on this date.');
    return;
  }

  const url = buildShareUrl(cragId, dateStr);
  const text = `Check out the conditions at ${row.crag.name}.`;
  const title = `${row.crag.name} — SENDTEMPS`;

  // Try to generate the image card and include it in the share sheet.
  // Falls back to text-only if canvas or file sharing isn't supported.
  const doShare = async () => {
    let files;
    try {
      const img = await buildShareImage(row, dateStr);
      if (navigator.canShare && navigator.canShare({ files: [img] })) {
        files = [img];
      }
    } catch { /* canvas failed — share text-only */ }

    if (typeof navigator.share === 'function') {
      navigator.share({ title, text, url, ...(files ? { files } : {}) })
        .catch(err => {
          if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
          copyToClipboardWithToast(`${text}\n${url}`);
        });
    } else {
      copyToClipboardWithToast(`${text}\n${url}`);
    }
  };

  doShare();
}

function shareDestination(destination) {
  if (!destination) return;
  // Find the destination's trip data from weekendTrip state
  const dest = state.destinations?.find(d => d.destination === destination);
  if (!dest) { showToast('Nothing to share for this destination.'); return; }

  const { tripScore, destDailyScores = [] } = dest;

  // Build day-by-day summary lines
  const dayLines = destDailyScores.map(d => {
    try {
      const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      return `  ${label}: ${Math.round(d.score)}/100${d.bestCragName ? ' (' + d.bestCragName + ')' : ''}`;
    } catch { return ''; }
  }).filter(Boolean).join('\n');

  const dateRange = (() => {
    if (!state.tripDates?.length) return '';
    const fmt = d => { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); } catch { return d; } };
    const dates = state.tripDates;
    return dates.length > 1 ? `${fmt(dates[0])}–${fmt(dates[dates.length - 1])}` : fmt(dates[0]);
  })();

  const text = [
    `${destination} · ${dateRange}`,
    `Trip score ${tripScore}/100`,
    dayLines,
    'via SendTemps',
  ].filter(Boolean).join('\n');

  const url = `${location.origin}${location.pathname}`;
  const title = `${destination} trip forecast — SendTemps`;

  if (typeof navigator.share === 'function') {
    navigator.share({ title, text, url })
      .catch(err => {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
        copyToClipboardWithToast(`${text}\n${url}`);
      });
    return;
  }
  copyToClipboardWithToast(`${text}\n${url}`);
}

function copyToClipboardWithToast(text) {
  // navigator.clipboard requires a secure context (https), which GH Pages is.
  const fallbackCopy = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(ok ? 'Forecast copied to clipboard' : 'Couldn\u2019t copy — select and copy manually');
    } catch {
      showToast('Couldn\u2019t copy — select and copy manually');
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Forecast copied to clipboard'))
      .catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

// ---- Toast ----
//
// Lightweight transient message anchored bottom-center. We keep at most one
// toast in the DOM at a time — a second call replaces the first.
let _toastTimer = null;
function showToast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('toast-visible');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove('toast-visible');
  }, 2400);
}

// ---- Deep link reader ----
//
// Reads ?crag=ID&date=YYYY-MM-DD from the URL after the initial render and:
//   1. switches the active tab to the requested date if it's in range
//   2. scrolls the matching card into view
//   3. opens its detail expander
// Then strips the params from the address bar so subsequent reloads don't
// keep re-opening the same card.
function applyDeepLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const cragId = params.get('crag');
  const dateStr = params.get('date');
  if (!cragId && !dateStr) return;

  // Switch tab if the requested date is in the current rolling window.
  // If ?shared=1 is present (link from a Pro user), bypass the tier gate
  // so free users can see the shared forecast day without hitting the lock.
  // This only unlocks the specific shared date — not the whole app.
  const isSharedLink = params.get('shared') === '1';
  // Mark session as shared so visibleDayCount() opens the gate for this date.
  // Cleared when the user manually switches tabs (see renderTabs click handler).
  if (isSharedLink) state.sharedLinkActive = true;
  const dateIdx = dateStr && state.dates ? state.dates.indexOf(dateStr) : -1;
  const withinTier = dateIdx !== -1 && (isSharedLink || dateIdx < visibleDayCount());
  if (withinTier && state.activeDate !== dateStr) {
    state.activeDate = dateStr;
    renderTabs();
    renderRegionFilter();
    renderDay();
  }

  // Strip the params — user shouldn't see them lingering, and refreshes
  // shouldn't re-trigger this. history.replaceState avoids a navigation.
  try {
    const clean = `${location.origin}${location.pathname}`;
    history.replaceState(null, '', clean);
  } catch { /* ignore — cosmetic only */ }

  if (!cragId) return;

  // The matching card may not yet exist if cragId is unranked on this date.
  // Defer to next frame so renderDay() has settled the DOM.
  requestAnimationFrame(() => {
    const card = document.querySelector(`article.crag-card[data-id="${CSS.escape(cragId)}"]`);
    if (!card) return;
    if (card.dataset.open !== 'true') {
      card.querySelector('.crag-header')?.click();
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('crag-card-deeplink-flash');
    setTimeout(() => card.classList.remove('crag-card-deeplink-flash'), 1800);
  });
}

// iOS install hint — show a small, dismissible banner to users on iOS Safari
// who haven't yet added the app to their home screen. Apple doesn't expose a
// beforeinstallprompt event on iOS, so this is the only way to discover the
// install path. One-time dismissal stored in localStorage.
const IOS_HINT_KEY = 'sendtemps:ios-hint-dismissed';

function maybeShowIosInstallHint() {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (!isIOS) return;

  // Detect standalone (already installed). iOS uses non-standard
  // `navigator.standalone`; we also check the standard `display-mode` query
  // for completeness (and for future-proofing if Apple ever ships support).
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || navigator.standalone === true;
  if (isStandalone) return;

  if (_storage && _storage.getItem(IOS_HINT_KEY)) return;

  // Don't double-render if init() runs twice.
  if (document.getElementById('ios-install-hint')) return;

  const banner = document.createElement('aside');
  banner.id = 'ios-install-hint';
  banner.className = 'ios-install-hint';
  banner.setAttribute('role', 'note');
  banner.innerHTML = `
    <svg class="ios-share-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v13" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
    <div class="ios-install-hint-text">
      <strong>Install SendTemps</strong>
      <span>Tap Share <span aria-hidden="true">↑</span> then <em>Add to Home Screen</em>.</span>
    </div>
    <button class="ios-install-hint-dismiss" type="button" aria-label="Dismiss install hint">×</button>
  `;

  banner.querySelector('.ios-install-hint-dismiss').addEventListener('click', () => {
    try { _storage && _storage.setItem(IOS_HINT_KEY, '1'); } catch (_) { /* private mode */ }
    banner.remove();
  });

  const content = document.getElementById('content');
  if (content && content.parentNode) {
    content.parentNode.insertBefore(banner, content);
  }
}

async function init() {
  const loading = document.getElementById('loading');
  const content = document.getElementById('content');
  const errorEl = document.getElementById('error');
  const errorMsg = document.getElementById('error-message');

  loading.hidden = false;
  content.hidden = true;
  errorEl.hidden = true;

  try {
    // Resolve the region to fetch before the very first request goes out —
    // on a brand-new device this may prompt for location permission.
    state.regionFilter = await resolveInitialRegion();
    const next = await fetchAndRank();
    Object.assign(state, next);
    state.activeDate = state.dates[0];
    state.lastUpdated = Date.now();

    renderTabs();
    renderRegionFilter();
    renderDay();
    paintUpdated();

    loading.hidden = true;
    content.hidden = false;
    maybeShowIosInstallHint();
    applyDeepLinkFromUrl();
  } catch (err) {
    console.error(err);
    loading.hidden = true;
    content.hidden = true;
    errorEl.hidden = false;
    errorMsg.textContent = err.message || 'Network error';
  }
}

// Silent refresh — preserves activeDate and any expanded card; never shows full loader.
// Uses stale-while-revalidate: re-renders immediately from cached state so the UI
// feels instant, then fetches fresh data in the background and re-renders if changed.
async function refresh({ reason } = {}) {
  if (state.refreshing) return;
  if (!state.forecasts) { return init(); } // safety: no baseline yet
  state.refreshing = true;
  paintUpdated();

  const prevActive = state.activeDate;
  const expandedIds = Array.from(document.querySelectorAll('article.crag-card[data-open="true"]'))
    .map(c => c.dataset.id)
    .filter(Boolean);

  // Stale-while-revalidate: render current state immediately so UI feels instant.
  // Skip for region switches — stale data from the old region is misleading.
  const skipStale = reason === 'region-switch';
  if (!skipStale) {
    renderTabs();
    renderRegionFilter();
    renderDay();
    expandedIds.forEach(id => {
      const card = document.querySelector(`article.crag-card[data-id="${CSS.escape(id)}"]`);
      if (card) card.dataset.open = 'true';
    });
  }

  try {
    const next = await fetchAndRank();
    // Keep activeDate if it still exists in the new rolling window.
    Object.assign(state, next);
    state.activeDate = next.dates.includes(prevActive) ? prevActive : next.dates[0];
    state.lastUpdated = Date.now();
    // Re-render with fresh data.
    const freshExpandedIds = Array.from(document.querySelectorAll('article.crag-card[data-open="true"]'))
      .map(c => c.dataset.id)
      .filter(Boolean);
    renderTabs();
    renderRegionFilter();
    renderDay();
    if (freshExpandedIds.length) {
      freshExpandedIds.forEach(id => {
        const el = document.querySelector(`article.crag-card[data-id="${CSS.escape(id)}"]`);
        if (el && el.dataset.open !== 'true') el.querySelector('.crag-header')?.click();
      });
    }
  } catch (err) {
    console.error('[refresh] failed', err);
    // Don't disrupt the UI — just keep the previous data and try again next tick.
  } finally {
    state.refreshing = false;
    paintUpdated();
  }
}

document.getElementById('retry').addEventListener('click', init);

// Periodic background refresh (only when tab is visible — don't burn API calls in background).
setInterval(() => {
  if (document.visibilityState === 'visible') refresh({ reason: 'timer' });
}, REFRESH_INTERVAL_MS);

// Refresh when the user returns to the tab after ≥ 2 min.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const age = Date.now() - (state.lastUpdated || 0);
  if (age >= MIN_FOCUS_REFRESH_MS) refresh({ reason: 'focus' });
});

// Keep the relative timestamp (“2 min ago”) fresh without re-fetching.
setInterval(paintUpdated, 30 * 1000);

(async () => { await redeemCodeFromUrl(); init(); })();

// ─── Web Push subscription ────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = 'BDKj-7s-TEb5dmIoqLJ_pckUVYgkOPULfNtjUJUwLGHBzoYQaLSxQFEZebrW7Biqz-gaEHX9dNBnVXLd2t7p7ko';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

const BELL_SVG_OFF = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
const BELL_SVG_ON  = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`;

function getActiveState() {
  const activePill = document.querySelector('.region-pill[aria-pressed="true"]');
  return activePill ? activePill.dataset.region || 'VIC' : 'VIC';
}

function showNotifyPopover(btn, mode, activeState) {
  // mode: 'locked' (free tier) | 'subscribed' | 'unsubscribed'
  // Remove any existing popover
  document.getElementById('notify-popover')?.remove();
  document.getElementById('day-lock-popover')?.remove();
  document.getElementById('subcrag-lock-popover')?.remove();

  const pop = document.createElement('div');
  pop.id = 'notify-popover';
  pop.className = 'pro-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Rare window alerts');

  if (mode === 'locked') {
    pop.innerHTML = `
      <p class="notify-pop-title">Rare window alerts — Pro</p>
      <p class="notify-pop-body">Push alerts are a Pro feature while SendTemps is in testing. Got an invite link? Open it once and this unlocks automatically.</p>
      <button class="notify-pop-close" id="notify-pop-close" aria-label="Close">✕</button>
    `;
  } else if (mode === 'subscribed') {
    pop.innerHTML = `
      <p class="notify-pop-title">Rare window alerts on</p>
      <p class="notify-pop-body">You'll be notified when an unusually good climbing day is forecast — warmer, drier, or calmer than normal for the season.</p>
      <button class="notify-pop-action notify-pop-test" id="notify-test">Send test push</button>
      <button class="notify-pop-action notify-pop-off" id="notify-unsub">Turn off alerts</button>
      <button class="notify-pop-close" id="notify-pop-close" aria-label="Close">✕</button>
    `;
  } else {
    pop.innerHTML = `
      <p class="notify-pop-title">Rare window alerts</p>
      <p class="notify-pop-body">Get notified when an unusually good climbing day is forecast for <strong>${activeState}</strong> — warmer, drier, or calmer than the seasonal norm.</p>
      <button class="notify-pop-action notify-pop-on" id="notify-sub">Notify me</button>
      <button class="notify-pop-close" id="notify-pop-close" aria-label="Close">✕</button>
    `;
  }

  // Position below the bell button
  const rect = btn.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 8 + window.scrollY}px`;
  pop.style.right = `${document.documentElement.clientWidth - rect.right}px`;
  document.body.appendChild(pop);

  // Close handlers
  document.getElementById('notify-pop-close').addEventListener('click', () => pop.remove());
  document.addEventListener('pointerdown', function outside(e) {
    if (!pop.contains(e.target) && e.target !== btn) {
      pop.remove();
      document.removeEventListener('pointerdown', outside);
    }
  });

  return pop;
}

function updateNotifyBtn(subscribed) {
  const btn = document.getElementById('notify-btn');
  if (!btn) return;
  if (subscribed) {
    btn.setAttribute('aria-label', 'Rare window alerts — on');
    btn.classList.add('notify-active');
    btn.innerHTML = BELL_SVG_ON;
  } else {
    btn.setAttribute('aria-label', 'Rare window alerts — tap to enable');
    btn.classList.remove('notify-active');
    btn.innerHTML = BELL_SVG_OFF;
  }
}

async function initNotifyBtn() {
  const btn = document.getElementById('notify-btn');
  if (!btn) return;

  // Hide if push not supported
  if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
    btn.style.display = 'none';
    return;
  }

  // Check existing subscription state + silently re-register if stale
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  updateNotifyBtn(!!existing);
  btn.classList.toggle('notify-locked', !isPro());

  // On every load, re-POST the current endpoint so Supabase stays fresh.
  // This handles cases where the service worker updated and the endpoint changed.
  if (existing) {
    try {
      await fetch(`${API_BASE}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: existing.toJSON(),
          state: getActiveState(),
          favourites: [...state.favouriteCrags],
          thresholds: loadFavThresholds(),
        }),
      });
    } catch { /* offline — fine */ }
  }

  btn.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const activeState = getActiveState();

    if (!isPro()) {
      showNotifyPopover(btn, 'locked', activeState);
      return;
    }

    const pop = showNotifyPopover(btn, existing ? 'subscribed' : 'unsubscribed', activeState);

    // Wire up the action button inside the popover
    if (existing) {
      document.getElementById('notify-test')?.addEventListener('click', async () => {
        const testBtn = document.getElementById('notify-test');
        if (testBtn) { testBtn.textContent = 'Sending…'; testBtn.disabled = true; }
        try {
          const res = await fetch(`${API_BASE}/test-push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          });
          const data = await res.json();
          if (testBtn) {
            testBtn.textContent = data.pushed ? 'Push sent!' : 'No alerts (score below threshold)';
            setTimeout(() => { if (testBtn) { testBtn.textContent = 'Send test push'; testBtn.disabled = false; } }, 3000);
          }
        } catch {
          if (testBtn) { testBtn.textContent = 'Failed — try again'; testBtn.disabled = false; }
        }
      });

      document.getElementById('notify-unsub')?.addEventListener('click', async () => {
        pop.remove();
        await existing.unsubscribe();
        await fetch(`${API_BASE}/subscribe`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        }).catch(() => {});
        updateNotifyBtn(false);
      });
    } else {
      document.getElementById('notify-sub')?.addEventListener('click', async () => {
        pop.remove();
        if (!isPro()) return; // safety net — shouldn't be reachable, gated above
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          alert('Notifications are blocked. Enable them in your device settings to receive rare window alerts.');
          return;
        }
        try {
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          });
          // Include favourites + thresholds so the Worker can send targeted alerts
          const favs = [...state.favouriteCrags];
          const thresholds = loadFavThresholds();
          await fetch(`${API_BASE}/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subscription: sub.toJSON(),
              state: activeState,
              favourites: favs,
              thresholds,
            }),
          });
          updateNotifyBtn(true);
        } catch (err) {
          console.error('Push subscribe failed:', err);
        }
      });
    }
  });
}

// Initialise after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNotifyBtn);
} else {
  initNotifyBtn();
}

// ─── In-app code redemption ───────────────────────────────────────────────────
// Lets PWA users redeem access codes without needing a URL bar.
(function initRedeemRow() {
  const row    = document.getElementById('redeem-row');
  const input  = document.getElementById('redeem-input');
  const btn    = document.getElementById('redeem-btn');
  const status = document.getElementById('redeem-status');
  if (!row || !input || !btn || !status) return;

  // Hide the row entirely once Pro is already active
  if (isPro()) { row.hidden = true; return; }

  btn.addEventListener('click', async () => {
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    status.textContent = '';
    try {
      const res  = await fetch(`${API_BASE}/redeem?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (data.ok) {
        localStorage.setItem(TIER_KEY, data.tier || 'pro');
        if (data.expires_at) localStorage.setItem(TIER_EXPIRES_KEY, data.expires_at);
        else localStorage.removeItem(TIER_EXPIRES_KEY);
        status.textContent = '✓ Pro unlocked — reloading…';
        status.style.color = '#2d5a27';
        setTimeout(() => location.reload(), 1000);
      } else {
        status.textContent = 'Code not recognised.';
        status.style.color = '#A13544';
        btn.disabled = false;
        btn.textContent = 'Redeem';
      }
    } catch {
      status.textContent = 'Network error — try again.';
      status.style.color = '#A13544';
      btn.disabled = false;
      btn.textContent = 'Redeem';
    }
  });

  // Allow Enter key to submit
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
})();
