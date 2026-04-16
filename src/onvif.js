const { execSync } = require('child_process');
const http = require('http');
const dgram = require('dgram');

/**
 * ONVIF Camera Discovery — finds IP cameras on the local network
 * Uses WS-Discovery (SOAP over UDP multicast) to find ONVIF devices
 */
class OnvifDiscovery {
  constructor() {
    this.discovered = new Map(); // ip -> camera info
  }

  /**
   * Send WS-Discovery probe and collect responses
   * @returns {Promise<Array>} Array of discovered cameras
   */
  async discover(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const results = [];
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      // WS-Discovery probe message for ONVIF devices
      const probe = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
               xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
               xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <soap:Header>
    <wsa:MessageID>uuid:${crypto.randomUUID ? crypto.randomUUID() : Date.now()}</wsa:MessageID>
    <wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
  </soap:Header>
  <soap:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </soap:Body>
</soap:Envelope>`;

      socket.on('message', (msg, rinfo) => {
        const xml = msg.toString();
        const xAddrs = xml.match(/<[^:]*XAddrs[^>]*>([^<]+)<\//);
        const scopes = xml.match(/<[^:]*Scopes[^>]*>([^<]+)<\//);

        if (xAddrs) {
          const serviceUrl = xAddrs[1].trim().split(' ')[0];
          const camera = {
            ip: rinfo.address,
            port: rinfo.port,
            serviceUrl,
            scopes: scopes ? scopes[1].trim().split(' ') : [],
            manufacturer: '',
            model: '',
            name: '',
          };

          // Parse scopes for manufacturer/model info
          for (const scope of camera.scopes) {
            if (scope.includes('onvif://www.onvif.org/name/')) {
              camera.name = decodeURIComponent(scope.split('/name/')[1] || '');
            }
            if (scope.includes('onvif://www.onvif.org/hardware/')) {
              camera.model = decodeURIComponent(scope.split('/hardware/')[1] || '');
            }
            if (scope.includes('onvif://www.onvif.org/manufacturer/')) {
              camera.manufacturer = decodeURIComponent(scope.split('/manufacturer/')[1] || '');
            }
          }

          if (!camera.name) camera.name = `${camera.manufacturer} ${camera.model}`.trim() || `Camera at ${camera.ip}`;

          // Deduplicate by IP
          if (!this.discovered.has(camera.ip)) {
            this.discovered.set(camera.ip, camera);
            results.push(camera);
            console.log(`[ONVIF] Discovered: ${camera.name} (${camera.ip}) — ${camera.manufacturer} ${camera.model}`);
          }
        }
      });

      socket.on('error', (err) => {
        console.error('[ONVIF] Socket error:', err.message);
      });

      socket.bind(() => {
        socket.setBroadcast(true);
        socket.addMembership('239.255.255.250');

        const buf = Buffer.from(probe);
        socket.send(buf, 0, buf.length, 3702, '239.255.255.250', (err) => {
          if (err) console.error('[ONVIF] Send error:', err.message);
          else console.log('[ONVIF] Discovery probe sent');
        });
      });

      setTimeout(() => {
        socket.close();
        console.log(`[ONVIF] Discovery complete: ${results.length} cameras found`);
        resolve(results);
      }, timeoutMs);
    });
  }

  /**
   * Get RTSP stream URL from an ONVIF camera
   * Uses the camera's ONVIF service to get media profiles and stream URIs
   */
  async getStreamUrl(serviceUrl, username = '', password = '') {
    try {
      // Get media profiles
      const profilesXml = await this._soapRequest(serviceUrl.replace('/onvif/device_service', '/onvif/media'), `
        <GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>
      `, username, password);

      const profileToken = profilesXml.match(/token="([^"]+)"/)?.[1];
      if (!profileToken) return null;

      // Get stream URI for the first profile
      const streamXml = await this._soapRequest(serviceUrl.replace('/onvif/device_service', '/onvif/media'), `
        <GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">
          <StreamSetup>
            <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
            <Transport xmlns="http://www.onvif.org/ver10/schema">
              <Protocol>RTSP</Protocol>
            </Transport>
          </StreamSetup>
          <ProfileToken>${profileToken}</ProfileToken>
        </GetStreamUri>
      `, username, password);

      const uri = streamXml.match(/<[^:]*Uri[^>]*>([^<]+)<\//)?.[1];
      return uri || null;
    } catch (e) {
      console.error(`[ONVIF] Failed to get stream URL from ${serviceUrl}:`, e.message);
      return null;
    }
  }

  async _soapRequest(url, body, username = '', password = '') {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(soapEnvelope),
        },
        timeout: 10000,
      };

      if (username) {
        options.headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(soapEnvelope);
      req.end();
    });
  }

  /**
   * Quick network scan for cameras using common RTSP ports
   * Fallback when ONVIF discovery doesn't find cameras
   */
  async scanNetwork(subnet = null) {
    if (!subnet) {
      // Auto-detect subnet from local IP
      try {
        const ip = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
        subnet = ip.replace(/\.\d+$/, '');
      } catch {
        subnet = '192.168.1';
      }
    }

    console.log(`[ONVIF] Scanning ${subnet}.0/24 for RTSP cameras...`);
    const cameras = [];

    // Quick ping sweep + RTSP port check
    const checkPromises = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      checkPromises.push(this._checkRtspPort(ip, 554).then(open => {
        if (open) {
          cameras.push({ ip, port: 554, rtsp_url: `rtsp://${ip}:554/stream1` });
          console.log(`[ONVIF] Found RTSP service at ${ip}:554`);
        }
      }));
    }

    await Promise.all(checkPromises);
    console.log(`[ONVIF] Network scan complete: ${cameras.length} RTSP services found`);
    return cameras;
  }

  _checkRtspPort(ip, port) {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, ip);
    });
  }

  getDiscovered() {
    return Array.from(this.discovered.values());
  }
}

module.exports = { OnvifDiscovery };
