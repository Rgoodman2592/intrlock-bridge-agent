const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const CERTS_DIR = path.join(config.CONFIG_DIR, 'certs');

function certsExist() {
  return fs.existsSync(path.join(CERTS_DIR, 'device.crt')) &&
         fs.existsSync(path.join(CERTS_DIR, 'device.key'));
}

function generateKeyPair() {
  console.log('[PROVISION] Generating RSA 2048 key pair...');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.mkdirSync(CERTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CERTS_DIR, 'device.key'), privateKey);
  fs.writeFileSync(path.join(CERTS_DIR, 'device.pub'), publicKey);
  console.log('[PROVISION] Key pair generated');
  return { publicKey, privateKey };
}

async function provision(cfg) {
  if (certsExist()) {
    console.log('[PROVISION] Device already provisioned');
    return true;
  }

  console.log('[PROVISION] Starting fleet provisioning...');
  console.log(`[PROVISION] Serial: ${cfg.serial_number}`);
  console.log(`[PROVISION] Device ID: ${cfg.device_id}`);

  const claimCertPath = path.join(CERTS_DIR, 'claim.crt');
  const claimKeyPath = path.join(CERTS_DIR, 'claim.key');

  if (!fs.existsSync(claimCertPath) || !fs.existsSync(claimKeyPath)) {
    console.log('[PROVISION] No claim certificate found — device needs manual provisioning');
    console.log('[PROVISION] Place claim.crt and claim.key in', CERTS_DIR);
    console.log('[PROVISION] Running in offline/test mode until provisioned');
    return false;
  }

  try {
    generateKeyPair();

    // Fleet provisioning happens via MQTT using the claim cert
    // The full implementation requires connecting with claim cert,
    // publishing to $aws/provisioning-templates/intrlock-bridge-provision/provision/json
    // and receiving the signed device cert in response
    const { mqtt, iot } = require('aws-iot-device-sdk-v2');

    const caPath = path.join(CERTS_DIR, 'AmazonRootCA1.pem');
    const configBuilder = iot.AwsIotMqttConnectionConfigBuilder
      .new_mtls_builder(claimCertPath, claimKeyPath)
      .with_certificate_authority(caPath)
      .with_endpoint(cfg.mqtt_endpoint)
      .with_client_id(`provision-${cfg.device_id}`)
      .with_clean_session(true);

    const mqttConfig = configBuilder.build();
    const client = new mqtt.MqttClient();
    const connection = client.new_connection(mqttConfig);

    await connection.connect();
    console.log('[PROVISION] Connected with claim cert');

    // Subscribe to provisioning response topics
    const responseTopic = `$aws/provisioning-templates/intrlock-bridge-provision/provision/json/accepted`;
    const rejectTopic = `$aws/provisioning-templates/intrlock-bridge-provision/provision/json/rejected`;

    const result = await new Promise((resolve, reject) => {
      connection.subscribe(responseTopic, mqtt.QoS.AtLeastOnce);
      connection.subscribe(rejectTopic, mqtt.QoS.AtLeastOnce);

      connection.on('message', (topic, payload) => {
        const data = JSON.parse(payload.toString());
        if (topic.includes('accepted')) resolve(data);
        else reject(new Error(data.errorMessage || 'Provisioning rejected'));
      });

      // Publish provisioning request
      connection.publish(
        `$aws/provisioning-templates/intrlock-bridge-provision/provision/json`,
        JSON.stringify({
          serialNumber: cfg.serial_number,
          deviceId: cfg.device_id,
        }),
        mqtt.QoS.AtLeastOnce,
      );

      setTimeout(() => reject(new Error('Provisioning timeout')), 30000);
    });

    // Save returned device certificate
    if (result.deviceCertificate) {
      fs.writeFileSync(path.join(CERTS_DIR, 'device.crt'), result.deviceCertificate);
      console.log('[PROVISION] Device certificate saved');
    }

    await connection.disconnect();
    console.log('[PROVISION] Provisioning complete');
    return true;
  } catch (e) {
    console.error('[PROVISION] Failed:', e.message);
    console.log('[PROVISION] Running in offline/test mode');
    return false;
  }
}

module.exports = { provision, certsExist, CERTS_DIR };
