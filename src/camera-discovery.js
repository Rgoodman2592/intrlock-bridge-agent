/**
 * Camera Auto-Discovery — finds, configures, and streams IP cameras automatically.
 *
 * Flow:
 *   1. Scan eth0 for cameras via ARP broadcast + tcpdump for link-local devices
 *   2. Try ONVIF discovery + common RTSP URL patterns
 *   3. Assign static IP on camera subnet (192.168.1.x)
 *   4. Update MediaMTX config to proxy the stream
 *   5. Persist camera list to config.json
 */
const { execSync, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const CAMERA_SUBNET = '192.168.1';
const BRIDGE_IP = `${CAMERA_SUBNET}.50`;
const CAMERA_IFACE = 'eth0';
const MEDIAMTX_CONFIG = '/tmp/mediamtx.yml';
const MEDIAMTX_BIN = '/opt/mediamtx/mediamtx';

// Common default credentials for IP cameras
const DEFAULT_CREDS = [
  { user: 'admin', pass: '123456' },
  { user: 'admin', pass: 'admin' },
  { user: 'admin', pass: '' },
  { user: 'admin', pass: 'admin123' },
  { user: 'admin', pass: '12345' },
  { user: 'root', pass: 'root' },
  { user: 'admin', pass: 'password' },
];

// Common RTSP URL patterns by manufacturer
const RTSP_PATHS = [
  '/',                                           // Dahua/InViD default
  '/cam/realmonitor?channel=1&subtype=0',        // Dahua main stream
  '/cam/realmonitor?channel=1&subtype=1',        // Dahua sub stream
  '/Streaming/Channels/101',                     // Hikvision main
  '/Streaming/Channels/102',                     // Hikvision sub
  '/stream1',                                    // Generic
  '/live',                                       // Generic
  '/h264Preview_01_main',                        // Amcrest
  '/live/ch00_1',                                // Uniview
];

class CameraDiscovery {
  constructor(config) {
    this.config = config;
    this.cameras = config.cameras || [];
    this.nextIp = this._getNextIp();
    this.mediamtxProc = null;
  }

  /**
   * Run full discovery: scan network, find cameras, get RTSP URLs, start streaming
   */
  async discover() {
    console.log('[DISCOVERY] Starting camera auto-discovery...');

    // Ensure eth0 is configured for camera subnet
    this._setupInterface();

    // Phase 1: Find devices via multiple methods
    const found = new Map(); // ip -> { ip, mac, rtspUrl, name, creds }

    // 1a. Check for link-local devices (uninitialized cameras)
    console.log('[DISCOVERY] Phase 1a: Checking for link-local cameras...');
    const linkLocal = await this._findLinkLocal();
    for (const dev of linkLocal) {
      found.set(dev.ip, dev);
    }

    // 1b. ARP scan camera subnet
    console.log('[DISCOVERY] Phase 1b: Scanning camera subnet...');
    const subnetDevices = await this._arpScan(CAMERA_SUBNET);
    for (const dev of subnetDevices) {
      if (dev.ip !== BRIDGE_IP) found.set(dev.ip, dev);
    }

    // 1c. ONVIF WS-Discovery
    console.log('[DISCOVERY] Phase 1c: ONVIF discovery...');
    const onvifDevices = await this._onvifDiscover();
    for (const dev of onvifDevices) {
      if (!found.has(dev.ip)) found.set(dev.ip, dev);
    }

    // 1d. Check known camera IPs from config
    for (const cam of this.cameras) {
      if (cam.ip && !found.has(cam.ip)) {
        const alive = await this._ping(cam.ip);
        if (alive) found.set(cam.ip, { ip: cam.ip, mac: cam.mac || '', name: cam.name || '' });
      }
    }

    console.log(`[DISCOVERY] Found ${found.size} device(s)`);
    if (found.size === 0) return [];

    // Phase 2: For each device, find working RTSP URL
    console.log('[DISCOVERY] Phase 2: Probing RTSP streams...');
    const cameras = [];
    for (const [ip, dev] of found) {
      console.log(`[DISCOVERY] Probing ${ip}...`);
      const cam = await this._probeCamera(ip, dev);
      if (cam) {
        cameras.push(cam);
        console.log(`[DISCOVERY] ✓ ${cam.name} at ${cam.ip} → ${cam.rtspUrl}`);
      } else {
        console.log(`[DISCOVERY] ✗ ${ip} — no RTSP stream found`);
      }
    }

    // Phase 3: Assign static IPs to link-local cameras
    for (const cam of cameras) {
      if (cam.ip.startsWith('169.254.')) {
        const newIp = this._assignIp();
        console.log(`[DISCOVERY] Assigning ${cam.ip} → ${newIp}`);
        const changed = await this._setCameraIp(cam, newIp);
        if (changed) {
          cam.rtspUrl = cam.rtspUrl.replace(cam.ip, newIp);
          cam.ip = newIp;
        }
      }
    }

    // Phase 4: Save and start streaming
    this.cameras = cameras;
    this._saveConfig();
    this._updateMediaMTX();

    console.log(`[DISCOVERY] Complete: ${cameras.length} camera(s) configured`);
    return cameras;
  }

  /**
   * Quick scan — just check known cameras are still alive + find new ones
   */
  async refresh() {
    console.log('[DISCOVERY] Refreshing camera list...');
    const alive = [];
    for (const cam of this.cameras) {
      if (await this._ping(cam.ip)) {
        alive.push(cam);
      } else {
        console.log(`[DISCOVERY] Camera ${cam.name} (${cam.ip}) offline`);
      }
    }
    this.cameras = alive;

    // Quick scan for new devices
    const newDevices = await this._arpScan(CAMERA_SUBNET);
    for (const dev of newDevices) {
      if (dev.ip === BRIDGE_IP) continue;
      if (this.cameras.find(c => c.ip === dev.ip)) continue;
      console.log(`[DISCOVERY] New device at ${dev.ip}, probing...`);
      const cam = await this._probeCamera(dev.ip, dev);
      if (cam) {
        this.cameras.push(cam);
        console.log(`[DISCOVERY] ✓ New camera: ${cam.name} at ${cam.ip}`);
      }
    }

    this._saveConfig();
    this._updateMediaMTX();
    return this.cameras;
  }

  /**
   * Add a camera manually by IP
   */
  async addCamera(ip, username, password) {
    console.log(`[DISCOVERY] Adding camera at ${ip}...`);
    const dev = { ip, mac: '' };
    const cam = await this._probeCamera(ip, dev, username, password);
    if (cam) {
      // Remove existing camera with same IP
      this.cameras = this.cameras.filter(c => c.ip !== ip);
      this.cameras.push(cam);
      this._saveConfig();
      this._updateMediaMTX();
      console.log(`[DISCOVERY] ✓ Added: ${cam.name}`);
      return cam;
    }
    return null;
  }

  /**
   * Remove a camera by IP or name
   */
  removeCamera(ipOrName) {
    const before = this.cameras.length;
    this.cameras = this.cameras.filter(c => c.ip !== ipOrName && c.name !== ipOrName);
    if (this.cameras.length < before) {
      this._saveConfig();
      this._updateMediaMTX();
      console.log(`[DISCOVERY] Removed camera: ${ipOrName}`);
      return true;
    }
    return false;
  }

  /**
   * Get list of configured cameras
   */
  getCameras() {
    return this.cameras.map(c => ({
      name: c.name,
      ip: c.ip,
      mac: c.mac,
      streamId: c.streamId,
      rtspUrl: c.rtspUrl ? c.rtspUrl.replace(/\/\/[^@]+@/, '//***:***@') : null, // hide creds
      status: 'configured',
    }));
  }

  // ── Internal methods ──────────────────────────────────────────────

  _setupInterface() {
    try {
      // Add camera subnet IP to eth0 if not already set
      const addrs = execSync(`ip addr show ${CAMERA_IFACE} 2>/dev/null`, { encoding: 'utf8' });
      if (!addrs.includes(BRIDGE_IP)) {
        execSync(`sudo ip addr add ${BRIDGE_IP}/24 dev ${CAMERA_IFACE} 2>/dev/null`);
        execSync(`sudo ip link set ${CAMERA_IFACE} up`);
        console.log(`[DISCOVERY] Set ${CAMERA_IFACE} to ${BRIDGE_IP}`);
      }
      // Also add link-local range for uninitialized cameras
      if (!addrs.includes('169.254.')) {
        execSync(`sudo ip addr add 169.254.1.1/16 dev ${CAMERA_IFACE} 2>/dev/null`);
      }
      // Make sure default route stays on WiFi
      try {
        execSync(`sudo ip route del default dev ${CAMERA_IFACE} 2>/dev/null`);
      } catch (e) { /* no default route on eth0, good */ }
    } catch (e) {
      console.error('[DISCOVERY] Interface setup error:', e.message);
    }
  }

  async _findLinkLocal() {
    return new Promise((resolve) => {
      const devices = [];
      try {
        const proc = spawn('sudo', ['timeout', '5', 'tcpdump', '-i', CAMERA_IFACE, '-n', '-c', '50', 'arp'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.stderr.on('data', d => output += d.toString());
        proc.on('close', () => {
          // Parse ARP requests for 169.254.x.x addresses
          const matches = output.matchAll(/who-has\s+(169\.254\.\d+\.\d+)/g);
          const seen = new Set();
          for (const m of matches) {
            const ip = m[1];
            if (!seen.has(ip)) {
              seen.add(ip);
              devices.push({ ip, mac: '', name: '' });
            }
          }
          // Also check ARP replies
          const replies = output.matchAll(/(169\.254\.\d+\.\d+)\s+is-at\s+([0-9a-f:]+)/gi);
          for (const m of replies) {
            if (!seen.has(m[1])) {
              seen.add(m[1]);
              devices.push({ ip: m[1], mac: m[2], name: '' });
            }
          }
          resolve(devices);
        });
      } catch (e) {
        resolve(devices);
      }
    });
  }

  async _arpScan(subnet) {
    try {
      const output = execSync(
        `sudo arp-scan -I ${CAMERA_IFACE} ${subnet}.0/24 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      );
      const devices = [];
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]+)\s+(.*)$/i);
        if (match) {
          devices.push({ ip: match[1], mac: match[2], name: match[3].trim() });
        }
      }
      return devices;
    } catch (e) {
      return [];
    }
  }

  async _onvifDiscover() {
    return new Promise((resolve) => {
      const results = [];
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const probe = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
               xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
               xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <soap:Header>
    <wsa:MessageID>uuid:${Date.now()}</wsa:MessageID>
    <wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
  </soap:Header>
  <soap:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </soap:Body>
</soap:Envelope>`;

      socket.on('message', (msg, rinfo) => {
        const xml = msg.toString();
        const xAddrs = xml.match(/<[^:]*XAddrs[^>]*>([^<]+)<\//);
        if (xAddrs) {
          results.push({
            ip: rinfo.address,
            mac: '',
            name: '',
            serviceUrl: xAddrs[1].trim().split(' ')[0],
          });
        }
      });

      socket.on('error', () => {});
      socket.bind(() => {
        try {
          socket.setBroadcast(true);
          socket.addMembership('239.255.255.250');
          const buf = Buffer.from(probe);
          socket.send(buf, 0, buf.length, 3702, '239.255.255.250');
        } catch (e) { /* ignore */ }
      });

      setTimeout(() => { socket.close(); resolve(results); }, 3000);
    });
  }

  async _probeCamera(ip, dev, forceUser, forcePass) {
    // Check if RTSP port is open
    const rtspOpen = await this._checkPort(ip, 554);
    if (!rtspOpen) return null;

    // Try credentials
    const credsToTry = forceUser
      ? [{ user: forceUser, pass: forcePass || '' }]
      : DEFAULT_CREDS;

    for (const creds of credsToTry) {
      for (const rtspPath of RTSP_PATHS) {
        const url = `rtsp://${creds.user}:${creds.pass}@${ip}:554${rtspPath}`;
        const works = await this._testRtsp(url);
        if (works) {
          const camNum = this.cameras.length + 1;
          const streamId = `cam${camNum}`;
          return {
            name: dev.name || `Camera ${camNum}`,
            ip,
            mac: dev.mac || '',
            rtspUrl: url,
            username: creds.user,
            password: creds.pass,
            rtspPath,
            streamId,
            discoveredAt: new Date().toISOString(),
          };
        }
      }
    }
    return null;
  }

  async _testRtsp(url) {
    try {
      execSync(
        `timeout 5 ffprobe -v quiet -print_format json -show_streams "${url}" 2>&1`,
        { encoding: 'utf8', timeout: 8000 }
      );
      // If ffprobe returns without error and has stream data, it works
      const result = execSync(
        `timeout 5 ffprobe -v quiet -print_format json -show_streams "${url}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 8000 }
      );
      const parsed = JSON.parse(result);
      return parsed.streams && parsed.streams.length > 0;
    } catch (e) {
      return false;
    }
  }

  _checkPort(ip, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, ip);
    });
  }

  _ping(ip) {
    try {
      execSync(`ping -c 1 -W 1 ${ip} 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  async _setCameraIp(cam, newIp) {
    // Try Dahua API to set static IP
    try {
      const body = `table.Network.eth0.IPAddress=${newIp}&table.Network.eth0.SubnetMask=255.255.255.0&table.Network.eth0.DefaultGateway=${BRIDGE_IP}`;
      const res = await this._httpRequest(
        cam.ip, 80,
        `/cgi-bin/configManager.cgi?action=setConfig&${body}`,
        cam.username, cam.password
      );
      if (res.includes('OK')) {
        console.log(`[DISCOVERY] Camera IP changed to ${newIp} via Dahua API`);
        // Wait for camera to come up on new IP
        await new Promise(r => setTimeout(r, 5000));
        return true;
      }
    } catch (e) { /* not Dahua, try ONVIF */ }

    console.log(`[DISCOVERY] Could not auto-assign IP. Camera stays at ${cam.ip}`);
    return false;
  }

  _httpRequest(host, port, path, username, password) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: host, port, path, method: 'GET',
        headers: username ? { 'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') } : {},
        timeout: 5000,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  _getNextIp() {
    const used = new Set(this.cameras.map(c => c.ip));
    used.add(BRIDGE_IP);
    for (let i = 101; i <= 254; i++) {
      const ip = `${CAMERA_SUBNET}.${i}`;
      if (!used.has(ip)) return i;
    }
    return 101;
  }

  _assignIp() {
    const ip = `${CAMERA_SUBNET}.${this.nextIp}`;
    this.nextIp++;
    if (this.nextIp > 254) this.nextIp = 101;
    return ip;
  }

  _saveConfig() {
    try {
      this.config.cameras = this.cameras;
      const configPath = path.join(this.config._configDir || '/opt/intrlock-bridge', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      console.log(`[DISCOVERY] Saved ${this.cameras.length} camera(s) to config`);
    } catch (e) {
      console.error('[DISCOVERY] Failed to save config:', e.message);
    }
  }

  _updateMediaMTX() {
    if (this.cameras.length === 0) return;

    // Build MediaMTX config
    let yml = 'webrtcAddress: :8889\n';
    yml += 'hlsAddress: :8888\n';
    yml += 'rtspAddress: :8554\n';
    yml += 'api: yes\n';
    yml += 'apiAddress: :9997\n';
    yml += 'paths:\n';

    for (const cam of this.cameras) {
      yml += `  ${cam.streamId}:\n`;
      yml += `    source: ${cam.rtspUrl}\n`;
      yml += `    sourceOnDemand: yes\n`;
    }

    fs.writeFileSync(MEDIAMTX_CONFIG, yml);
    console.log('[DISCOVERY] MediaMTX config updated');

    // Restart MediaMTX
    this._restartMediaMTX();
  }

  _restartMediaMTX() {
    try {
      execSync('sudo killall mediamtx 2>/dev/null');
    } catch (e) { /* not running */ }

    if (!fs.existsSync(MEDIAMTX_BIN)) {
      console.error('[DISCOVERY] MediaMTX not found at', MEDIAMTX_BIN);
      return;
    }

    this.mediamtxProc = spawn('sudo', [MEDIAMTX_BIN, MEDIAMTX_CONFIG], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    this.mediamtxProc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) console.log('[MEDIAMTX]', line);
    });

    this.mediamtxProc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) console.error('[MEDIAMTX]', line);
    });

    this.mediamtxProc.unref();
    console.log('[DISCOVERY] MediaMTX started');
  }

  cleanup() {
    if (this.mediamtxProc) {
      try { process.kill(-this.mediamtxProc.pid); } catch (e) { /* ignore */ }
    }
    try { execSync('sudo killall mediamtx 2>/dev/null'); } catch (e) { /* ignore */ }
  }
}

// ── CLI: Run discovery directly ─────────────────────────────────────────────
if (require.main === module) {
  const configPath = path.join(process.env.BRIDGE_DIR || '/opt/intrlock-bridge', 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { /* empty config */ }
  config._configDir = path.dirname(configPath);

  const action = process.argv[2] || 'discover';
  const discovery = new CameraDiscovery(config);

  if (action === 'discover') {
    discovery.discover().then(cameras => {
      console.log('\n=== Discovered Cameras ===');
      for (const cam of cameras) {
        console.log(`  ${cam.streamId}: ${cam.name} (${cam.ip})`);
        console.log(`    RTSP: ${cam.rtspUrl.replace(/\/\/[^@]+@/, '//***:***@')}`);
        console.log(`    View: http://localhost:8889/${cam.streamId}`);
      }
      if (cameras.length === 0) console.log('  No cameras found.');
      console.log('');
    });
  } else if (action === 'list') {
    console.log(JSON.stringify(discovery.getCameras(), null, 2));
  } else if (action === 'add' && process.argv[3]) {
    discovery.addCamera(process.argv[3], process.argv[4] || 'admin', process.argv[5] || '123456').then(cam => {
      if (cam) console.log('Added:', cam.name, cam.ip);
      else console.log('Failed to add camera');
    });
  } else if (action === 'refresh') {
    discovery.refresh().then(cameras => {
      console.log(`${cameras.length} camera(s) online`);
    });
  } else {
    console.log('Usage: node camera-discovery.js [discover|list|add <ip> [user] [pass]|refresh]');
  }
}

module.exports = { CameraDiscovery };
