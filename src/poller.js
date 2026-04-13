const https = require('https');
const BRIDGE_API = 'https://ovle12ewnh.execute-api.us-east-1.amazonaws.com';

class CommandPoller {
  constructor(deviceId, gpioManager, mqttClient) {
    this.deviceId = deviceId;
    this.gpio = gpioManager;
    this.mqtt = mqttClient;
    this.interval = null;
    this.polling = false;
  }

  start(intervalMs = 3000) {
    // Only poll if MQTT is not connected
    this.interval = setInterval(() => {
      if (this.mqtt && this.mqtt.connected) return; // MQTT handles it
      this.poll();
    }, intervalMs);
    this.poll(); // immediate first poll
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const data = await this.httpGet(`${BRIDGE_API}/bridge/poll/${this.deviceId}`);
      if (data && data.commands && data.commands.length > 0) {
        for (const cmd of data.commands) {
          this.executeCommand(cmd);
        }
      }
    } catch (e) {
      // Silent fail - network may be temporarily down
    } finally {
      this.polling = false;
    }
  }

  executeCommand(cmd) {
    try {
      const ch = cmd.channel || 1;
      const duration = cmd.duration_ms || 5000;
      if (cmd.action === 'pulse' || cmd.action === 'unlock') {
        this.gpio.pulse(ch, duration);
      } else if (cmd.action === 'on' || cmd.action === 'open') {
        this.gpio.setRelay(ch, 'open');
      } else if (cmd.action === 'off' || cmd.action === 'close' || cmd.action === 'lock') {
        this.gpio.setRelay(ch, 'closed');
      }
      console.log(`[POLLER] Executed: ${cmd.action} ch${ch}`);
    } catch (e) {
      console.error('[POLLER] Command error:', e.message);
    }
  }

  httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }).on('error', reject);
    });
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}

module.exports = { CommandPoller };
