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
  
  // Populate Quick Weather Cards (using current / first timestep values)
  if (ttt.length > 0) {
    const curTempC = ttt[0] - 273.15;
    document.getElementById('current-temp').textContent = curTempC.toFixed(1);
    
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
    // Current sunshine (in minutes, raw is seconds in last hour)
    const curSunMin = sund1[0] !== null ? Math.round(sund1[0] / 60) : 0;
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
    const curRainProb = wwp[0] !== null ? Math.round(wwp[0]) : 0;
    document.getElementById('rain-probability').textContent = curRainProb;
    
    // Find max rain probability in next 48h
    const limit = Math.min(48, wwp.length);
    let maxProb = 0;
    for (let i = 0; i < limit; i++) {
      if (wwp[i] !== null && wwp[i] > maxProb) maxProb = wwp[i];
    }
    document.getElementById('rain-summary').textContent = `Max risk: ${Math.round(maxProb)}% chance next 48h`;
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
  
  if (currentViewMode === 'near') {
    // Show only the first 48 hours (hourly)
    const targetLimit = Math.min(48, limit);
    for (let i = 0; i < targetLimit; i++) {
      addDataPoint(result, i, times, ttt, sund1, wwp, drr1, rr1c, mqttHistory);
    }
  } else {
    // Extended Outlook: displays near-term forecasts in higher time-resolution than longer term forecasts!
    // Near term (first 48 hours): hourly
    // Longer term (after 48 hours): downsampled to 6-hour resolution (indices where (i - 48) % 6 == 0)
    for (let i = 0; i < limit; i++) {
      if (i < 48) {
        addDataPoint(result, i, times, ttt, sund1, wwp, drr1, rr1c, mqttHistory);
      } else if ((i - 48) % 6 === 0) {
        addDataPoint(result, i, times, ttt, sund1, wwp, drr1, rr1c, mqttHistory);
      }
    }
  }
  
  return result;
}

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

function addDataPoint(target, index, times, ttt, sund1, wwp, drr1, rr1c, mqttHistory) {
  target.labels.push(times[index]);
  
  // Convert temperature Kelvin -> Celsius
  const tempC = ttt[index] !== null ? ttt[index] - 273.15 : null;
  target.temps.push(tempC);

  // Local temperature history from MQTT (average of 10-minute intervals within that hour)
  const isoTime = times[index];
  const localTemp = getLocalTempForHour(isoTime, mqttHistory);
  target.localTemps.push(localTemp);
  
  // Convert sunshine duration seconds -> minutes
  const sunMin = sund1[index] !== null ? sund1[index] / 60 : null;
  target.sunDuration.push(sunMin);
  
  // Rain probability %
  target.rainProb.push(wwp[index]);
  
  // Convert rain duration seconds -> minutes
  const rainMin = drr1[index] !== null ? drr1[index] / 60 : null;
  target.rainDuration.push(rainMin);
  
  // Rain amount mm/hour
  target.rainAmount.push(rr1c[index]);
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
    // If Near-term, show weekday and hour. If extended, show weekday, date, and hour.
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
          
          // Find adjacent forecast points bracketing "now"
          let interpolatedTemp = null;
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
          
          // Interpolate exact vertical line X coordinate and forecast temp
          let x = null;
          if (idx1 !== -1 && idx2 !== -1 && meta.data[idx1] && meta.data[idx2]) {
            const x1 = meta.data[idx1].x;
            const x2 = meta.data[idx2].x;
            const d1 = new Date(data.labels[idx1]);
            const d2 = new Date(data.labels[idx2]);
            const weight = (now - d1) / (d2 - d1);
            x = x1 + weight * (x2 - x1);
            
            const t1 = data.temps[idx1];
            const t2 = data.temps[idx2];
            if (t1 !== null && t2 !== null) {
              interpolatedTemp = t1 + weight * (t2 - t1);
            }
          } else {
            x = meta.data[closestIdx].x;
          }
          
          if (interpolatedTemp === null) {
            interpolatedTemp = data.temps[closestIdx];
          }

          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'; // Semi-transparent white
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 5]); // Dashed line pattern
          ctx.moveTo(x, topY);
          ctx.lineTo(x, bottomY);
          ctx.stroke();

          // Format multi-line capsule text
          const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
          const lines = [`Now ${timeStr}`];
          if (interpolatedTemp !== null) {
            lines.push(`Fcst: ${interpolatedTemp.toFixed(1)}°C`);
          }
          const lastMqtt = weatherData.mqtt_last_measurement;
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
          
          // Move capsule to the upper left corner of the chart area
          const rectX = chart.chartArea.left + 10;
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
  };
  
  weatherChart = new Chart(ctx, {
    type: 'bar', // Mixed chart uses bar for base, line for individual datasets
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
          barPercentage: 0.7,
          categoryPercentage: 0.7,
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
          barPercentage: 0.5,
          categoryPercentage: 0.7,
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
