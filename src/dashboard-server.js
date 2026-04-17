const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const cameraConfig = require('./camera-config');
const { StorageManager } = require('./storage-manager');
const { RecordingManager } = require('./recording-manager');
const { OnvifDiscovery } = require('./onvif');
const systemInfo = require('./system-info');
const { ActivationManager } = require('./activation');
const config = require('./config');

function createDashboardServer(port = 3000) {
  const app = express();
  app.use(express.json());

  // Static dashboard files
  app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));

  // Redirect root to dashboard
  app.get('/', (req, res) => res.redirect('/dashboard'));

  // Initialize managers
  const settings = cameraConfig.getRecordingSettings();
  const storage = new StorageManager(settings.usb_mount_path);
  const recording = new RecordingManager(storage, cameraConfig);
  const onvif = new OnvifDiscovery();
  const bridgeConfig = config.load();
  const activation = new ActivationManager(bridgeConfig, cameraConfig);

  // ── Camera CRUD ──

  app.get('/api/cameras', (req, res) => {
    const cameras = cameraConfig.listCameras();
    const enriched = cameras.map(cam => ({
      ...cam,
      recording_active: recording.processes.has(cam.id),
      password: cam.password ? '***' : '',
    }));
    res.json(enriched);
  });

  app.post('/api/cameras', (req, res) => {
    const cam = cameraConfig.addCamera(req.body);
    res.json({ ok: true, camera: cam });
  });

  app.put('/api/cameras/:id', (req, res) => {
    const updated = cameraConfig.updateCamera(req.params.id, req.body);
    if (!updated) return res.status(404).json({ ok: false, message: 'Camera not found' });
    res.json({ ok: true, camera: updated });
  });

  app.delete('/api/cameras/:id', (req, res) => {
    recording.stopRecording(req.params.id);
    const removed = cameraConfig.removeCamera(req.params.id);
    if (!removed) return res.status(404).json({ ok: false, message: 'Camera not found' });
    res.json({ ok: true });
  });

  app.post('/api/cameras/discover', async (req, res) => {
    try {
      const cameras = await onvif.discover(req.body.timeout || 5000);
      const scanned = await onvif.scanNetwork();
      const seen = new Set(cameras.map(c => c.ip));
      for (const s of scanned) {
        if (!seen.has(s.ip)) cameras.push(s);
      }
      res.json({ ok: true, cameras });
    } catch (e) {
      res.json({ ok: false, message: e.message, cameras: [] });
    }
  });

  app.post('/api/cameras/:id/test', (req, res) => {
    const cam = cameraConfig.getCamera(req.params.id);
    if (!cam) return res.status(404).json({ ok: false, message: 'Camera not found' });
    try {
      execSync(
        `ffprobe -rtsp_transport tcp -i "${cam.rtsp_url}" -timeout 5000000 -v quiet -print_format json -show_streams 2>&1`,
        { encoding: 'utf8', timeout: 10000 }
      );
      res.json({ ok: true, message: 'Stream is reachable' });
    } catch (e) {
      res.json({ ok: false, message: 'Stream unreachable: ' + e.message.slice(0, 200) });
    }
  });

  // ── Recording ──

  app.get('/api/recording/status', (req, res) => {
    res.json(recording.getStatus());
  });

  app.post('/api/recording/:id/start', (req, res) => {
    res.json(recording.startRecording(req.params.id));
  });

  app.post('/api/recording/:id/stop', (req, res) => {
    res.json(recording.stopRecording(req.params.id));
  });

  app.put('/api/recording/settings', (req, res) => {
    const updated = cameraConfig.updateRecordingSettings(req.body);
    res.json({ ok: true, settings: updated });
  });

  // ── Storage ──

  app.get('/api/storage', (req, res) => {
    const stats = storage.getDiskStats();
    const drives = storage.detectUsbDrives();
    const recordingDirs = storage.listRecordingDirs();
    res.json({ ...stats, drives, recording_cameras: recordingDirs });
  });

  app.post('/api/storage/mount', (req, res) => {
    res.json(storage.mount());
  });

  app.get('/api/storage/recordings/:camId', (req, res) => {
    const dates = storage.listDates(req.params.camId);
    res.json({ dates });
  });

  app.get('/api/storage/recordings/:camId/:date', (req, res) => {
    const segments = storage.listSegments(req.params.camId, req.params.date);
    res.json({ segments });
  });

  app.get('/api/storage/recordings/:camId/:date/:file', (req, res) => {
    const filePath = path.join(
      storage.recordingsDir, req.params.camId, req.params.date, req.params.file
    );
    // Path traversal protection
    if (!filePath.startsWith(storage.recordingsDir)) {
      return res.status(403).json({ ok: false, message: 'Access denied' });
    }
    res.sendFile(filePath);
  });

  // ── System ──

  app.get('/api/system', async (req, res) => {
    const [info, network] = await Promise.all([
      systemInfo.getSystemInfo(),
      Promise.resolve(systemInfo.getNetworkInfo()),
    ]);
    const services = {
      'intrlock-bridge': systemInfo.getServiceStatus('intrlock-bridge'),
      'intrlock-mediamtx': systemInfo.getServiceStatus('intrlock-mediamtx'),
      dnsmasq: systemInfo.getServiceStatus('dnsmasq'),
    };
    const leases = systemInfo.getDhcpLeases();
    res.json({ ...info, network, services, dhcp_leases: leases });
  });

  app.post('/api/system/restart/:service', (req, res) => {
    res.json(systemInfo.restartService(req.params.service));
  });

  // ── Activation ──

  app.post('/api/activation/generate', (req, res) => {
    res.json(activation.generate());
  });

  app.get('/api/activation/status', (req, res) => {
    res.json(activation.getStatus());
  });

  app.post('/api/activation/validate', (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ valid: false, reason: 'missing code' });
    res.json(activation.validate(code));
  });

  // Start server
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[DASHBOARD] http://0.0.0.0:${port}/dashboard`);
  });

  // Regenerate MediaMTX config from cameras.json and reload
  // (CameraManager may have written its own config on startup with just 'cam' path)
  const cameras = cameraConfig.listCameras();
  if (cameras.length > 0) {
    cameraConfig.regenerateMediaMtx();
    // Send HUP to MediaMTX to reload config without restart
    try {
      execSync('pkill -HUP mediamtx 2>/dev/null', { timeout: 3000 });
      console.log('[DASHBOARD] MediaMTX config regenerated and reloaded');
    } catch {
      console.log('[DASHBOARD] MediaMTX config regenerated (reload signal failed — may need manual restart)');
    }
  }

  // Auto-start recordings for cameras with recording=true
  recording.startAll();
  recording.startRetentionLoop();

  return { app, server, recording, storage, activation };
}

module.exports = { createDashboardServer };
