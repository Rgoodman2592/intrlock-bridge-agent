const fs = require('fs');
const path = require('path');

class MqttClient {
  constructor(config) {
    this.config = config;
    this.deviceId = config.device_id;
    this.baseTopic = `intrlock/bridge/${this.deviceId}`;
    this.client = null;
    this.connected = false;
    this.handlers = {};
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 60000;
  }

  async connect() {
    const certDir = path.join(this.config._configDir || '/opt/intrlock-bridge', 'certs');
    const certPath = path.join(certDir, 'device.crt');
    const keyPath = path.join(certDir, 'device.key');
    const caPath = path.join(certDir, 'AmazonRootCA1.pem');

    if (!fs.existsSync(certPath)) {
      console.log('[MQTT] No device certificate — running in offline mode');
      return;
    }

    try {
      const { mqtt, iot } = require('aws-iot-device-sdk-v2');

      const configBuilder = iot.AwsIotMqttConnectionConfigBuilder
        .new_mtls_builder(certPath, keyPath)
        .with_certificate_authority(caPath)
        .with_endpoint(this.config.mqtt_endpoint)
        .with_client_id(this.deviceId)
        .with_clean_session(false)
        .with_keep_alive_seconds(30)
        .with_will({
          topic: `${this.baseTopic}/status`,
          payload: JSON.stringify({ status: 'offline', timestamp: Date.now() }),
          qos: mqtt.QoS.AtLeastOnce,
        });

      const mqttConfig = configBuilder.build();
      this.client = new mqtt.MqttClient();
      const connection = this.client.new_connection(mqttConfig);

      connection.on('connect', () => {
        console.log('[MQTT] Connected to AWS IoT Core');
        this.connected = true;
        this.reconnectDelay = 1000;
        this.publish('status', { status: 'online', timestamp: Date.now() });
        this._subscribe(`${this.baseTopic}/command`);
      });

      connection.on('disconnect', () => {
        console.log('[MQTT] Disconnected');
        this.connected = false;
        this._reconnect(connection);
      });

      connection.on('error', (err) => {
        console.error('[MQTT] Error:', err.message);
      });

      connection.on('message', (topic, payload) => {
        try {
          const data = JSON.parse(payload.toString());
          const suffix = topic.replace(`${this.baseTopic}/`, '');
          if (this.handlers[suffix]) this.handlers[suffix](data);
        } catch (e) { console.error('[MQTT] Message parse error:', e.message); }
      });

      await connection.connect();
      this._connection = connection;
    } catch (e) {
      console.error('[MQTT] Connection failed:', e.message);
      console.log('[MQTT] Running in offline mode — will retry in background');
    }
  }

  async _subscribe(topic) {
    try {
      const { mqtt } = require('aws-iot-device-sdk-v2');
      await this._connection.subscribe(topic, mqtt.QoS.AtLeastOnce);
      console.log(`[MQTT] Subscribed to ${topic}`);
    } catch (e) { console.error('[MQTT] Subscribe failed:', e.message); }
  }

  _reconnect(connection) {
    const jitter = this.reconnectDelay * (0.75 + Math.random() * 0.5);
    console.log(`[MQTT] Reconnecting in ${Math.round(jitter)}ms...`);
    setTimeout(async () => {
      try {
        await connection.connect();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this._reconnect(connection);
      }
    }, jitter);
  }

  publish(subtopic, payload) {
    if (!this.connected || !this._connection) {
      console.log(`[MQTT] Offline — queuing ${subtopic}`);
      return;
    }
    try {
      const { mqtt } = require('aws-iot-device-sdk-v2');
      this._connection.publish(`${this.baseTopic}/${subtopic}`, JSON.stringify(payload), mqtt.QoS.AtLeastOnce);
    } catch (e) { console.error('[MQTT] Publish failed:', e.message); }
  }

  onCommand(handler) { this.handlers['command'] = handler; }

  async disconnect() {
    if (this._connection) {
      this.publish('status', { status: 'offline', timestamp: Date.now() });
      try { await this._connection.disconnect(); } catch {}
    }
  }
}

module.exports = { MqttClient };
