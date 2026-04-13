let Gpio;
try { Gpio = require('onoff').Gpio; } catch { Gpio = null; }

class SimulatedGpio {
  constructor(pin) { this.pin = pin; this._value = 1; this._watchers = []; }
  writeSync(v) { this._value = v; console.log(`[GPIO-SIM] Pin ${this.pin} = ${v === 0 ? 'ON' : 'OFF'}`); }
  readSync() { return this._value; }
  watch(cb) { this._watchers.push(cb); }
  setDirection(d) {}
  unexport() {}
}

class GpioManager {
  constructor() {
    this.relays = {};      // channel -> Gpio output
    this.sensors = {};     // channel -> Gpio input
    this.timers = {};      // channel -> active pulse timeout
    this.states = {};      // channel -> 'open'|'closed'
    this.sensorStates = {};
    this.simulated = false;
  }

  initChannels(channels) {
    for (const ch of channels) {
      if (!ch.enabled) continue;
      const pin = ch.gpio_pin;
      try {
        if (Gpio && !ch.simulated) {
          // Active-low: HIGH (1) = relay OFF, LOW (0) = relay ON
          this.relays[ch.channel] = new Gpio(pin, 'high');
        } else {
          this.relays[ch.channel] = new SimulatedGpio(pin);
          this.simulated = true;
        }
        this.states[ch.channel] = 'closed';

        // Sensor input (if configured)
        if (ch.sensor_gpio_pin) {
          try {
            const sensorPin = Gpio && !ch.simulated
              ? new Gpio(ch.sensor_gpio_pin, 'in', 'both', { debounceTimeout: 50 })
              : new SimulatedGpio(ch.sensor_gpio_pin);
            this.sensors[ch.channel] = sensorPin;
            this.sensorStates[ch.channel] = 'unknown';
          } catch (e) { console.error(`[GPIO] Sensor pin ${ch.sensor_gpio_pin} init failed:`, e.message); }
        }
      } catch (e) {
        console.error(`[GPIO] Channel ${ch.channel} pin ${pin} init failed:`, e.message);
        this.relays[ch.channel] = new SimulatedGpio(pin);
        this.simulated = true;
        this.states[ch.channel] = 'closed';
      }
    }
    console.log(`[GPIO] Initialized ${Object.keys(this.relays).length} channels${this.simulated ? ' (simulated)' : ''}`);
  }

  pulse(channel, durationMs = 5000) {
    const relay = this.relays[channel];
    if (!relay) throw new Error(`Channel ${channel} not found`);

    // Cancel any existing pulse timer
    if (this.timers[channel]) clearTimeout(this.timers[channel]);

    // Activate relay (active-low: 0 = ON)
    relay.writeSync(0);
    this.states[channel] = 'open';

    // Auto-off after duration
    this.timers[channel] = setTimeout(() => {
      relay.writeSync(1);
      this.states[channel] = 'closed';
      delete this.timers[channel];
      console.log(`[GPIO] Channel ${channel} pulse complete (${durationMs}ms)`);
    }, durationMs);

    console.log(`[GPIO] Channel ${channel} pulsed for ${durationMs}ms`);
    return { channel, state: 'open', duration_ms: durationMs };
  }

  setRelay(channel, state) {
    const relay = this.relays[channel];
    if (!relay) throw new Error(`Channel ${channel} not found`);

    if (this.timers[channel]) { clearTimeout(this.timers[channel]); delete this.timers[channel]; }

    if (state === 'open' || state === 'on') {
      relay.writeSync(0);
      this.states[channel] = 'open';
    } else {
      relay.writeSync(1);
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
    for (const [channel, sensor] of Object.entries(this.sensors)) {
      sensor.watch((err, value) => {
        if (err) return;
        const state = value === 1 ? 'open' : 'closed';
        this.sensorStates[channel] = state;
        callback(Number(channel), state);
      });
    }
  }

  cleanup() {
    for (const timer of Object.values(this.timers)) clearTimeout(timer);
    for (const gpio of Object.values(this.relays)) {
      try { gpio.writeSync(1); gpio.unexport(); } catch {}
    }
    for (const gpio of Object.values(this.sensors)) {
      try { gpio.unexport(); } catch {}
    }
    console.log('[GPIO] Cleaned up');
  }
}

module.exports = { GpioManager };
