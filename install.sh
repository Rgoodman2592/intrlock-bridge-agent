#!/bin/bash
set -e

echo "============================================"
echo "  Intrlock Bridge Agent Installer"
echo "============================================"
echo ""

INSTALL_DIR="/opt/intrlock-bridge"
REPO_URL="https://github.com/Rgoodman2592/intrlock-bridge-agent.git"
NODE_VERSION="20"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Please run as root (use sudo)"
  exit 1
fi

# Step 1: Update system
echo "[1/8] Updating system packages..."
apt-get update -qq
apt-get install -y -qq python3-pip python3-pil python3-spidev gpiod libgpiod-dev 2>/dev/null || true

# Step 1b: Install camera dependencies
echo "  Installing camera dependencies..."
apt-get install -y -qq v4l-utils libcamera-tools 2>/dev/null || true

# Step 2: Install Node.js 20
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt $NODE_VERSION ]]; then
  echo "[2/8] Installing Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
else
  echo "[2/8] Node.js $(node -v) already installed"
fi

# Step 3: Install git if needed
if ! command -v git &> /dev/null; then
  echo "[3/8] Installing git..."
  apt-get install -y -qq git
else
  echo "[3/8] git already installed"
fi

# Step 4: Ensure NTP time sync
echo "[4/8] Configuring time sync..."
timedatectl set-ntp true 2>/dev/null || true
systemctl enable systemd-timesyncd 2>/dev/null || true
systemctl start systemd-timesyncd 2>/dev/null || true

# Wait for time sync (max 60 seconds)
for i in $(seq 1 12); do
  if timedatectl status 2>/dev/null | grep -q "synchronized: yes"; then
    echo "  Time synchronized"
    break
  fi
  echo "  Waiting for time sync... ($((i*5))s)"
  sleep 5
done

# Step 5: Configure DNS fallback
echo "[5/8] Configuring DNS fallback..."
if ! grep -q "8.8.8.8" /etc/resolv.conf 2>/dev/null; then
  echo "nameserver 8.8.8.8" >> /etc/resolv.conf
  echo "nameserver 1.1.1.1" >> /etc/resolv.conf
fi

# Step 6: Clone or update the agent
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[6/8] Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  echo "[6/8] Installing Intrlock Bridge Agent..."
  rm -rf "$INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# Step 7: Install Node dependencies and Python e-ink libraries
echo "[7/8] Installing dependencies..."
npm install --production --quiet 2>/dev/null

# Install Python libraries for e-ink display (--break-system-packages for Bookworm+)
echo "  Installing Python e-ink libraries..."
pip3 install qrcode pillow spidev --break-system-packages --quiet 2>/dev/null || \
  pip3 install qrcode pillow spidev --quiet 2>/dev/null || true

# Enable SPI interface (required for e-ink display)
echo "  Enabling SPI interface..."
raspi-config nonint do_spi 0 2>/dev/null || true
# Also set via config.txt directly as a fallback
if ! grep -q "^dtparam=spi=on" /boot/firmware/config.txt 2>/dev/null; then
  echo "dtparam=spi=on" >> /boot/firmware/config.txt 2>/dev/null || true
fi
if ! grep -q "^dtparam=spi=on" /boot/config.txt 2>/dev/null; then
  echo "dtparam=spi=on" >> /boot/config.txt 2>/dev/null || true
fi

# Download Amazon Root CA
mkdir -p "$INSTALL_DIR/certs"
if [ ! -f "$INSTALL_DIR/certs/AmazonRootCA1.pem" ]; then
  echo "  Downloading Amazon Root CA..."
  curl -sSL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$INSTALL_DIR/certs/AmazonRootCA1.pem"
fi

# Step 8: Install MediaMTX for camera streaming
echo "[8/9] Installing MediaMTX..."
chmod +x "$INSTALL_DIR/scripts/install-mediamtx.sh"
bash "$INSTALL_DIR/scripts/install-mediamtx.sh"

# Step 9: Create and enable systemd service
echo "[9/9] Configuring systemd service..."
cp "$INSTALL_DIR/systemd/intrlock-bridge.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable intrlock-bridge
systemctl restart intrlock-bridge

echo ""
echo "============================================"
echo "  Intrlock Bridge Agent Installed!"
echo "============================================"
echo ""

# Wait a moment for the agent to start and generate config
sleep 3

# Display device info
if [ -f "$INSTALL_DIR/config.json" ]; then
  DEVICE_ID=$(grep -o '"device_id":\s*"[^"]*"' "$INSTALL_DIR/config.json" | cut -d'"' -f4)
  SERIAL=$(grep -o '"serial_number":\s*"[^"]*"' "$INSTALL_DIR/config.json" | cut -d'"' -f4)
  echo "  Device ID:     $DEVICE_ID"
  echo "  Serial Number: $SERIAL"
  echo ""
  echo "  To claim this device:"
  echo "  1. Go to https://beta.intrlock.io"
  echo "  2. Access Control → Add System → Intrlock Bridge"
  echo "  3. Enter serial: $SERIAL"
  echo ""
fi

echo "  Service status: systemctl status intrlock-bridge"
echo "  View logs:      journalctl -u intrlock-bridge -f"
echo ""
