'use strict';

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = Number(bytes);
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
function refreshTab(tabName) {
  switch (tabName) {
    case 'live':      loadLiveView(); break;
    case 'cameras':   loadCameras(); break;
    case 'recording': loadRecording(); break;
    case 'playback':  loadPlayback(); break;
    case 'system':    loadSystem(); break;
  }
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    refreshTab(tabName);
  });
});

// ---------------------------------------------------------------------------
// Live View
// ---------------------------------------------------------------------------
async function loadLiveView() {
  const grid = document.getElementById('live-grid');
  grid.innerHTML = '<div class="loading">Loading cameras...</div>';

  let cameras = [];
  try {
    cameras = await api('/cameras');
    if (!Array.isArray(cameras)) cameras = [];
  } catch (e) {
    grid.innerHTML = '<div class="no-cameras">Failed to load cameras.</div>';
    return;
  }

  const enabled = cameras.filter(c => c.enabled !== false);
  if (enabled.length === 0) {
    grid.innerHTML = '<div class="no-cameras">No cameras configured. Add a camera in the Cameras tab.</div>';
    return;
  }

  grid.innerHTML = enabled.map(cam => `
    <div class="stream-cell" id="cell-${cam.id}">
      <iframe
        src="http://${location.hostname}:8889/${cam.id}/"
        allowfullscreen
        allow="autoplay"
        title="${escapeHtml(cam.name)}"
      ></iframe>
      <button class="stream-fullscreen-btn" onclick="toggleFullscreen('cell-${cam.id}')" title="Fullscreen">&#x26F6;</button>
      <div class="stream-label">
        <span class="stream-name">${escapeHtml(cam.name)}</span>
        <span class="stream-status">
          <span class="status-dot"></span> Live
        </span>
      </div>
    </div>
  `).join('');
}

function toggleFullscreen(cellId) {
  const el = document.getElementById(cellId);
  if (el) el.classList.toggle('fullscreen');
}

// Grid size selection
document.querySelectorAll('.grid-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const size = btn.dataset.grid;
    document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const grid = document.getElementById('live-grid');
    grid.className = `live-grid grid-${size}`;
  });
});

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------
async function loadCameras() {
  const list = document.getElementById('camera-list');
  list.innerHTML = '<div class="loading">Loading...</div>';

  let cameras = [];
  try {
    cameras = await api('/cameras');
    if (!Array.isArray(cameras)) cameras = [];
  } catch (e) {
    list.innerHTML = '<div class="loading">Failed to load cameras.</div>';
    return;
  }

  if (cameras.length === 0) {
    list.innerHTML = '<div class="no-cameras">No cameras configured.</div>';
    return;
  }

  list.innerHTML = cameras.map(cam => `
    <div class="camera-card">
      <div class="camera-card-info">
        <div class="camera-card-name">${escapeHtml(cam.name)}</div>
        <div class="camera-card-meta">
          <span>${escapeHtml(cam.ip || '')}</span>
          ${cam.manufacturer ? `<span>${escapeHtml(cam.manufacturer)}</span>` : ''}
        </div>
      </div>
      <div class="camera-card-actions">
        <button class="btn btn-sm" id="test-btn-${cam.id}" onclick="testCamera('${cam.id}')">Test</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCamera('${cam.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

// Add Camera
document.getElementById('btn-add-camera').addEventListener('click', () => {
  document.getElementById('add-camera-form').reset();
  openModal('modal-add-camera');
});

document.getElementById('add-camera-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());

  try {
    await api('/cameras', { method: 'POST', body: data });
    closeModal('modal-add-camera');
    loadCameras();
  } catch (err) {
    alert('Failed to add camera: ' + err.message);
  }
});

// Discover
document.getElementById('btn-discover').addEventListener('click', async () => {
  openModal('modal-discover');
  document.getElementById('discover-results').innerHTML = '<div class="loading">Scanning network...</div>';

  let results = [];
  try {
    results = await api('/cameras/discover', { method: 'POST' });
    if (!Array.isArray(results)) results = [];
  } catch (e) {
    document.getElementById('discover-results').innerHTML = '<div class="loading">Discovery failed.</div>';
    return;
  }

  if (results.length === 0) {
    document.getElementById('discover-results').innerHTML = '<div class="loading">No cameras found.</div>';
    return;
  }

  document.getElementById('discover-results').innerHTML = results.map(r => `
    <div class="discover-item">
      <div class="discover-item-info">
        <div class="discover-item-name">${escapeHtml(r.name || 'Unknown Camera')}</div>
        <div class="discover-item-meta">${escapeHtml(r.ip || '')} ${r.manufacturer ? '· ' + escapeHtml(r.manufacturer) : ''}</div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="addDiscovered('${escapeAttr(r.ip)}', '${escapeAttr(r.name || '')}', '${escapeAttr(r.manufacturer || '')}')">
        Add
      </button>
    </div>
  `).join('');
});

async function addDiscovered(ip, name, manufacturer) {
  try {
    await api('/cameras', { method: 'POST', body: { ip, name, manufacturer } });
    closeModal('modal-discover');
    loadCameras();
  } catch (err) {
    alert('Failed to add camera: ' + err.message);
  }
}

async function testCamera(id) {
  const btn = document.getElementById(`test-btn-${id}`);
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    const res = await api(`/cameras/${id}/test`, { method: 'POST' });
    const ok = res && (res.ok || res.success || res.status === 'ok');
    btn.textContent = ok ? 'OK' : 'Fail';
    btn.style.color = ok ? 'var(--green)' : 'var(--red)';
  } catch (e) {
    btn.textContent = 'Fail';
    btn.style.color = 'var(--red)';
  }

  setTimeout(() => {
    btn.textContent = 'Test';
    btn.style.color = '';
    btn.disabled = false;
  }, 3000);
}

async function deleteCamera(id) {
  if (!confirm('Delete this camera?')) return;
  try {
    await api(`/cameras/${id}`, { method: 'DELETE' });
    loadCameras();
  } catch (err) {
    alert('Failed to delete camera: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
async function loadRecording() {
  // Load storage info
  try {
    const storage = await api('/storage');
    renderStorageCard(storage);
  } catch (e) {
    document.getElementById('storage-info').querySelector('.card-body') &&
      (document.querySelector('#storage-info .card-body').innerHTML = '<span class="status-text-red">Failed to load storage info.</span>');
  }

  // Load recording settings
  try {
    const settings = await api('/recording/settings');
    if (settings) {
      if (settings.segment_duration != null) document.getElementById('setting-segment-duration').value = settings.segment_duration;
      if (settings.retention_days != null) document.getElementById('setting-retention-days').value = settings.retention_days;
      if (settings.max_disk_percent != null) document.getElementById('setting-max-disk').value = settings.max_disk_percent;
    }
  } catch (e) { /* settings optional */ }

  // Load per-camera recording status
  try {
    const status = await api('/recording/status');
    renderRecordingStatus(status);
  } catch (e) {
    document.getElementById('recording-status-list').innerHTML =
      '<div class="loading">Failed to load recording status.</div>';
  }
}

function renderStorageCard(storage) {
  const bodyEl = document.querySelector('#storage-info');
  if (!bodyEl) return;

  if (!storage || !storage.mounted) {
    bodyEl.innerHTML = `
      <div class="card-title">USB Storage</div>
      <div class="card-body">
        <span class="status-text-yellow">No USB storage mounted.</span>
        <button class="btn btn-sm btn-primary" style="margin-left:12px" onclick="mountUsb()">Mount</button>
      </div>
    `;
    return;
  }

  const pct = storage.used_percent || 0;
  const barClass = pct > 90 ? 'danger' : pct > 75 ? 'warn' : '';

  bodyEl.innerHTML = `
    <div class="card-title">USB Storage</div>
    <div class="card-body">
      <div class="storage-bar-wrap">
        <div class="storage-bar ${barClass}" style="width:${pct}%"></div>
      </div>
      <div class="storage-stats">
        <span>Used: ${formatBytes(storage.used)}</span>
        <span>Free: ${formatBytes(storage.free)}</span>
        <span>Total: ${formatBytes(storage.total)}</span>
        <span>${pct}%</span>
      </div>
    </div>
  `;
}

function renderRecordingStatus(statusList) {
  const el = document.getElementById('recording-status-list');
  if (!Array.isArray(statusList) || statusList.length === 0) {
    el.innerHTML = '<div class="loading">No recording data.</div>';
    return;
  }

  el.innerHTML = statusList.map(s => {
    const isRec = s.recording || s.active;
    return `
      <div class="rec-card">
        <div class="rec-indicator${isRec ? ' active' : ''}"></div>
        <div class="rec-card-info">
          <div class="rec-card-name">${escapeHtml(s.name || s.camera_id || s.id)}</div>
          <div class="rec-card-meta">
            ${isRec ? '<span class="status-text-red">Recording</span>' : '<span class="status-text-yellow">Stopped</span>'}
            ${s.disk_used != null ? ` &nbsp;·&nbsp; Disk: ${formatBytes(s.disk_used)}` : ''}
          </div>
        </div>
        <div class="rec-card-actions">
          <button class="btn btn-sm ${isRec ? 'btn-danger' : 'btn-primary'}"
            onclick="toggleRecording('${s.id || s.camera_id}', ${!!isRec})">
            ${isRec ? 'Stop' : 'Record'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleRecording(id, isRecording) {
  try {
    const action = isRecording ? 'stop' : 'start';
    await api(`/recording/${action}`, { method: 'POST', body: { camera_id: id } });
    loadRecording();
  } catch (err) {
    alert('Failed to toggle recording: ' + err.message);
  }
}

async function mountUsb() {
  try {
    await api('/storage/mount', { method: 'POST' });
    alert('Mount command sent.');
    loadRecording();
  } catch (err) {
    alert('Mount failed: ' + err.message);
  }
}

document.getElementById('recording-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  // Convert numeric fields
  data.segment_duration = parseInt(data.segment_duration, 10);
  data.retention_days = parseInt(data.retention_days, 10);
  data.max_disk_percent = parseInt(data.max_disk_percent, 10);

  try {
    await api('/recording/settings', { method: 'PUT', body: data });
    alert('Settings saved.');
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
async function loadPlayback() {
  const camSel = document.getElementById('playback-camera-select');
  camSel.innerHTML = '<option value="">Select Camera...</option>';

  let cameras = [];
  try {
    cameras = await api('/cameras');
    if (!Array.isArray(cameras)) cameras = [];
  } catch (e) { cameras = []; }

  cameras.forEach(cam => {
    const opt = document.createElement('option');
    opt.value = cam.id;
    opt.textContent = cam.name;
    camSel.appendChild(opt);
  });

  document.getElementById('playback-date-select').disabled = true;
  document.getElementById('playback-date-select').innerHTML = '<option value="">Select Date...</option>';
  document.getElementById('playback-segments').innerHTML = '';
  document.getElementById('playback-player').classList.add('hidden');

  if (cameras.length > 0) {
    camSel.value = cameras[0].id;
    await loadPlaybackDates(cameras[0].id);
  }
}

document.getElementById('playback-camera-select').addEventListener('change', async (e) => {
  const camId = e.target.value;
  document.getElementById('playback-date-select').disabled = !camId;
  document.getElementById('playback-date-select').innerHTML = '<option value="">Select Date...</option>';
  document.getElementById('playback-segments').innerHTML = '';
  document.getElementById('playback-player').classList.add('hidden');

  if (camId) await loadPlaybackDates(camId);
});

document.getElementById('playback-date-select').addEventListener('change', async (e) => {
  const camId = document.getElementById('playback-camera-select').value;
  const date = e.target.value;
  document.getElementById('playback-segments').innerHTML = '';
  document.getElementById('playback-player').classList.add('hidden');

  if (camId && date) await loadPlaybackSegments(camId, date);
});

async function loadPlaybackDates(camId) {
  const dateSel = document.getElementById('playback-date-select');
  dateSel.disabled = true;
  dateSel.innerHTML = '<option value="">Loading...</option>';

  let dates = [];
  try {
    const res = await api(`/storage/recordings/${camId}`);
    dates = Array.isArray(res) ? res : (res.dates || []);
  } catch (e) { dates = []; }

  dateSel.innerHTML = '<option value="">Select Date...</option>';
  dates.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    dateSel.appendChild(opt);
  });
  dateSel.disabled = dates.length === 0;
}

async function loadPlaybackSegments(camId, date) {
  const container = document.getElementById('playback-segments');
  container.innerHTML = '<div class="loading">Loading segments...</div>';

  let segments = [];
  try {
    const res = await api(`/storage/recordings/${camId}/${date}`);
    segments = Array.isArray(res) ? res : (res.files || res.segments || []);
  } catch (e) {
    container.innerHTML = '<div class="loading">Failed to load segments.</div>';
    return;
  }

  if (segments.length === 0) {
    container.innerHTML = '<div class="loading">No recordings for this date.</div>';
    return;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Segments — ${escapeHtml(date)}</div>
      <div class="segment-list">
        ${segments.map(seg => {
          const filename = typeof seg === 'string' ? seg : seg.filename || seg.name;
          return `<button class="segment-btn" id="seg-${btoa(filename).replace(/=/g,'')}"
            onclick="playSegment('${escapeAttr(camId)}', '${escapeAttr(date)}', '${escapeAttr(filename)}', this)">
            ${escapeHtml(filename)}
          </button>`;
        }).join('')}
      </div>
    </div>
  `;
}

function playSegment(camId, date, filename, btn) {
  document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('playing'));
  if (btn) btn.classList.add('playing');

  const player = document.getElementById('playback-player');
  const video = document.getElementById('playback-video');
  const label = document.getElementById('playback-filename');

  label.textContent = filename;
  video.src = `/api/storage/recordings/${camId}/${date}/${filename}`;
  player.classList.remove('hidden');
  video.play().catch(() => {});
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------
async function loadSystem() {
  let data = null;
  try {
    data = await api('/system');
  } catch (e) {
    ['system-health', 'network-info', 'dhcp-leases', 'service-controls'].forEach(id => {
      const card = document.getElementById(id);
      if (card) card.querySelector('.card-body').innerHTML = '<span class="status-text-red">Failed to load.</span>';
    });
    return;
  }

  renderHealthCard(data);
  renderNetworkCard(data);
  renderDhcpCard(data);
  renderServicesCard(data);
  loadActivationStatus();
}

function renderHealthCard(data) {
  const el = document.getElementById('system-health');
  if (!el) return;
  const h = data.health || data;
  el.innerHTML = `
    <div class="card-title">System Health</div>
    <div class="card-body">
      <div class="stat-row"><span class="stat-label">CPU Temp</span><span class="stat-value">${h.cpu_temp != null ? h.cpu_temp + '°C' : '--'}</span></div>
      <div class="stat-row"><span class="stat-label">CPU Load</span><span class="stat-value">${h.cpu_load != null ? h.cpu_load + '%' : '--'}</span></div>
      <div class="stat-row"><span class="stat-label">Memory</span><span class="stat-value">${h.memory_used != null ? formatBytes(h.memory_used) + ' / ' + formatBytes(h.memory_total) : '--'}</span></div>
      <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${h.uptime ? formatUptime(h.uptime) : '--'}</span></div>
    </div>
  `;
}

function renderNetworkCard(data) {
  const el = document.getElementById('network-info');
  if (!el) return;
  const ifaces = data.network || data.interfaces || [];
  if (!Array.isArray(ifaces) || ifaces.length === 0) {
    el.innerHTML = `<div class="card-title">Network</div><div class="card-body"><span class="status-text-yellow">No data.</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card-title">Network</div>
    <div class="card-body">
      <table class="info-table">
        <thead><tr><th>Interface</th><th>IP</th><th>MAC</th></tr></thead>
        <tbody>
          ${ifaces.map(i => `
            <tr>
              <td>${escapeHtml(i.interface || i.name || '')}</td>
              <td>${escapeHtml(i.ip || i.address || '')}</td>
              <td>${escapeHtml(i.mac || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderDhcpCard(data) {
  const el = document.getElementById('dhcp-leases');
  if (!el) return;
  const leases = data.dhcp_leases || data.leases || [];
  if (!Array.isArray(leases) || leases.length === 0) {
    el.innerHTML = `<div class="card-title">DHCP Leases</div><div class="card-body"><span class="status-text-yellow">No leases.</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card-title">DHCP Leases</div>
    <div class="card-body">
      <table class="info-table">
        <thead><tr><th>IP</th><th>MAC</th><th>Hostname</th></tr></thead>
        <tbody>
          ${leases.map(l => `
            <tr>
              <td>${escapeHtml(l.ip || '')}</td>
              <td>${escapeHtml(l.mac || '')}</td>
              <td>${escapeHtml(l.hostname || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderServicesCard(data) {
  const el = document.getElementById('service-controls');
  if (!el) return;
  const services = data.services || [];
  if (!Array.isArray(services) || services.length === 0) {
    el.innerHTML = `<div class="card-title">Services</div><div class="card-body"><span class="status-text-yellow">No services.</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card-title">Services</div>
    <div class="card-body">
      <table class="info-table">
        <thead><tr><th>Service</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${services.map(svc => {
            const active = svc.active || svc.status === 'active' || svc.running;
            return `
              <tr>
                <td>${escapeHtml(svc.name)}</td>
                <td>
                  <span class="status-dot ${active ? '' : 'offline'}"></span>
                  <span class="${active ? 'status-text-green' : 'status-text-red'}" style="margin-left:6px">${active ? 'Active' : 'Inactive'}</span>
                </td>
                <td>
                  <button class="btn btn-sm" onclick="restartService('${escapeAttr(svc.name)}')">Restart</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function restartService(name) {
  if (!confirm(`Restart service: ${name}?`)) return;
  try {
    await api(`/system/restart/${name}`, { method: 'POST' });
    alert(`Service "${name}" restart initiated.`);
    loadSystem();
  } catch (err) {
    alert('Failed to restart service: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// System Badge (header)
// ---------------------------------------------------------------------------
async function updateBadge() {
  try {
    const data = await api('/system');
    const h = data.health || data;
    const tempEl = document.getElementById('badge-temp');
    const ramEl = document.getElementById('badge-ram');

    if (tempEl && h.cpu_temp != null) tempEl.textContent = `${h.cpu_temp}°C`;
    if (ramEl) {
      if (h.memory_used != null && h.memory_total != null && h.memory_total > 0) {
        const pct = Math.round((h.memory_used / h.memory_total) * 100);
        ramEl.textContent = `RAM ${pct}%`;
      } else if (h.memory_percent != null) {
        ramEl.textContent = `RAM ${h.memory_percent}%`;
      }
    }
  } catch (e) { /* silent fail for badge */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function formatUptime(seconds) {
  if (seconds == null) return '--';
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── ACTIVATION CODE ──
let activationTimer = null;

async function generateActivationCode() {
  const btn = document.getElementById('btn-generate-code');
  if (btn) btn.disabled = true;

  const result = await api('/activation/generate', { method: 'POST' });

  if (!result.ok) {
    alert(result.message || 'Failed to generate code');
    if (btn) btn.disabled = false;
    return;
  }

  showActivationCode(result.code, result.expires_at);
}

function showActivationCode(code, expiresAt) {
  const formatted = code.slice(0, 3) + ' – ' + code.slice(3);
  const container = document.getElementById('activation-content');

  container.innerHTML = `
    <div class="activation-code-display">
      <div class="activation-code">${formatted}</div>
      <div class="activation-timer" id="activation-timer"></div>
      <div class="activation-subtitle">Enter this code in the Intrlock dashboard to link this bridge's cameras</div>
      <div class="activation-actions">
        <button class="btn btn-sm" onclick="generateActivationCode()">Regenerate</button>
      </div>
    </div>
  `;

  if (activationTimer) clearInterval(activationTimer);
  activationTimer = setInterval(() => {
    const now = Date.now();
    const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const timerEl = document.getElementById('activation-timer');

    if (!timerEl) { clearInterval(activationTimer); return; }

    timerEl.textContent = `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
    timerEl.className = 'activation-timer' +
      (remaining <= 60 ? ' critical' : remaining <= 180 ? ' expiring' : '');

    if (remaining <= 0) {
      clearInterval(activationTimer);
      resetActivationUI();
    }
  }, 1000);
}

function resetActivationUI() {
  const container = document.getElementById('activation-content');
  if (container) {
    container.innerHTML = `
      <p class="activation-hint">Generate a code to link this bridge's cameras to the Intrlock dashboard.</p>
      <button id="btn-generate-code" class="btn btn-primary" onclick="generateActivationCode()">Generate Activation Code</button>
    `;
  }
}

async function loadActivationStatus() {
  const status = await api('/activation/status');
  if (status.active) {
    const container = document.getElementById('activation-content');
    container.innerHTML = `
      <div class="activation-code-display">
        <div class="activation-code">• • • – • • •</div>
        <div class="activation-timer" id="activation-timer">Code active</div>
        <div class="activation-subtitle">A code was generated in another session. Generate a new one to see it.</div>
        <div class="activation-actions">
          <button class="btn btn-sm btn-primary" onclick="generateActivationCode()">Generate New Code</button>
        </div>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  loadLiveView();
  updateBadge();
  setInterval(updateBadge, 30000);
});
