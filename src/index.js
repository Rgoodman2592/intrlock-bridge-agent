#!/usr/bin/env node
const config = require('./config');
const { detectGpioPins, buildChannelConfig } = require('./detect');
const { GpioManager } = require('./gpio');
const { MqttClient } = require('./mqtt');
const { HealthReporter } = require('./health');
const { provision } = require('./provision');
const { startPeriodicCheck } = require('./updater');
const { CommandPoller } = require('./poller');
const { EinkDisplay } = require('./eink');
const { CameraManager } = require('./camera');
const { createDashboardServer } = require('./dashboard-server');

async function main() {
  console.log('===========================================');
  console.log('  Intrlock Bridge Agent v' + require('../package.json').version);
  console.log('===========================================');

  // Load or create config
  const cfg = config.load();
  cfg._configDir = config.CONFIG_DIR;
  console.log(`[MAIN] Device ID: ${cfg.device_id}`);
  console.log(`[MAIN] Serial: ${cfg.serial_number}`);

  // Auto-detect GPIO pins if no channels configured
  if (!cfg.channels || cfg.channels.length === 0) {
    const detected = detectGpioPins();
    cfg.channels = buildChannelConfig(detected.pins, detected.simulated);
    config.save(cfg);
    console.log(`[MAIN] Auto-configured ${cfg.channels.length} channels`);
  }

  // Initialize GPIO
  const gpio = new GpioManager();
  gpio.initChannels(cfg.channels);

  // Initialize e-ink display (non-fatal — disabled automatically if hardware absent)
  const eink = new EinkDisplay(cfg);
  await eink.init();

  // Initialize camera (non-fatal — disabled if no camera detected)
  // Note: mqtt not connected yet, pass null — we set it after mqtt.connect()
  const camera = new CameraManager(cfg, null);
  const camDetected = camera.detect();
  if (camDetected) {
    console.log(`[MAIN] Camera detected: ${camDetected.type} (${camDetected.device})`);
  }

  // Sensor change events
  gpio.onSensorChange((channel, state) => {
    console.log(`[SENSOR] Channel ${channel}: door ${state}`);
    mqtt.publish('event', {
      event_type: state === 'open' ? 'door_opened' : 'door_closed',
      channel,
      triggered_by: 'sensor',
      timestamp: Date.now(),
    });
  });

  // Attempt fleet provisioning
  await provision(cfg);

  // Connect MQTT
  const mqtt = new MqttClient(cfg);
  await mqtt.connect();

  // Give camera access to MQTT for event publishing
  camera.mqtt = mqtt;

  // Camera streams are now managed by the dashboard server via cameras.json + MediaMTX config.
  // CameraManager auto-start is disabled to avoid conflicts (double ffmpeg on /dev/video0).
  // CameraManager is still available for MQTT stream commands if needed.

  // Handle incoming commands
  mqtt.onCommand(async (data) => {
    console.log('[CMD] Received:', JSON.stringify(data));
    try {
      const ch = data.channel || 1;
      const channelCfg = cfg.channels.find(c => c.channel === ch);
      const mode = data.mode || channelCfg?.mode || 'momentary';
      const duration = data.duration_ms || channelCfg?.pulse_duration_ms || 5000;

      // E-ink display commands — handled before relay logic
      if (data.action === 'show_qr') {
        eink.showQR(data.url || '', data.text || '');
        mqtt.publish('event', {
          event_type: 'display_updated',
          display_action: 'show_qr',
          url: data.url,
          timestamp: Date.now(),
        });
        return;
      }
      if (data.action === 'clear_display') {
        eink.clear();
        mqtt.publish('event', {
          event_type: 'display_updated',
          display_action: 'clear',
          timestamp: Date.now(),
        });
        return;
      }
      if (data.action === 'show_status') {
        eink.showStatus(data.text || '');
        mqtt.publish('event', {
          event_type: 'display_updated',
          display_action: 'show_status',
          text: data.text,
          timestamp: Date.now(),
        });
        return;
      }

      // Camera commands
      if (data.action === 'stream_start') {
        const urls = await camera.start();
        mqtt.publish('event', {
          event_type: 'stream_started',
          stream_urls: urls,
          timestamp: Date.now(),
        });
        return;
      }
      if (data.action === 'stream_stop') {
        camera.stop();
        mqtt.publish('event', {
          event_type: 'stream_stopped',
          timestamp: Date.now(),
        });
        return;
      }
      if (data.action === 'stream_status') {
        const status = camera.getStatus();
        mqtt.publish('event', {
          event_type: 'stream_status',
          ...status,
          timestamp: Date.now(),
        });
        return;
      }

      let result;
      if (data.action === 'pulse' || (data.action === 'unlock' && mode === 'momentary')) {
        result = gpio.pulse(ch, duration);
      } else if (data.action === 'on' || data.action === 'open' || data.action === 'unlock') {
        result = gpio.setRelay(ch, 'open');
      } else if (data.action === 'off' || data.action === 'close' || data.action === 'lock') {
        result = gpio.setRelay(ch, 'closed');
      } else if (data.action === 'status') {
        result = gpio.getStates();
      } else if (data.action === 'config') {
        // Update channel config
        if (data.channels) {
          cfg.channels = data.channels;
          config.save(cfg);
          gpio.cleanup();
          gpio.initChannels(cfg.channels);
        }
        result = { configured: true };
      } else {
        result = { error: 'Unknown action: ' + data.action };
      }

      // Publish event
      mqtt.publish('event', {
        event_type: 'relay_triggered',
        channel: ch,
        action: data.action,
        triggered_by: data.triggered_by || 'cloud',
        user_id: data.user_id || null,
        duration_ms: duration,
        timestamp: Date.now(),
      });

      // Publish updated status
      mqtt.publish('status', {
        relay_states: gpio.getStates(),
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('[CMD] Error:', e.message);
      mqtt.publish('event', {
        event_type: 'command_error',
        error: e.message,
        command: data,
        timestamp: Date.now(),
      });
    }
  });

  // Start HTTP command polling (fallback when MQTT is unavailable)
  const poller = new CommandPoller(cfg.device_id, gpio, mqtt);
  poller.start(3000);

  // Start health reporting
  const health = new HealthReporter(mqtt, gpio, cfg, camera);
  health.start();

  // Start OTA update checker
  startPeriodicCheck(mqtt, cfg.update_check_interval_ms);

  console.log('[MAIN] Intrlock Bridge Agent running');

  // Start dashboard web server
  const dashboard = createDashboardServer(3000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[MAIN] Shutting down...');
    camera.cleanup();
    poller.stop();
    health.stop();
    gpio.cleanup();
    await mqtt.disconnect();
    dashboard.recording.cleanup();
    dashboard.server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
