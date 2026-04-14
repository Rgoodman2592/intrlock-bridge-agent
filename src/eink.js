const { execSync } = require('child_process');
const path = require('path');

class EinkDisplay {
  constructor(config = {}) {
    this.scriptPath = path.join(__dirname, '..', 'scripts', 'eink_render.py');
    this.enabled = false;
    this.propertyUrl = '';
    this.propertyName = '';
    this.dcPin = config.eink_dc_pin || 16;
    this.rstPin = config.eink_rst_pin || 20;
    this.busyPin = config.eink_busy_pin || 21;
  }

  async init() {
    try {
      // Check if SPI is enabled and spidev is accessible
      execSync('sudo python3 -c "import spidev; s=spidev.SpiDev(); s.open(0,0); s.close()"', {
        stdio: 'ignore',
        timeout: 5000,
      });
      this.enabled = true;
      console.log('[EINK] Display detected on SPI0');
    } catch {
      console.log('[EINK] No e-ink display detected — module disabled');
      this.enabled = false;
    }
  }

  showQR(url, propertyName) {
    if (!this.enabled) return;
    this.propertyUrl = url;
    this.propertyName = propertyName;
    try {
      execSync(
        `sudo python3 "${this.scriptPath}" --action qr --url "${url}" --text "${propertyName}" --dc ${this.dcPin} --rst ${this.rstPin} --busy ${this.busyPin}`,
        { timeout: 30000 }
      );
      console.log(`[EINK] QR displayed: ${url}`);
    } catch (e) {
      console.error('[EINK] Failed to render QR:', e.message);
    }
  }

  showStatus(text) {
    if (!this.enabled) return;
    try {
      execSync(
        `sudo python3 "${this.scriptPath}" --action status --text "${text}" --dc ${this.dcPin} --rst ${this.rstPin} --busy ${this.busyPin}`,
        { timeout: 30000 }
      );
      console.log(`[EINK] Status displayed: ${text}`);
    } catch (e) {
      console.error('[EINK] Failed to show status:', e.message);
    }
  }

  clear() {
    if (!this.enabled) return;
    try {
      execSync(
        `sudo python3 "${this.scriptPath}" --action clear --dc ${this.dcPin} --rst ${this.rstPin} --busy ${this.busyPin}`,
        { timeout: 30000 }
      );
      console.log('[EINK] Display cleared');
    } catch (e) {
      console.error('[EINK] Failed to clear display:', e.message);
    }
  }
}

module.exports = { EinkDisplay };
