const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.BRIDGE_DIR || '/opt/intrlock-bridge';
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  device_id: '',
  serial_number: '',
  mqtt_endpoint: '',
  channels: [],
  health_interval_ms: 60000,
  update_check_interval_ms: 6 * 60 * 60 * 1000,
  firmware_bucket: 'intrlock-bridge-firmware',
};

function getPiSerial() {
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const match = cpuinfo.match(/Serial\s*:\s*([0-9a-f]+)/i);
    return match ? match[1] : 'unknown';
  } catch { return 'unknown-' + crypto.randomBytes(4).toString('hex'); }
}

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (e) { console.error('[CONFIG] Failed to load:', e.message); }

  // First run — generate defaults
  const config = {
    ...DEFAULT_CONFIG,
    device_id: crypto.randomUUID(),
    serial_number: getPiSerial(),
  };
  save(config);
  return config;
}

function save(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) { console.error('[CONFIG] Failed to save:', e.message); }
}

module.exports = { load, save, CONFIG_DIR, CONFIG_PATH };
