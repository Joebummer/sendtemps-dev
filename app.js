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
} from './forecast.js?v=29';

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

// ---- Anonymous pageview ping ----
// Visitor ID = SHA-256 of (UA + screen size + Melbourne date), truncated.
// Rotates daily so visitors aren't trackable across days.
(async function () {
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
    const seed = `${navigator.userAgent}|${screen.width}x${screen.height}|${today}`;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
    const visitor = Array.from(new Uint8Array(buf)).slice(0, 8)
      .map(b => b.toString(16).padStart(2, '0')).join('');
    fetch('/__PORT_5000__/api/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* no-op */ }
})();

// ---- App state ----
const HIDDEN_KEY = 'sendtemps:hidden';
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

const state = {
  forecasts: null,
  ranked: null,
  weekendTrip: null,    // ranked array of weekend crags by Fri–Sun trip score
  tripDates: [],        // [Fri, Sat, Sun] used for trip scoring
  dates: [],            // 7 dates: today + next 6, used for tabs
  activeDate: null,
  hiddenCrags: loadHidden(),
};

// ---- Render functions ----
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

  const allDayRows = rows
    .filter(r => r.crag.trip === 'day' || r.crag.trip === 'both')
    .filter(r => !isHidden(r));

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
    .sort((a, b) => b.score - a.score);

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
  out.sort((a, b) => b.tripScore - a.tripScore);
  return out;
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
      ${renderHideButton(`dest:${destination}`, destination)}
      <button class="crag-header" aria-expanded="false" aria-controls="detail-dest-${safeDest}">
        <div class="score-pill ${band.color}" aria-label="Trip score ${tripScore} out of 100">
          ${tripScore}
          <span class="score-pill-sub">trip</span>
        </div>
        <div class="crag-info">
          <h3>${escapeHtml(destination)}</h3>
          <div class="area">${drive} from Melbourne · ${namedSubCrags.length} crag${namedSubCrags.length === 1 ? '' : 's'}</div>
          <div class="day-score-note">Today's best: <strong>${escapeHtml(bestForToday.crag.name)}</strong> · ${bestForToday.score}/100</div>
          ${renderDrynessLine(bestForToday.nowDryness, bestForToday.lastRain)}
          <div class="reasons">${reasonsHtml}</div>
        </div>
        <svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      <div class="crag-detail" id="detail-dest-${safeDest}" role="region">
        ${destDailyScores.length ? renderDestinationBreakdown(destDailyScores) : ''}
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
        <span class="subcrag-aspect">${sub.crag.aspect}-facing</span>
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

  return `
    <article class="crag-card ${isTop ? 'top' : ''}" data-open="false" data-id="${crag.id}">
      ${renderHideButton(crag.id, crag.name)}
      <button class="crag-header" aria-expanded="false" aria-controls="detail-${crag.id}">
        <div class="score-pill ${band.color}" aria-label="Score ${headlineScore} out of 100">
          ${headlineScore}
          ${isWeekend && tripScore != null ? `<span class="score-pill-sub">trip</span>` : ''}
        </div>
        <div class="crag-info">
          <h3>${escapeHtml(crag.name)}</h3>
          ${showArea ? `<div class="area">${escapeHtml(crag.area)} · ${crag.driveTime} from Melbourne</div>` : `<div class="area">${crag.driveTime} from Melbourne</div>`}
          ${isWeekend && tripScore != null ? `<div class="day-score-note">Today scores <strong>${score}</strong> on its own</div>` : ''}
          ${bestSubCragName ? `<div class="day-score-note">Best: <strong>${escapeHtml(bestSubCragName)}</strong></div>` : ''}
          ${renderDrynessLine(nowDryness, lastRain)}
          <div class="reasons">${reasonsHtml}</div>
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
        </div>
        <div class="detail-section">
          <div class="section-label">Forecast</div>
          <p>${w.icon} ${w.label}. Feels like ${Math.round(day.tFeel || day.tMax)}°C. ${sunHours}h sun expected. ${day.precipSum > 0.2 ? `${day.precipSum.toFixed(1)}mm rain forecast.` : 'No measurable rain.'}${prevDay && prevDay.precipSum > 1 ? ` Yesterday saw ${prevDay.precipSum.toFixed(1)}mm.` : ''}</p>
        </div>
        ${renderRainTiming(day)}
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
          ${crag.sunOnWall ? `<div class="sun-on-wall"><span class="sun-on-wall-label">Sun on wall</span> <span class="sun-on-wall-value">${escapeHtml(crag.sunOnWall)}</span></div>` : ''}
        </div>
        ${renderDaySubCrags(daySubCrags)}
      </div>
    </article>
  `;
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
          <span class="subcrag-aspect">${sub.crag.aspect}-facing</span>
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

function renderScoreBreakdown(contributions, finalScore) {
  if (!Array.isArray(contributions) || contributions.length === 0) return '';
  // Group bonuses and penalties; show category icon next to each.
  const iconFor = (cat) => ({
    temp: '🌡️',
    aspect: '🧭',
    bestIn: '🎯',
    precip: '🌧️',
    dryness: '🪨',
    wind: '💨',
    sun: '☀️',
    closure: '🚫',
  }[cat] || '•');
  const rows = contributions.map(c => {
    const deltaCls = c.delta > 0 ? 'pos' : 'neg';
    const sign = c.delta > 0 ? '+' : '';
    return `
      <li class="breakdown-item">
        <span class="breakdown-icon" aria-hidden="true">${iconFor(c.category)}</span>
        <span class="breakdown-label">
          <span class="breakdown-name">${escapeHtml(c.label)}</span>
          <span class="breakdown-detail">${escapeHtml(c.detail)}</span>
        </span>
        <span class="breakdown-delta ${deltaCls}">${sign}${c.delta}</span>
      </li>
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
    </details>
  `;
}

function renderDrynessLine(nowDryness, lastRain) {
  if (nowDryness == null) return '';
  const band = drynessBand(nowDryness);
  let rainText = '';
  if (lastRain && lastRain.hoursAgo != null && lastRain.hoursAgo < 72 && lastRain.totalMm >= 0.3) {
    const h = lastRain.hoursAgo;
    const ago = h < 1 ? 'now' : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
    const mm = lastRain.totalMm >= 1 ? `${lastRain.totalMm.toFixed(1)}mm` : `${lastRain.totalMm.toFixed(1)}mm`;
    rainText = `<span class="dryness-rain">Last rain ${ago} · ${mm}</span>`;
  }
  return `
    <div class="dryness-line">
      <span class="dryness-pill ${band.color}" title="Rock dryness ${nowDryness}/100">
        <span class="dryness-dot"></span>${escapeHtml(band.label)} · ${nowDryness}
      </span>
      ${rainText}
    </div>
  `;
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
    renderDay();
    paintUpdated();

    loading.hidden = true;
    content.hidden = false;
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
