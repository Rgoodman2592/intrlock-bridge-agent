const crypto = require('crypto');
const https = require('https');
const os = require('os');

const BRIDGE_API = 'https://ovle12ewnh.execute-api.us-east-1.amazonaws.com';
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GENERATE_COOLDOWN_MS = 30 * 1000; // 30 seconds
const MAX_VALIDATE_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

class ActivationManager {
  constructor(bridgeConfig, cameraConfig) {
    this.bridgeConfig = bridgeConfig;
    this.cameraConfig = cameraConfig;
    this.activeCode = null;
    this.lastGenerated = 0;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
  }

  generate() {
    const now = Date.now();

    // Rate limit check
    if (now - this.lastGenerated < GENERATE_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((GENERATE_COOLDOWN_MS - (now - this.lastGenerated)) / 1000);
      return { ok: false, message: `Wait ${waitSeconds}s before generating another code` };
    }

    // Generate 6-digit code
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = now + CODE_TTL_MS;

    // Store active code
    this.activeCode = { code, expiresAt, used: false, createdAt: now };
    this.lastGenerated = now;

    // Reset failure tracking
    this.failedAttempts = 0;
    this.lockedUntil = 0;

    // Push to Lambda in background (non-blocking)
    this._pushToLambda(code, expiresAt);

    const expiresInSeconds = Math.floor(CODE_TTL_MS / 1000);
    return { ok: true, code, expires_in: expiresInSeconds, expires_at: expiresAt };
  }

  getStatus() {
    const now = Date.now();

    // No code, expired, or already used
    if (!this.activeCode || now > this.activeCode.expiresAt || this.activeCode.used) {
      return { active: false };
    }

    const expiresInSeconds = Math.floor((this.activeCode.expiresAt - now) / 1000);
    return { active: true, expires_in: expiresInSeconds, expires_at: this.activeCode.expiresAt };
  }

  validate(code) {
    const now = Date.now();

    // Check lockout
    if (now < this.lockedUntil) {
      const retryAfterSeconds = Math.ceil((this.lockedUntil - now) / 1000);
      return { valid: false, reason: 'rate_limited', retry_after: retryAfterSeconds };
    }

    // Check if code exists
    if (!this.activeCode) {
      this._recordFailure();
      return { valid: false, reason: 'invalid' };
    }

    // Check if already used
    if (this.activeCode.used) {
      return { valid: false, reason: 'already_used' };
    }

    // Check if expired
    if (now > this.activeCode.expiresAt) {
      return { valid: false, reason: 'expired' };
    }

    // Check if code matches
    if (code !== this.activeCode.code) {
      this._recordFailure();
      return { valid: false, reason: 'invalid' };
    }

    // Valid! Mark used and reset attempts
    this.activeCode.used = true;
    this.failedAttempts = 0;
    this.lockedUntil = 0;

    // Build response with bridge and camera data
    const bridgeInfo = {
      device_id: this.bridgeConfig.device_id,
      serial_number: this.bridgeConfig.serial_number,
      hostname: os.hostname(),
      ip: this._getLocalIp(),
      firmware_version: this._getFirmwareVersion(),
    };

    const cameras = this.cameraConfig.listCameras().map((cam) => ({
      id: cam.id,
      name: cam.name,
      ip: cam.ip,
      manufacturer: cam.manufacturer,
      model: cam.model,
      rtsp_url: cam.rtsp_url,
    }));

    return { valid: true, bridge: bridgeInfo, cameras };
  }

  _recordFailure() {
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_VALIDATE_ATTEMPTS) {
      this.lockedUntil = Date.now() + LOCKOUT_MS;
      console.log(`[ACTIVATION] Locked until ${new Date(this.lockedUntil).toISOString()}`);
    }
  }

  _getLocalIp() {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const entry of iface) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
    return '127.0.0.1';
  }

  _getFirmwareVersion() {
    try {
      const pkg = require('../package.json');
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  _pushToLambda(code, expiresAt) {
    const body = JSON.stringify({
      device_id: this.bridgeConfig.device_id,
      serial_number: this.bridgeConfig.serial_number,
      code,
      expires_at: expiresAt,
    });

    const parsed = new URL(`${BRIDGE_API}/bridge/activate`);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('[ACTIVATION] Code pushed to Lambda successfully');
          } else {
            console.error(`[ACTIVATION] Lambda returned status ${res.statusCode}`);
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error('[ACTIVATION] Failed to push to Lambda:', err.message);
    });

    req.write(body);
    req.end();
  }
}

module.exports = { ActivationManager };
