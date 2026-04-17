const si = require('systeminformation');
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Get system information including CPU, memory, uptime, and disk usage.
 */
async function getSystemInfo() {
  try {
    const [cpu, mem, fsData] = await Promise.all([
      si.cpuTemperature().catch(() => ({})),
      si.mem().catch(() => ({})),
      si.fsSize().catch(() => []),
    ]);

    const rootDisk = (Array.isArray(fsData) ? fsData : []).find(d => d.mount === '/') || {};

    return {
      cpu_temp: cpu.main || null,
      cpu_load: Math.round(si.currentLoad ? (await si.currentLoad().catch(() => ({}))).currentLoad || 0 : 0),
      memory_used_mb: mem.used ? Math.round(mem.used / 1048576) : null,
      memory_total_mb: mem.total ? Math.round(mem.total / 1048576) : null,
      memory_percent: mem.used && mem.total ? Math.round((mem.used / mem.total) * 100) : null,
      uptime_seconds: Math.floor(os.uptime()),
      hostname: os.hostname(),
      root_disk: rootDisk ? {
        size_mb: rootDisk.size ? Math.round(rootDisk.size / 1048576) : null,
        used_mb: rootDisk.used ? Math.round(rootDisk.used / 1048576) : null,
        available_mb: rootDisk.available ? Math.round(rootDisk.available / 1048576) : null,
        percent: rootDisk.use || null,
      } : null,
    };
  } catch (e) {
    console.error('[SYSTEM-INFO] getSystemInfo failed:', e.message);
    return {
      cpu_temp: null,
      cpu_load: null,
      memory_used_mb: null,
      memory_total_mb: null,
      memory_percent: null,
      uptime_seconds: Math.floor(os.uptime()),
      hostname: os.hostname(),
      root_disk: null,
    };
  }
}

/**
 * Get network mode (client or standalone) from /tmp/intrlock-network-mode
 */
function getNetworkMode() {
  try {
    if (fs.existsSync('/tmp/intrlock-network-mode')) {
      return fs.readFileSync('/tmp/intrlock-network-mode', 'utf8').trim();
    }
  } catch {}
  return 'unknown';
}

/**
 * Get network information for each interface with IPv4 non-internal address.
 */
function getNetworkInfo() {
  try {
    const interfaces = os.networkInterfaces();
    const result = {};

    Object.entries(interfaces).forEach(([name, addrs]) => {
      const ipv4 = (Array.isArray(addrs) ? addrs : []).find(addr => addr.family === 'IPv4' && !addr.internal);
      if (ipv4) {
        result[name] = {
          ip: ipv4.address || null,
          mac: ipv4.mac || null,
        };
      }
    });

    result._mode = getNetworkMode();
    return result;
  } catch (e) {
    console.error('[SYSTEM-INFO] getNetworkInfo failed:', e.message);
    return { _mode: 'unknown' };
  }
}

/**
 * Get the status of a systemd service.
 */
function getServiceStatus(serviceName) {
  try {
    const status = execSync(`systemctl is-active ${serviceName}`, { encoding: 'utf-8' }).trim();
    return status;
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Read DHCP leases from dnsmasq leases file.
 */
function getDhcpLeases() {
  try {
    const leaseFile = '/var/lib/misc/dnsmasq.leases';
    if (!fs.existsSync(leaseFile)) {
      return [];
    }

    const content = fs.readFileSync(leaseFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    return lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        return {
          expires: parseInt(parts[0], 10),
          mac: parts[1],
          ip: parts[2],
          hostname: parts[3],
        };
      }
      return null;
    }).filter(lease => lease !== null);
  } catch (e) {
    console.error('[SYSTEM-INFO] getDhcpLeases failed:', e.message);
    return [];
  }
}

/**
 * Restart a systemd service (allowlist only).
 */
function restartService(serviceName) {
  const allowlist = ['intrlock-mediamtx', 'intrlock-bridge', 'intrlock-webcam', 'dnsmasq'];

  if (!allowlist.includes(serviceName)) {
    return {
      ok: false,
      message: 'not in allowlist',
    };
  }

  try {
    execSync(`sudo systemctl restart ${serviceName}`, { encoding: 'utf-8' });
    return {
      ok: true,
      message: `Service ${serviceName} restart initiated`,
    };
  } catch (e) {
    return {
      ok: false,
      message: e.message,
    };
  }
}

module.exports = {
  getSystemInfo,
  getNetworkInfo,
  getServiceStatus,
  getDhcpLeases,
  restartService,
};
