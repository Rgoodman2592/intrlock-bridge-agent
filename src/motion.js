const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Motion Detection — local motion detection using FFmpeg frame differencing
 * No external dependencies beyond FFmpeg (already required for camera.js)
 *
 * How it works:
 * 1. Captures a snapshot from the camera stream every N seconds
 * 2. Compares consecutive frames using pixel difference
 * 3. If difference exceeds threshold → motion detected → trigger event
 * 4. Saves motion snapshot to disk and pushes event to cloud
 *
 * This is intentionally simple and runs on Pi hardware without GPU.
 * For AI-powered detection (person, vehicle, face), see the AI detection add-on.
 */
class MotionDetector {
  constructor(config, mqtt) {
    this.config = config;
    this.mqtt = mqtt;
    this.enabled = false;
    this.interval = null;
    this.lastFrame = null;
    this.motionCooldown = false;
    this.snapshotDir = config.snapshot_dir || '/tmp/intrlock-snapshots';
    this.settings = {
      checkIntervalMs: config.motion_interval_ms || 2000,    // Check every 2s
      sensitivity: config.motion_sensitivity || 15,           // % of pixels changed
      cooldownMs: config.motion_cooldown_ms || 10000,        // 10s cooldown between events
      minAreaPercent: config.motion_min_area || 5,            // Ignore changes < 5% of frame
      snapshotRetention: config.snapshot_retention || 100,    // Keep last 100 snapshots
    };

    // Ensure snapshot directory exists
    fs.mkdirSync(this.snapshotDir, { recursive: true });
  }

  /**
   * Start motion detection on a given RTSP stream
   * @param {string} rtspUrl — RTSP URL of the camera stream
   */
  start(rtspUrl) {
    if (this.enabled) return;
    this.enabled = true;
    this.rtspUrl = rtspUrl;
    console.log(`[MOTION] Started detection on ${rtspUrl} (interval: ${this.settings.checkIntervalMs}ms, sensitivity: ${this.settings.sensitivity}%)`);

    this.interval = setInterval(() => this._captureAndCompare(), this.settings.checkIntervalMs);
  }

  stop() {
    this.enabled = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[MOTION] Detection stopped');
  }

  /**
   * Capture a frame from the RTSP stream and compare with previous frame
   */
  async _captureAndCompare() {
    if (!this.enabled || !this.rtspUrl) return;

    try {
      const frame = await this._captureFrame();
      if (!frame) return;

      if (this.lastFrame) {
        const diff = this._compareFrames(this.lastFrame, frame);

        if (diff > this.settings.sensitivity && !this.motionCooldown) {
          console.log(`[MOTION] Motion detected! (${diff.toFixed(1)}% change)`);
          this._onMotion(frame, diff);
        }
      }

      this.lastFrame = frame;
    } catch (e) {
      // Silently fail — camera may be temporarily unavailable
    }
  }

  /**
   * Capture a single JPEG frame from the RTSP stream using FFmpeg
   */
  _captureFrame() {
    return new Promise((resolve) => {
      const chunks = [];
      const ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp',
        '-i', this.rtspUrl,
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '10',       // Lower quality for faster comparison
        '-vf', 'scale=320:240',  // Small resolution for comparison
        '-y', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

      ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
      ffmpeg.on('close', () => {
        if (chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(null);
        }
      });
      ffmpeg.on('error', () => resolve(null));

      // Kill if takes too long
      setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch {} }, 5000);
    });
  }

  /**
   * Simple pixel-level comparison between two JPEG frames
   * Returns percentage of pixels that changed significantly
   *
   * This is a basic approach — for production, consider:
   * - Background subtraction (MOG2)
   * - Optical flow
   * - On-device ML (Pi AI Camera)
   */
  _compareFrames(frame1, frame2) {
    // Quick size-based heuristic — if frame sizes differ significantly, there's change
    const sizeDiff = Math.abs(frame1.length - frame2.length) / Math.max(frame1.length, frame2.length) * 100;
    if (sizeDiff > 30) return sizeDiff; // Major change

    // Byte-level comparison (JPEG compressed — not pixel-perfect but fast)
    const minLen = Math.min(frame1.length, frame2.length);
    const sampleSize = Math.min(minLen, 10000); // Sample first 10KB
    const step = Math.max(1, Math.floor(minLen / sampleSize));

    let diffCount = 0;
    let totalSampled = 0;

    for (let i = 0; i < minLen; i += step) {
      totalSampled++;
      if (Math.abs(frame1[i] - frame2[i]) > 30) { // Threshold per byte
        diffCount++;
      }
    }

    return totalSampled > 0 ? (diffCount / totalSampled) * 100 : 0;
  }

  /**
   * Handle motion detection event
   */
  _onMotion(frame, changePercent) {
    // Cooldown — prevent rapid-fire events
    this.motionCooldown = true;
    setTimeout(() => { this.motionCooldown = false; }, this.settings.cooldownMs);

    // Save snapshot
    const timestamp = Date.now();
    const filename = `motion-${timestamp}.jpg`;
    const filepath = path.join(this.snapshotDir, filename);

    // Capture a high-res snapshot for the event
    this._captureHighRes().then(hiResFrame => {
      const saveFrame = hiResFrame || frame;
      fs.writeFileSync(filepath, saveFrame);
      console.log(`[MOTION] Snapshot saved: ${filepath} (${(saveFrame.length / 1024).toFixed(0)}KB)`);

      // Publish event to cloud
      if (this.mqtt) {
        this.mqtt.publish('event', {
          event_type: 'motion.detected',
          change_percent: changePercent,
          snapshot_path: filepath,
          snapshot_size: saveFrame.length,
          timestamp,
        });
      }

      // Cleanup old snapshots
      this._cleanupSnapshots();
    });
  }

  /**
   * Capture a high-resolution snapshot for the motion event
   */
  _captureHighRes() {
    return new Promise((resolve) => {
      const chunks = [];
      const ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp',
        '-i', this.rtspUrl,
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '2',        // High quality
        '-y', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

      ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
      ffmpeg.on('close', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null));
      ffmpeg.on('error', () => resolve(null));
      setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch {} }, 5000);
    });
  }

  /**
   * Remove old snapshots beyond retention limit
   */
  _cleanupSnapshots() {
    try {
      const files = fs.readdirSync(this.snapshotDir)
        .filter(f => f.startsWith('motion-') && f.endsWith('.jpg'))
        .sort()
        .reverse();

      if (files.length > this.settings.snapshotRetention) {
        const toDelete = files.slice(this.settings.snapshotRetention);
        for (const f of toDelete) {
          fs.unlinkSync(path.join(this.snapshotDir, f));
        }
        console.log(`[MOTION] Cleaned up ${toDelete.length} old snapshots`);
      }
    } catch {}
  }

  getStatus() {
    return {
      enabled: this.enabled,
      rtsp_url: this.rtspUrl || null,
      settings: this.settings,
      snapshot_dir: this.snapshotDir,
      cooldown_active: this.motionCooldown,
    };
  }
}

module.exports = { MotionDetector };
