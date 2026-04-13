#!/bin/bash
# Intrlock Bridge - First Boot Auto-Provisioner
# This script runs ONCE on first boot, installs the Bridge agent,
# then disables itself so it never runs again.
#
# How it gets on the SD card:
# After flashing Raspberry Pi OS, mount the boot partition and copy
# this file + the systemd service to trigger it automatically.

set -e
LOG="/var/log/intrlock-first-boot.log"
MARKER="/opt/intrlock-bridge/.first-boot-done"
INSTALL_URL="https://raw.githubusercontent.com/Rgoodman2592/intrlock-bridge-agent/main/install.sh"

# If already completed, exit
if [ -f "$MARKER" ]; then
  echo "First boot already completed" >> "$LOG"
  exit 0
fi

exec >> "$LOG" 2>&1
echo "=========================================="
echo "Intrlock Bridge First Boot - $(date)"
echo "=========================================="

# Wait for network connectivity (max 120 seconds)
echo "[1/5] Waiting for network..."
for i in $(seq 1 24); do
  if ping -c 1 -W 2 google.com > /dev/null 2>&1; then
    echo "  Network is up"
    break
  fi
  echo "  Waiting... ($((i*5))s)"
  sleep 5
done

if ! ping -c 1 -W 2 google.com > /dev/null 2>&1; then
  echo "ERROR: No network after 120s. Will retry on next boot."
  exit 1
fi

# Wait for time sync
echo "[2/5] Syncing clock..."
timedatectl set-ntp true 2>/dev/null || true
for i in $(seq 1 12); do
  if timedatectl status 2>/dev/null | grep -q "synchronized: yes"; then
    echo "  Clock synced"
    break
  fi
  sleep 5
done

# Run the install script
echo "[3/5] Running Intrlock Bridge installer..."
curl -sSL "$INSTALL_URL" | bash

# Mark first boot as complete
echo "[4/5] Marking first boot complete..."
mkdir -p /opt/intrlock-bridge
touch "$MARKER"

# Disable the first-boot service so it never runs again
echo "[5/5] Disabling first-boot service..."
systemctl disable intrlock-first-boot.service 2>/dev/null || true

echo ""
echo "=========================================="
echo "  First boot complete! $(date)"
echo "=========================================="
echo ""

# Read the config for display
if [ -f /opt/intrlock-bridge/config.json ]; then
  SERIAL=$(grep -o '"serial_number":\s*"[^"]*"' /opt/intrlock-bridge/config.json | cut -d'"' -f4)
  echo "  Serial Number: $SERIAL"
  echo "  Claim at: https://beta.intrlock.io"
  echo "  Access Control → Add System → Intrlock Bridge"
fi
