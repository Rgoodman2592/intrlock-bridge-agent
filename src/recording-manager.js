const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class RecordingManager {
  constructor(storageManager, cameraConfig) {
    this.storage = storageManager;
    this.config = cameraConfig;
    this.processes = new Map(); // cameraId -> { process, startedAt }
    this.retentionInterval = null;
  }

  /**
   * Start recording for a camera
   * Returns { ok: boolean, message?: string }
   */
  startRecording(cameraId) {
    // Check if already recording
    if (this.processes.has(cameraId)) {
      return { ok: false, message: 'Already recording' };
    }

    // Get camera config
    const camera = this.config.getCamera(cameraId);
    if (!camera) {
      return { ok: false, message: 'Camera not found' };
    }

    // Check for RTSP URL
    if (!camera.rtsp_url) {
      return { ok: false, message: 'No RTSP URL configured' };
    }

    // Check if USB mounted
    if (!this.storage.isMounted()) {
      return { ok: false, message: 'USB drive not mounted' };
    }

    // Get recording settings
    const recordingSettings = this.config.getRecordingSettings();
    const segmentDuration = recordingSettings.segment_duration || 300;

    // Choose stream URL (prefer sub_stream_url if available)
    const streamUrl = camera.sub_stream_url || camera.rtsp_url;

    // Create base camera directory
    const cameraRecordingsDir = path.join(this.storage.recordingsDir, cameraId);
    try {
      fs.mkdirSync(cameraRecordingsDir, { recursive: true });
    } catch (err) {
      return { ok: false, message: `Failed to create camera directory: ${err.message}` };
    }

    // Output pattern for ffmpeg segmentation
    const outputPattern = path.join(cameraRecordingsDir, '%Y-%m-%d', '%H-%M-%S.mp4');

    // Spawn ffmpeg process
    const ffmpegArgs = [
      '-rtsp_transport', 'tcp',
      '-i', streamUrl,
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', segmentDuration.toString(),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      '-strftime_mkdir', '1',
      outputPattern,
    ];

    let process;
    try {
      process = spawn('ffmpeg', ffmpegArgs);
    } catch (err) {
      return { ok: false, message: `Failed to spawn ffmpeg: ${err.message}` };
    }

    // Monitor stderr for logging
    process.stderr.on('data', (data) => {
      const line = data.toString().trim();
      // Only log lines that aren't ffmpeg progress
      if (line && !line.startsWith('frame=') && !line.startsWith('size=')) {
        console.log(`[RECORDING:${cameraId}] ${line}`);
      }
    });

    // Handle process exit
    process.on('exit', () => {
      this.processes.delete(cameraId);
      console.log(`[RECORDING] Process exited for ${cameraId}`);

      // Auto-restart if camera still has recording enabled
      const updatedCamera = this.config.getCamera(cameraId);
      if (updatedCamera && updatedCamera.recording && updatedCamera.enabled) {
        console.log(`[RECORDING] Auto-restarting ${cameraId} in 5s`);
        setTimeout(() => {
          this.startRecording(cameraId);
        }, 5000);
      }
    });

    // Store process info
    this.processes.set(cameraId, {
      process,
      startedAt: Date.now(),
    });

    // Update camera config to mark as recording
    this.config.updateCamera(cameraId, { recording: true });

    console.log(`[RECORDING] Started recording for ${cameraId}`);
    return { ok: true, message: 'Recording started' };
  }

  /**
   * Stop recording for a camera
   * Returns { ok: boolean, message?: string }
   */
  stopRecording(cameraId) {
    const entry = this.processes.get(cameraId);
    if (!entry) {
      return { ok: false, message: 'Not recording' };
    }

    // Update camera config FIRST to prevent auto-restart
    this.config.updateCamera(cameraId, { recording: false });

    // Kill the process with SIGTERM, fallback to SIGKILL after 5s
    const { process } = entry;
    let killed = false;

    const killTimer = setTimeout(() => {
      if (!killed) {
        console.log(`[RECORDING] Force killing ${cameraId} with SIGKILL`);
        process.kill('SIGKILL');
        killed = true;
      }
    }, 5000);

    process.on('exit', () => {
      clearTimeout(killTimer);
    });

    process.kill('SIGTERM');

    // Remove from processes map
    this.processes.delete(cameraId);

    console.log(`[RECORDING] Stopped recording for ${cameraId}`);
    return { ok: true };
  }

  /**
   * Get recording status for all cameras
   * Returns array of { id, name, recording, startedAt, diskUsed }
   */
  getStatus() {
    const cameras = this.config.listCameras();
    const status = [];

    for (const camera of cameras) {
      const entry = this.processes.get(camera.id);
      const recording = this.processes.has(camera.id);
      const diskUsed = this.storage.getCameraRecordingSize(camera.id);

      status.push({
        id: camera.id,
        name: camera.name,
        recording,
        startedAt: recording ? entry.startedAt : null,
        diskUsed,
      });
    }

    return status;
  }

  /**
   * Start recording for all cameras with recording=true and enabled=true
   */
  startAll() {
    const cameras = this.config.listCameras();

    for (const camera of cameras) {
      if (camera.recording && camera.enabled) {
        this.startRecording(camera.id);
      }
    }
  }

  /**
   * Start retention loop to enforce retention policy
   */
  startRetentionLoop(intervalMs = 600000) {
    this.retentionInterval = setInterval(() => {
      const recordingSettings = this.config.getRecordingSettings();
      const maxDiskPercent = recordingSettings.max_disk_percent || 90;
      const retentionDays = recordingSettings.retention_days || 30;

      console.log(`[RECORDING] Running retention cleanup: ${maxDiskPercent}% threshold, ${retentionDays}d retention`);
      this.storage.enforceRetention(maxDiskPercent, retentionDays);
    }, intervalMs);

    console.log(`[RECORDING] Retention loop started (${intervalMs}ms interval)`);
  }

  /**
   * Cleanup: stop all processes and clear intervals
   */
  cleanup() {
    // Clear retention interval
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = null;
    }

    // Kill all ffmpeg processes
    for (const [cameraId, entry] of this.processes.entries()) {
      try {
        entry.process.kill('SIGKILL');
        console.log(`[RECORDING] Killed process for ${cameraId}`);
      } catch (err) {
        console.error(`[RECORDING] Error killing process for ${cameraId}:`, err.message);
      }
    }

    // Clear processes map
    this.processes.clear();

    console.log('[RECORDING] Cleanup complete');
  }
}

module.exports = { RecordingManager };
