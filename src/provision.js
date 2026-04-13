const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

const BRIDGE_API = 'https://ovle12ewnh.execute-api.us-east-1.amazonaws.com';
const CERTS_DIR = path.join(config.CONFIG_DIR, 'certs');

function certsExist() {
  return fs.existsSync(path.join(CERTS_DIR, 'device.crt')) &&
         fs.existsSync(path.join(CERTS_DIR, 'device.key'));
}

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let result = '';
      res.on('data', (chunk) => result += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(result)); } catch { resolve({ raw: result }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function provision(cfg) {
  console.log('[PROVISION] Starting self-registration...');
  console.log(`[PROVISION] Serial: ${cfg.serial_number}`);
  console.log(`[PROVISION] Device ID: ${cfg.device_id}`);

  // Register with the Bridge API (creates record in Xano if not exists)
  try {
    const result = await httpPost(`${BRIDGE_API}/bridge/register`, {
      serial_number: cfg.serial_number,
      bridge_device_id: cfg.device_id,
      firmware_version: require('../package.json').version,
      channel_count: cfg.channels ? cfg.channels.length : 0,
    });
    console.log('[PROVISION] Registration result:', JSON.stringify(result));

    if (result.error && !result.error.includes('already')) {
      console.log('[PROVISION] Registration note:', result.error);
    }
  } catch (e) {
    console.error('[PROVISION] API registration failed:', e.message);
    console.log('[PROVISION] Device will register when cloud connection is available');
  }

  // IoT Core MQTT certs — skip if no claim cert (will connect via API polling instead)
  if (!certsExist()) {
    const claimCertPath = path.join(CERTS_DIR, 'claim.crt');
    if (!fs.existsSync(claimCertPath)) {
      console.log('[PROVISION] No IoT Core claim certificate — running in API-only mode');
      console.log('[PROVISION] MQTT will be available once fleet provisioning certs are deployed');
      return false;
    }
  }

  console.log('[PROVISION] Device certificates found — MQTT ready');
  return true;
}

module.exports = { provision, certsExist, CERTS_DIR };
