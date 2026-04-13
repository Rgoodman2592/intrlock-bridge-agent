const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const FIRMWARE_URL = 'https://intrlock-bridge-firmware.s3.amazonaws.com/latest.json';
const INSTALL_DIR = '/opt/intrlock-bridge';
const STAGING_DIR = '/opt/intrlock-bridge-staging';
const ROLLBACK_DIR = '/opt/intrlock-bridge-rollback';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { fs.unlinkSync(dest); reject(e); });
  });
}

function verifySha256(filePath, expected) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex') === expected;
}

async function checkForUpdate(mqtt) {
  try {
    console.log('[UPDATER] Checking for updates...');
    const latest = await fetchJson(FIRMWARE_URL);

    if (!latest.version || !latest.url || !latest.sha256) {
      console.log('[UPDATER] No valid update info');
      return false;
    }

    if (latest.version === pkg.version) {
      console.log(`[UPDATER] Already on latest version (${pkg.version})`);
      return false;
    }

    console.log(`[UPDATER] Update available: ${pkg.version} → ${latest.version}`);

    // Download tarball
    const tarPath = '/tmp/intrlock-bridge-update.tar.gz';
    await downloadFile(latest.url, tarPath);

    // Verify checksum
    if (!verifySha256(tarPath, latest.sha256)) {
      console.error('[UPDATER] SHA-256 checksum mismatch — update rejected');
      fs.unlinkSync(tarPath);
      return false;
    }

    // Extract to staging
    execSync(`rm -rf ${STAGING_DIR} && mkdir -p ${STAGING_DIR}`);
    execSync(`tar -xzf ${tarPath} -C ${STAGING_DIR} --strip-components=1`);
    execSync(`cd ${STAGING_DIR} && npm install --production`, { timeout: 120000 });

    // Swap directories
    execSync(`rm -rf ${ROLLBACK_DIR}`);
    if (fs.existsSync(INSTALL_DIR)) {
      execSync(`mv ${INSTALL_DIR} ${ROLLBACK_DIR}`);
    }
    execSync(`mv ${STAGING_DIR} ${INSTALL_DIR}`);

    // Preserve config and certs from rollback
    for (const keep of ['config.json', 'certs']) {
      const src = path.join(ROLLBACK_DIR, keep);
      const dst = path.join(INSTALL_DIR, keep);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        execSync(`cp -r ${src} ${dst}`);
      }
    }

    fs.unlinkSync(tarPath);
    console.log(`[UPDATER] Updated to ${latest.version} — restarting...`);

    if (mqtt) {
      mqtt.publish('health', {
        updated: true,
        old_version: pkg.version,
        new_version: latest.version,
        timestamp: Date.now(),
      });
    }

    // Restart via systemd
    setTimeout(() => {
      try { execSync('systemctl restart intrlock-bridge'); } catch {
        process.exit(0); // Fallback: let systemd restart us
      }
    }, 2000);

    return true;
  } catch (e) {
    console.error('[UPDATER] Update check failed:', e.message);
    return false;
  }
}

function startPeriodicCheck(mqtt, intervalMs = 6 * 60 * 60 * 1000) {
  // Check on start
  setTimeout(() => checkForUpdate(mqtt), 30000);
  // Then every interval
  setInterval(() => checkForUpdate(mqtt), intervalMs);
}

module.exports = { checkForUpdate, startPeriodicCheck };
