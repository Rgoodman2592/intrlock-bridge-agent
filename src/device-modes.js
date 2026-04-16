/**
 * Device Mode Configuration
 *
 * Each Bridge hardware product runs the same base agent software
 * but with different modules enabled based on device_type.
 *
 * Device type is set during first boot via:
 * 1. Hardware detection (display attached? camera? relays?)
 * 2. Config file (/opt/intrlock-bridge/config.json → device_type)
 * 3. Command line arg (--device-type=panel)
 *
 * This file defines which modules to start for each device type.
 */

const DEVICE_MODES = {
  // ── Bridge Relay (existing product) ──
  relay: {
    label: 'Bridge Relay',
    description: 'Relay controller for door strikes and gates',
    modules: {
      gpio: true,          // Relay control
      camera: false,       // No camera
      display: false,      // No display
      audio: false,        // No audio
      onvif: false,        // No camera discovery
      motion: false,       // No motion detection
      kiosk: false,        // No kiosk UI
      face: false,         // No face recognition
    },
    hardware: {
      requires_gpio: true,
      requires_display: false,
      requires_camera: false,
      requires_audio: false,
    },
  },

  // ── Bridge Intercom Panel ──
  panel: {
    label: 'Bridge Intercom Panel',
    description: 'Touchscreen intercom with video calls and facial recognition',
    modules: {
      gpio: true,          // Single relay for door strike
      camera: true,        // Pi AI Camera for face recognition
      display: true,       // Touch Display 2 in kiosk mode
      audio: true,         // I2S speaker + microphone for calls
      onvif: false,        // Not a camera aggregator
      motion: false,       // Not needed — face detection handles this
      kiosk: true,         // Chromium kiosk mode
      face: true,          // Face detection + recognition
    },
    hardware: {
      requires_gpio: true,
      requires_display: true,
      requires_camera: true,
      requires_audio: true,
    },
    kiosk: {
      url_template: 'https://visitors.intrlock.io/{property_uuid}',
      fullscreen: true,
      hide_cursor: true,
      disable_context_menu: true,
      auto_restart_on_crash: true,
    },
  },

  // ── Bridge Camera Hub ──
  hub: {
    label: 'Bridge Camera Hub',
    description: 'Camera aggregator for IP cameras, NVRs, and analog feeds',
    modules: {
      gpio: false,         // No relays
      camera: true,        // MediaMTX for streaming
      display: false,      // Headless
      audio: false,        // No audio
      onvif: true,         // ONVIF camera discovery
      motion: true,        // Motion detection on streams
      kiosk: false,        // No UI
      face: false,         // No face recognition (unless AI camera attached)
    },
    hardware: {
      requires_gpio: false,
      requires_display: false,
      requires_camera: false, // External cameras, not onboard
      requires_audio: false,
    },
    camera: {
      max_streams: 12,
      default_resolution: '720p',
      recording_dir: '/var/intrlock/recordings',
      snapshot_dir: '/var/intrlock/snapshots',
    },
  },

  // ── Bridge Doorbell ──
  doorbell: {
    label: 'Bridge Doorbell',
    description: 'Audio doorbell with camera and face recognition',
    modules: {
      gpio: true,          // Single relay for door + button input
      camera: true,        // Pi Camera for face recognition
      display: false,      // No display — audio only
      audio: true,         // Speaker + microphone
      onvif: false,        // Not a camera aggregator
      motion: true,        // Motion detection triggers face scan
      kiosk: false,        // No kiosk UI
      face: true,          // Face recognition
    },
    hardware: {
      requires_gpio: true,
      requires_display: false,
      requires_camera: true,
      requires_audio: true,
    },
    doorbell: {
      button_gpio: 24,        // GPIO pin for doorbell button
      led_gpio: 18,           // GPIO pin for LED ring (PWM)
      led_count: 12,          // Number of LEDs in ring
      tts_engine: 'piper',    // Text-to-speech engine
      ring_sound: '/opt/intrlock-bridge/sounds/doorbell.wav',
      face_scan_timeout_ms: 3000,
      call_timeout_ms: 30000,
    },
  },

  // ── Bridge Camera (ESP32-CAM — separate firmware, not Pi) ──
  camera: {
    label: 'Bridge Camera',
    description: 'ESP32-CAM module (separate firmware)',
    modules: {
      gpio: false,
      camera: true,
      display: false,
      audio: false,
      onvif: false,
      motion: false,
      kiosk: false,
      face: false,
    },
    hardware: {
      requires_gpio: false,
      requires_display: false,
      requires_camera: true,
      requires_audio: false,
    },
    note: 'ESP32-CAM runs its own firmware (intrlock-bridge-cam repo). This config is for reference only.',
  },
};

/**
 * Auto-detect device type from attached hardware
 */
function autoDetectDeviceType() {
  const fs = require('fs');
  const { execSync } = require('child_process');

  let hasDisplay = false;
  let hasCamera = false;
  let hasGpio = false;
  let hasAudio = false;

  // Check for display
  try {
    hasDisplay = fs.existsSync('/dev/fb0') || fs.existsSync('/dev/dri/card0');
    // Check for touchscreen specifically
    const inputs = execSync('cat /proc/bus/input/devices 2>/dev/null', { encoding: 'utf8' });
    if (inputs.includes('FT5406') || inputs.includes('raspberrypi-ts') || inputs.includes('Touch')) {
      hasDisplay = true;
    }
  } catch {}

  // Check for camera
  try {
    execSync('libcamera-hello --list-cameras 2>&1', { timeout: 5000 });
    hasCamera = true;
  } catch {}
  if (!hasCamera) {
    try {
      hasCamera = fs.existsSync('/dev/video0');
    } catch {}
  }

  // Check for GPIO (relay board)
  try {
    hasGpio = fs.existsSync('/sys/class/gpio/export');
  } catch {}

  // Check for audio devices
  try {
    const aplay = execSync('aplay -l 2>/dev/null', { encoding: 'utf8' });
    hasAudio = aplay.includes('card');
  } catch {}

  console.log(`[DETECT] Hardware: display=${hasDisplay} camera=${hasCamera} gpio=${hasGpio} audio=${hasAudio}`);

  // Determine device type based on what's attached
  if (hasDisplay && hasCamera && hasAudio) return 'panel';
  if (hasCamera && hasAudio && !hasDisplay) return 'doorbell';
  if (!hasCamera && !hasDisplay && hasGpio) return 'relay';
  if (hasCamera && !hasDisplay && !hasAudio) return 'hub';

  // Default to relay (most common)
  return 'relay';
}

/**
 * Get the configuration for a device type
 */
function getDeviceMode(deviceType) {
  return DEVICE_MODES[deviceType] || DEVICE_MODES.relay;
}

module.exports = { DEVICE_MODES, autoDetectDeviceType, getDeviceMode };
