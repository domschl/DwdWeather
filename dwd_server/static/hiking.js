// Hiking Conditions Module — 10-day sunshine, R101 precipitation probability,
// hour-by-hour morphing hiking-opportunity bar, min/max temp & snow depth.

let hikingLocationsData = null;
const hikingCharts = new Map(); // station_id -> Chart instance
let hikingMinWindowHours = 6;
let hikingSearchTimer = null;
let hikingSearchBound = false;

// ---------------------------------------------------------------------------
// NOAA Solar Sunrise / Sunset Calculation (UTC ms)
// ---------------------------------------------------------------------------
function getSunriseSunsetMs(year, month, day, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const startOfYear = Date.UTC(year, 0, 1);
  const currentDay = Date.UTC(year, month - 1, day);
  const dayOfYear = Math.floor((currentDay - startOfYear) / 86400000) + 1;

  // Fractional year in radians (at noon UTC)
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);

  // Equation of time (minutes)
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // Solar declination angle (radians)
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latRad = latDeg * rad;
  const zenithRad = 90.833 * rad;
  const cosHa =
    Math.cos(zenithRad) / (Math.cos(latRad) * Math.cos(decl)) -
    Math.tan(latRad) * Math.tan(decl);

  if (cosHa > 1) {
    // Polar night
    return { sunriseMs: currentDay + 43200000, sunsetMs: currentDay + 43200000 };
  }
  if (cosHa < -1) {
    // Midnight sun
    return { sunriseMs: currentDay, sunsetMs: currentDay + 86400000 };
  }

  const haDeg = Math.acos(cosHa) * deg;
  const sunriseMin = 720 - 4 * (lonDeg + haDeg) - eqTime;
  const sunsetMin = 720 - 4 * (lonDeg - haDeg) - eqTime;

  return {
    sunriseMs: currentDay + sunriseMin * 60000,
    sunsetMs: currentDay + sunsetMin * 60000,
  };
}

function getLocalDateKey(ms) {
  return new Date(ms).toLocaleDateString('sv', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD
}

function formatLocalHM(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Berlin',
  });
}

function formatLocalDayShort(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Berlin',
  });
}

// ---------------------------------------------------------------------------
// Color Morphing (Hour-by-hour)
// ---------------------------------------------------------------------------
function lerpColor(c1, c2, t) {
  const f = Math.max(0, Math.min(1, t));
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

// Dry hour color morphing: 0% sun (warm grey) -> 50% sun (medium green) -> 85%+ sun (vivid emerald)
function getDryHourColor(sunFrac) {
  const f = Math.max(0, Math.min(1, sunFrac));
  const cMedium = [148, 158, 144]; // warm grey (#949e90)
  const cGood = [74, 222, 128];    // green (#4ade80)
  const cExcellent = [0, 230, 118]; // vivid emerald (#00e676)
  if (f <= 0.5) {
    return lerpColor(cMedium, cGood, f / 0.5);
  }
  return lerpColor(cGood, cExcellent, (f - 0.5) / 0.35);
}

const BASIC_BAR_COLOR = 'rgb(100, 116, 139)'; // cool slate-grey (#64748b)

function getTierLabelForHour(mode, sunFrac) {
  if (mode === 'none') return 'Not hikeable';
  if (mode === 'basic') return 'Basic (slight precip)';
  if (sunFrac >= 0.8) return 'Excellent (dry, sunny)';
  if (sunFrac >= 0.5) return 'Good (dry, ≥50% sun)';
  return 'Medium (dry, cloudy)';
}

// ---------------------------------------------------------------------------
// Evaluate 10-day Hiking Windows & Daily Summaries
// ---------------------------------------------------------------------------
function evaluateHikingConditions(locData, minWindowHours) {
  const fc = locData.forecast;
  const times = fc.timesteps || [];
  const elems = fc.elements || {};
  const sunD1 = elems.SunD1 || [];
  const r101 = elems.R101 || elems.wwP || [];
  const rr1c = elems.RR1c || [];
  const rrs1c = elems.RRS1c || [];
  const ttt = elems.TTT || [];
  const snowDepth = locData.snow_depth_cm || [];

  const lon = (fc.coordinates && fc.coordinates[0]) || 11.82;
  const lat = (fc.coordinates && fc.coordinates[1]) || 47.75;

  const sunTimesCache = new Map();
  function getSunForDay(dayStr) {
    if (!sunTimesCache.has(dayStr)) {
      const [y, m, d] = dayStr.split('-').map(Number);
      sunTimesCache.set(dayStr, getSunriseSunsetMs(y, m, d, lat, lon));
    }
    return sunTimesCache.get(dayStr);
  }

  // Build per-hour records
  const hours = times.map((iso, idx) => {
    const endMs = new Date(iso).getTime();
    const startMs = endMs - 3600000;
    const midMs = endMs - 1800000;
    const dayStr = getLocalDateKey(midMs);
    const { sunriseMs, sunsetMs } = getSunForDay(dayStr);

    const overlapStart = Math.max(startMs, sunriseMs);
    const overlapEnd = Math.min(endMs, sunsetMs);
    const daylightSecs = Math.max(0, (overlapEnd - overlapStart) / 1000);
    const isDaytime = daylightSecs >= 1800;

    const sunSec = sunD1[idx] != null ? sunD1[idx] : 0;
    const precipProb = r101[idx] != null ? r101[idx] : 0;
    const precipAmt = rr1c[idx] != null ? rr1c[idx] : 0;
    const freshSnow = rrs1c[idx] != null ? rrs1c[idx] : 0;
    const tempC = ttt[idx] != null ? ttt[idx] - 273.15 : null;
    const snowCm = snowDepth[idx] != null ? snowDepth[idx] : null;

    // Classify precipitation state for hiking
    let precipClass = 'wet';
    if (precipAmt < 0.1 && precipProb < 15) {
      precipClass = 'dry';
    } else if (precipAmt <= 0.3 && precipProb < 35) {
      precipClass = 'slight';
    }

    const sunFrac = daylightSecs > 0 ? Math.max(0, Math.min(1, sunSec / daylightSecs)) : 0;

    return {
      idx,
      iso,
      startMs,
      endMs,
      dayStr,
      sunriseMs,
      sunsetMs,
      daylightSecs,
      isDaytime,
      sunSec,
      sunPct: Math.min(100, (sunSec / 3600) * 100),
      sunFrac,
      precipProb,
      precipAmt,
      freshSnow,
      tempC,
      snowCm,
      precipClass,
      // Populated below
      barMode: 'none', // 'none' | 'basic' | 'dry'
      barColor: null,
      windowInfo: null,
    };
  });

  // Group hours by local day
  const daysMap = new Map();
  for (const h of hours) {
    if (!daysMap.has(h.dayStr)) {
      daysMap.set(h.dayStr, []);
    }
    daysMap.get(h.dayStr).push(h);
  }

  const dailySummaries = [];
  const nightBands = [];

  const dayKeys = Array.from(daysMap.keys()).sort();
  for (const dayStr of dayKeys) {
    const dayHours = daysMap.get(dayStr);
    const { sunriseMs, sunsetMs } = getSunForDay(dayStr);

    // Track night shading bands for the chart
    const dayStartMs = dayHours[0].startMs;
    const dayEndMs = dayHours[dayHours.length - 1].endMs;
    if (sunriseMs > dayStartMs) {
      nightBands.push({ from: dayStartMs, to: Math.min(sunriseMs, dayEndMs) });
    }
    if (sunsetMs < dayEndMs) {
      nightBands.push({ from: Math.max(sunsetMs, dayStartMs), to: dayEndMs });
    }

    // 1. Find contiguous daytime DRY runs >= minWindowHours
    const dryRuns = [];
    let curRun = [];
    for (const h of dayHours) {
      if (h.isDaytime && h.precipClass === 'dry') {
        curRun.push(h);
      } else {
        if (curRun.length >= minWindowHours) dryRuns.push(curRun);
        curRun = [];
      }
    }
    if (curRun.length >= minWindowHours) dryRuns.push(curRun);

    // 2. Find contiguous daytime (DRY or SLIGHT) runs >= minWindowHours
    const basicRuns = [];
    curRun = [];
    for (const h of dayHours) {
      if (h.isDaytime && (h.precipClass === 'dry' || h.precipClass === 'slight')) {
        curRun.push(h);
      } else {
        if (curRun.length >= minWindowHours) basicRuns.push(curRun);
        curRun = [];
      }
    }
    if (curRun.length >= minWindowHours) basicRuns.push(curRun);

    // Mark qualifying DRY hours (hour-by-hour morphing)
    for (const run of dryRuns) {
      const winStart = formatLocalHM(run[0].startMs);
      const winEnd = formatLocalHM(run[run.length - 1].endMs);
      const info = `${winStart}–${winEnd} (${run.length}h dry)`;
      for (const h of run) {
        h.barMode = 'dry';
        h.barColor = getDryHourColor(h.sunFrac);
        h.windowInfo = info;
      }
    }

    // Mark qualifying BASIC hours (only if not already marked dry)
    for (const run of basicRuns) {
      const winStart = formatLocalHM(run[0].startMs);
      const winEnd = formatLocalHM(run[run.length - 1].endMs);
      const info = `${winStart}–${winEnd} (${run.length}h, slight precip)`;
      for (const h of run) {
        if (h.barMode === 'none') {
          h.barMode = 'basic';
          h.barColor = BASIC_BAR_COLOR;
          h.windowInfo = info;
        }
      }
    }

    // Daily summary metrics
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    let maxSnowCm = null;
    let freshSnowMm = 0;
    for (const h of dayHours) {
      if (h.tempC !== null) {
        if (h.tempC < minTemp) minTemp = h.tempC;
        if (h.tempC > maxTemp) maxTemp = h.tempC;
      }
      if (h.snowCm !== null) {
        maxSnowCm = maxSnowCm === null ? h.snowCm : Math.max(maxSnowCm, h.snowCm);
      }
      if (h.freshSnow > 0) {
        freshSnowMm += h.freshSnow;
      }
    }

    // Best daily hiking tier
    let bestTier = 'none';
    let bestHours = 0;
    let bestRange = '';
    let bestAvgSun = 0;

    if (dryRuns.length > 0) {
      // Pick longest dry run (tie-break by avg sunshine)
      dryRuns.sort((a, b) => {
        if (b.length !== a.length) return b.length - a.length;
        const avgA = a.reduce((s, x) => s + x.sunFrac, 0) / a.length;
        const avgB = b.reduce((s, x) => s + x.sunFrac, 0) / b.length;
        return avgB - avgA;
      });
      const best = dryRuns[0];
      bestHours = best.length;
      bestRange = `${formatLocalHM(best[0].startMs)}–${formatLocalHM(best[best.length - 1].endMs)}`;
      bestAvgSun = best.reduce((s, x) => s + x.sunFrac, 0) / best.length;
      if (bestAvgSun >= 0.8) bestTier = 'excellent';
      else if (bestAvgSun >= 0.5) bestTier = 'good';
      else bestTier = 'medium';
    } else if (basicRuns.length > 0) {
      basicRuns.sort((a, b) => b.length - a.length);
      const best = basicRuns[0];
      bestHours = best.length;
      bestRange = `${formatLocalHM(best[0].startMs)}–${formatLocalHM(best[best.length - 1].endMs)}`;
      bestAvgSun = best.reduce((s, x) => s + x.sunFrac, 0) / best.length;
      bestTier = 'basic';
    }

    dailySummaries.push({
      dayStr,
      label: formatLocalDayShort(dayStr),
      bestTier,
      bestHours,
      bestRange,
      bestAvgSun,
      minTemp: minTemp === Infinity ? null : minTemp,
      maxTemp: maxTemp === -Infinity ? null : maxTemp,
      maxSnowCm,
      freshSnowMm,
    });
  }

  return { hours, dailySummaries, nightBands };
}

// ---------------------------------------------------------------------------
// API & View Lifecycle
// ---------------------------------------------------------------------------
function bindHikingSearchEvents() {
  if (hikingSearchBound) return;
  hikingSearchBound = true;

  const input = document.getElementById('hiking-station-search');
  const dropdown = document.getElementById('hiking-search-results');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (hikingSearchTimer) clearTimeout(hikingSearchTimer);
    if (q.length < 2) {
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
      return;
    }
    hikingSearchTimer = setTimeout(() => runHikingStationSearch(q), 220);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addHikingStationFromInput();
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.hiking-search-wrapper')) {
      dropdown.style.display = 'none';
    }
  });
}

async function runHikingStationSearch(query) {
  const dropdown = document.getElementById('hiking-search-results');
  if (!dropdown) return;
  try {
    const resp = await fetch(`/api/hiking/stations/search?q=${encodeURIComponent(query)}&limit=15`);
    if (!resp.ok) return;
    const data = await resp.json();
    const results = data.results || [];
    if (results.length === 0) {
      dropdown.innerHTML = `<div class="hiking-search-empty">No DWD stations matching "${escapeHtml(query)}"</div>`;
      dropdown.style.display = 'block';
      return;
    }
    dropdown.innerHTML = results
      .map(
        (st) => `
      <div class="hiking-search-item" onclick="selectHikingStation('${escapeAttr(st.id)}', '${escapeAttr(st.name)}')">
        <span class="hs-id">${escapeHtml(st.id)}</span>
        <span class="hs-name">${escapeHtml(st.name)}</span>
        <span class="hs-elev">${st.elevation} m</span>
      </div>`
      )
      .join('');
    dropdown.style.display = 'block';
  } catch (err) {
    console.error('Hiking station search failed:', err);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function selectHikingStation(stationId, stationName) {
  const input = document.getElementById('hiking-station-search');
  const dropdown = document.getElementById('hiking-search-results');
  if (dropdown) dropdown.style.display = 'none';
  if (input) input.value = '';
  await addHikingStation(stationId, stationName);
}

async function addHikingStationFromInput() {
  const input = document.getElementById('hiking-station-search');
  const dropdown = document.getElementById('hiking-search-results');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;

  // If dropdown has a first item, check if user typed a name rather than an ID
  if (dropdown && dropdown.style.display !== 'none') {
    const firstItem = dropdown.querySelector('.hiking-search-item');
    if (firstItem && !/^[A-Za-z0-9]{4,5}$/.test(val)) {
      firstItem.click();
      return;
    }
  }
  if (dropdown) dropdown.style.display = 'none';
  input.value = '';
  await addHikingStation(val, '');
}

async function addHikingStation(stationId, label) {
  const btn = document.getElementById('btn-hiking-add');
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/hiking/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station_id: stationId, label: label || '' }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!hikingLocationsData) hikingLocationsData = [];
    const idx = hikingLocationsData.findIndex(
      (l) => l.station_id.toLowerCase() === data.location.station_id.toLowerCase()
    );
    if (idx >= 0) {
      hikingLocationsData[idx] = data.location;
    } else {
      hikingLocationsData.push(data.location);
    }
    renderHikingCards();
    if (typeof showToast === 'function') {
      showToast(`Added hiking location: ${data.location.label} (${data.location.station_id})`);
    }
  } catch (err) {
    console.error('Failed to add hiking location:', err);
    alert(`Could not add station "${stationId}": ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeHikingStation(stationId) {
  try {
    const resp = await fetch(`/api/hiking/locations/${encodeURIComponent(stationId)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    if (hikingLocationsData) {
      hikingLocationsData = hikingLocationsData.filter(
        (l) => l.station_id.toLowerCase() !== stationId.toLowerCase()
      );
    }
    renderHikingCards();
    if (typeof showToast === 'function') {
      showToast(`Removed hiking location ${stationId}`);
    }
  } catch (err) {
    console.error('Failed to remove hiking location:', err);
    alert(`Failed to remove location: ${err.message}`);
  }
}

async function loadHikingView() {
  bindHikingSearchEvents();
  if (hikingLocationsData !== null) {
    renderHikingCards();
    return;
  }
  const container = document.getElementById('hiking-cards-container');
  if (container) {
    container.innerHTML = '<div class="hiking-placeholder">Loading 10-day hiking forecasts from DWD...</div>';
  }
  try {
    const resp = await fetch('/api/hiking/locations');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    hikingLocationsData = data.locations || [];
    renderHikingCards();
  } catch (err) {
    console.error('Failed to load hiking locations:', err);
    if (container) {
      container.innerHTML = `<div class="hiking-placeholder">Failed to load hiking locations: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function refreshHikingData() {
  const btn = document.getElementById('btn-hiking-refresh');
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/hiking/refresh', { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    hikingLocationsData = data.locations || [];
    renderHikingCards();
    if (typeof showToast === 'function') {
      showToast('Hiking locations refreshed.');
    }
  } catch (err) {
    console.error('Failed to refresh hiking locations:', err);
    alert(`Refresh failed: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function onHikingMinHoursChange() {
  const sel = document.getElementById('hiking-min-hours');
  if (!sel) return;
  hikingMinWindowHours = parseInt(sel.value, 10) || 6;
  const legendSpan = document.getElementById('hiking-legend-hours');
  if (legendSpan) legendSpan.textContent = String(hikingMinWindowHours);
  renderHikingCards();
}

// ---------------------------------------------------------------------------
// Rendering Cards & Charts
// ---------------------------------------------------------------------------
function renderHikingCards() {
  const container = document.getElementById('hiking-cards-container');
  if (!container) return;

  // Destroy existing Chart.js instances
  hikingCharts.forEach((ch) => ch.destroy());
  hikingCharts.clear();

  if (!hikingLocationsData || hikingLocationsData.length === 0) {
    container.innerHTML =
      '<div class="hiking-placeholder">No hiking locations configured. Search above to add a DWD station.</div>';
    return;
  }

  container.innerHTML = '';

  for (const loc of hikingLocationsData) {
    const card = document.createElement('div');
    card.className = 'hiking-location-card';

    if (!loc.forecast) {
      card.innerHTML = `
        <div class="hiking-card-header">
          <div class="hiking-card-title">
            <h3>${escapeHtml(loc.label || loc.station_id)}</h3>
            <span class="hiking-station-meta">${escapeHtml(loc.station_id)}</span>
          </div>
          <button class="hiking-remove-btn" title="Remove location" onclick="removeHikingStation('${escapeAttr(loc.station_id)}')">✕</button>
        </div>
        <div class="hiking-placeholder">${escapeHtml(loc.error || 'Forecast unavailable')}</div>
      `;
      container.appendChild(card);
      continue;
    }

    const evalRes = evaluateHikingConditions(loc, hikingMinWindowHours);
    const fc = loc.forecast;
    const coords = fc.coordinates || [0, 0, 0];
    const elev = Math.round(coords[2] || 0);

    // 10-day overall stats
    const hikeableDays = evalRes.dailySummaries.filter((d) => d.bestTier !== 'none').length;
    const allMins = evalRes.dailySummaries.map((d) => d.minTemp).filter((v) => v !== null);
    const allMaxs = evalRes.dailySummaries.map((d) => d.maxTemp).filter((v) => v !== null);
    const allSnow = evalRes.dailySummaries.map((d) => d.maxSnowCm).filter((v) => v !== null);
    const tempChip =
      allMins.length && allMaxs.length
        ? `🌡️ ${Math.min(...allMins).toFixed(0)}° .. ${Math.max(...allMaxs).toFixed(0)}°C`
        : '';
    const maxSnow = allSnow.length ? Math.max(...allSnow) : null;
    const snowChip = maxSnow !== null ? `❄️ Snow: up to ${maxSnow.toFixed(0)} cm` : '';

    const canvasId = `hiking-chart-${loc.station_id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

    const dayPillsHtml = evalRes.dailySummaries
      .map((d) => {
        const tempStr =
          d.minTemp !== null && d.maxTemp !== null
            ? `${Math.round(d.minTemp)}° / ${Math.round(d.maxTemp)}°`
            : '--';
        const snowStr =
          d.maxSnowCm !== null && d.maxSnowCm > 0
            ? `❄️ ${d.maxSnowCm.toFixed(0)} cm`
            : d.freshSnowMm >= 0.5
              ? `🌨️ +${d.freshSnowMm.toFixed(0)} cm`
              : '';
        const tierBadge =
          d.bestTier === 'none'
            ? `<span class="day-tier tier-none">—</span><div class="day-tier-sub tier-none">&nbsp;</div>`
            : `<span class="day-tier tier-${d.bestTier}" title="${d.bestHours}h · ${escapeAttr(d.bestTier)}">${escapeHtml(d.bestRange)}</span><div class="day-tier-sub tier-text-${d.bestTier}">${escapeHtml(d.bestTier)}</div>`;
        return `
          <div class="hiking-day-pill tier-border-${d.bestTier}">
            <div class="day-pill-date">${escapeHtml(d.label)}</div>
            ${tierBadge}
            <div class="day-pill-temp">${tempStr}</div>
            ${snowStr ? `<div class="day-pill-snow">${snowStr}</div>` : '<div class="day-pill-snow muted">0 cm</div>'}
          </div>
        `;
      })
      .join('');

    card.innerHTML = `
      <div class="hiking-card-header">
        <div class="hiking-card-title">
          <h3>🥾 ${escapeHtml(loc.label || fc.station_name || loc.station_id)}</h3>
          <span class="hiking-station-meta">
            ${escapeHtml(loc.station_id)} · ${escapeHtml(fc.station_name || '')} · ${elev} m · ${coords[1].toFixed(2)}°N, ${coords[0].toFixed(2)}°E
          </span>
        </div>
        <div class="hiking-card-chips">
          <span class="hiking-chip chip-days">🥾 ${hikeableDays}/${evalRes.dailySummaries.length} days</span>
          ${tempChip ? `<span class="hiking-chip">${tempChip}</span>` : ''}
          ${snowChip ? `<span class="hiking-chip chip-snow">${snowChip}</span>` : ''}
          <button class="hiking-remove-btn" title="Remove location" onclick="removeHikingStation('${escapeAttr(loc.station_id)}')">✕</button>
        </div>
      </div>
      <div class="hiking-chart-wrapper">
        <canvas id="${canvasId}"></canvas>
      </div>
      <div class="hiking-days-strip">
        ${dayPillsHtml}
      </div>
    `;

    container.appendChild(card);
    renderHikingLocationChart(canvasId, loc.station_id, evalRes);
  }
}

function renderHikingLocationChart(canvasId, stationId, evalRes) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const { hours, nightBands } = evalRes;
  const sunPoints = hours.map((h) => ({ x: h.endMs, y: h.sunPct }));
  const rainPoints = hours.map((h) => ({ x: h.endMs, y: h.precipProb }));

  // Plugin to draw night shading, midnight lines, and the hour-by-hour hiking-opportunity bar
  const hikingOverlayPlugin = {
    id: 'hikingOverlayPlugin',
    beforeDatasetsDraw(chart) {
      const { ctx: c, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const xScale = scales.x;

      c.save();
      // 1. Night shading
      c.fillStyle = 'rgba(10, 12, 24, 0.42)';
      for (const band of nightBands) {
        const x1 = Math.max(chartArea.left, xScale.getPixelForValue(band.from));
        const x2 = Math.min(chartArea.right, xScale.getPixelForValue(band.to));
        if (x2 > x1) {
          c.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        }
      }

      // 2. Subtle midnight vertical lines
      c.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      c.lineWidth = 1;
      let prevDay = null;
      for (const h of hours) {
        if (prevDay !== null && h.dayStr !== prevDay) {
          const px = xScale.getPixelForValue(h.startMs);
          if (px >= chartArea.left && px <= chartArea.right) {
            c.beginPath();
            c.moveTo(px, chartArea.top);
            c.lineTo(px, chartArea.bottom);
            c.stroke();
          }
        }
        prevDay = h.dayStr;
      }
      c.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx: c, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const xScale = scales.x;

      const barHeight = 14;
      const barTop = chartArea.bottom - barHeight - 3;

      c.save();
      // Subtle track background along bottom of plot
      c.fillStyle = 'rgba(255, 255, 255, 0.04)';
      c.fillRect(chartArea.left, barTop, chartArea.right - chartArea.left, barHeight);

      // Draw each qualifying hour segment with its morphed color
      for (const h of hours) {
        if (h.barMode === 'none' || !h.barColor) continue;
        const x1 = Math.max(chartArea.left, xScale.getPixelForValue(h.startMs));
        const x2 = Math.min(chartArea.right, xScale.getPixelForValue(h.endMs));
        if (x2 <= x1) continue;

        c.fillStyle = h.barColor;
        if (h.barMode === 'basic') {
          // Slightly slimmer bar for basic (slight precip) so it's visually distinct from dry
          c.globalAlpha = 0.85;
          c.fillRect(x1, barTop + 3, Math.max(1.5, x2 - x1 + 0.5), barHeight - 6);
        } else {
          c.globalAlpha = 0.95;
          c.fillRect(x1, barTop, Math.max(1.5, x2 - x1 + 0.5), barHeight);
        }
      }
      c.restore();
    },
  };

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Sunshine (%)',
          data: sunPoints,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.22)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.25,
        },
        {
          label: 'Precip Prob R101 (%)',
          data: rainPoints,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.16)',
          borderWidth: 1.8,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      layout: {
        padding: { bottom: 4 },
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'day',
            displayFormats: {
              day: 'EEE dd.MM',
            },
          },
          ticks: {
            color: '#94a3b8',
            font: { size: 11 },
            maxRotation: 0,
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.04)',
          },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 25,
            color: '#94a3b8',
            font: { size: 11 },
            callback: (v) => `${v}%`,
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.05)',
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: '#cbd5e1',
            boxWidth: 12,
            font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.15)',
          borderWidth: 1,
          titleColor: '#f8fafc',
          bodyColor: '#e2e8f0',
          padding: 10,
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const h = hours[items[0].dataIndex];
              if (!h) return '';
              return `${formatLocalDayShort(h.dayStr)} · ${formatLocalHM(h.startMs)}–${formatLocalHM(h.endMs)}`;
            },
            label(item) {
              const h = hours[item.dataIndex];
              if (!h) return '';
              if (item.datasetIndex === 0) {
                return `☀️ Sunshine: ${Math.round(h.sunSec / 60)} min/h (${Math.round(h.sunPct)}%)`;
              }
              return `🌧️ Precip Prob (R101): ${Math.round(h.precipProb)}% (${h.precipAmt.toFixed(1)} mm/h)`;
            },
            afterBody(items) {
              if (!items.length) return [];
              const h = hours[items[0].dataIndex];
              if (!h) return [];
              const lines = [];
              if (h.tempC !== null) {
                lines.push(`🌡️ Temp: ${h.tempC.toFixed(1)} °C`);
              }
              if (h.snowCm !== null) {
                lines.push(`❄️ Snow depth: ${h.snowCm.toFixed(1)} cm${h.freshSnow > 0 ? ` (+${h.freshSnow.toFixed(1)} mm/h fresh)` : ''}`);
              } else if (h.freshSnow > 0) {
                lines.push(`🌨️ Fresh snow eq.: ${h.freshSnow.toFixed(1)} mm/h`);
              }
              const tierText = getTierLabelForHour(h.barMode, h.sunFrac);
              lines.push(`🥾 Hiking: ${tierText}${h.windowInfo ? ` · ${h.windowInfo}` : ''}`);
              return lines;
            },
          },
        },
      },
    },
    plugins: [hikingOverlayPlugin],
  });

  hikingCharts.set(stationId, chart);
}
