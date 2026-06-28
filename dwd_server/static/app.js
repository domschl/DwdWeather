// Register custom Chart.js interaction mode: closest dataset to mouse, or multiple if very close
if (typeof window !== 'undefined' && window.Chart) {
  Chart.Interaction.modes.closestOrNeighbours = function(chart, e, options) {
    const indexElements = Chart.Interaction.modes.index(chart, e, { intersect: false, axis: 'x' });
    if (!indexElements || indexElements.length === 0) return [];
    
    const mouseY = e.y;
    let closestEl = null;
    let minDistance = Infinity;
    const distances = [];
    
    indexElements.forEach(el => {
      const datasetIndex = el.datasetIndex;
      const index = el.index;
      const meta = chart.getDatasetMeta(datasetIndex);
      const element = meta.data[index];
      if (element && typeof element.y === 'number' && !isNaN(element.y)) {
        const dist = Math.abs(element.y - mouseY);
        distances.push({ el, dist, y: element.y });
        if (dist < minDistance) {
          minDistance = dist;
          closestEl = el;
        }
      }
    });
    
    if (!closestEl) return indexElements;
    
    const targetY = distances.find(d => d.el === closestEl).y;
    const tolerance = 15; // pixels
    
    return distances
      .filter(d => Math.abs(d.y - targetY) <= tolerance)
      .map(d => d.el);
  };
}

let weatherData = null;
let ensembleData = null;
let currentViewMode = 'near'; // 'near', 'extended', 'ensemble', or 'history'
let weatherChart = null;
let historyData = null;
let currentHistoryGroup = 'space_weather'; // 'temp_solar', 'moisture', 'radiation', 'pressure', 'magnetic', 'space_weather'
let statusData = null;

document.addEventListener('DOMContentLoaded', () => {
  fetchForecast();
  fetchStatus();
  // Auto-refresh status every 2 minutes
  setInterval(fetchStatus, 120_000);
});

// Fetch forecast from the REST API
async function fetchForecast() {
  setLoadingState(true);
  try {
    const response = await fetch('/api/forecast');
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
    const data = await response.json();
    weatherData = data;
    updateDashboard();
    switchViewMode(currentViewMode);
  } catch (error) {
    console.error('Error fetching forecast:', error);
    alert(`Failed to load forecast data: ${error.message}`);
  } finally {
    setLoadingState(false);
  }
}

// Fetch ensemble weather data from API
async function fetchEnsembleData() {
  setLoadingState(true);
  try {
    const response = await fetch('/api/ensemble');
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
    const res = await response.json();
    ensembleData = res.data;
    renderChartAndTable();
  } catch (error) {
    console.error('Error fetching ensemble forecast:', error);
    alert(`Failed to load ensemble data: ${error.message}`);
  } finally {
    setLoadingState(false);
  }
}

// Trigger manual refresh
async function triggerRefresh() {
  const refreshBtn = document.getElementById('btn-refresh');
  const btnIcon = refreshBtn.querySelector('.btn-icon');
  
  refreshBtn.disabled = true;
  if (btnIcon) btnIcon.classList.add('spinning');
  
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
    const data = await response.json();
    weatherData = data;
    
    // Notify if served from cache due to rate limits
    if (data.source.includes('cache (rate-limited)')) {
      showToast("Weather updated recently. Serving from cache (1,800s rate limit).");
    } else {
      showToast("Forecast successfully refreshed from DWD!");
    }
    
    ensembleData = null;
    if (currentViewMode === 'ensemble') {
      await fetchEnsembleData();
    } else {
      updateDashboard();
    }
  } catch (error) {
    console.error('Error refreshing forecast:', error);
    alert(`Refresh failed: ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
    if (btnIcon) btnIcon.classList.remove('spinning');
  }
}

// Set UI loading indicator state
def = null;
function setLoadingState(isLoading) {
  const statusText = document.getElementById('cache-status-text');
  const statusDot = document.getElementById('status-dot');
  
  if (isLoading) {
    statusText.textContent = "Loading data...";
    statusDot.className = "status-dot warning";
  }
}

// Show a non-blocking temporary toast message
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Inject style dynamically if not already styled in CSS
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Helper to format ISO timesteps to Europe/Berlin timezone in 24h format
function formatLocalTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleString('en-GB', { 
    weekday: 'short', 
    day: '2-digit', 
    month: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Berlin'
  });
}

function formatHour(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Berlin'
  });
}

function interpolateValue(now, times, dataArray) {
  if (!times || !dataArray || times.length === 0 || dataArray.length === 0) return null;
  
  let idx1 = -1;
  let idx2 = -1;
  for (let i = 0; i < times.length - 1; i++) {
    const d1 = new Date(times[i]);
    const d2 = new Date(times[i+1]);
    if (now >= d1 && now <= d2) {
      idx1 = i;
      idx2 = i + 1;
      break;
    }
  }
  
  if (idx1 !== -1 && idx2 !== -1) {
    const d1 = new Date(times[idx1]);
    const d2 = new Date(times[idx2]);
    const v1 = dataArray[idx1];
    const v2 = dataArray[idx2];
    if (v1 !== null && v2 !== null) {
      const weight = (now - d1) / (d2 - d1);
      return v1 + weight * (v2 - v1);
    }
  }
  
  let closestIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]) - now);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }
  return dataArray[closestIdx];
}

// Update all components of the dashboard
function updateDashboard() {
  if (!weatherData || !weatherData.forecast) return;
  
  const fc = weatherData.forecast;
  
  // Update Station Badges and Meta
  document.getElementById('station-info-display').textContent = `${fc.station_id} - ${fc.station_name}`;
  document.getElementById('meta-station-id').textContent = fc.station_id;
  document.getElementById('meta-station-name').textContent = fc.station_name;
  document.getElementById('meta-coordinates').textContent = `${fc.coordinates[1].toFixed(2)}°N, ${fc.coordinates[0].toFixed(2)}°E`;
  document.getElementById('meta-elevation').textContent = `${fc.coordinates[2]} m`;
  
  // Update cache status
  const lastUpdatedDate = new Date(weatherData.last_updated * 1000);
  const formattedLastUpdated = lastUpdatedDate.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Europe/Berlin'
  });
  document.getElementById('cache-status-text').textContent = `Status: Fresh (Source: ${weatherData.source}, Updated: ${formattedLastUpdated} CET/CEST)`;
  const statusDot = document.getElementById('status-dot');
  
  // Set color green/yellow based on age
  const ageSecs = (Date.now() / 1000) - weatherData.last_updated;
  if (ageSecs < 1800) {
    statusDot.className = "status-dot fresh";
  } else {
    statusDot.className = "status-dot warning";
  }
  
  // Update Forecast Issue Time
  const issueDate = new Date(fc.issue_time);
  const formattedIssueTime = issueDate.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Berlin'
  });
  document.getElementById('data-issue-time').textContent = `Forecast Issue Time: ${formattedIssueTime} CET/CEST`;
  
  // Extract lists
  const times = fc.timesteps;
  const ttt = fc.elements.TTT || [];
  const sund1 = fc.elements.SunD1 || [];
  const wwp = fc.elements.wwP || [];
  const drr1 = fc.elements.DRR1 || [];
  const rr1c = fc.elements.RR1c || [];
  
  // Populate Quick Weather Cards (interpolating values for current time)
  const nowVal = new Date();

  // Populate Home Sensors Card
  const lastMqtt = weatherData.mqtt_last_measurement;
  const lastMqttIndoor = weatherData.mqtt_indoor_last_measurement;
  
  if (lastMqtt && lastMqtt.temp !== null) {
    document.getElementById('sensor-outdoor-temp').textContent = lastMqtt.temp.toFixed(1);
  } else {
    document.getElementById('sensor-outdoor-temp').textContent = '--.-';
  }
  
  if (lastMqttIndoor && lastMqttIndoor.temp !== null) {
    document.getElementById('sensor-indoor-temp').textContent = lastMqttIndoor.temp.toFixed(1);
  } else {
    document.getElementById('sensor-indoor-temp').textContent = '--.-';
  }
  
  let lastTimeMs = 0;
  if (lastMqtt && lastMqtt.time) {
    lastTimeMs = Math.max(lastTimeMs, lastMqtt.time * 1000);
  }
  if (lastMqttIndoor && lastMqttIndoor.time) {
    lastTimeMs = Math.max(lastTimeMs, lastMqttIndoor.time * 1000);
  }
  
  if (lastTimeMs > 0) {
    const sensorDate = new Date(lastTimeMs);
    const timeFormatted = sensorDate.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Europe/Berlin'
    });
    document.getElementById('sensor-updated').textContent = `Last reading at ${timeFormatted} CET/CEST`;
  } else {
    document.getElementById('sensor-updated').textContent = 'No measurements received';
  }
  
  if (ttt.length > 0) {
    const interpolatedTempK = interpolateValue(nowVal, times, ttt);
    const curTempC = interpolatedTempK !== null ? (interpolatedTempK - 273.15) : null;
    document.getElementById('current-temp').textContent = curTempC !== null ? curTempC.toFixed(1) : '--.-';
    
    // Find min/max in the next 48h
    const limit = Math.min(48, ttt.length);
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    for (let i = 0; i < limit; i++) {
      if (ttt[i] !== null) {
        const tempC = ttt[i] - 273.15;
        if (tempC < minTemp) minTemp = tempC;
        if (tempC > maxTemp) maxTemp = tempC;
      }
    }
    document.getElementById('temp-range').textContent = `48h Min: ${minTemp.toFixed(1)}°C | Max: ${maxTemp.toFixed(1)}°C`;
  }
  
  if (sund1.length > 0) {
    // Current sunshine (interpolated, converted from seconds to minutes)
    const interpolatedSunSecs = interpolateValue(nowVal, times, sund1);
    const curSunMin = interpolatedSunSecs !== null ? Math.round(interpolatedSunSecs / 60) : 0;
    document.getElementById('sun-duration').textContent = curSunMin;
    
    // Calculate total sunshine hours in next 48h
    const limit = Math.min(48, sund1.length);
    let totalSunSecs = 0;
    for (let i = 0; i < limit; i++) {
      if (sund1[i] !== null) totalSunSecs += sund1[i];
    }
    const totalSunHrs = totalSunSecs / 3600;
    document.getElementById('sun-summary').textContent = `Total: ${totalSunHrs.toFixed(1)}h sunshine next 48h`;
  }
  
  if (wwp.length > 0) {
    // Current rain probability (interpolated)
    const interpolatedRainProb = interpolateValue(nowVal, times, wwp);
    const curRainProb = interpolatedRainProb !== null ? Math.round(interpolatedRainProb) : 0;
    document.getElementById('rain-probability').textContent = curRainProb;
    
    // Find index of current slot
    let curIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(new Date(times[i]) - nowVal);
      if (diff < minDiff) {
        minDiff = diff;
        curIdx = i;
      }
    }
    
    // Calculate risk in next 3 hours (from curIdx to curIdx+2)
    let next3hMax = 0;
    let next3hNoRainProb = 1.0;
    let next3hCount = 0;
    for (let i = curIdx; i < Math.min(curIdx + 3, wwp.length); i++) {
      if (wwp[i] !== null) {
        const p = wwp[i] / 100.0;
        next3hNoRainProb *= (1.0 - p);
        if (wwp[i] > next3hMax) next3hMax = wwp[i];
        next3hCount++;
      }
    }
    const next3hUnion = next3hCount > 0 ? Math.round((1.0 - next3hNoRainProb) * 100) : 0;

    // Find max rain probability in next 48h
    const limit = Math.min(48, wwp.length);
    let maxProb = 0;
    for (let i = 0; i < limit; i++) {
      if (wwp[i] !== null && wwp[i] > maxProb) maxProb = wwp[i];
    }
    document.getElementById('rain-summary').textContent = `Next 3h: ${next3hUnion}% risk (Max ${Math.round(next3hMax)}%) | 48h Max: ${Math.round(maxProb)}%`;
  }
  
  // Render Chart and Table
  renderChartAndTable();
}

// Switch between Near-term (48h detailed), Extended (10d downsampled), Ensemble, or History
function switchViewMode(mode) {
  currentViewMode = mode;
  
  // Update Tab active style
  document.getElementById('btn-tab-near').classList.toggle('active', mode === 'near');
  document.getElementById('btn-tab-extended').classList.toggle('active', mode === 'extended');
  document.getElementById('btn-tab-ensemble').classList.toggle('active', mode === 'ensemble');
  document.getElementById('btn-tab-history').classList.toggle('active', mode === 'history');
  
  const historyControls = document.getElementById('history-controls');
  if (mode === 'history') {
    historyControls.style.display = 'flex';
    const startInput = document.getElementById('history-start');
    const endInput = document.getElementById('history-end');
    if (!startInput.value || !endInput.value) {
      setHistoryRange(7);
    } else {
      fetchHistoryData();
    }
  } else if (mode === 'ensemble') {
    historyControls.style.display = 'none';
    if (!ensembleData) {
      fetchEnsembleData();
    } else {
      renderChartAndTable();
    }
  } else {
    historyControls.style.display = 'none';
    renderChartAndTable();
  }
}

function setHistoryRange(days) {
  document.getElementById('btn-preset-7d').classList.toggle('active', days === 7);
  document.getElementById('btn-preset-30d').classList.toggle('active', days === 30);
  
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];
  
  document.getElementById('history-start').value = startStr;
  document.getElementById('history-end').value = endStr;
  
  fetchHistoryData();
}

function onCustomHistoryChange() {
  document.getElementById('btn-preset-7d').classList.remove('active');
  document.getElementById('btn-preset-30d').classList.remove('active');
  fetchHistoryData();
}

async function fetchHistoryData() {
  const startVal = document.getElementById('history-start').value;
  const endVal = document.getElementById('history-end').value;
  if (!startVal || !endVal) return;
  
  setLoadingState(true);
  try {
    const startDate = new Date(startVal + 'T00:00:00Z');
    const endDate = new Date(endVal + 'T23:59:59Z');
    
    const response = await fetch(`/api/history?start=${startDate.toISOString()}&end=${endDate.toISOString()}`);
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
    historyData = await response.json();
    renderChartAndTable();
  } catch (error) {
    console.error('Error fetching history:', error);
    alert(`Failed to load historical data: ${error.message}`);
  } finally {
    setLoadingState(false);
  }
}

function getMetricKeyFromTopic(topic) {
  if (topic.endsWith('/frequency')) return 'geiger_freq';
  if (topic.endsWith('/pressureNN')) return 'pressure';
  if (topic.endsWith('/humidity')) return 'humidity';
  if (topic.endsWith('/illuminance')) return 'luminosity';
  if (topic.endsWith('/magnetic_field_strength')) return 'magnetic';
  if (topic.endsWith('/magnetic_field_x')) return 'magnetic_x';
  if (topic.endsWith('/magnetic_field_y')) return 'magnetic_y';
  if (topic.endsWith('/magnetic_field_z')) return 'magnetic_z';
  if (topic.endsWith('/gamma10minavg')) return 'gamma_10m';
  if (topic.endsWith('/gamma1minavg')) return 'gamma_1m';
  if (topic.endsWith('/unitrain')) return 'rain_sensor';
  return null;
}

function switchHistoryGroup(group) {
  currentHistoryGroup = group;
  const groups = ['temp_solar', 'moisture', 'radiation', 'pressure', 'magnetic', 'space_weather'];
  groups.forEach(g => {
    const btn = document.getElementById(`btn-group-${g}`);
    if (btn) {
      btn.classList.toggle('active', g === group);
    }
  });
  renderChartAndTable();
}

function getHistoricalFilteredData() {
  if (!historyData) return null;
  const hourlyMap = {};
  
  function initHour(hourKey) {
    if (!hourlyMap[hourKey]) {
      hourlyMap[hourKey] = {
        forecast_temp: [],
        forecast_sund: [],
        forecast_wwp: [],
        outdoor_temp: [],
        indoor_temp: [],
        geiger_freq: [],
        pressure: [],
        humidity: [],
        luminosity: [],
        magnetic: [],
        magnetic_x: [],
        magnetic_y: [],
        magnetic_z: [],
        gamma_10m: [],
        gamma_1m: [],
        rain_sensor: [],
        kp: [],
        wind_speed: [],
        wind_density: [],
        imf_bt: [],
        imf_bz: [],
        mim_temp: [],
        mim_humidity: [],
        mim_wind_speed: [],
        mim_wind_dir: [],
        mim_global_rad: [],
        mim_diffuse_rad: [],
        mim_atm_rad: []
      };
    }
  }

  // Tracks which (hourKey, key) pairs have at least one null-sentinel row.
  // If an hour has ONLY null sentinels and no real values, avg() returns null
  // and the time-axis entry is still created so Chart.js shows a gap.
  const nullSentinelHours = {}; // key -> Set<hourKey>

  function addToHourly(list, key, transform = (v) => v) {
    if (!list) return;
    list.forEach(item => {
      const d = new Date(item.time);
      if (isNaN(d.getTime())) return;
      d.setMinutes(0, 0, 0);
      const hourKey = d.toISOString();
      if (item.val === null || item.val === undefined) {
        // Null sentinel: register the hour so it appears on the time axis
        initHour(hourKey);
        if (!nullSentinelHours[key]) nullSentinelHours[key] = new Set();
        nullSentinelHours[key].add(hourKey);
        return; // do not push into the numeric array
      }
      initHour(hourKey);
      hourlyMap[hourKey][key].push(transform(item.val));
    });
  }

  addToHourly(historyData.forecast, 'forecast_temp', (v) => v - 273.15); // convert forecast Kelvin to C
  addToHourly(historyData.forecast_sund, 'forecast_sund', (v) => v / 60); // convert seconds to minutes
  addToHourly(historyData.forecast_wwp, 'forecast_wwp');
  addToHourly(historyData.outdoor, 'outdoor_temp');
  addToHourly(historyData.indoor, 'indoor_temp');
  addToHourly(historyData.kp, 'kp');
  addToHourly(historyData.wind_speed, 'wind_speed');
  addToHourly(historyData.wind_density, 'wind_density');
  addToHourly(historyData.imf_bt, 'imf_bt');
  addToHourly(historyData.imf_bz, 'imf_bz');
  addToHourly(historyData.mim_temp, 'mim_temp');
  addToHourly(historyData.mim_humidity, 'mim_humidity');
  addToHourly(historyData.mim_wind_speed, 'mim_wind_speed');
  addToHourly(historyData.mim_wind_dir, 'mim_wind_dir');
  addToHourly(historyData.mim_global_rad, 'mim_global_rad');
  addToHourly(historyData.mim_diffuse_rad, 'mim_diffuse_rad');
  addToHourly(historyData.mim_atm_rad, 'mim_atm_rad');

  if (historyData.additional) {
    Object.entries(historyData.additional).forEach(([topic, list]) => {
      const key = getMetricKeyFromTopic(topic);
      if (key) {
        addToHourly(list, key);
      }
    });
  }

  const sortedHours = Object.keys(hourlyMap).sort();
  const result = {
    labels: [],
    temps: [],
    localTemps: [],
    indoorTemps: [],
    sunDuration: [],
    rainProb: [],
    geiger_freq: [],
    pressure: [],
    humidity: [],
    luminosity: [],
    magnetic: [],
    magnetic_x: [],
    magnetic_y: [],
    magnetic_z: [],
    gamma_10m: [],
    gamma_1m: [],
    rain_sensor: [],
    kp: [],
    wind_speed: [],
    wind_density: [],
    imf_bt: [],
    imf_bz: [],
    mim_temp: [],
    mim_humidity: [],
    mim_wind_speed: [],
    mim_wind_dir: [],
    mim_global_rad: [],
    mim_diffuse_rad: [],
    mim_atm_rad: []
  };

  sortedHours.forEach(hourStr => {
    result.labels.push(hourStr);
    const obj = hourlyMap[hourStr];
    
    // avgOrNull returns null both when arr is empty (no data for this hour)
    // and when the hour had only null-sentinel rows (handled by nullSentinelHours).
    const avg = (arr) => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    
    result.temps.push(avg(obj.forecast_temp));
    result.localTemps.push(avg(obj.outdoor_temp));
    result.indoorTemps.push(avg(obj.indoor_temp));
    result.sunDuration.push(avg(obj.forecast_sund));
    result.rainProb.push(avg(obj.forecast_wwp));
    
    result.geiger_freq.push(avg(obj.geiger_freq));
    result.pressure.push(avg(obj.pressure));
    result.humidity.push(avg(obj.humidity));
    result.luminosity.push(avg(obj.luminosity));
    result.magnetic.push(avg(obj.magnetic));
    result.magnetic_x.push(avg(obj.magnetic_x));
    result.magnetic_y.push(avg(obj.magnetic_y));
    result.magnetic_z.push(avg(obj.magnetic_z));
    result.gamma_10m.push(avg(obj.gamma_10m));
    result.gamma_1m.push(avg(obj.gamma_1m));
    result.rain_sensor.push(avg(obj.rain_sensor));
    result.kp.push(avg(obj.kp));
    result.wind_speed.push(avg(obj.wind_speed));
    result.wind_density.push(avg(obj.wind_density));
    result.imf_bt.push(avg(obj.imf_bt));
    result.imf_bz.push(avg(obj.imf_bz));
    result.mim_temp.push(avg(obj.mim_temp));
    result.mim_humidity.push(avg(obj.mim_humidity));
    result.mim_wind_speed.push(avg(obj.mim_wind_speed));
    result.mim_wind_dir.push(avg(obj.mim_wind_dir));
    result.mim_global_rad.push(avg(obj.mim_global_rad));
    result.mim_diffuse_rad.push(avg(obj.mim_diffuse_rad));
    result.mim_atm_rad.push(avg(obj.mim_atm_rad));
  });

  result.nullSentinelHours = nullSentinelHours;
  return result;
}

// Filters and formats datasets based on the selected view mode
function getLocalTempForHour(isoTime, mqttHistory) {
  const targetDate = new Date(isoTime);
  let sum = 0;
  let count = 0;
  
  for (const [key, temp] of Object.entries(mqttHistory)) {
    const slotDate = new Date(key);
    const diffMs = slotDate - targetDate;
    // Average all 10-minute slots falling within the hour [0, 59] minutes
    if (diffMs >= 0 && diffMs < 3600000) {
      sum += temp;
      count++;
    }
  }
  
  return count > 0 ? (sum / count) : null;
}

// Formats ECMWF ensemble forecasts for the spaghetti plots and comparison table
function getEnsembleFilteredData() {
  if (!ensembleData || !ensembleData.hourly) return null;
  
  const hourly = ensembleData.hourly;
  const times = hourly.time;
  const labels = times.map(t => new Date(t).toISOString());
  
  const tempMean = hourly.temperature_2m || [];
  const precipMean = hourly.precipitation || [];
  
  // Calculate accumulated precipitation for mean
  const precipMeanAcc = [];
  let accumMean = 0;
  for (let i = 0; i < precipMean.length; i++) {
    if (precipMean[i] !== null && precipMean[i] !== undefined) {
      accumMean += precipMean[i];
    }
    precipMeanAcc.push(accumMean);
  }
  
  // Align DWD forecast values (Temp and Accumulated Rain) to the ensemble timeline
  const dwdTempList = new Array(times.length).fill(null);
  const dwdPrecipList = new Array(times.length).fill(null);
  
  if (weatherData && weatherData.forecast) {
    const fc = weatherData.forecast;
    const fcTimes = fc.timesteps;
    const fcTtt = fc.elements.TTT || [];
    const fcRrc = fc.elements.RR1c || [];
    
    // Create mapping of time (rounded to hour) to value
    const fcTempMap = new Map();
    const fcPrecipMap = new Map();
    let dwdPrecipAccum = 0;
    
    for (let i = 0; i < fcTimes.length; i++) {
      const ms = new Date(fcTimes[i]).getTime();
      // Round to nearest hour
      const msRounded = Math.round(ms / 3600000) * 3600000;
      
      if (fcTtt[i] !== null) {
        fcTempMap.set(msRounded, fcTtt[i] - 273.15);
      }
      if (fcRrc[i] !== null) {
        dwdPrecipAccum += fcRrc[i];
        fcPrecipMap.set(msRounded, dwdPrecipAccum);
      }
    }
    
    // Fill the aligned lists
    for (let i = 0; i < times.length; i++) {
      const ensMs = new Date(times[i]).getTime();
      const ensMsRounded = Math.round(ensMs / 3600000) * 3600000;
      
      if (fcTempMap.has(ensMsRounded)) {
        dwdTempList[i] = fcTempMap.get(ensMsRounded);
      }
      if (fcPrecipMap.has(ensMsRounded)) {
        dwdPrecipList[i] = fcPrecipMap.get(ensMsRounded);
      }
    }
  }
  
  // Build chart datasets
  const chartDatasets = [];
  
  // 1. Temperature Members
  for (let m = 1; m <= 50; m++) {
    const memberKey = `temperature_2m_member${m.toString().padStart(2, '0')}`;
    const memberData = hourly[memberKey];
    if (memberData) {
      const points = memberData.map((val, idx) => ({ x: labels[idx], y: val }));
      chartDatasets.push({
        type: 'line',
        label: `Member Temp ${m}`,
        data: points,
        borderColor: 'rgba(255, 94, 58, 0.20)',
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y-temp',
        tension: 0.1,
        order: 10
      });
    }
  }
  
  // 2. Precipitation Members (Accumulated)
  for (let m = 1; m <= 50; m++) {
    const memberKey = `precipitation_member${m.toString().padStart(2, '0')}`;
    const memberData = hourly[memberKey];
    if (memberData) {
      const points = [];
      let accum = 0;
      for (let i = 0; i < memberData.length; i++) {
        if (memberData[i] !== null && memberData[i] !== undefined) {
          accum += memberData[i];
        }
        points.push({ x: labels[i], y: accum });
      }
      chartDatasets.push({
        type: 'line',
        label: `Member Precip ${m}`,
        data: points,
        borderColor: 'rgba(59, 130, 246, 0.20)',
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y-precip-acc',
        tension: 0.1,
        order: 11
      });
    }
  }
  
  // 3. Ensemble Temp Mean
  chartDatasets.push({
    type: 'line',
    label: 'Ensemble Temp Mean (°C)',
    data: tempMean.map((val, idx) => ({ x: labels[idx], y: val })),
    borderColor: '#ff5e3a',
    borderWidth: 3,
    pointRadius: 0,
    pointHoverRadius: 4,
    fill: false,
    yAxisID: 'y-temp',
    tension: 0.2,
    order: 2
  });
  
  // 4. Ensemble Precipitation Mean (Accumulated)
  chartDatasets.push({
    type: 'line',
    label: 'Ensemble Precip Mean (mm)',
    data: precipMeanAcc.map((val, idx) => ({ x: labels[idx], y: val })),
    borderColor: '#3b82f6',
    borderWidth: 3,
    pointRadius: 0,
    pointHoverRadius: 4,
    fill: false,
    yAxisID: 'y-precip-acc',
    tension: 0.2,
    order: 3
  });
  
  // 5. DWD Forecast Temp (Overlay)
  const dwdTempPoints = [];
  for (let i = 0; i < dwdTempList.length; i++) {
    if (dwdTempList[i] !== null) {
      dwdTempPoints.push({ x: labels[i], y: dwdTempList[i] });
    }
  }
  if (dwdTempPoints.length > 0) {
    chartDatasets.push({
      type: 'line',
      label: 'DWD Forecast Temp (°C)',
      data: dwdTempPoints,
      borderColor: '#00ff66',
      borderWidth: 2,
      borderDash: [5, 5],
      pointRadius: 0,
      fill: false,
      yAxisID: 'y-temp',
      tension: 0.2,
      order: 1
    });
  }
  
  // 6. DWD Forecast Precip (Overlay)
  const dwdPrecipPoints = [];
  for (let i = 0; i < dwdPrecipList.length; i++) {
    if (dwdPrecipList[i] !== null) {
      dwdPrecipPoints.push({ x: labels[i], y: dwdPrecipList[i] });
    }
  }
  if (dwdPrecipPoints.length > 0) {
    chartDatasets.push({
      type: 'line',
      label: 'DWD Forecast Precip (mm)',
      data: dwdPrecipPoints,
      borderColor: '#e879f9',
      borderWidth: 2,
      borderDash: [5, 5],
      pointRadius: 0,
      fill: false,
      yAxisID: 'y-precip-acc',
      tension: 0.2,
      order: 4
    });
  }
  
  return {
    labels: labels,
    ensembleTemp: tempMean,
    dwdTemp: dwdTempList,
    ensemblePrecip: precipMeanAcc,
    dwdPrecip: dwdPrecipList,
    chartDatasets: chartDatasets
  };
}

// Filters and formats datasets based on the selected view mode
function getFilteredData() {
  if (currentViewMode === 'ensemble') {
    return getEnsembleFilteredData();
  }
  if (currentViewMode === 'history') {
    return getHistoricalFilteredData();
  }
  if (!weatherData || !weatherData.forecast) return null;
  
  const fc = weatherData.forecast;
  const times = fc.timesteps;
  const ttt = fc.elements.TTT || [];
  const sund1 = fc.elements.SunD1 || [];
  const wwp = fc.elements.wwP || [];
  const drr1 = fc.elements.DRR1 || [];
  const rr1c = fc.elements.RR1c || [];
  const mqttHistory = weatherData.mqtt_history || {};
  const mqttIndoorHistory = weatherData.mqtt_indoor_history || {};
  
  const result = {
    labels: [],
    temps: [],
    localTemps: [],
    indoorTemps: [],
    sunDuration: [],
    rainProb: [],
    rainDuration: [],
    rainAmount: []
  };
  
  const limit = times.length;
  const forecastIndices = [];
  
  if (currentViewMode === 'near') {
    const targetLimit = Math.min(48, limit);
    for (let i = 0; i < targetLimit; i++) {
      forecastIndices.push(i);
    }
  } else {
    for (let i = 0; i < limit; i++) {
      if (i < 48) {
        forecastIndices.push(i);
      } else if ((i - 48) % 6 === 0) {
        forecastIndices.push(i);
      }
    }
  }
  
  if (forecastIndices.length === 0) return result;
  
  if (currentViewMode === 'near') {
    // 1. Time scale: Merge forecast and 10-minute sensor timestamps
    const startTime = new Date(times[forecastIndices[0]]).getTime();
    const endTime = new Date(times[forecastIndices[forecastIndices.length - 1]]).getTime();
    
    const uniqueTimesSet = new Set();
    forecastIndices.forEach(idx => {
      uniqueTimesSet.add(new Date(times[idx]).getTime());
    });
    
    Object.keys(mqttHistory).forEach(slotStr => {
      const slotMs = new Date(slotStr).getTime();
      if (slotMs >= startTime && slotMs <= endTime) {
        uniqueTimesSet.add(slotMs);
      }
    });

    Object.keys(mqttIndoorHistory).forEach(slotStr => {
      const slotMs = new Date(slotStr).getTime();
      if (slotMs >= startTime && slotMs <= endTime) {
        uniqueTimesSet.add(slotMs);
      }
    });
    
    const sortedTimesMs = Array.from(uniqueTimesSet).sort((a, b) => a - b);
    
    const forecastMap = new Map();
    forecastIndices.forEach(idx => {
      const ms = new Date(times[idx]).getTime();
      forecastMap.set(ms, {
        temp: ttt[idx] !== null ? ttt[idx] - 273.15 : null,
        sun: sund1[idx] !== null ? sund1[idx] / 60 : null,
        prob: wwp[idx],
        dur: drr1[idx] !== null ? drr1[idx] / 60 : null,
        amt: rr1c[idx]
      });
    });
    
    const sensorMap = new Map();
    Object.entries(mqttHistory).forEach(([slotStr, temp]) => {
      const ms = new Date(slotStr).getTime();
      sensorMap.set(ms, temp);
    });

    const sensorIndoorMap = new Map();
    Object.entries(mqttIndoorHistory).forEach(([slotStr, temp]) => {
      const ms = new Date(slotStr).getTime();
      sensorIndoorMap.set(ms, temp);
    });
    
    sortedTimesMs.forEach(ms => {
      const isoStr = new Date(ms).toISOString();
      result.labels.push(isoStr);
      
      if (forecastMap.has(ms)) {
        const fcVal = forecastMap.get(ms);
        result.temps.push(fcVal.temp);
        result.sunDuration.push(fcVal.sun);
        result.rainProb.push(fcVal.prob);
        result.rainDuration.push(fcVal.dur);
        result.rainAmount.push(fcVal.amt);
      } else {
        result.temps.push(null);
        result.sunDuration.push(null);
        result.rainProb.push(null);
        result.rainDuration.push(null);
        result.rainAmount.push(null);
      }
      
      if (sensorMap.has(ms)) {
        result.localTemps.push(sensorMap.get(ms));
      } else {
        result.localTemps.push(null);
      }

      if (sensorIndoorMap.has(ms)) {
        result.indoorTemps.push(sensorIndoorMap.get(ms));
      } else {
        result.indoorTemps.push(null);
      }
    });
  } else {
    // 2. Category scale: Keep exactly the forecast timesteps
    forecastIndices.forEach(idx => {
      const isoStr = times[idx];
      result.labels.push(isoStr);
      
      const tempC = ttt[idx] !== null ? ttt[idx] - 273.15 : null;
      result.temps.push(tempC);
      
      const sunMin = sund1[idx] !== null ? sund1[idx] / 60 : null;
      result.sunDuration.push(sunMin);
      
      result.rainProb.push(wwp[idx]);
      
      const rainMin = drr1[idx] !== null ? drr1[idx] / 60 : null;
      result.rainDuration.push(rainMin);
      
      result.rainAmount.push(rr1c[idx]);
      
      // For local temperatures in extended view, use hourly averaged sensor values for the first 48 hours
      const localTemp = getLocalTempForHour(isoStr, mqttHistory);
      result.localTemps.push(localTemp);

      const indoorTemp = getLocalTempForHour(isoStr, mqttIndoorHistory);
      result.indoorTemps.push(indoorTemp);
    });
  }
  
  return result;
}

function getHistoryChartData(labels, values, key, nullSentinelHours) {
  const chartData = [];
  const sentinels = (nullSentinelHours && nullSentinelHours[key]) || new Set();
  for (let i = 0; i < labels.length; i++) {
    const val = values[i];
    if (val !== null) {
      chartData.push({ x: labels[i], y: val });
    } else if (sentinels.has(labels[i])) {
      chartData.push({ x: labels[i], y: null });
    }
  }
  return chartData;
}

// Render chart and populate data table
function renderChartAndTable() {
  const data = getFilteredData();
  if (!data) return;
  
  // --- 1. Populate Table ---
  const theadTr = document.querySelector('#forecast-data-table thead tr');
  const tbody = document.getElementById('forecast-table-body');
  tbody.innerHTML = '';
  
  let columns = [];
  if (currentViewMode === 'ensemble') {
    theadTr.innerHTML = `
      <th>Time (Local)</th>
      <th>Ensemble Temp Mean (°C)</th>
      <th>DWD Forecast Temp (°C)</th>
      <th>Ensemble Accum. Precip (mm)</th>
      <th>DWD Forecast Precip (mm)</th>
    `;
    columns = [
      { name: 'time', format: formatLocalTime },
      { name: 'ensembleTemp', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
      { name: 'dwdTemp', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
      { name: 'ensemblePrecip', format: v => v !== null ? `${v.toFixed(1)} mm` : '-' },
      { name: 'dwdPrecip', format: v => v !== null ? `${v.toFixed(1)} mm` : '-' }
    ];
  } else if (currentViewMode !== 'history') {
    theadTr.innerHTML = `
      <th>Time (Local)</th>
      <th>Forecast Temp (°C)</th>
      <th>Outdoor Sensor (°C)</th>
      <th>Indoor Sensor (°C)</th>
      <th>Precipitation Prob (%)</th>
      <th>Precipitation Dur (min)</th>
      <th>Precipitation Amt (mm)</th>
      <th>Sunshine Dur (min)</th>
    `;
    columns = [
      { name: 'time', format: formatLocalTime },
      { name: 'temps', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
      { name: 'localTemps', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
      { name: 'indoorTemps', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
      { name: 'rainProb', format: v => v !== null ? `${Math.round(v)} %` : '-' },
      { name: 'rainDuration', format: v => v !== null ? `${Math.round(v)} min` : '-' },
      { name: 'rainAmount', format: v => v !== null ? `${v.toFixed(2)} mm` : '-' },
      { name: 'sunDuration', format: v => v !== null ? `${Math.round(v)} min` : '-' }
    ];
  } else {
    if (currentHistoryGroup === 'temp_solar') {
      theadTr.innerHTML = `
        <th>Time (Local)</th>
        <th>Forecast Temp (°C)</th>
        <th>Outdoor Temp (°C)</th>
        <th>Indoor Temp (°C)</th>
        <th>MIM Temp (°C)</th>
        <th>Sunshine Dur (min)</th>
        <th>Luminosity (lux)</th>
        <th>MIM Global Rad (W/m²)</th>
        <th>MIM Diffuse Rad (W/m²)</th>
        <th>MIM Atm Rad (W/m²)</th>
      `;
      columns = [
        { name: 'time', format: formatLocalTime },
        { name: 'temps', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
        { name: 'localTemps', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
        { name: 'indoorTemps', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
        { name: 'mim_temp', format: v => v !== null ? `${v.toFixed(1)} °C` : '-' },
        { name: 'sunDuration', format: v => v !== null ? `${Math.round(v)} min` : '-' },
        { name: 'luminosity', format: v => v !== null ? `${v.toFixed(1)} lx` : '-' },
        { name: 'mim_global_rad', format: v => v !== null ? `${v.toFixed(1)} W/m²` : '-' },
        { name: 'mim_diffuse_rad', format: v => v !== null ? `${v.toFixed(1)} W/m²` : '-' },
        { name: 'mim_atm_rad', format: v => v !== null ? `${v.toFixed(1)} W/m²` : '-' }
      ];
    } else if (currentHistoryGroup === 'moisture') {
      theadTr.innerHTML = `
        <th>Time (Local)</th>
        <th>Outdoor Humidity (%)</th>
        <th>MIM Humidity (%)</th>
        <th>Forecast Rain Prob (%)</th>
        <th>Rain Sensor (0-1)</th>
      `;
      columns = [
        { name: 'time', format: formatLocalTime },
        { name: 'humidity', format: v => v !== null ? `${Math.round(v)} %` : '-' },
        { name: 'mim_humidity', format: v => v !== null ? `${Math.round(v)} %` : '-' },
        { name: 'rainProb', format: v => v !== null ? `${Math.round(v)} %` : '-' },
        { name: 'rain_sensor', format: v => v !== null ? `${v.toFixed(2)}` : '-' }
      ];
    } else if (currentHistoryGroup === 'radiation') {
      theadTr.innerHTML = `
        <th>Time (Local)</th>
        <th>Geiger Freq (Hz)</th>
        <th>Gamma 10min Avg (μSv/h)</th>
        <th>Gamma 1min Avg (μSv/h)</th>
      `;
      columns = [
        { name: 'time', format: formatLocalTime },
        { name: 'geiger_freq', format: v => v !== null ? `${v.toFixed(2)} Hz` : '-' },
        { name: 'gamma_10m', format: v => v !== null ? `${v.toFixed(3)} μSv/h` : '-' },
        { name: 'gamma_1m', format: v => v !== null ? `${v.toFixed(3)} μSv/h` : '-' }
      ];
    } else if (currentHistoryGroup === 'pressure') {
      theadTr.innerHTML = `
        <th>Time (Local)</th>
        <th>Air Pressure (hPa)</th>
        <th>MIM Wind Speed (m/s)</th>
        <th>MIM Wind Dir (°)</th>
      `;
      columns = [
        { name: 'time', format: formatLocalTime },
        { name: 'pressure', format: v => v !== null ? `${v.toFixed(1)} hPa` : '-' },
        { name: 'mim_wind_speed', format: v => v !== null ? `${v.toFixed(1)} m/s` : '-' },
        { name: 'mim_wind_dir', format: v => v !== null ? `${Math.round(v)}°` : '-' }
      ];
    } else if (currentHistoryGroup === 'magnetic') {
      theadTr.innerHTML = `
        <th>Time (Local)</th>
        <th>Magnetic Total (nT)</th>
        <th>Magnetic X (nT)</th>
        <th>Magnetic Y (nT)</th>
        <th>Magnetic Z (nT)</th>
      `;
      columns = [
        { name: 'time', format: formatLocalTime },
        { name: 'magnetic', format: v => v !== null ? `${v.toFixed(1)} nT` : '-' },
        { name: 'magnetic_x', format: v => v !== null ? `${v.toFixed(1)} nT` : '-' },
        { name: 'magnetic_y', format: v => v !== null ? `${v.toFixed(1)} nT` : '-' },
        { name: 'magnetic_z', format: v => v !== null ? `${v.toFixed(1)} nT` : '-' }
      ];
    } else if (currentHistoryGroup === 'space_weather') {
      theadTr.innerHTML = `
        <th>Time (Local)</th>
        <th>NOAA Kp Index</th>
        <th>Wind Speed (km/s)</th>
        <th>Wind Density (p/cm³)</th>
        <th>IMF Bt (nT)</th>
        <th>IMF Bz (nT)</th>
      `;
      columns = [
        { name: 'time', format: formatLocalTime },
        { name: 'kp', format: v => v !== null ? `${v.toFixed(2)}` : '-' },
        { name: 'wind_speed', format: v => v !== null ? `${v.toFixed(1)} km/s` : '-' },
        { name: 'wind_density', format: v => v !== null ? `${v.toFixed(1)} p/cm³` : '-' },
        { name: 'imf_bt', format: v => v !== null ? `${v.toFixed(1)} nT` : '-' },
        { name: 'imf_bz', format: v => v !== null ? `${v.toFixed(1)} nT` : '-' }
      ];
    }
  }
  
  document.getElementById('table-row-count').textContent = `Showing ${data.labels.length} data steps`;
  
  data.labels.forEach((timeStr, idx) => {
    const tr = document.createElement('tr');
    columns.forEach(col => {
      const td = document.createElement('td');
      let val;
      if (col.name === 'time') {
        val = timeStr;
      } else {
        val = data[col.name][idx];
      }
      td.textContent = col.format(val);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  
  // --- 2. Render Chart.js ---
  const ctx = document.getElementById('weatherChart').getContext('2d');
  
  // Destroy old chart if exists
  if (weatherChart) {
    weatherChart.destroy();
  }
  
  // Create neon gradients for the chart
  const tempGradient = ctx.createLinearGradient(0, 0, 0, 350);
  tempGradient.addColorStop(0, 'rgba(255, 94, 58, 0.4)');
  tempGradient.addColorStop(1, 'rgba(255, 42, 109, 0.0)');
  
  // Combined custom plugin for chart decorations (alternating day backgrounds and vertical "now" line)
  const forecastDecorationPlugin = {
    id: 'forecastDecoration',
    beforeDatasetsDraw: (chart) => {
      try {
        const { ctx, chartArea, scales: { x: xScale } } = chart;
        if (!chartArea || !xScale || !chart.data || !chart.data.labels || chart.data.labels.length === 0) return;
        
        const labels = chart.data.labels;
        
        // Group indices by calendar day in Europe/Berlin timezone
        const dayGroups = {}; // dayStr -> { startIdx, endIdx }
        for (let i = 0; i < labels.length; i++) {
          const date = new Date(labels[i]);
          if (isNaN(date.getTime())) continue;
          const dayStr = date.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // "YYYY-MM-DD"
          if (!(dayStr in dayGroups)) {
            dayGroups[dayStr] = { startIdx: i, endIdx: i };
          } else {
            dayGroups[dayStr].endIdx = i;
          }
        }
        
        const uniqueDays = Object.keys(dayGroups).sort();
        if (uniqueDays.length === 0) return;
        
        const getBerlinMidnight = (dayStr) => {
          const [year, month, day] = dayStr.split('-').map(Number);
          const d = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
          const format = d.toLocaleString('sv', { timeZone: 'Europe/Berlin' });
          const match = format.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
          if (!match) return d;
          
          const localMs = Date.UTC(
            parseInt(match[1]),
            parseInt(match[2]) - 1,
            parseInt(match[3]),
            parseInt(match[4]),
            parseInt(match[5]),
            parseInt(match[6])
          );
          const offsetMs = localMs - d.getTime();
          return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs);
        };

        const getX = (i) => {
          // 1. Try dataset element coordinate
          const meta = chart.getDatasetMeta(1) || chart.getDatasetMeta(0);
          if (meta && meta.data && meta.data[i] && typeof meta.data[i].x === 'number' && !isNaN(meta.data[i].x)) {
            return meta.data[i].x;
          }
          // 2. Try scale's getPixelForValue with string
          const label = labels[i];
          let val = xScale.getPixelForValue(label);
          if (typeof val === 'number' && !isNaN(val)) return val;
          
          // 3. Try scale's getPixelForValue with Date
          const date = new Date(label);
          if (!isNaN(date.getTime())) {
            val = xScale.getPixelForValue(date);
            if (typeof val === 'number' && !isNaN(val)) return val;
            val = xScale.getPixelForValue(date.getTime());
            if (typeof val === 'number' && !isNaN(val)) return val;
          }
          
          // 4. Try scale's getPixelForTick
          if (typeof xScale.getPixelForTick === 'function') {
            val = xScale.getPixelForTick(i);
            if (typeof val === 'number' && !isNaN(val)) return val;
          }
          
          // 5. Fallback to linear interpolation
          return chartArea.left + (chartArea.right - chartArea.left) * (i / (labels.length - 1 || 1));
        };
        
        ctx.save();
        
        uniqueDays.forEach((dayStr, index) => {
          const { startIdx, endIdx } = dayGroups[dayStr];
          
          // Alternating background colors - different shades of blue/indigo
          if (index % 2 === 0) {
            ctx.fillStyle = 'rgba(99, 102, 241, 0.04)'; // Subtle light blue/indigo tint (4% opacity)
          } else {
            ctx.fillStyle = 'rgba(99, 102, 241, 0.16)'; // Clearer blue/indigo tint (16% opacity)
          }
          
          let xLeft, xRight;
          
          if (xScale.type === 'time') {
            // Time scale: calculate boundaries exactly at 00:00 midnight local time
            const tLeft = getBerlinMidnight(dayStr);
            
            // Add 1 day for right boundary
            const [y, m, d] = dayStr.split('-').map(Number);
            const nextDayDate = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
            const nextDayStr = nextDayDate.toISOString().split('T')[0];
            const tRight = getBerlinMidnight(nextDayStr);
            
            xLeft = xScale.getPixelForValue(tLeft.getTime());
            xRight = xScale.getPixelForValue(tRight.getTime());
          } else {
            // Category scale: align boundaries exactly with the 00:00 tick index
            xLeft = startIdx === 0 ? chartArea.left : getX(startIdx);
            
            const nextDayStr = uniqueDays[index + 1];
            if (nextDayStr) {
              const nextDayStartIdx = dayGroups[nextDayStr].startIdx;
              xRight = getX(nextDayStartIdx);
            } else {
              xRight = chartArea.right;
            }
          }
          
          // Clamp boundaries
          xLeft = Math.max(chartArea.left, Math.min(chartArea.right, xLeft));
          xRight = Math.max(chartArea.left, Math.min(chartArea.right, xRight));
          
          const width = xRight - xLeft;
          if (width > 0) {
            ctx.fillRect(xLeft, chartArea.top, width, chartArea.bottom - chartArea.top);
          }
        });
        
        ctx.restore();
      } catch (err) {
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.fillStyle = '#ff0055';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('Plugin Error: ' + err.message, (chartArea ? chartArea.left : 10) + 10, 30);
        ctx.restore();
        console.error('forecastDecoration plugin backgrounds error:', err);
      }
    },
    afterDraw: (chart) => {
      if (!data || !data.labels || data.labels.length < 2) return;
      
      const now = new Date();
      const firstLabel = new Date(data.labels[0]);
      const lastLabel = new Date(data.labels[data.labels.length - 1]);
      if (now < firstLabel || now > lastLabel) return;
      
      const xScale = chart.scales.x;
      if (!xScale) return;
      
      const ctx = chart.ctx;
      const topY = chart.chartArea.top;
      const bottomY = chart.chartArea.bottom;
      
      // Find adjacent forecast points in raw forecast data to interpolate forecast temperature
      const fcTimes = weatherData && weatherData.forecast ? weatherData.forecast.timesteps : null;
      const fcTtt = weatherData && weatherData.forecast && weatherData.forecast.elements ? (weatherData.forecast.elements.TTT || []) : [];
      let interpolatedTemp = null;
      let fcIdx1 = -1;
      let fcIdx2 = -1;
      if (fcTimes) {
        for (let i = 0; i < fcTimes.length - 1; i++) {
          const d1 = new Date(fcTimes[i]);
          const d2 = new Date(fcTimes[i+1]);
          if (now >= d1 && now <= d2) {
            fcIdx1 = i;
            fcIdx2 = i + 1;
            break;
          }
        }
      }
      if (fcTimes && fcIdx1 !== -1 && fcIdx2 !== -1) {
        const d1 = new Date(fcTimes[fcIdx1]);
        const d2 = new Date(fcTimes[fcIdx2]);
        const t1 = fcTtt[fcIdx1] !== null ? fcTtt[fcIdx1] - 273.15 : null;
        const t2 = fcTtt[fcIdx2] !== null ? fcTtt[fcIdx2] - 273.15 : null;
        if (t1 !== null && t2 !== null) {
          const weight = (now - d1) / (d2 - d1);
          interpolatedTemp = t1 + weight * (t2 - t1);
        }
      }
      
      // Find the closest index in labels to get flat array values
      let closestIdx = -1;
      let minDiff = Infinity;
      for (let i = 0; i < data.labels.length; i++) {
        const diff = Math.abs(new Date(data.labels[i]) - now);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      
      // Calculate vertical line X coordinate
      let x = null;
      if (xScale.type === 'time') {
        x = xScale.getPixelForValue(now.getTime());
      } else {
        // Fall back to index-based calculation (category scale)
        if (closestIdx !== -1) {
          const meta = chart.getDatasetMeta(0);
          let idx1 = -1;
          let idx2 = -1;
          for (let i = 0; i < data.labels.length - 1; i++) {
            const d1 = new Date(data.labels[i]);
            const d2 = new Date(data.labels[i+1]);
            if (now >= d1 && now <= d2) {
              idx1 = i;
              idx2 = i + 1;
              break;
            }
          }
          
          if (idx1 !== -1 && idx2 !== -1 && meta && meta.data && meta.data[idx1] && meta.data[idx2]) {
            const x1 = meta.data[idx1].x;
            const x2 = meta.data[idx2].x;
            const d1 = new Date(data.labels[idx1]);
            const d2 = new Date(data.labels[idx2]);
            const weight = (now - d1) / (d2 - d1);
            x = x1 + weight * (x2 - x1);
          } else if (meta && meta.data && meta.data[closestIdx]) {
            x = meta.data[closestIdx].x;
          }
        }
      }
      
      // Draw the vertical "now" line
      if (x !== null && x >= chart.chartArea.left && x <= chart.chartArea.right) {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'; // Semi-transparent white
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]); // Dashed line pattern
        ctx.moveTo(x, topY);
        ctx.lineTo(x, bottomY);
        ctx.stroke();
        
        const yTempScale = chart.scales['y-temp'];
        
        // Draw glowing dot for the interpolated forecast temperature on the vertical line
        if (interpolatedTemp !== null && yTempScale) {
          const yVal = yTempScale.getPixelForValue(interpolatedTemp);
          ctx.beginPath();
          ctx.arc(x, yVal, 8, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(255, 94, 58, 0.35)'; // Semi-transparent neon orange/red
          ctx.fill();
          
          ctx.beginPath();
          ctx.arc(x, yVal, 4, 0, 2 * Math.PI);
          ctx.fillStyle = '#ff5e3a'; // Solid neon orange/red
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        }

        const lastMqtt = weatherData ? weatherData.mqtt_last_measurement : null;
        const lastMqttIndoor = weatherData ? weatherData.mqtt_indoor_last_measurement : null;

        // Draw glowing dot for the latest sensor temperature on the vertical line
        if (lastMqtt && lastMqtt.temp !== null && yTempScale) {
          const yVal = yTempScale.getPixelForValue(lastMqtt.temp);
          ctx.beginPath();
          ctx.arc(x, yVal, 8, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(0, 255, 102, 0.35)'; // Semi-transparent neon green
          ctx.fill();
          
          ctx.beginPath();
          ctx.arc(x, yVal, 4, 0, 2 * Math.PI);
          ctx.fillStyle = '#00ff66'; // Solid neon green
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        }

        // Draw glowing dot for the latest indoor sensor temperature on the vertical line
        if (lastMqttIndoor && lastMqttIndoor.temp !== null && yTempScale) {
          const yVal = yTempScale.getPixelForValue(lastMqttIndoor.temp);
          ctx.beginPath();
          ctx.arc(x, yVal, 8, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(255, 0, 240, 0.35)'; // Semi-transparent neon pink
          ctx.fill();
          
          ctx.beginPath();
          ctx.arc(x, yVal, 4, 0, 2 * Math.PI);
          ctx.fillStyle = '#ff00f0'; // Solid neon pink
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        }

        // Format multi-line capsule text
        const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
        const lines = [`Now ${timeStr}`];
        
        // Draw multi-line indicator box
        ctx.font = '600 10px Outfit';
        const lineHeights = 15;
        const padX = 10;
        const padY = 8;
        
        let maxTextWidth = 0;
        lines.forEach(l => {
          const w = ctx.measureText(l).width;
          if (w > maxTextWidth) maxTextWidth = w;
        });
        
        const rectW = maxTextWidth + padX * 2;
        const rectH = lines.length * lineHeights + padY * 2;
        
        // Position capsule adjacent to the vertical line
        let rectX = x + 10;
        if (rectX + rectW > chart.chartArea.right) {
          rectX = x - 10 - rectW;
        }
        const rectY = topY + 10;
        
        // Draw background capsule for text (transparent gray, opacity 0.5)
        ctx.fillStyle = 'rgba(22, 24, 38, 0.5)';
        ctx.beginPath();
        ctx.roundRect(rectX, rectY, rectW, rectH, 6);
        ctx.fill();
        
        // Add a subtle border outline
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Draw text lines (centered within the capsule box)
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const textX = rectX + rectW / 2;
        lines.forEach((line, index) => {
          ctx.fillText(line, textX, rectY + padY + index * lineHeights);
        });

        ctx.restore();
      }
    }
  };
  
  let chartDatasets = [];
  if (currentViewMode === 'ensemble') {
    chartDatasets = data.chartDatasets;
  } else if (currentViewMode !== 'history') {
    chartDatasets = [
      {
        type: 'line',
        label: 'Outdoor Temp (°C)',
        data: data.localTemps,
        borderColor: '#00ff66',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 10,
        fill: false,
        yAxisID: 'y-temp',
        tension: 0.3,
        spanGaps: false,
        order: 0
      },
      {
        type: 'line',
        label: 'Indoor Temp (°C)',
        data: data.indoorTemps,
        borderColor: '#ff00f0',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 10,
        fill: false,
        yAxisID: 'y-temp',
        tension: 0.3,
        spanGaps: false,
        order: 0
      },
      {
        type: 'line',
        label: 'Temperature (°C)',
        data: data.temps,
        borderColor: '#ff5e3a',
        borderWidth: 3,
        pointRadius: (currentViewMode === 'near') ? 2 : 1,
        pointBackgroundColor: '#ff2a6d',
        backgroundColor: tempGradient,
        fill: true,
        yAxisID: 'y-temp',
        tension: 0.35,
        spanGaps: false,
        order: 1
      },
      {
        type: 'bar',
        label: 'Precipitation Prob (%)',
        data: data.rainProb,
        backgroundColor: 'rgba(0, 242, 254, 0.3)',
        borderColor: '#00f2fe',
        borderWidth: 1,
        yAxisID: 'y-pct',
        barThickness: 8,
        order: 3
      },
      {
        type: 'bar',
        label: 'Sunshine Duration (min/h)',
        data: data.sunDuration,
        backgroundColor: 'rgba(255, 179, 0, 0.45)',
        borderColor: '#ffb300',
        borderWidth: 1,
        yAxisID: 'y-sun',
        barThickness: 8,
        order: 2
      }
    ];
  } else {
    if (currentHistoryGroup === 'temp_solar') {
      chartDatasets = [
        {
          type: 'line',
          label: 'Outdoor Temp (°C)',
          data: getHistoryChartData(data.labels, data.localTemps, 'outdoor_temp', data.nullSentinelHours),
          borderColor: '#00ff66',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-temp',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'Indoor Temp (°C)',
          data: getHistoryChartData(data.labels, data.indoorTemps, 'indoor_temp', data.nullSentinelHours),
          borderColor: '#ff00f0',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-temp',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'Forecast Temp (°C)',
          data: getHistoryChartData(data.labels, data.temps, 'forecast_temp', data.nullSentinelHours),
          borderColor: '#ff5e3a',
          borderWidth: 3,
          pointRadius: 1,
          pointBackgroundColor: '#ff2a6d',
          fill: false,
          yAxisID: 'y-temp',
          tension: 0.35,
          spanGaps: false,
          order: 1
        },
        {
          type: 'line',
          label: 'MIM Temp (°C)',
          data: getHistoryChartData(data.labels, data.mim_temp, 'mim_temp', data.nullSentinelHours),
          borderColor: '#10b981',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-temp',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'bar',
          label: 'Sunshine Duration (min/h)',
          data: data.sunDuration,
          backgroundColor: 'rgba(255, 179, 0, 0.35)',
          borderColor: '#ffb300',
          borderWidth: 1,
          yAxisID: 'y-sun',
          barThickness: 8,
          order: 2
        },
        {
          type: 'line',
          label: 'Luminosity (lux)',
          data: getHistoryChartData(data.labels, data.luminosity, 'luminosity', data.nullSentinelHours),
          borderColor: '#00f2fe',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-lux',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'MIM Global Rad (W/m²)',
          data: getHistoryChartData(data.labels, data.mim_global_rad, 'mim_global_rad', data.nullSentinelHours),
          borderColor: '#f59e0b',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-solar-rad',
          tension: 0.3,
          spanGaps: false,
          order: 3
        },
        {
          type: 'line',
          label: 'MIM Diffuse Rad (W/m²)',
          data: getHistoryChartData(data.labels, data.mim_diffuse_rad, 'mim_diffuse_rad', data.nullSentinelHours),
          borderColor: '#3b82f6',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-solar-rad',
          tension: 0.3,
          spanGaps: false,
          order: 4
        },
        {
          type: 'line',
          label: 'MIM Atm Rad (W/m²)',
          data: getHistoryChartData(data.labels, data.mim_atm_rad, 'mim_atm_rad', data.nullSentinelHours),
          borderColor: '#a855f7',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-solar-rad',
          tension: 0.3,
          spanGaps: false,
          order: 5
        }
      ];
    } else if (currentHistoryGroup === 'moisture') {
      chartDatasets = [
        {
          type: 'line',
          label: 'Outdoor Humidity (%)',
          data: getHistoryChartData(data.labels, data.humidity, 'humidity', data.nullSentinelHours),
          borderColor: '#00f2fe',
          borderWidth: 2.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-pct',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'MIM Humidity (%)',
          data: getHistoryChartData(data.labels, data.mim_humidity, 'mim_humidity', data.nullSentinelHours),
          borderColor: '#10b981',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-pct',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'Forecast Rain Prob (%)',
          data: getHistoryChartData(data.labels, data.rainProb, 'forecast_wwp', data.nullSentinelHours),
          borderColor: '#3b82f6',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-pct',
          tension: 0.3,
          spanGaps: false,
          order: 1
        },
        {
          type: 'bar',
          label: 'Rain Sensor (0-1)',
          data: data.rain_sensor,
          backgroundColor: 'rgba(99, 102, 241, 0.45)',
          borderColor: '#6366f1',
          borderWidth: 1,
          yAxisID: 'y-rain',
          barThickness: 8,
          order: 2
        }
      ];
    } else if (currentHistoryGroup === 'radiation') {
      chartDatasets = [
        {
          type: 'line',
          label: 'Geiger Freq (Hz)',
          data: getHistoryChartData(data.labels, data.geiger_freq, 'geiger_freq', data.nullSentinelHours),
          borderColor: '#ff00f0',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-freq',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'Gamma 10min Avg (μSv/h)',
          data: getHistoryChartData(data.labels, data.gamma_10m, 'gamma_10m', data.nullSentinelHours),
          borderColor: '#00ff66',
          borderWidth: 2.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-rad',
          tension: 0.3,
          spanGaps: false,
          order: 1
        },
        {
          type: 'line',
          label: 'Gamma 1min Avg (μSv/h)',
          data: getHistoryChartData(data.labels, data.gamma_1m, 'gamma_1m', data.nullSentinelHours),
          borderColor: '#a855f7',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-rad',
          tension: 0.3,
          spanGaps: false,
          order: 2
        }
      ];
    } else if (currentHistoryGroup === 'pressure') {
      chartDatasets = [
        {
          type: 'line',
          label: 'Air Pressure (hPa)',
          data: getHistoryChartData(data.labels, data.pressure, 'pressure', data.nullSentinelHours),
          borderColor: '#00f2fe',
          borderWidth: 2.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-press',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'MIM Wind Speed (m/s)',
          data: getHistoryChartData(data.labels, data.mim_wind_speed, 'mim_wind_speed', data.nullSentinelHours),
          borderColor: '#e11d48',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-wind-speed',
          tension: 0.3,
          spanGaps: false,
          order: 1
        },
        {
          type: 'line',
          label: 'MIM Wind Dir (°)',
          data: getHistoryChartData(data.labels, data.mim_wind_dir, 'mim_wind_dir', data.nullSentinelHours),
          borderColor: '#d97706',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-wind-dir',
          tension: 0.3,
          spanGaps: false,
          order: 2
        }
      ];
    } else if (currentHistoryGroup === 'magnetic') {
      chartDatasets = [
        {
          type: 'line',
          label: 'Magnetic Total (nT)',
          data: getHistoryChartData(data.labels, data.magnetic, 'magnetic', data.nullSentinelHours),
          borderColor: '#ff5e3a',
          borderWidth: 3,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-mag-total',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'Magnetic X (nT)',
          data: getHistoryChartData(data.labels, data.magnetic_x, 'magnetic_x', data.nullSentinelHours),
          borderColor: '#ffb300',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-mag-x',
          tension: 0.3,
          spanGaps: false,
          order: 1
        },
        {
          type: 'line',
          label: 'Magnetic Y (nT)',
          data: getHistoryChartData(data.labels, data.magnetic_y, 'magnetic_y', data.nullSentinelHours),
          borderColor: '#00ff66',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-mag-y',
          tension: 0.3,
          spanGaps: false,
          order: 2
        },
        {
          type: 'line',
          label: 'Magnetic Z (nT)',
          data: getHistoryChartData(data.labels, data.magnetic_z, 'magnetic_z', data.nullSentinelHours),
          borderColor: '#ff00f0',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-mag-z',
          tension: 0.3,
          spanGaps: false,
          order: 3
        }
      ];
    } else if (currentHistoryGroup === 'space_weather') {
      chartDatasets = [
        {
          type: 'line',
          label: 'NOAA Kp Index',
          data: getHistoryChartData(data.labels, data.kp, 'kp', data.nullSentinelHours),
          borderColor: '#a855f7',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-kp',
          tension: 0.3,
          spanGaps: false,
          order: 0
        },
        {
          type: 'line',
          label: 'Wind Speed (km/s)',
          data: getHistoryChartData(data.labels, data.wind_speed, 'wind_speed', data.nullSentinelHours),
          borderColor: '#f59e0b',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-speed',
          tension: 0.3,
          spanGaps: false,
          order: 1
        },
        {
          type: 'line',
          label: 'Wind Density (p/cm³)',
          data: getHistoryChartData(data.labels, data.wind_density, 'wind_density', data.nullSentinelHours),
          borderColor: '#10b981',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-density',
          tension: 0.3,
          spanGaps: false,
          order: 2
        },
        {
          type: 'line',
          label: 'IMF Bt (nT)',
          data: getHistoryChartData(data.labels, data.imf_bt, 'imf_bt', data.nullSentinelHours),
          borderColor: '#e11d48',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-imf',
          tension: 0.3,
          spanGaps: false,
          order: 3
        },
        {
          type: 'line',
          label: 'IMF Bz (nT)',
          data: getHistoryChartData(data.labels, data.imf_bz, 'imf_bz', data.nullSentinelHours),
          borderColor: '#3b82f6',
          borderWidth: 2,
          pointRadius: 2,
          pointHitRadius: 10,
          fill: false,
          yAxisID: 'y-imf',
          tension: 0.3,
          spanGaps: false,
          order: 4
        }
      ];
    }
  }

  // Calculate dynamic boundaries for pressure and magnetic y-axes to fit interval tight without starting at 0
  let minPress = undefined, maxPress = undefined;
  let minMagTotal = undefined, maxMagTotal = undefined;
  let minMagX = undefined, maxMagX = undefined;
  let minMagY = undefined, maxMagY = undefined;
  let minMagZ = undefined, maxMagZ = undefined;
  if (data) {
    if (data.pressure) {
      const pressures = data.pressure.filter(v => v !== null && v !== undefined);
      if (pressures.length > 0) {
        minPress = Math.floor(Math.min(...pressures)) - 1;
        maxPress = Math.ceil(Math.max(...pressures)) + 1;
      }
    }
    if (data.magnetic) {
      const vals = data.magnetic.filter(v => v !== null && v !== undefined);
      if (vals.length > 0) {
        minMagTotal = Math.floor(Math.min(...vals)) - 5;
        maxMagTotal = Math.ceil(Math.max(...vals)) + 5;
      }
    }
    if (data.magnetic_x) {
      const vals = data.magnetic_x.filter(v => v !== null && v !== undefined);
      if (vals.length > 0) {
        minMagX = Math.floor(Math.min(...vals)) - 5;
        maxMagX = Math.ceil(Math.max(...vals)) + 5;
      }
    }
    if (data.magnetic_y) {
      const vals = data.magnetic_y.filter(v => v !== null && v !== undefined);
      if (vals.length > 0) {
        minMagY = Math.floor(Math.min(...vals)) - 5;
        maxMagY = Math.ceil(Math.max(...vals)) + 5;
      }
    }
    if (data.magnetic_z) {
      const vals = data.magnetic_z.filter(v => v !== null && v !== undefined);
      if (vals.length > 0) {
        minMagZ = Math.floor(Math.min(...vals)) - 5;
        maxMagZ = Math.ceil(Math.max(...vals)) + 5;
      }
    }
  }

  weatherChart = new Chart(ctx, {
    type: 'bar',
    plugins: [forecastDecorationPlugin],
    data: {
      labels: data.labels,
      datasets: chartDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'closestOrNeighbours',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#8f9cae',
            font: {
              family: 'Outfit',
              size: 12
            },
            filter: function(item, chart) {
              return !item.text.includes('Member');
            }
          }
        },
        tooltip: {
          backgroundColor: '#161826',
          titleColor: '#ffffff',
          bodyColor: '#f5f6fa',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleFont: { family: 'Outfit', weight: 'bold' },
          bodyFont: { family: 'Outfit' },
          callbacks: {
            title: function(context) {
              if (context.length > 0) {
                const chartInstance = context[0].chart;
                let dateVal;
                if (chartInstance && chartInstance.scales.x && chartInstance.scales.x.type === 'time') {
                  dateVal = context[0].parsed.x;
                } else {
                  dateVal = data.labels[context[0].dataIndex];
                }
                const date = new Date(dateVal);
                return date.toLocaleString('en-GB', {
                  weekday: 'short',
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                  timeZone: 'Europe/Berlin'
                });
              }
              return '';
            },
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              const val = context.parsed.y;
              if (val !== null && val !== undefined) {
                if (label.includes('Temp')) {
                  label += val.toFixed(1) + ' °C';
                } else if (label.includes('Precip') || label.includes('Rain Amount')) {
                  label += val.toFixed(1) + ' mm';
                } else if (label.includes('Humidity') || label.includes('Prob')) {
                  label += Math.round(val) + ' %';
                } else if (label.includes('Duration')) {
                  label += Math.round(val) + ' min';
                } else if (label.includes('Luminosity')) {
                  label += val.toFixed(1) + ' lx';
                } else if (label.includes('Rain Sensor')) {
                  label += val.toFixed(2);
                } else if (label.includes('Geiger')) {
                  label += val.toFixed(2) + ' Hz';
                } else if (label.includes('Gamma')) {
                  label += val.toFixed(3) + ' μSv/h';
                } else if (label.includes('Pressure')) {
                  label += val.toFixed(1) + ' hPa';
                } else if (label.includes('Magnetic')) {
                  label += val.toFixed(1) + ' nT';
                } else if (label.includes('Kp')) {
                  label += val.toFixed(2);
                } else if (label.includes('Wind Speed')) {
                  if (label.includes('MIM')) {
                    label += val.toFixed(1) + ' m/s';
                  } else {
                    label += val.toFixed(1) + ' km/s';
                  }
                } else if (label.includes('Wind Dir')) {
                  label += Math.round(val) + '°';
                } else if (label.includes('Wind Density')) {
                  label += val.toFixed(1) + ' p/cm³';
                } else if (label.includes('IMF')) {
                  label += val.toFixed(1) + ' nT';
                } else if (label.includes('Rad')) {
                  label += val.toFixed(1) + ' W/m²';
                } else {
                  label += val;
                }
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: (currentViewMode === 'near' || currentViewMode === 'history' || currentViewMode === 'ensemble') ? {
          type: 'time',
          time: {
            unit: (currentViewMode === 'history' || currentViewMode === 'ensemble') ? 'day' : 'hour',
            stepSize: (currentViewMode === 'history' || currentViewMode === 'ensemble') ? 1 : 6,
            displayFormats: {
              hour: 'EEE HH:mm',
              day: 'EEE dd/MM',
              week: 'EEE dd/MM',
              month: 'MMM yyyy'
            }
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.08)',
            tickColor: 'rgba(255, 255, 255, 0.25)',
            drawTicks: true,
            offset: false
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#8f9cae',
            font: { family: 'Outfit', size: 10 },
            maxTicksLimit: (currentViewMode === 'history' || currentViewMode === 'ensemble') ? 15 : 12,
            callback: function(value, index, ticks) {
              const tickVal = (ticks && ticks[index] && typeof ticks[index].value === 'number') ? ticks[index].value : value;
              const date = new Date(tickVal);
              if (isNaN(date.getTime())) return value;
              if (currentViewMode === 'history' || currentViewMode === 'ensemble') {
                return date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
              }
              const weekday = date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Berlin' });
              const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
              return `${weekday} ${time}`;
            }
          }
        } : {
          type: 'category',
          grid: {
            color: 'rgba(255, 255, 255, 0.08)',
            tickColor: 'rgba(255, 255, 255, 0.25)',
            drawTicks: true,
            offset: false
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#8f9cae',
            font: { family: 'Outfit', size: 10 },
            maxTicksLimit: 20,
            callback: function(value, index, ticks) {
              const labelStr = data.labels[index];
              if (!labelStr) return '';
              const date = new Date(labelStr);
              if (isNaN(date.getTime())) return labelStr;
              const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', timeZone: 'Europe/Berlin' }).replace(',', '');
              const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
              return `${day} ${time}:00`;
            }
          }
        },
        'y-temp': {
          type: 'linear',
          position: 'left',
          display: currentViewMode !== 'history' || currentHistoryGroup === 'temp_solar',
          grid: {
            color: 'rgba(255, 255, 255, 0.10)'
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#ff5e3a',
            font: { family: 'Outfit' },
            callback: value => `${value}°C`
          },
          title: {
            display: true,
            text: 'Temperature',
            color: '#ff5e3a',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-pct': {
          type: 'linear',
          position: 'left',
          min: 0,
          max: 100,
          display: (currentViewMode !== 'history' && currentViewMode !== 'ensemble') || currentHistoryGroup === 'moisture',
          grid: {
            color: 'rgba(255, 255, 255, 0.10)',
            drawOnChartArea: currentViewMode === 'history'
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#00f2fe',
            font: { family: 'Outfit' },
            callback: value => `${value}%`
          },
          title: {
            display: true,
            text: currentViewMode === 'history' ? 'Humidity / Rain Prob' : 'Rain Probability',
            color: '#00f2fe',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-precip-acc': {
          type: 'linear',
          position: 'right',
          min: 0,
          display: currentViewMode === 'ensemble',
          grid: {
            drawOnChartArea: false,
            tickColor: '#3b82f6',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#3b82f6',
            font: { family: 'Outfit' },
            callback: value => `${value} mm`
          },
          title: {
            display: true,
            text: 'Accumulated Precip (mm)',
            color: '#3b82f6',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-sun': {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 60,
          display: (currentViewMode !== 'history' && currentViewMode !== 'ensemble') || currentHistoryGroup === 'temp_solar',
          grid: {
            drawOnChartArea: false,
            tickColor: '#ffb300',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#ffb300',
            font: { family: 'Outfit' },
            callback: value => `${value}m`
          },
          title: {
            display: true,
            text: 'Sunshine Duration',
            color: '#ffb300',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-lux': {
          type: 'linear',
          position: 'right',
          display: currentViewMode === 'history' && currentHistoryGroup === 'temp_solar',
          grid: {
            drawOnChartArea: false,
            tickColor: '#00f2fe',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#00f2fe',
            font: { family: 'Outfit' },
            callback: value => `${value} lx`
          },
          title: {
            display: true,
            text: 'Luminosity',
            color: '#00f2fe',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-rain': {
          type: 'linear',
          position: 'right',
          display: currentViewMode === 'history' && currentHistoryGroup === 'moisture',
          grid: {
            drawOnChartArea: false,
            tickColor: '#6366f1',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#6366f1',
            font: { family: 'Outfit' },
            callback: value => `${value}`
          },
          title: {
            display: true,
            text: 'Rain Sensor (0-1)',
            color: '#6366f1',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-rad': {
          type: 'linear',
          position: 'left',
          display: currentViewMode === 'history' && currentHistoryGroup === 'radiation',
          grid: {
            color: 'rgba(255, 255, 255, 0.10)',
            drawOnChartArea: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#00ff66',
            font: { family: 'Outfit' },
            callback: value => `${value} μSv/h`
          },
          title: {
            display: true,
            text: 'Radiation',
            color: '#00ff66',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-freq': {
          type: 'linear',
          position: 'right',
          display: currentViewMode === 'history' && currentHistoryGroup === 'radiation',
          grid: {
            drawOnChartArea: false,
            tickColor: '#ff00f0',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#ff00f0',
            font: { family: 'Outfit' },
            callback: value => `${value} Hz`
          },
          title: {
            display: true,
            text: 'Geiger Frequency',
            color: '#ff00f0',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-press': {
          type: 'linear',
          position: 'left',
          min: minPress,
          max: maxPress,
          display: currentViewMode === 'history' && currentHistoryGroup === 'pressure',
          grid: {
            color: 'rgba(255, 255, 255, 0.10)',
            drawOnChartArea: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#00f2fe',
            font: { family: 'Outfit' },
            callback: value => `${value} hPa`
          },
          title: {
            display: true,
            text: 'Air Pressure',
            color: '#00f2fe',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-mag-total': {
          type: 'linear',
          position: 'left',
          min: minMagTotal,
          max: maxMagTotal,
          display: currentViewMode === 'history' && currentHistoryGroup === 'magnetic',
          grid: {
            color: 'rgba(255, 255, 255, 0.10)',
            drawOnChartArea: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#ff5e3a',
            font: { family: 'Outfit' },
            callback: value => `${value} nT`
          },
          title: {
            display: true,
            text: 'Mag Total',
            color: '#ff5e3a',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-mag-x': {
          type: 'linear',
          position: 'right',
          min: minMagX,
          max: maxMagX,
          display: currentViewMode === 'history' && currentHistoryGroup === 'magnetic',
          grid: {
            drawOnChartArea: false,
            tickColor: '#ffb300',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#ffb300',
            font: { family: 'Outfit' },
            callback: value => `${value} nT`
          },
          title: {
            display: true,
            text: 'Mag X',
            color: '#ffb300',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-mag-y': {
          type: 'linear',
          position: 'right',
          min: minMagY,
          max: maxMagY,
          display: currentViewMode === 'history' && currentHistoryGroup === 'magnetic',
          grid: {
            drawOnChartArea: false,
            tickColor: '#00ff66',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#00ff66',
            font: { family: 'Outfit' },
            callback: value => `${value} nT`
          },
          title: {
            display: true,
            text: 'Mag Y',
            color: '#00ff66',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-mag-z': {
          type: 'linear',
          position: 'left',
          min: minMagZ,
          max: maxMagZ,
          display: currentViewMode === 'history' && currentHistoryGroup === 'magnetic',
          grid: {
            drawOnChartArea: false,
            tickColor: '#ff00f0',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#ff00f0',
            font: { family: 'Outfit' },
            callback: value => `${value} nT`
          },
          title: {
            display: true,
            text: 'Mag Z',
            color: '#ff00f0',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-kp': {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 9,
          display: currentViewMode === 'history' && currentHistoryGroup === 'space_weather',
          grid: {
            drawOnChartArea: false,
            tickColor: '#a855f7',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#a855f7',
            font: { family: 'Outfit' },
            callback: value => `${value}`
          },
          title: {
            display: true,
            text: 'Kp Index',
            color: '#a855f7',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-speed': {
          type: 'linear',
          position: 'left',
          display: currentViewMode === 'history' && currentHistoryGroup === 'space_weather',
          grid: {
            drawOnChartArea: false,
            tickColor: '#f59e0b',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#f59e0b',
            font: { family: 'Outfit' },
            callback: value => `${value} km/s`
          },
          title: {
            display: true,
            text: 'Wind Speed',
            color: '#f59e0b',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-density': {
          type: 'linear',
          position: 'right',
          display: currentViewMode === 'history' && currentHistoryGroup === 'space_weather',
          grid: {
            drawOnChartArea: false,
            tickColor: '#10b981',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#10b981',
            font: { family: 'Outfit' },
            callback: value => `${value} p/cm³`
          },
          title: {
            display: true,
            text: 'Wind Density',
            color: '#10b981',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-imf': {
          type: 'linear',
          position: 'right',
          display: currentViewMode === 'history' && currentHistoryGroup === 'space_weather',
          grid: {
            drawOnChartArea: false,
            tickColor: '#e11d48',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#e11d48',
            font: { family: 'Outfit' },
            callback: value => `${value} nT`
          },
          title: {
            display: true,
            text: 'IMF Strength',
            color: '#e11d48',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-solar-rad': {
          type: 'linear',
          position: 'right',
          display: currentViewMode === 'history' && currentHistoryGroup === 'temp_solar',
          grid: {
            drawOnChartArea: false,
            tickColor: '#f59e0b',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#f59e0b',
            font: { family: 'Outfit' },
            callback: value => `${value} W/m²`
          },
          title: {
            display: true,
            text: 'Radiation (W/m²)',
            color: '#f59e0b',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-wind-speed': {
          type: 'linear',
          position: 'left',
          display: currentViewMode === 'history' && currentHistoryGroup === 'pressure',
          grid: {
            drawOnChartArea: false,
            tickColor: '#e11d48',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#e11d48',
            font: { family: 'Outfit' },
            callback: value => `${value} m/s`
          },
          title: {
            display: true,
            text: 'Wind Speed',
            color: '#e11d48',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-wind-dir': {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 360,
          display: currentViewMode === 'history' && currentHistoryGroup === 'pressure',
          grid: {
            drawOnChartArea: false,
            tickColor: '#d97706',
            drawTicks: true
          },
          border: {
            color: 'rgba(255, 255, 255, 0.15)',
            display: true
          },
          ticks: {
            color: '#d97706',
            font: { family: 'Outfit' },
            callback: value => `${value}°`
          },
          title: {
            display: true,
            text: 'Wind Direction',
            color: '#d97706',
            font: { family: 'Outfit', weight: 500 }
          }
        }
      }
    }
  });
}

// Injects stylesheet rule for dynamic toast notifications
const toastStyle = document.createElement('style');
toastStyle.textContent = `
  .toast-notification {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: rgba(22, 24, 38, 0.9);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #f5f6fa;
    padding: 12px 24px;
    border-radius: 10px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    transform: translateY(100px);
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    z-index: 9999;
    font-size: 0.9rem;
    font-weight: 500;
  }
  .toast-notification.show {
    transform: translateY(0);
    opacity: 1;
  }
`;
document.head.appendChild(toastStyle);

// =============================================================================
// Data Sources Status Panel
// =============================================================================

function toggleDataSources() {
  const body = document.getElementById('datasources-body');
  const chevron = document.getElementById('ds-chevron');
  const btn = document.getElementById('datasources-toggle');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  chevron.classList.toggle('open', !isOpen);
  btn.setAttribute('aria-expanded', String(!isOpen));
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    statusData = await res.json();
    renderStatusPanel();
  } catch (e) {
    console.warn('Failed to fetch /api/status:', e);
  }
}

function formatAge(ageSecs) {
  if (ageSecs === null || ageSecs === undefined) return 'never';
  if (ageSecs < 60) return `${Math.round(ageSecs)}s ago`;
  if (ageSecs < 3600) return `${Math.round(ageSecs / 60)}m ago`;
  return `${(ageSecs / 3600).toFixed(1)}h ago`;
}

function formatLastSeen(ts) {
  if (!ts) return 'never';
  return new Date(ts * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Europe/Berlin'
  });
}

function chipState(isStale, neverSeen) {
  if (neverSeen) return 'unavailable';
  if (isStale) return 'stale';
  return 'healthy';
}

function makeChip(dotClass, name, detail, detailClass = '') {
  return `
    <div class="ds-source-chip ${dotClass}">
      <span class="ds-dot ${dotClass}"></span>
      <div class="ds-info">
        <span class="ds-name" title="${name}">${name}</span>
        <span class="ds-detail ${detailClass}" title="${detail}">${detail}</span>
      </div>
    </div>`;
}

function renderStatusPanel() {
  if (!statusData) return;

  const grid = document.getElementById('ds-grid');
  if (!grid) return;

  let html = '';
  let issueCount = 0;

  // --- Polled sources ---
  const sources = statusData.sources || {};
  for (const [key, src] of Object.entries(sources)) {
    const neverSeen = !src.last_updated;
    const state = chipState(src.is_stale, neverSeen);
    if (state !== 'healthy') issueCount++;

    let detail;
    if (neverSeen) {
      detail = 'No data yet';
    } else {
      const age = formatAge(src.age_secs);
      const nextIn = src.next_poll_in !== undefined && src.next_poll_in !== null
        ? src.next_poll_in
        : (src.last_updated ? Math.max(0, src.interval_secs - src.age_secs) : null);
      const nextStr = nextIn !== null ? ` · next in ${Math.round(nextIn / 60)}m` : '';
      detail = `Updated ${age}${nextStr}`;
    }

    const detailClass = state === 'unavailable' ? 'error' : state === 'stale' ? 'warn' : '';
    html += makeChip(state, src.label, detail, detailClass);
  }

  // --- MQTT sensors ---
  const mqttTopics = statusData.mqtt || {};
  const threshold = statusData.mqtt_stale_threshold_secs || 900;
  const outdoor = [];
  const indoor = [];
  for (const [topic, s] of Object.entries(mqttTopics)) {
    (s.group === 'indoor' ? indoor : outdoor).push([topic, s]);
  }

  const renderMqttGroup = (label, items) => {
    if (items.length === 0) return '';
    let out = `<div class="ds-section-header">${label}</div>`;
    for (const [topic, s] of items) {
      const neverSeen = s.last_seen === null;
      const state = chipState(s.is_stale, neverSeen);
      if (state !== 'healthy') issueCount++;

      // Shorten topic to last 2 path segments for readability
      const parts = topic.split('/');
      const shortName = parts.slice(-2).join('/');

      let detail;
      if (neverSeen) {
        detail = 'No data received';
      } else {
        const timeStr = formatLastSeen(s.last_seen);
        detail = `Last: ${timeStr} (${formatAge(s.age_secs)})`;
      }

      const detailClass = state === 'unavailable' ? 'error' : state === 'stale' ? 'warn' : '';
      out += makeChip(state, shortName, detail, detailClass);
    }
    return out;
  };

  html += renderMqttGroup('MQTT Outdoor', outdoor);
  html += renderMqttGroup('MQTT Indoor', indoor);

  grid.innerHTML = html;

  // Update collapsed summary badge
  const summary = document.getElementById('ds-summary');
  if (summary) {
    if (issueCount === 0) {
      summary.textContent = 'All OK';
      summary.style.color = '#10b981';
    } else {
      summary.textContent = `${issueCount} issue${issueCount > 1 ? 's' : ''}`;
      summary.style.color = '#f59e0b';
    }
  }
}
