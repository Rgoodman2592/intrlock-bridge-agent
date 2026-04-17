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
      const output = execSync('lsblk -Jno NAME,SIZE,FSTYPE,MOUNTPOINT,TRAN', {
        encoding: 'utf8',
        timeout: 5000,
      });

      const data = JSON.parse(output);
      const usbDrives = [];

      if (data.blockdevices) {
        for (const dev of data.blockdevices) {
          if (dev.tran === 'usb') {
            usbDrives.push({
              name: dev.name,
              size: dev.size,
              fstype: dev.fstype,
              mountpoint: dev.mountpoint,
              tran: dev.tran,
            });
          }
        }
      }

      return usbDrives;
    } catch {
      return [];
    }
  }

  /**
   * Mount the first available USB drive
   * If already mounted, returns ok. Creates recordingsDir if mounted successfully.
   */
  mount() {
    try {
      if (this.isMounted()) {
        console.log(`[STORAGE] Already mounted at ${this.mountPath}`);
        return { ok: true, message: 'Already mounted' };
      }

      const drives = this.detectUsbDrives();
      if (drives.length === 0) {
        return { ok: false, message: 'No USB drives detected' };
      }

      // Find first unmounted USB drive with fstype
      const unmountedDrive = drives.find(d => d.fstype && !d.mountpoint);
      if (!unmountedDrive) {
        return { ok: false, message: 'No unmounted USB drives available' };
      }

      const devicePath = `/dev/${unmountedDrive.name}`;
      fs.mkdirSync(this.mountPath, { recursive: true });

      execSync(`sudo mount ${devicePath} ${this.mountPath}`, {
        stdio: 'pipe',
        timeout: 10000,
      });

      // Create recordings directory
      fs.mkdirSync(this.recordingsDir, { recursive: true });

      console.log(`[STORAGE] Mounted ${devicePath} at ${this.mountPath}`);
      return { ok: true, message: `Mounted ${devicePath}`, device: devicePath };
    } catch (err) {
      const message = err.message || 'Mount failed';
      console.error(`[STORAGE] Mount error: ${message}`);
      return { ok: false, message };
    }
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
