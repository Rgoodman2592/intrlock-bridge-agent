#!/bin/bash
# Intrlock Bridge - SD Card Preparer
#
# Run this AFTER flashing Raspberry Pi OS with Pi Imager.
# It copies the first-boot script onto the SD card's boot partition
# so the Bridge agent installs itself automatically on first power-on.
#
# Usage:
#   1. Flash Raspberry Pi OS Lite (64-bit) with Pi Imager
#      - Set hostname: intrlock-bridge
#      - Enable SSH with password
#      - Configure WiFi
#   2. Don't eject the SD card yet!
#   3. Run this script:
#      ./prepare-sd-card.sh
#   4. Eject SD card, insert into Pi, power on
#   5. Wait ~5 minutes — everything installs automatically
#   6. Claim on beta.intrlock.io

set -e

echo "============================================"
echo "  Intrlock Bridge — SD Card Preparer"
echo "============================================"
echo ""

# Find the boot partition
# macOS: /Volumes/bootfs
# Linux: /media/$USER/bootfs or /mnt/boot
BOOT_MOUNT=""
for candidate in /Volumes/bootfs /media/*/bootfs /mnt/boot /boot/firmware; do
  if [ -d "$candidate" ] && [ -f "$candidate/config.txt" ]; then
    BOOT_MOUNT="$candidate"
    break
  fi
done

if [ -z "$BOOT_MOUNT" ]; then
  echo "ERROR: Cannot find the SD card boot partition."
  echo ""
  echo "Make sure:"
  echo "  1. The SD card is still inserted after flashing"
  echo "  2. The boot partition is mounted"
  echo ""
  echo "On macOS, it should be at /Volumes/bootfs"
  echo "On Linux, try: sudo mount /dev/sdX1 /mnt/boot"
  exit 1
fi

echo "Found boot partition at: $BOOT_MOUNT"
echo ""

# Get the script directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Copy first-boot script to the boot partition
echo "[1/3] Copying first-boot script..."
cp "$SCRIPT_DIR/first-boot.sh" "$BOOT_MOUNT/intrlock-first-boot.sh"
chmod +x "$BOOT_MOUNT/intrlock-first-boot.sh"

# Copy the systemd service file
echo "[2/3] Copying systemd service..."
cp "$SCRIPT_DIR/intrlock-first-boot.service" "$BOOT_MOUNT/intrlock-first-boot.service"

# Create a firstrun script that moves the service into place on first boot
# Pi OS runs /boot/firmware/firstrun.sh if it exists, but we can't rely on that.
# Instead, we use the cmdline.txt trick to run our setup on first boot.
echo "[3/3] Configuring auto-run on first boot..."

# Create a script that the Pi runs to install the systemd service
cat > "$BOOT_MOUNT/intrlock-setup-service.sh" << 'SETUP'
#!/bin/bash
# This runs once to install the first-boot service, then removes itself
cp /boot/firmware/intrlock-first-boot.service /etc/systemd/system/
chmod 644 /etc/systemd/system/intrlock-first-boot.service
chmod +x /boot/firmware/intrlock-first-boot.sh
systemctl daemon-reload
systemctl enable intrlock-first-boot.service
systemctl start intrlock-first-boot.service &
# Remove this setup script from rc.local
sed -i '/intrlock-setup-service/d' /etc/rc.local 2>/dev/null
SETUP
chmod +x "$BOOT_MOUNT/intrlock-setup-service.sh"

# Add to rc.local on the rootfs partition (if accessible)
# On macOS we can't write to the ext4 rootfs, so we use a different approach:
# Create a custom userconf file that triggers on boot
ROOTFS=""
for candidate in /Volumes/rootfs /media/*/rootfs /mnt/rootfs; do
  if [ -d "$candidate/etc" ]; then
    ROOTFS="$candidate"
    break
  fi
done

if [ -n "$ROOTFS" ]; then
  # Linux: we can write directly to rootfs
  echo "  Found rootfs at: $ROOTFS"
  cp "$SCRIPT_DIR/intrlock-first-boot.service" "$ROOTFS/etc/systemd/system/"
  chmod 644 "$ROOTFS/etc/systemd/system/intrlock-first-boot.service"
  # Enable the service
  mkdir -p "$ROOTFS/etc/systemd/system/multi-user.target.wants"
  ln -sf /etc/systemd/system/intrlock-first-boot.service "$ROOTFS/etc/systemd/system/multi-user.target.wants/intrlock-first-boot.service"
  echo "  Service installed directly to rootfs"
else
  # macOS: can't write to ext4 rootfs — use the boot partition trick
  # The Pi's firstrun.sh mechanism (used by Pi Imager) runs scripts from boot
  # We append our setup to the end of firstrun.sh if it exists
  if [ -f "$BOOT_MOUNT/firstrun.sh" ]; then
    echo "" >> "$BOOT_MOUNT/firstrun.sh"
    echo "# Intrlock Bridge auto-install" >> "$BOOT_MOUNT/firstrun.sh"
    echo "bash /boot/firmware/intrlock-setup-service.sh" >> "$BOOT_MOUNT/firstrun.sh"
    echo "  Appended to existing firstrun.sh"
  else
    # Create a new firstrun.sh
    cat > "$BOOT_MOUNT/firstrun.sh" << 'FIRSTRUN'
#!/bin/bash
# Intrlock Bridge - runs on very first boot
bash /boot/firmware/intrlock-setup-service.sh
rm -f /boot/firmware/firstrun.sh
FIRSTRUN
    chmod +x "$BOOT_MOUNT/firstrun.sh"
    echo "  Created firstrun.sh"
  fi
fi

echo ""
echo "============================================"
echo "  SD Card is ready!"
echo "============================================"
echo ""
echo "  Next steps:"
echo "  1. Safely eject the SD card"
echo "  2. Insert it into your Raspberry Pi 5"
echo "  3. Plug in power"
echo "  4. Wait ~5 minutes (the Pi will:"
echo "     - Boot up"
echo "     - Connect to WiFi"
echo "     - Install Node.js"
echo "     - Download & start the Bridge agent"
echo "     - Auto-configure relay pins)"
echo "  5. Go to https://beta.intrlock.io"
echo "     → Access Control → Add System → Intrlock Bridge"
echo "     → Enter the serial number"
echo ""
echo "  To find the serial number later:"
echo "    ssh pi@intrlock-bridge.local"
echo "    cat /opt/intrlock-bridge/config.json"
echo ""
