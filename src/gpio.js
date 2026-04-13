const { execSync } = require('child_process');
const fs = require('fs');

// Pi 5 uses /dev/gpiochip4 (RP1), older Pis use /dev/gpiochip0
function findGpioChip() {
  if (fs.existsSync('/dev/gpiochip4')) return '4'; // Pi 5
  if (fs.existsSync('/dev/gpiochip0')) return '0'; // Pi 4/3/2
  return null;
}

class GpioManager {
  constructor() {
    this.chip = findGpioChip();
    this.states = {};      // channel -> 'open'|'closed'
    this.sensorStates = {};
    this.timers = {};
    this.channelMap = {};  // channel -> gpio pin
    this.simulated = false;
  }

  initChannels(channels) {
    if (!this.chip) {
      console.log('[GPIO] No GPIO chip found — running in simulated mode');
      this.simulated = true;
    }

    for (const ch of channels) {
      if (!ch.enabled) continue;
      this.channelMap[ch.channel] = ch.gpio_pin;
      this.states[ch.channel] = 'closed';

      if (!this.simulated) {
        // Set pin as output, HIGH (relay OFF — active-low)
        try {
          execSync(`gpioset --mode=signal ${this.chip} ${ch.gpio_pin}=1 &`, { stdio: 'ignore' });
        } catch (e) {
          console.error(`[GPIO] Pin ${ch.gpio_pin} init failed:`, e.message);
        }
      }
    }
    console.log(`[GPIO] Initialized ${Object.keys(this.channelMap).length} channels${this.simulated ? ' (simulated)' : ` on gpiochip${this.chip}`}`);
  }

  _setPin(pin, value) {
    if (this.simulated) {
      console.log(`[GPIO-SIM] Pin ${pin} = ${value === 0 ? 'ON' : 'OFF'}`);
      return;
    }
    try {
      // gpioset sets a pin value: 0 = LOW (relay ON), 1 = HIGH (relay OFF)
      execSync(`gpioset ${this.chip} ${pin}=${value}`, { timeout: 2000 });
    } catch (e) {
      console.error(`[GPIO] Failed to set pin ${pin}:`, e.message);
    }
  }

  pulse(channel, durationMs = 5000) {
    const pin = this.channelMap[channel];
    if (pin === undefined) throw new Error(`Channel ${channel} not found`);

    if (this.timers[channel]) clearTimeout(this.timers[channel]);

    // Activate relay (active-low: 0 = ON)
    this._setPin(pin, 0);
    this.states[channel] = 'open';

    this.timers[channel] = setTimeout(() => {
      this._setPin(pin, 1);
      this.states[channel] = 'closed';
      delete this.timers[channel];
      console.log(`[GPIO] Channel ${channel} pulse complete (${durationMs}ms)`);
    }, durationMs);

    console.log(`[GPIO] Channel ${channel} pulsed for ${durationMs}ms`);
    return { channel, state: 'open', duration_ms: durationMs };
  }

  setRelay(channel, state) {
    const pin = this.channelMap[channel];
    if (pin === undefined) throw new Error(`Channel ${channel} not found`);

    if (this.timers[channel]) { clearTimeout(this.timers[channel]); delete this.timers[channel]; }

    if (state === 'open' || state === 'on') {
      this._setPin(pin, 0);
      this.states[channel] = 'open';
    } else {
      this._setPin(pin, 1);
      this.states[channel] = 'closed';
    }
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
    // Sensor monitoring via gpiomon (future)
  }

  cleanup() {
    for (const timer of Object.values(this.timers)) clearTimeout(timer);
    // Set all relays OFF
    for (const [ch, pin] of Object.entries(this.channelMap)) {
      this._setPin(pin, 1);
    }
    console.log('[GPIO] Cleaned up');
  }
}

module.exports = { GpioManager };
