const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class StorageManager {
  constructor(mountPath = '/mnt/usb') {
    this.mountPath = mountPath;
    this.recordingsDir = path.join(mountPath, 'recordings');
  }

  /**
   * Check if the USB drive is mounted by reading /proc/mounts
   */
  isMounted() {
    try {
      const mounts = fs.readFileSync('/proc/mounts', 'utf8');
      return mounts.includes(this.mountPath);
    } catch {
      return false;
    }
  }

  /**
   * Get disk statistics for the mounted drive
   * Returns { mounted, total, used, free, percent }
   */
  getDiskStats() {
    if (!this.isMounted()) {
      return { mounted: false, total: 0, used: 0, free: 0, percent: 0 };
    }

    try {
      const output = execSync(`df -B1 ${this.mountPath} | tail -1`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      const fields = output.split(/\s+/);
      if (fields.length < 4) {
        return { mounted: false, total: 0, used: 0, free: 0, percent: 0 };
      }

      const total = parseInt(fields[1], 10);
      const used = parseInt(fields[2], 10);
      const free = parseInt(fields[3], 10);
      const percent = total > 0 ? Math.round((used / total) * 100) : 0;

      return { mounted: true, total, used, free, percent };
    } catch {
      return { mounted: false, total: 0, used: 0, free: 0, percent: 0 };
    }
  }

  /**
   * Detect USB drives by parsing lsblk JSON output
   * Returns array of { name, size, fstype, mountpoint, tran }
   */
  detectUsbDrives() {
    try {
      const output = execSync('lsblk -Jbo NAME,SIZE,FSTYPE,MOUNTPOINT,TRAN,MODEL,TYPE', {
        encoding: 'utf8',
        timeout: 5000,
      });

      const data = JSON.parse(output);
      const usbDrives = [];

      if (data.blockdevices) {
        for (const dev of data.blockdevices) {
          if (dev.tran === 'usb') {
            // Include the parent disk and its partitions
            const partitions = (dev.children || []).map(p => ({
              name: p.name,
              size: p.size,
              sizeHuman: this._formatSize(p.size),
              fstype: p.fstype || null,
              mountpoint: p.mountpoint || null,
              type: p.type,
            }));

            usbDrives.push({
              name: dev.name,
              size: dev.size,
              sizeHuman: this._formatSize(dev.size),
              fstype: dev.fstype || null,
              mountpoint: dev.mountpoint || null,
              model: (dev.model || '').trim(),
              tran: dev.tran,
              partitions,
            });
          }
        }
      }

      return usbDrives;
    } catch {
      return [];
    }
  }

  _formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  /**
   * Format a USB drive as ext4 and label it for Intrlock recordings
   * WARNING: This erases all data on the drive!
   * @param {string} deviceName — e.g., 'sda'
   */
  formatDrive(deviceName) {
    // Safety checks
    if (!deviceName || deviceName.startsWith('mmcblk') || deviceName.startsWith('zram')) {
      return { ok: false, message: 'Cannot format system drive' };
    }

    const drives = this.detectUsbDrives();
    const drive = drives.find(d => d.name === deviceName);
    if (!drive) {
      return { ok: false, message: `Drive ${deviceName} not found or not USB` };
    }

    // Unmount any mounted partitions first
    for (const part of drive.partitions) {
      if (part.mountpoint) {
        try {
          execSync(`sudo umount /dev/${part.name}`, { timeout: 10000 });
        } catch {}
      }
    }
    if (drive.mountpoint) {
      try {
        execSync(`sudo umount /dev/${drive.name}`, { timeout: 10000 });
      } catch {}
    }

    const devPath = `/dev/${deviceName}`;
    try {
      console.log(`[STORAGE] Formatting ${devPath} as ext4...`);

      // Create new partition table + single partition
      execSync(`sudo parted -s ${devPath} mklabel gpt mkpart primary ext4 0% 100%`, {
        timeout: 30000,
      });

      // Wait for kernel to pick up new partition
      execSync('sudo partprobe && sleep 2', { timeout: 10000 });

      // Format the partition as ext4
      const partPath = `${devPath}1`;
      execSync(`sudo mkfs.ext4 -F -L intrlock-recordings ${partPath}`, {
        timeout: 120000, // Large drives can take a while
      });

      console.log(`[STORAGE] Formatted ${partPath} as ext4`);
      return { ok: true, message: `Formatted ${devPath} as ext4`, partition: partPath };
    } catch (err) {
      console.error(`[STORAGE] Format error:`, err.message);
      return { ok: false, message: err.message.slice(0, 200) };
    }
  }

  /**
   * Mount a specific drive/partition to the recordings path
   * @param {string} partitionName — e.g., 'sda1'
   */
  mountDrive(partitionName) {
    if (this.isMounted()) {
      return { ok: true, message: 'Already mounted' };
    }

    if (!partitionName) {
      return { ok: false, message: 'No partition specified' };
    }

    const devPath = `/dev/${partitionName}`;
    try {
      fs.mkdirSync(this.mountPath, { recursive: true });
      execSync(`sudo mount ${devPath} ${this.mountPath}`, { timeout: 10000 });
      fs.mkdirSync(this.recordingsDir, { recursive: true });
      console.log(`[STORAGE] Mounted ${devPath} at ${this.mountPath}`);
      return { ok: true, message: `Mounted ${devPath}` };
    } catch (err) {
      return { ok: false, message: err.message.slice(0, 200) };
    }
  }

  /**
   * Mount the first available USB drive (legacy auto-mount)
   */
  mount() {
    if (this.isMounted()) {
      return { ok: true, message: 'Already mounted' };
    }

    const drives = this.detectUsbDrives();
    for (const drive of drives) {
      for (const part of drive.partitions) {
        if (part.fstype && !part.mountpoint) {
          return this.mountDrive(part.name);
        }
      }
    }

    return { ok: false, message: 'No mountable USB partitions found' };
  }

  /**
   * List subdirectories of recordingsDir (camera IDs)
   */
  listRecordingDirs() {
    try {
      if (!fs.existsSync(this.recordingsDir)) {
        return [];
      }

      const entries = fs.readdirSync(this.recordingsDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * List .mp4 files in recordingsDir/{cameraId}/{date}
   * Returns array of { filename, path, time (filename without .mp4), size }
   */
  listSegments(cameraId, date) {
    try {
      const dirPath = path.join(this.recordingsDir, cameraId, date);

      if (!fs.existsSync(dirPath)) {
        return [];
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const segments = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.mp4')) {
          const filePath = path.join(dirPath, entry.name);
          const stats = fs.statSync(filePath);
          segments.push({
            filename: entry.name,
            path: filePath,
            time: entry.name.replace('.mp4', ''),
            size: stats.size,
          });
        }
      }

      return segments;
    } catch {
      return [];
    }
  }

  /**
   * List date directories in recordingsDir/{cameraId} matching YYYY-MM-DD format
   * Returns sorted array in reverse order (newest first)
   */
  listDates(cameraId) {
    try {
      const cameraPath = path.join(this.recordingsDir, cameraId);

      if (!fs.existsSync(cameraPath)) {
        return [];
      }

      const entries = fs.readdirSync(cameraPath, { withFileTypes: true });
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const dates = entries
        .filter(entry => entry.isDirectory() && dateRegex.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse();

      return dates;
    } catch {
      return [];
    }
  }

  /**
   * Get total recording size for a camera by walking the directory recursively
   */
  getCameraRecordingSize(cameraId) {
    try {
      const cameraPath = path.join(this.recordingsDir, cameraId);

      if (!fs.existsSync(cameraPath)) {
        return 0;
      }

      let totalSize = 0;

      const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile()) {
            const stats = fs.statSync(fullPath);
            totalSize += stats.size;
          } else if (entry.isDirectory()) {
            walk(fullPath);
          }
        }
      };

      walk(cameraPath);
      return totalSize;
    } catch {
      return 0;
    }
  }

  /**
   * Enforce retention policy: delete old dates and manage disk usage
   * First deletes dates older than retentionDays cutoff
   * Then deletes oldest dates if still above maxDiskPercent threshold
   * Returns { deleted: count }
   */
  enforceRetention(maxDiskPercent = 90, retentionDays = 30) {
    try {
      let deletedCount = 0;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD format

      // Phase 1: Delete dates older than retention period
      const cameras = this.listRecordingDirs();
      for (const cameraId of cameras) {
        const dates = this.listDates(cameraId);
        for (const dateStr of dates) {
          if (dateStr < cutoffDateStr) {
            const dateDir = path.join(this.recordingsDir, cameraId, dateStr);
            try {
              this._recursiveDelete(dateDir);
              deletedCount++;
              console.log(`[STORAGE] Deleted old date: ${cameraId}/${dateStr}`);
            } catch (err) {
              console.error(`[STORAGE] Failed to delete ${dateDir}:`, err.message);
            }
          }
        }
      }

      // Phase 2: If still over threshold, delete oldest dates across all cameras
      let stats = this.getDiskStats();
      if (stats.mounted && stats.percent > maxDiskPercent) {
        // Collect all date directories with camera context
        const allDates = [];
        for (const cameraId of cameras) {
          const dates = this.listDates(cameraId);
          for (const dateStr of dates) {
            allDates.push({ cameraId, dateStr });
          }
        }

        // Sort by date (oldest first)
        allDates.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

        // Delete oldest dates until below threshold or no more dates
        for (const { cameraId, dateStr } of allDates) {
          if (stats.percent <= maxDiskPercent) break;

          const dateDir = path.join(this.recordingsDir, cameraId, dateStr);
          try {
            this._recursiveDelete(dateDir);
            deletedCount++;
            console.log(`[STORAGE] Deleted for disk space: ${cameraId}/${dateStr}`);
            stats = this.getDiskStats();
          } catch (err) {
            console.error(`[STORAGE] Failed to delete ${dateDir}:`, err.message);
          }
        }
      }

      return { deleted: deletedCount };
    } catch (err) {
      console.error('[STORAGE] enforceRetention error:', err.message);
      return { deleted: 0 };
    }
  }

  /**
   * Recursively delete a directory and all its contents
   */
  _recursiveDelete(dirPath) {
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this._recursiveDelete(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(dirPath);
  }
}

module.exports = { StorageManager };
