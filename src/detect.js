const fs = require('fs');

// Common relay board GPIO pin patterns
// Try 8-channel patterns first, then fall back to 4-channel
const PIN_PATTERNS = [
  [17, 27, 22, 23, 5, 6, 13, 19],  // Inland MC509703 8-channel
  [17, 27, 22, 23],                  // Inland 350892 4-channel
  [5, 6, 13, 19],                    // Alternative 4-channel
  [4, 17, 27, 22],                   // Another 4-channel layout
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

  // Fallback to default pattern
  console.log('[DETECT] Using default pin pattern: 17, 27, 22, 23');
  return { pins: [17, 27, 22, 23], simulated: false };
}

function buildChannelConfig(pins, simulated) {
  return pins.map((pin, i) => ({
    channel: i + 1,
    gpio_pin: pin,
    name: `Channel ${i + 1}`,
    type: 'door_strike',
    mode: 'momentary',
    pulse_duration_ms: 5000,
    enabled: true,
    sensor_gpio_pin: null,
    tamper_gpio_pin: null,
    simulated,
  }));
}

module.exports = { detectGpioPins, buildChannelConfig, isRaspberryPi };
