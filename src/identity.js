const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Bridge Device Identity
 *
 * Every Intrlock Bridge device has a unique identity derived from hardware:
 * - Pi CPU Serial Number (from /proc/cpuinfo)
 * - Primary MAC Address (from network interface)
 * - Device Type (relay, panel, doorbell, camera)
 *
 * The identity is encoded into a QR code printed on the device sticker.
 * When a customer scans the QR code in the Intrlock web/mobile app,
 * the device automatically pairs to their property.
 *
 * QR Code Format:
 *   intrlock://device/{device_type}/{mac_address}/{verification_code}
 *
 * Example:
 *   intrlock://device/relay/dc:a6:32:12:ab:cd/a1b2c3
 *
 * The verification code is a 6-char hash of serial+mac to prevent
 * spoofing — only the real device can generate the matching code.
 */

const DEVICE_TYPES = ['relay', 'panel', 'doorbell', 'camera', 'hub'];

class DeviceIdentity {
  constructor(deviceType = 'relay') {
    this.deviceType = deviceType;
    this.serial = this._getCpuSerial();
    this.mac = this._getPrimaryMac();
    this.hostname = os.hostname();
    this.verificationCode = this._generateVerificationCode();
    this.deviceId = `${deviceType}-${this.mac.replace(/:/g, '')}`;
    this.qrPayload = `intrlock://device/${deviceType}/${this.mac}/${this.verificationCode}`;
  }

  /**
   * Get the Raspberry Pi CPU serial number
   * Unique per physical Pi board — never changes
   */
  _getCpuSerial() {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const match = cpuinfo.match(/Serial\s*:\s*([0-9a-f]+)/i);
      if (match) return match[1];
    } catch {}

    // Fallback for non-Pi systems (dev/testing)
    try {
      // Use machine-id on Linux
      return fs.readFileSync('/etc/machine-id', 'utf8').trim();
    } catch {}

    return 'dev-' + crypto.randomBytes(8).toString('hex');
  }

  /**
   * Get the primary network interface MAC address
   * Uses eth0 first (wired), then wlan0 (wireless)
   */
  _getPrimaryMac() {
    const interfaces = os.networkInterfaces();

    // Priority: eth0 → wlan0 → first non-internal interface
    for (const name of ['eth0', 'wlan0', 'en0', 'enp0s3']) {
      if (interfaces[name]) {
        const entry = interfaces[name].find(e => e.mac && e.mac !== '00:00:00:00:00:00');
        if (entry) return entry.mac;
      }
    }

    // Fallback: first interface with a real MAC
    for (const entries of Object.values(interfaces)) {
      const entry = entries.find(e => !e.internal && e.mac && e.mac !== '00:00:00:00:00:00');
      if (entry) return entry.mac;
    }

    return '00:00:00:00:00:00';
  }

  /**
   * Generate a 6-character verification code from serial + MAC
   * This prevents QR code spoofing — only a device with the real
   * serial+MAC combination can generate the matching code
   */
  _generateVerificationCode() {
    const hash = crypto.createHash('sha256')
      .update(`intrlock:${this.serial}:${this.mac}:${this.deviceType}`)
      .digest('hex');
    return hash.substring(0, 6);
  }

  /**
   * Get all identity info for registration
   */
  getIdentity() {
    return {
      device_id: this.deviceId,
      device_type: this.deviceType,
      serial_number: this.serial,
      mac_address: this.mac,
      hostname: this.hostname,
      verification_code: this.verificationCode,
      qr_payload: this.qrPayload,
      firmware_version: this._getFirmwareVersion(),
      hardware: this._getHardwareInfo(),
      network: this._getNetworkInfo(),
    };
  }

  /**
   * Verify a QR code payload matches this device
   * Used during onboarding to confirm the scan is legitimate
   */
  verifyQrPayload(payload) {
    return payload === this.qrPayload;
  }

  /**
   * Generate QR code as SVG string (no external dependency)
   * Uses the qrcode npm package already in package.json
   */
  async generateQrSvg() {
    try {
      const QRCode = require('qrcode');
      return await QRCode.toString(this.qrPayload, { type: 'svg', margin: 2 });
    } catch {
      return `<!-- QR: ${this.qrPayload} -->`;
    }
  }

  /**
   * Generate QR code as PNG buffer
   */
  async generateQrPng() {
    try {
      const QRCode = require('qrcode');
      return await QRCode.toBuffer(this.qrPayload, { type: 'png', margin: 2, width: 300 });
    } catch {
      return null;
    }
  }

  /**
   * Save device identity to a label-ready file
   * This is used during manufacturing to print the device sticker
   */
  async saveLabelFile(outputDir = '/tmp') {
    const labelData = {
      device_id: this.deviceId,
      device_type: this.deviceType,
      mac: this.mac,
      serial: this.serial,
      qr_payload: this.qrPayload,
      verification: this.verificationCode,
      generated_at: new Date().toISOString(),
    };

    const labelPath = `${outputDir}/intrlock-label-${this.deviceId}.json`;
    fs.writeFileSync(labelPath, JSON.stringify(labelData, null, 2));

    // Save QR code as PNG
    const qrPng = await this.generateQrPng();
    if (qrPng) {
      const qrPath = `${outputDir}/intrlock-qr-${this.deviceId}.png`;
      fs.writeFileSync(qrPath, qrPng);
      console.log(`[IDENTITY] QR code saved: ${qrPath}`);
    }

    console.log(`[IDENTITY] Label data saved: ${labelPath}`);
    return labelPath;
  }

  _getFirmwareVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync('/opt/intrlock-bridge/package.json', 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  _getHardwareInfo() {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const model = cpuinfo.match(/Model\s*:\s*(.+)/i)?.[1]?.trim() || 'Unknown';
      const revision = cpuinfo.match(/Revision\s*:\s*([0-9a-f]+)/i)?.[1] || '';

      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const totalMem = parseInt(meminfo.match(/MemTotal:\s*(\d+)/)?.[1] || '0') / 1024;

      return {
        model,
        revision,
        memory_mb: Math.round(totalMem),
        arch: os.arch(),
        platform: os.platform(),
      };
    } catch {
      return { model: 'Unknown', arch: os.arch(), platform: os.platform() };
    }
  }

  _getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const result = {};

    for (const [name, entries] of Object.entries(interfaces)) {
      const ipv4 = entries.find(e => e.family === 'IPv4' && !e.internal);
      if (ipv4) {
        result[name] = {
          ip: ipv4.address,
          mac: ipv4.mac || entries[0]?.mac,
          netmask: ipv4.netmask,
        };
      }
    }

    // WiFi signal strength
    try {
      const iwconfig = execSync('iwconfig wlan0 2>/dev/null', { encoding: 'utf8' });
      const signal = iwconfig.match(/Signal level=(-?\d+)/)?.[1];
      if (signal) result.wifi_signal_dbm = parseInt(signal);
    } catch {}

    return result;
  }
}

/**
 * Parse a scanned QR code payload
 * Returns the device info or null if invalid
 */
function parseQrPayload(payload) {
  const match = payload.match(/^intrlock:\/\/device\/(\w+)\/([\da-f:]+)\/([a-f0-9]{6})$/i);
  if (!match) return null;

  return {
    device_type: match[1],
    mac_address: match[2],
    verification_code: match[3],
    device_id: `${match[1]}-${match[2].replace(/:/g, '')}`,
  };
}

module.exports = { DeviceIdentity, parseQrPayload, DEVICE_TYPES };
