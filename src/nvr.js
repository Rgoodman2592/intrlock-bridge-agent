const http = require('http');
const https = require('https');

/**
 * NVR Integration — connect to Hikvision/Dahua NVRs via their HTTP API
 * Pull camera list and RTSP stream URLs from the NVR
 */
class NvrClient {
  constructor(host, port, username, password, type = 'hikvision') {
    this.host = host;
    this.port = port || (type === 'hikvision' ? 80 : 80);
    this.username = username;
    this.password = password;
    this.type = type; // 'hikvision' | 'dahua'
    this.auth = Buffer.from(`${username}:${password}`).toString('base64');
  }

  /**
   * Get list of cameras/channels from the NVR
   */
  async getCameras() {
    if (this.type === 'hikvision') return this._getHikvisionCameras();
    if (this.type === 'dahua') return this._getDahuaCameras();
    throw new Error(`Unsupported NVR type: ${this.type}`);
  }

  async _getHikvisionCameras() {
    try {
      // Hikvision ISAPI — get video input channels
      const xml = await this._request('/ISAPI/ContentMgmt/InputProxy/channels');
      const channels = [];
      const matches = xml.matchAll(/<InputProxyChannel>([\s\S]*?)<\/InputProxyChannel>/g);

      for (const match of matches) {
        const block = match[1];
        const id = block.match(/<id>(\d+)<\/id>/)?.[1];
        const name = block.match(/<name>([^<]+)<\/name>/)?.[1];
        const sourceUrl = block.match(/<sourceInputPortDescriptor>[\s\S]*?<ipAddress>([^<]+)<\/ipAddress>/)?.[1];

        if (id) {
          channels.push({
            id: parseInt(id),
            name: name || `Channel ${id}`,
            sourceIp: sourceUrl || '',
            rtsp_url: `rtsp://${this.username}:${this.password}@${this.host}:554/Streaming/Channels/${id}01`,
            rtsp_sub: `rtsp://${this.username}:${this.password}@${this.host}:554/Streaming/Channels/${id}02`,
          });
        }
      }

      // Fallback: try system/video channels
      if (channels.length === 0) {
        const sysXml = await this._request('/ISAPI/System/Video/inputs/channels');
        const sysMatches = sysXml.matchAll(/<VideoInputChannel>([\s\S]*?)<\/VideoInputChannel>/g);
        let ch = 1;
        for (const m of sysMatches) {
          channels.push({
            id: ch,
            name: `Channel ${ch}`,
            sourceIp: '',
            rtsp_url: `rtsp://${this.username}:${this.password}@${this.host}:554/Streaming/Channels/${ch}01`,
            rtsp_sub: `rtsp://${this.username}:${this.password}@${this.host}:554/Streaming/Channels/${ch}02`,
          });
          ch++;
        }
      }

      console.log(`[NVR] Hikvision: found ${channels.length} channels`);
      return channels;
    } catch (e) {
      console.error(`[NVR] Hikvision API error:`, e.message);
      return [];
    }
  }

  async _getDahuaCameras() {
    try {
      // Dahua HTTP API
      const response = await this._request('/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle');
      const channels = [];
      const lines = response.split('\n');

      for (const line of lines) {
        const match = line.match(/table\.ChannelTitle\[(\d+)\]\.Name=(.+)/);
        if (match) {
          const id = parseInt(match[1]) + 1;
          const name = match[2].trim();
          channels.push({
            id,
            name: name || `Channel ${id}`,
            sourceIp: '',
            rtsp_url: `rtsp://${this.username}:${this.password}@${this.host}:554/cam/realmonitor?channel=${id}&subtype=0`,
            rtsp_sub: `rtsp://${this.username}:${this.password}@${this.host}:554/cam/realmonitor?channel=${id}&subtype=1`,
          });
        }
      }

      console.log(`[NVR] Dahua: found ${channels.length} channels`);
      return channels;
    } catch (e) {
      console.error(`[NVR] Dahua API error:`, e.message);
      return [];
    }
  }

  /**
   * Get NVR device info
   */
  async getDeviceInfo() {
    try {
      if (this.type === 'hikvision') {
        const xml = await this._request('/ISAPI/System/deviceInfo');
        return {
          name: xml.match(/<deviceName>([^<]+)/)?.[1] || 'Hikvision NVR',
          model: xml.match(/<model>([^<]+)/)?.[1] || '',
          serial: xml.match(/<serialNumber>([^<]+)/)?.[1] || '',
          firmware: xml.match(/<firmwareVersion>([^<]+)/)?.[1] || '',
          channels: parseInt(xml.match(/<analogChannelNum>(\d+)/)?.[1] || '0') +
                    parseInt(xml.match(/<digitalChannelNum>(\d+)/)?.[1] || '0'),
          type: 'hikvision',
        };
      }
      return { name: 'NVR', type: this.type };
    } catch (e) {
      return { name: 'NVR (offline)', type: this.type, error: e.message };
    }
  }

  _request(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method: 'GET',
        headers: { 'Authorization': `Basic ${this.auth}` },
        timeout: 10000,
      };

      const req = http.request(options, (res) => {
        if (res.statusCode === 401) {
          // Try digest auth
          reject(new Error('Authentication failed — try digest auth'));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }
}

module.exports = { NvrClient };
