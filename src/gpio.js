const { execSync } = require('child_process');
const fs = require('fs');

function isRaspberryPi() {
  try {
    return fs.existsSync('/dev/gpiochip0') || fs.existsSync('/dev/gpiochip4');
  } catch { return false; }
}

class GpioManager {
  constructor() {
    this.states = {};
    this.sensorStates = {};
    this.timers = {};
    this.channelMap = {};   // channel -> gpio pin
    this.activeHigh = {};   // channel -> boolean
    this.simulated = false;
  }

  initChannels(channels) {
    if (!isRaspberryPi()) {
      console.log('[GPIO] No GPIO detected — running in simulated mode');
      this.simulated = true;
    }

    for (const ch of channels) {
      if (!ch.enabled) continue;
      this.channelMap[ch.channel] = ch.gpio_pin;
      this.activeHigh[ch.channel] = ch.active_high !== false; // default active-high
      this.states[ch.channel] = 'closed';

      // Ensure relay is OFF on init
      if (!this.simulated) {
        this._setPin(ch.gpio_pin, false, ch.active_high !== false);
      }
    }
    console.log(`[GPIO] Initialized ${Object.keys(this.channelMap).length} channels${this.simulated ? ' (simulated)' : ''}`);
  }

  _setPin(pin, on, activeHigh) {
    if (this.simulated) {
      console.log(`[GPIO-SIM] Pin ${pin} = ${on ? 'ON' : 'OFF'}`);
      return;
    }
    try {
      // Use gpiozero via python3 — most reliable on Pi 5
      const value = (on && activeHigh) || (!on && !activeHigh) ? '1' : '0';
      const pyCmd = `import gpiozero;r=gpiozero.OutputDevice(${pin},active_high=${activeHigh ? 'True' : 'False'},initial_value=False);r.value=${value};import time;time.sleep(0.05)`;
      // Use a persistent approach — write a control file
      const ctrlFile = `/tmp/intrlock_gpio_${pin}`;
      if (on) {
        // Start a background python process that holds the pin
        execSync(`python3 -c "import gpiozero,time,signal;r=gpiozero.OutputDevice(${pin},active_high=${activeHigh ? 'True' : 'False'});r.on();open('${ctrlFile}','w').write(str(r.pin));signal.pause()" &`,
          { shell: '/bin/bash', stdio: 'ignore', timeout: 3000 });
      } else {
        // Kill the background process holding this pin
        try {
          execSync(`pkill -f "intrlock_gpio_${pin}" 2>/dev/null; rm -f ${ctrlFile}`, { shell: '/bin/bash', stdio: 'ignore', timeout: 2000 });
        } catch {}
        // Explicitly set pin off
        try {
          execSync(`python3 -c "import gpiozero;r=gpiozero.OutputDevice(${pin},active_high=${activeHigh ? 'True' : 'False'});r.off();r.close()"`,
            { stdio: 'ignore', timeout: 3000 });
        } catch {}
      }
    } catch (e) {
      console.error(`[GPIO] Pin ${pin} error:`, e.message);
    }
  }

  pulse(channel, durationMs = 5000) {
    const pin = this.channelMap[channel];
    if (pin === undefined) throw new Error(`Channel ${channel} not found`);

    if (this.timers[channel]) clearTimeout(this.timers[channel]);

    this._setPin(pin, true, this.activeHigh[channel]);
    this.states[channel] = 'open';

    this.timers[channel] = setTimeout(() => {
      this._setPin(pin, false, this.activeHigh[channel]);
      this.states[channel] = 'closed';
      delete this.timers[channel];
      console.log(`[GPIO] Channel ${channel} pulse complete (${durationMs}ms)`);
    }, durationMs);

    console.log(`[GPIO] Channel ${channel} (pin ${pin}) pulsed for ${durationMs}ms`);
    return { channel, state: 'open', duration_ms: durationMs };
  }

  setRelay(channel, state) {
    const pin = this.channelMap[channel];
    if (pin === undefined) throw new Error(`Channel ${channel} not found`);

    if (this.timers[channel]) { clearTimeout(this.timers[channel]); delete this.timers[channel]; }

    const on = state === 'open' || state === 'on';
    this._setPin(pin, on, this.activeHigh[channel]);
    this.states[channel] = on ? 'open' : 'closed';
    console.log(`[GPIO] Channel ${channel} set to ${this.states[channel]}`);
    return { channel, state: this.states[channel] };
  }

  getStates() {
    const result = {};
    for (const [ch, state] of Object.entries(this.states)) {
      result[ch] = { relay: state, sensor: this.sensorStates[ch] || 'unknown' };
    }
    return result;
  }

  onSensorChange(callback) {
    // Future: monitor sensor GPIO inputs
  }

  cleanup() {
    for (const timer of Object.values(this.timers)) clearTimeout(timer);
    for (const [ch, pin] of Object.entries(this.channelMap)) {
      this._setPin(pin, false, this.activeHigh[ch]);
    }
    // Kill any lingering gpio processes
    try { execSync('pkill -f intrlock_gpio_ 2>/dev/null', { shell: '/bin/bash', stdio: 'ignore' }); } catch {}
    console.log('[GPIO] Cleaned up');
  }
}

module.exports = { GpioManager };
