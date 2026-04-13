const fs = require('fs');

// Common relay board GPIO pin patterns
// Try 8-channel patterns first, then fall back to 4-channel
const PIN_PATTERNS = [
  [17, 27, 22, 23, 5, 6, 13, 19],  // Inland MC509703 8-channel (active-low)
  [4, 22, 6, 26],                    // Inland MC350892 4-channel stackable (active-high)
  [17, 27, 22, 23],                  // Generic 4-channel (active-low)
  [5, 6, 13, 19],                    // Alternative 4-channel
];

function isRaspberryPi() {
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    return /raspberry|bcm2/i.test(cpuinfo);
  } catch { return false; }
}

function detectGpioPins() {
  if (!isRaspberryPi()) {
    console.log('[DETECT] Not running on Raspberry Pi — using simulated GPIO');
    return { pins: [17, 27, 22, 23], simulated: true };
  }

  // Check which GPIO pins are available by testing export
  for (const pattern of PIN_PATTERNS) {
    let allValid = true;
    for (const pin of pattern) {
      try {
        // Check if GPIO pin exists in sysfs
        if (!fs.existsSync(`/sys/class/gpio/gpio${pin}`) && fs.existsSync('/sys/class/gpio/export')) {
          fs.writeFileSync('/sys/class/gpio/export', String(pin));
          fs.writeFileSync(`/sys/class/gpio/gpio${pin}/direction`, 'out');
          // Clean up — unexport
          fs.writeFileSync('/sys/class/gpio/unexport', String(pin));
        }
      } catch {
        allValid = false;
        break;
      }
    }
    if (allValid) {
      console.log(`[DETECT] Found relay pins: ${pattern.join(', ')}`);
      return { pins: pattern, simulated: false };
    }
  }

  // Fallback to MC350892 stackable (confirmed working)
  console.log('[DETECT] Using default pin pattern: 4, 22, 6, 26 (MC350892)');
  return { pins: [4, 22, 6, 26], simulated: false };
}

// Known board configs: pins -> active_high setting
const BOARD_CONFIGS = {
  '4,22,6,26': { active_high: true, name: 'Inland MC350892 Stackable' },
  '17,27,22,23,5,6,13,19': { active_high: false, name: 'Inland MC509703 8-Channel' },
  '17,27,22,23': { active_high: false, name: 'Generic 4-Channel' },
};

function buildChannelConfig(pins, simulated) {
  const key = pins.join(',');
  const board = BOARD_CONFIGS[key] || { active_high: true, name: 'Unknown Board' };
  console.log(`[DETECT] Board: ${board.name} (active_high=${board.active_high})`);
  const relayNames = { 0: 'J2', 1: 'J3', 2: 'J4', 3: 'J5', 4: 'J6', 5: 'J7', 6: 'J8', 7: 'J9' };
  return pins.map((pin, i) => ({
    channel: i + 1,
    gpio_pin: pin,
    name: relayNames[i] || `Channel ${i + 1}`,
    type: 'door_strike',
    mode: 'momentary',
    pulse_duration_ms: 5000,
    active_high: board.active_high,
    enabled: true,
    sensor_gpio_pin: null,
    tamper_gpio_pin: null,
    simulated,
  }));
}

module.exports = { detectGpioPins, buildChannelConfig, isRaspberryPi };
