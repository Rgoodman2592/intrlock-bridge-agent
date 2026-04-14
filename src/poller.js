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
    this.pollCount = 0;
    this.interval = setInterval(() => {
      if (this.mqtt && this.mqtt.connected) return;
      this.poll();
    }, intervalMs);
    this.poll(); // immediate first poll
    // Heartbeat every 60 seconds — update status to online + last_seen
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 60000);
    this.sendHeartbeat(); // immediate first heartbeat
  }

  async sendHeartbeat() {
    try {
      await this.httpPost(`${BRIDGE_API}/bridge/heartbeat`, { device_id: this.deviceId });
    } catch {}
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
    const ch = cmd.channel || 1;
    const duration = cmd.duration_ms || 5000;
    let success = true;
    try {
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
      success = false;
    }
    // Acknowledge execution to cloud for audit logging
    this.httpPost(`${BRIDGE_API}/bridge/ack`, {
      device_id: this.deviceId, action: cmd.action, channel: ch,
      duration_ms: duration, success,
    }).catch(() => {});
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

  httpPost(url, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const parsed = new URL(url);
      const req = https.request({ hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let result = '';
        res.on('data', chunk => result += chunk);
        res.on('end', () => { try { resolve(JSON.parse(result)); } catch { resolve(null); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }
}

module.exports = { CommandPoller };
