const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const CONFIG_DIR = process.env.BRIDGE_DIR || '/opt/intrlock-bridge';
const CAMERAS_PATH = path.join(CONFIG_DIR, 'config', 'cameras.json');
const MEDIAMTX_CONF = '/opt/mediamtx/mediamtx.yml';

const DEFAULT_CAMERAS_CONFIG = {
  cameras: [],
  recording_settings: {
    segment_duration: 300,
    retention_days: 30,
    max_disk_percent: 90,
    usb_mount_path: '/mnt/usb',
  },
};

let cameraData = null;

function load() {
  try {
    if (fs.existsSync(CAMERAS_PATH)) {
      const raw = fs.readFileSync(CAMERAS_PATH, 'utf8');
      cameraData = { ...DEFAULT_CAMERAS_CONFIG, ...JSON.parse(raw) };
      return cameraData;
    }
  } catch (e) {
    console.error('[CAMERA-CONFIG] Failed to load:', e.message);
  }

  // First run — generate defaults
  cameraData = { ...DEFAULT_CAMERAS_CONFIG };
  save(cameraData);
  return cameraData;
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(CAMERAS_PATH), { recursive: true });
    fs.writeFileSync(CAMERAS_PATH, JSON.stringify(data, null, 2));
    cameraData = data;
  } catch (e) {
    console.error('[CAMERA-CONFIG] Failed to save:', e.message);
  }
}

function addCamera(camera) {
  if (!cameraData) load();

  const newCamera = {
    id: camera.id || `cam${Date.now().toString(36)}`,
    name: camera.name || '',
    ip: camera.ip || '',
    rtsp_url: camera.rtsp_url || '',
    sub_stream_url: camera.sub_stream_url || '',
    username: camera.username || '',
    password: camera.password || '',
    manufacturer: camera.manufacturer || '',
    model: camera.model || '',
    recording: camera.recording !== undefined ? camera.recording : false,
    enabled: camera.enabled !== undefined ? camera.enabled : true,
  };

  cameraData.cameras.push(newCamera);
  save(cameraData);
  return newCamera;
}

function updateCamera(id, updates) {
  if (!cameraData) load();

  const camera = cameraData.cameras.find((c) => c.id === id);
  if (!camera) {
    throw new Error(`Camera with id ${id} not found`);
  }

  const updated = { ...camera, ...updates, id };
  const index = cameraData.cameras.findIndex((c) => c.id === id);
  cameraData.cameras[index] = updated;
  save(cameraData);
  return updated;
}

function removeCamera(id) {
  if (!cameraData) load();

  const index = cameraData.cameras.findIndex((c) => c.id === id);
  if (index === -1) {
    throw new Error(`Camera with id ${id} not found`);
  }

  const removed = cameraData.cameras.splice(index, 1)[0];
  save(cameraData);
  return removed;
}

function getCamera(id) {
  if (!cameraData) load();

  return cameraData.cameras.find((c) => c.id === id) || null;
}

function listCameras() {
  if (!cameraData) load();

  return [...cameraData.cameras];
}

function getRecordingSettings() {
  if (!cameraData) load();

  return { ...cameraData.recording_settings };
}

function updateRecordingSettings(settings) {
  if (!cameraData) load();

  cameraData.recording_settings = { ...cameraData.recording_settings, ...settings };
  save(cameraData);
  return { ...cameraData.recording_settings };
}

function regenerateMediaMtx(data) {
  if (!cameraData) load();

  // Use provided data or load from disk
  const cameras = data?.cameras || cameraData.cameras;

  // Build paths object from enabled cameras
  const paths = {};
  cameras.forEach((camera) => {
    if (camera.enabled && camera.rtsp_url) {
      paths[camera.id] = {
        source: camera.rtsp_url,
        sourceOnDemand: true,
      };
    }
  });

  // Standard MediaMTX config
  const config = {
    logLevel: 'warn',
    api: true,
    apiAddress: ':9997',
    rtspAddress: ':8554',
    webrtcAddress: ':8889',
    hlsAddress: ':8888',
    paths,
  };

  try {
    fs.mkdirSync(path.dirname(MEDIAMTX_CONF), { recursive: true });
    const yamlContent = yaml.stringify(config, { lineWidth: 0 });
    fs.writeFileSync(MEDIAMTX_CONF, yamlContent);
  } catch (e) {
    console.error('[CAMERA-CONFIG] Failed to regenerate MediaMTX config:', e.message);
    throw e;
  }
}

module.exports = {
  load,
  save,
  addCamera,
  updateCamera,
  removeCamera,
  getCamera,
  listCameras,
  getRecordingSettings,
  updateRecordingSettings,
  regenerateMediaMtx,
  CAMERAS_PATH,
  MEDIAMTX_CONF,
};
