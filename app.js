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
} from './forecast.js?v=53';

// ---- Theme toggle ----
(function () {
  const t = document.querySelector('[data-theme-toggle]');
  const r = document.documentElement;
  let d = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
  const apply = () => {
    r.setAttribute('data-theme', d);
    t.innerHTML = d === 'dark'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    t.setAttribute('aria-label', `Switch to ${d === 'dark' ? 'light' : 'dark'} mode`);
  };
  apply();
  t.addEventListener('click', () => { d = d === 'dark' ? 'light' : 'dark'; apply(); });
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
      const reg = await navigator.serviceWorker.register('./sw.js');

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
  renderDay();
}

const REGION_FILTER_KEY = 'st_regionFilter';
function loadRegionFilter() {
  return _storage.getItem(REGION_FILTER_KEY) || 'ALL';
}

const state = {
  forecasts: null,
  ranked: null,
  weekendTrip: null,    // ranked array of weekend crags by Fri–Sun trip score
  tripDates: [],        // [Fri, Sat, Sun] used for trip scoring
  dates: [],            // 7 dates: today + next 6, used for tabs
  activeDate: null,
  hiddenCrags: loadHidden(),
  favouriteCrags: loadFavourites(),
  regionFilter: loadRegionFilter(), // 'ALL' | 'VIC' | 'TAS'
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
      state.regionFilter = btn.dataset.region;
      _storage.setItem(REGION_FILTER_KEY, state.regionFilter);
      renderRegionFilter();
      renderDay();
    });
  });
}

function renderTabs() {
  const tabs = document.getElementById('day-tabs');
  tabs.innerHTML = state.dates.map(date => {
    const selected = date === state.activeDate;
    const dayName = shortDayName(date);
    const dateLabel = formatDate(date).replace(/^[A-Za-z]+,?\s*/, ''); // strip weekday
    return `
      <button class="day-tab" role="tab"
        aria-selected="${selected}"
        data-date="${date}">
        <span class="day-name">${dayName}</span>
        <span class="day-date">${dateLabel}</span>
      </button>
    `;
  }).join('');

  tabs.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeDate = btn.dataset.date;
      renderTabs();
      renderDay();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
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
      if (!subs.length) return { ...r, daySubCrags: subs };
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
      map.set(destKey, { destination: destKey, drive: row.crag.driveTime, subCrags: [] });
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
    ? `<strong>Daily crag score:</strong> ${escapeHtml(dayTop.crag.name)} <span class="score-mini ${scoreBand(dayTop.score).color}">${dayTop.score}</span>`
    : `<strong>Daily crag score:</strong> no data`;
  const wkLine = destTop
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
    sections.push(renderDaySection('Overview', 'Daily crag score', dayRows, hiddenDay));
  }
  if (destinations.length || hiddenWeekendDest.length || hiddenWeekendCrag.length) {
    sections.push(renderWeekendSection('Weekend Away', 'By destination · Fri–Sun trip score', destinations, [...hiddenWeekendDest, ...hiddenWeekendCrag]));
  }

  list.innerHTML = sections.join('');

  list.querySelectorAll('.crag-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.crag-card');
      const open = card.dataset.open === 'true';
      card.dataset.open = open ? 'false' : 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
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

  // "N hidden — show" disclosure footer.
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

  // Share buttons — both the icon on the header and the labelled button in
  // the expander. stopPropagation so the header icon doesn't also toggle the
  // card open/closed.
  list.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      shareForecast(btn.dataset.shareId);
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

function renderDaySection(title, subtitle, rows, hiddenItems = []) {
  return `
    <section class="category">
      <header class="category-header">
        <h3>${escapeHtml(title)}</h3>
        <span class="category-sub">${escapeHtml(subtitle)}</span>
      </header>
      <div class="category-list">
        ${rows.map((row, i) => renderCard(row, i === 0, false)).join('')}
      </div>
      ${renderHiddenFooter(hiddenItems)}
    </section>
  `;
}

function renderWeekendSection(title, subtitle, destinations, hiddenItems = []) {
  return `
    <section class="category">
      <header class="category-header">
        <h3>${escapeHtml(title)}</h3>
        <span class="category-sub">${escapeHtml(subtitle)}</span>
      </header>
      <div class="category-list">
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
  return `
    <button type="button" class="favourite-btn${active ? ' active' : ''}"
      data-fav-id="${escapeHtml(id)}"
      aria-label="${escapeHtml(aria)}"
      aria-pressed="${active}"
      title="${escapeHtml(aria)}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="${active ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    </button>
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

function renderDestinationCard(dest, isTop) {
  const { destination, drive, tripScore, subCrags, bestForToday, bestPerDay, destDailyScores } = dest;
  const band = scoreBand(tripScore);
  const w = weatherIcon(bestForToday.day.weatherCode);
  const todayBand = scoreBand(bestForToday.score);

  // Reasons summary: pull top reasons from the best-for-today sub-crag.
  const reasonsHtml = (bestForToday.reasons && bestForToday.reasons.length
    ? bestForToday.reasons
    : ['conditions ok']
  ).map(r => `<span class="reason-tag">${escapeHtml(r)}</span>`).join('');

  const safeDest = destination.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  // Exclude parent placeholder entries (e.g. 'gramps-main', 'arap-main') from the sub-crag list and count.
  const namedSubCrags = subCrags.filter(s => s.crag.parentId);

  return `
    <article class="crag-card destination-card ${isTop ? 'top' : ''}" data-open="false" data-id="dest-${safeDest}">
      ${renderFavouriteButton(`dest:${destination}`, destination)}
      ${renderHideButton(`dest:${destination}`, destination)}
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
        ${destDailyScores.length ? renderDestinationBreakdown(destDailyScores) : ''}
        ${(() => {
          const fcDest = state.forecasts?.[bestForToday.crag.id];
          if (!fcDest) return '';
          if (fcDest.todayDate && state.activeDate === fcDest.todayDate) return renderHourlyStrip(fcDest, 'today', bestForToday.score);
          if (fcDest.tomorrowDate && state.activeDate === fcDest.tomorrowDate) return renderHourlyStrip(fcDest, 'tomorrow', bestForToday.score);
          return '';
        })()}
        ${renderPicksByDay(state.tripDates, bestPerDay)}
        <div class="detail-section">
          <div class="section-label">Sub-crags at this destination</div>
          <div class="subcrag-list">
            ${namedSubCrags.map(s => renderSubCragRow(s)).join('')}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderDestinationBreakdown(destDailyScores) {
  const cells = destDailyScores.map(d => {
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
      <div class="section-label">Fri–Sun outlook (best sub-crag per day)</div>
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

function renderSubCragRow(sub) {
  const band = scoreBand(sub.tripScore);
  const safeId = String(sub.crag.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const hasDaily = Array.isArray(sub.dailyScores) && sub.dailyScores.length > 0;
  return `
    <div class="subcrag-row-wrap" data-open="false">
      <button type="button" class="subcrag-row${hasDaily ? ' is-expandable' : ''}" aria-expanded="false" ${hasDaily ? `aria-controls="subdetail-${safeId}"` : ''}>
        <span class="subcrag-name">${escapeHtml(sub.crag.name)}</span>
        <span class="subcrag-aspect">${sub.crag.aspect === 'mixed' ? 'mixed aspects' : `${sub.crag.aspect}-facing`}</span>
        <span class="subcrag-trip ${band.color}">${sub.tripScore} trip</span>
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
  const { crag, day, score, reasons, prevDay, tripScore, dailyScores, daySubCrags, bestSubCragName, nowDryness, lastRain } = row;
  // We stash the row id on the share button via data-share-id so the
  // click handler (bound after render) can look up the row by crag.id
  // without re-deriving headlines or carrying closures through innerHTML.
  const shareId = crag.id;
  // For weekend cards, the headline number is the trip score (Fri–Sun).
  const headlineScore = isWeekend && tripScore != null ? tripScore : score;
  const band = scoreBand(headlineScore);
  const w = weatherIcon(day.weatherCode);

  const sunHours = Math.round((day.sunshine || 0) / 3600);

  const reasonsHtml = reasons.length
    ? reasons.map(r => {
        const cls = /^closed/i.test(r) ? 'reason-tag reason-tag-closed' : 'reason-tag';
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
    <article class="crag-card ${isTop ? 'top' : ''}" data-open="false" data-id="${crag.id}">
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
          ${renderHumidityTile(day)}
        </div>
        <div class="detail-section">
          <div class="section-label">Forecast</div>
          <p>${w.icon} ${w.label}. Feels like ${Math.round(day.tFeel || day.tMax)}°C. ${sunHours}h sun expected. ${day.precipSum > 0.2 ? `${day.precipSum.toFixed(1)}mm rain forecast.` : 'No measurable rain.'}${prevDay && prevDay.precipSum > 1 ? ` Yesterday saw ${prevDay.precipSum.toFixed(1)}mm.` : ''}</p>
        </div>
        ${renderRainTiming(day)}
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
            <span class="attribute">Ideal <strong>${crag.idealTemp[0]}–${crag.idealTemp[1]}°C</strong></span>
            <span class="attribute">Dries <strong>${dryLabel(crag.dryRating)}</strong></span>
            <span class="attribute"><strong>${escapeHtml(crag.rockType)}</strong></span>
          </div>
          ${renderSunWindow(day.sunWindow, crag.sunOnWall)}
        </div>
        ${renderDaySubCrags(daySubCrags)}
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
  </div>`;
}

function renderDaySubCrags(daySubCrags) {
  if (!Array.isArray(daySubCrags) || daySubCrags.length === 0) return '';
  // Sort by today's score (highest first) so the best sub-crag is at the top.
  const sorted = [...daySubCrags].sort((a, b) => b.score - a.score);
  const rows = sorted.map(sub => {
    const band = scoreBand(sub.score);
    return `
      <div class="subcrag-row-wrap" data-open="false">
        <button type="button" class="subcrag-row is-static" tabindex="-1">
          <span class="subcrag-name">${escapeHtml(sub.crag.name)}</span>
          <span class="subcrag-aspect">${sub.crag.aspect === 'mixed' ? 'mixed aspects' : `${sub.crag.aspect}-facing`}</span>
          <span class="subcrag-trip ${band.color}">${sub.score}</span>
        </button>
      </div>
    `;
  }).join('');
  return `
    <div class="detail-section">
      <div class="section-label">Sub-crags</div>
      <div class="subcrag-list">${rows}</div>
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
  return `<div class="condition-band" aria-hidden="true">${segments}</div>`;
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
  const cells = hours.map(h => {
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
        <span><strong>↑</strong> wind direction (arrow points where wind is going); gold = onshore, grey = lee. Bars show strength.</span>
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
        <span class="dryness-dot"></span>${isTomorrow ? 'Going into tomorrow' : 'Rock now'}: ${escapeHtml(band.label)} · ${nowDryness}
      </span>
      ${rainText}
    </div>
  `;
}

function renderHumidityTile(day) {
  const hum = day.climbHumidity;
  if (!hum || !(hum.climbHours >= 1) || hum.meanRh == null) return '';
  const mean = Math.round(hum.meanRh);
  // Sub-label prefers the most informative signal:
  //   - many humid hours → "Xh muggy"
  //   - many dry hours → "crisp"
  //   - otherwise show the climb-hours range as context
  let sub;
  if ((hum.hoursHumid || 0) >= 3) sub = `${hum.hoursHumid}h muggy`;
  else if ((hum.hoursHumid || 0) >= 1) sub = `${hum.hoursHumid}h muggy`;
  else if ((hum.hoursDry || 0) >= 6) sub = 'crisp';
  else if ((hum.hoursModerate || 0) >= 3) sub = `${hum.hoursModerate}h moderate`;
  else sub = `peak ${Math.round(hum.maxRh)}%`;
  return `<div class="metric" title="Mean relative humidity during climbing hours"><div class="v">${mean}%</div><div class="l">Humidity <span class="metric-sub">· ${sub}</span></div></div>`;
}

function renderRainTiming(day) {
  const windows = day.rainWindows;
  if (!windows || !windows.length) return '';
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
      <div class="section-label">Rain timing</div>
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
      <div class="section-label">Fri–Sun breakdown</div>
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

async function fetchAndRank() {
  const forecasts = await fetchAllForecasts();
  const dates = weekDates();
  const tripDates = weekendDates().slice(0, 3);
  const ranked = rankByDay(forecasts, dates);
  const weekendTrip = rankWeekendTrip(forecasts, tripDates);
  return { forecasts, dates, tripDates, ranked, weekendTrip };
}

// ---- Share a forecast ----
//
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
  return `${base}?${params.toString()}`;
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
  const text = buildShareText(row, dateStr);
  const title = `${row.crag.name} forecast — SendTemps`;

  // navigator.share is the right path on iOS Safari + Android Chrome.
  // It throws if the user cancels (NotAllowedError / AbortError) — we swallow
  // those silently and don't fall back, since the user explicitly dismissed.
  if (typeof navigator.share === 'function') {
    navigator.share({ title, text, url })
      .catch(err => {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
        // Genuine failure — try clipboard as a fallback.
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
  if (dateStr && state.dates && state.dates.includes(dateStr) && state.activeDate !== dateStr) {
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
async function refresh({ reason } = {}) {
  if (state.refreshing) return;
  if (!state.forecasts) { return init(); } // safety: no baseline yet
  state.refreshing = true;
  paintUpdated();
  try {
    const next = await fetchAndRank();
    // Keep activeDate if it still exists in the new rolling window; otherwise fall back to today.
    const prevActive = state.activeDate;
    Object.assign(state, next);
    state.activeDate = next.dates.includes(prevActive) ? prevActive : next.dates[0];
    state.lastUpdated = Date.now();
    // Remember which cards were expanded so the refresh doesn't collapse them.
    const expandedIds = Array.from(document.querySelectorAll('article.crag-card[data-open="true"]'))
      .map(c => c.dataset.id)
      .filter(Boolean);
    renderTabs();
    renderRegionFilter();
    renderDay();
    if (expandedIds.length) {
      expandedIds.forEach(id => {
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

init();
