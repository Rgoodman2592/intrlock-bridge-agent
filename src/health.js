const si = require('systeminformation');
const os = require('os');
const pkg = require('../package.json');

class HealthReporter {
  constructor(mqtt, gpioManager, config, camera) {
    this.mqtt = mqtt;
    this.gpio = gpioManager;
    this.config = config;
    this.camera = camera || null;
    this.interval = null;
  }

  start() {
    this.interval = setInterval(() => this.report(), this.config.health_interval_ms || 60000);
    this.report(); // Immediate first report
  }

  async report() {
    try {
      const [cpu, mem, net, wifi] = await Promise.all([
        si.cpuTemperature().catch(() => ({})),
        si.mem().catch(() => ({})),
        si.networkInterfaces().catch(() => []),
        si.wifiConnections().catch(() => []),
      ]);

      const activeNet = (Array.isArray(net) ? net : []).find(n => n.ip4 && !n.internal) || {};
      const activeWifi = (Array.isArray(wifi) ? wifi : [])[0] || {};

      const payload = {
        firmware_version: pkg.version,
        cpu_temp: cpu.main || null,
        uptime: Math.floor(os.uptime()),
        memory_used_mb: mem.used ? Math.round(mem.used / 1048576) : null,
        memory_total_mb: mem.total ? Math.round(mem.total / 1048576) : null,
        ip_address: activeNet.ip4 || null,
        wifi_ssid: activeWifi.ssid || null,
        wifi_signal: activeWifi.signalLevel || null,
        relay_states: this.gpio.getStates(),
        channel_count: Object.keys(this.gpio.channelMap || {}).length,
        camera: this.camera ? this.camera.getStatus() : null,
        timestamp: Date.now(),
      };

      this.mqtt.publish('health', payload);
    } catch (e) {
      console.error('[HEALTH] Report failed:', e.message);
    }
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}

module.exports = { HealthReporter };
