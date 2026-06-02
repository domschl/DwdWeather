// DWD Weather Hub Modern Frontend Controller

let weatherData = null;
let currentViewMode = 'near'; // 'near' or 'extended'
let weatherChart = null;

document.addEventListener('DOMContentLoaded', () => {
  fetchForecast();
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
  } catch (error) {
    console.error('Error fetching forecast:', error);
    alert(`Failed to load forecast data: ${error.message}`);
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
    
    updateDashboard();
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

// Switch between Near-term (48h detailed) and Extended (10d downsampled)
function switchViewMode(mode) {
  currentViewMode = mode;
  
  // Update Tab active style
  document.getElementById('btn-tab-near').classList.toggle('active', mode === 'near');
  document.getElementById('btn-tab-extended').classList.toggle('active', mode === 'extended');
  
  renderChartAndTable();
}

// Filters and formats datasets based on the selected view mode
function getFilteredData() {
  if (!weatherData || !weatherData.forecast) return null;
  
  const fc = weatherData.forecast;
  const times = fc.timesteps;
  const ttt = fc.elements.TTT || [];
  const sund1 = fc.elements.SunD1 || [];
  const wwp = fc.elements.wwP || [];
  const drr1 = fc.elements.DRR1 || [];
  const rr1c = fc.elements.RR1c || [];
  const mqttHistory = weatherData.mqtt_history || {};
  
  const result = {
    labels: [],
    temps: [],
    localTemps: [],
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
  
  const startTime = new Date(times[forecastIndices[0]]).getTime();
  const endTime = new Date(times[forecastIndices[forecastIndices.length - 1]]).getTime();
  
  const uniqueTimesSet = new Set();
  
  // Add selected forecast timesteps
  forecastIndices.forEach(idx => {
    uniqueTimesSet.add(new Date(times[idx]).getTime());
  });
  
  // Add sensor 10-minute slot times that fall within timeframe
  Object.keys(mqttHistory).forEach(slotStr => {
    const slotMs = new Date(slotStr).getTime();
    if (slotMs >= startTime && slotMs <= endTime) {
      uniqueTimesSet.add(slotMs);
    }
  });
  
  // Sort chronologically
  const sortedTimesMs = Array.from(uniqueTimesSet).sort((a, b) => a - b);
  
  // Map forecast data by timestamp epoch for quick lookup
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
  
  // Map sensor data by timestamp epoch
  const sensorMap = new Map();
  Object.entries(mqttHistory).forEach(([slotStr, temp]) => {
    const ms = new Date(slotStr).getTime();
    sensorMap.set(ms, temp);
  });
  
  // Populate result lists for each unique timestep
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
  });
  
  return result;
}

// Render chart and populate data table
function renderChartAndTable() {
  const data = getFilteredData();
  if (!data) return;
  
  // --- 1. Populate Table ---
  const tbody = document.getElementById('forecast-table-body');
  tbody.innerHTML = '';
  
  document.getElementById('table-row-count').textContent = `Showing ${data.labels.length} data steps`;
  
  data.labels.forEach((timeStr, idx) => {
    const tr = document.createElement('tr');
    
    const tdTime = document.createElement('td');
    tdTime.textContent = formatLocalTime(timeStr);
    tr.appendChild(tdTime);
    
    const tdTemp = document.createElement('td');
    const t = data.temps[idx];
    tdTemp.textContent = t !== null ? `${t.toFixed(1)} °C` : '-';
    tr.appendChild(tdTemp);

    const tdLocalTemp = document.createElement('td');
    const lt = data.localTemps[idx];
    tdLocalTemp.textContent = lt !== null ? `${lt.toFixed(1)} °C` : '-';
    tr.appendChild(tdLocalTemp);
    
    const tdRainProb = document.createElement('td');
    const rp = data.rainProb[idx];
    tdRainProb.textContent = rp !== null ? `${Math.round(rp)} %` : '-';
    tr.appendChild(tdRainProb);
    
    const tdRainDur = document.createElement('td');
    const rd = data.rainDuration[idx];
    tdRainDur.textContent = rd !== null ? `${Math.round(rd)} min` : '-';
    tr.appendChild(tdRainDur);
    
    const tdRainAmt = document.createElement('td');
    const ra = data.rainAmount[idx];
    tdRainAmt.textContent = ra !== null ? `${ra.toFixed(2)} mm` : '-';
    tr.appendChild(tdRainAmt);
    
    const tdSun = document.createElement('td');
    const s = data.sunDuration[idx];
    tdSun.textContent = s !== null ? `${Math.round(s)} min` : '-';
    tr.appendChild(tdSun);
    
    tbody.appendChild(tr);
  });
  
  // --- 2. Render Chart.js ---
  const ctx = document.getElementById('weatherChart').getContext('2d');
  
  // Destroy old chart if exists
  if (weatherChart) {
    weatherChart.destroy();
  }
  
  const displayLabels = data.labels.map(isoStr => {
    const date = new Date(isoStr);
    if (currentViewMode === 'near') {
      const weekday = date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Berlin' });
      const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
      return `${weekday} ${time}`;
    } else {
      const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', timeZone: 'Europe/Berlin' });
      const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
      return `${day} ${time}:00`;
    }
  });

  // Create neon gradients for the chart
  const tempGradient = ctx.createLinearGradient(0, 0, 0, 350);
  tempGradient.addColorStop(0, 'rgba(255, 94, 58, 0.4)');
  tempGradient.addColorStop(1, 'rgba(255, 42, 109, 0.0)');
  
  // Custom plugin to draw a vertical dashed line at the closest timestep to 'now'
  const currentLinePlugin = {
    id: 'currentLine',
    afterDraw: (chart) => {
      if (!data || !data.labels || data.labels.length === 0) return;
      
      const now = new Date();
      let closestIdx = -1;
      let minDiff = Infinity;
      
      for (let i = 0; i < data.labels.length; i++) {
        const diff = Math.abs(new Date(data.labels[i]) - now);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      
      if (closestIdx !== -1) {
        const meta = chart.getDatasetMeta(0);
        if (meta && meta.data[closestIdx]) {
          const ctx = chart.ctx;
          const topY = chart.chartArea.top;
          const bottomY = chart.chartArea.bottom;
          
          // Find adjacent forecast points in raw forecast data to interpolate forecast temperature
          const fcTimes = weatherData.forecast.timesteps;
          const fcTtt = weatherData.forecast.elements.TTT || [];
          let interpolatedTemp = null;
          let fcIdx1 = -1;
          let fcIdx2 = -1;
          for (let i = 0; i < fcTimes.length - 1; i++) {
            const d1 = new Date(fcTimes[i]);
            const d2 = new Date(fcTimes[i+1]);
            if (now >= d1 && now <= d2) {
              fcIdx1 = i;
              fcIdx2 = i + 1;
              break;
            }
          }
          if (fcIdx1 !== -1 && fcIdx2 !== -1) {
            const d1 = new Date(fcTimes[fcIdx1]);
            const d2 = new Date(fcTimes[fcIdx2]);
            const t1 = fcTtt[fcIdx1] !== null ? fcTtt[fcIdx1] - 273.15 : null;
            const t2 = fcTtt[fcIdx2] !== null ? fcTtt[fcIdx2] - 273.15 : null;
            if (t1 !== null && t2 !== null) {
              const weight = (now - d1) / (d2 - d1);
              interpolatedTemp = t1 + weight * (t2 - t1);
            }
          }
          
          // Find exact horizontal line X coordinate by interpolating between labels
          let x = null;
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
          
          if (idx1 !== -1 && idx2 !== -1 && meta.data[idx1] && meta.data[idx2]) {
            const x1 = meta.data[idx1].x;
            const x2 = meta.data[idx2].x;
            const d1 = new Date(data.labels[idx1]);
            const d2 = new Date(data.labels[idx2]);
            const weight = (now - d1) / (d2 - d1);
            x = x1 + weight * (x2 - x1);
          } else {
            x = meta.data[closestIdx] ? meta.data[closestIdx].x : null;
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

            const lastMqtt = weatherData.mqtt_last_measurement;

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

            // Format multi-line capsule text
            const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
            const lines = [`Now ${timeStr}`];
            if (interpolatedTemp !== null) {
              lines.push(`Fcst: ${interpolatedTemp.toFixed(1)}°C`);
            }
            if (lastMqtt && lastMqtt.temp !== null) {
              lines.push(`Sensor: ${lastMqtt.temp.toFixed(1)}°C`);
            }
            
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
      }
    }
  };
  
  weatherChart = new Chart(ctx, {
    type: 'bar',
    plugins: [currentLinePlugin],
    data: {
      labels: displayLabels,
      datasets: [
        {
          type: 'line',
          label: 'Local Temp (°C)',
          data: data.localTemps,
          borderColor: '#00ff66', // Neon green
          borderWidth: 2,
          borderDash: [3, 3], // Dashed line
          pointRadius: currentViewMode === 'near' ? 2 : 1,
          pointBackgroundColor: '#00ff66',
          fill: false,
          yAxisID: 'y-temp',
          tension: 0.35,
          spanGaps: true,
          order: 0 // Draw on top
        },
        {
          type: 'line',
          label: 'Temperature (°C)',
          data: data.temps,
          borderColor: '#ff5e3a',
          borderWidth: 3,
          pointRadius: currentViewMode === 'near' ? 2 : 1,
          pointBackgroundColor: '#ff2a6d',
          backgroundColor: tempGradient,
          fill: true,
          yAxisID: 'y-temp',
          tension: 0.35,
          spanGaps: true,
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
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
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
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                if (context.dataset.label.includes('Temp')) {
                  label += context.parsed.y.toFixed(1) + ' °C';
                } else if (context.dataset.label.includes('Precipitation')) {
                  label += Math.round(context.parsed.y) + ' %';
                } else {
                  label += Math.round(context.parsed.y) + ' min';
                }
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)'
          },
          ticks: {
            color: '#8f9cae',
            font: { family: 'Outfit', size: 10 },
            // Limit tick density
            maxTicksLimit: currentViewMode === 'near' ? 12 : 20
          }
        },
        'y-temp': {
          type: 'linear',
          position: 'left',
          grid: {
            color: 'rgba(255, 255, 255, 0.05)'
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
          position: 'right',
          min: 0,
          max: 100,
          grid: {
            drawOnChartArea: false // prevent grid overlaps
          },
          ticks: {
            color: '#00f2fe',
            font: { family: 'Outfit' },
            callback: value => `${value}%`
          },
          title: {
            display: true,
            text: 'Rain Probability',
            color: '#00f2fe',
            font: { family: 'Outfit', weight: 500 }
          }
        },
        'y-sun': {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 60,
          grid: {
            drawOnChartArea: false
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
