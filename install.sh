#!/bin/bash
set -e

INSTALL_DIR="/opt/intrlock-bridge"
DEVICE_TYPE="${1:-panel}"

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   Intrlock Bridge Installer                    ║"
echo "║   Device Type: $DEVICE_TYPE                    ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "❌ Run as root: sudo bash install.sh"
  exit 1
fi

echo "📦 [1/8] Updating system..."
apt-get update -qq
apt-get install -y -qq git curl jq qrencode ffmpeg

if [ "$DEVICE_TYPE" = "panel" ]; then
  echo "📦 [2/8] Installing display packages..."
  apt-get install -y -qq xserver-xorg x11-xserver-utils xinit openbox unclutter pulseaudio alsa-utils libcamera-apps
  apt-get install -y -qq chromium 2>/dev/null || apt-get install -y -qq chromium-browser 2>/dev/null || echo "⚠️  Chromium not found — install manually: sudo apt install chromium"

  echo "📦 [3/8] Disabling desktop environment for kiosk mode..."
  # Stop any running desktop
  systemctl stop labwc-pi 2>/dev/null || true
  systemctl stop lightdm 2>/dev/null || true
  systemctl stop gdm3 2>/dev/null || true
  # Disable desktop services
  systemctl disable labwc-pi 2>/dev/null || true
  systemctl disable lightdm 2>/dev/null || true
  systemctl disable gdm3 2>/dev/null || true
  # Switch to console boot
  systemctl set-default multi-user.target
  # Use raspi-config if available (sets boot to CLI with autologin)
  if command -v raspi-config &>/dev/null; then
    raspi-config nonint do_boot_behaviour B2
  fi
  # Kill any leftover X/Wayland sessions
  killall Xwayland 2>/dev/null || true
  killall labwc 2>/dev/null || true
  killall Xorg 2>/dev/null || true
  # Clean stale X locks
  rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
  echo "   Desktop disabled, kiosk will own the display"
else
  echo "📦 [2/8] Skipping display packages (not a panel)..."
  echo "📦 [3/8] Skipping desktop config (not a panel)..."
fi

echo "📦 [4/8] Installing Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "   Node $(node -v)"

echo "📦 [5/8] Installing MediaMTX..."
MEDIAMTX_DIR="/opt/mediamtx"
if [ ! -f "$MEDIAMTX_DIR/mediamtx" ]; then
  mkdir -p "$MEDIAMTX_DIR"
  ARCH=$(dpkg --print-architecture)
  [ "$ARCH" = "arm64" ] && MTX_ARCH="arm64v8" || MTX_ARCH="armv7"
  curl -sL "https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_${MTX_ARCH}.tar.gz" | tar xz -C "$MEDIAMTX_DIR"
fi

echo "📦 [6/8] Installing Bridge Agent..."
mkdir -p "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR" && git pull
else
  git clone https://github.com/Rgoodman2592/intrlock-bridge-agent.git "$INSTALL_DIR"
fi
cd "$INSTALL_DIR" && npm install --production 2>/dev/null

echo "⚙️  [7/8] Configuring device..."
SERIAL=$(grep Serial /proc/cpuinfo | awk '{print $3}' || echo "unknown")
IFACE=$(ip route show default 2>/dev/null | awk '{print $5}' | head -1)
MAC=$(cat /sys/class/net/${IFACE:-eth0}/address 2>/dev/null || echo "00:00:00:00:00:00")
DEVICE_ID="${DEVICE_TYPE}-$(echo $MAC | tr -d ':')"
VERIFY=$(echo -n "intrlock:${SERIAL}:${MAC}:${DEVICE_TYPE}" | sha256sum | cut -c1-6)
QR_PAYLOAD="intrlock://device/${DEVICE_TYPE}/${MAC}/${VERIFY}"

cat > "$INSTALL_DIR/config.json" << CONF
{
  "device_id": "${DEVICE_ID}",
  "serial_number": "${SERIAL}",
  "device_type": "${DEVICE_TYPE}",
  "mac_address": "${MAC}",
  "qr_payload": "${QR_PAYLOAD}",
  "verification_code": "${VERIFY}",
  "mqtt_endpoint": "a2hqnbt5x2s8et-ats.iot.us-east-1.amazonaws.com",
  "health_interval_ms": 60000,
  "kiosk_url": "",
  "property_id": null,
  "activated": false
}
CONF

qrencode -o "$INSTALL_DIR/device-qr.png" -s 10 -m 2 "$QR_PAYLOAD" 2>/dev/null && echo "   QR code generated" || echo "   QR generation skipped"

echo "🚀 [8/8] Setting up services..."

# Bridge agent service
cat > /etc/systemd/system/intrlock-bridge.service << 'SVC'
[Unit]
Description=Intrlock Bridge Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/opt/intrlock-bridge
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=BRIDGE_DIR=/opt/intrlock-bridge
[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable intrlock-bridge.service
systemctl start intrlock-bridge.service

# Panel-specific setup
if [ "$DEVICE_TYPE" = "panel" ]; then

  # Kiosk launch script
  cat > "$INSTALL_DIR/start-kiosk.sh" << 'KSK'
#!/bin/bash
# Clean stale X locks before starting
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0

CFG="/opt/intrlock-bridge/config.json"
ACT=$(jq -r '.activated' "$CFG" 2>/dev/null)
KURL=$(jq -r '.kiosk_url' "$CFG" 2>/dev/null)
if [ "$ACT" = "true" ] && [ -n "$KURL" ] && [ "$KURL" != "null" ]; then
  URL="$KURL"
else
  URL="file:///opt/intrlock-bridge/activation-page.html"
fi

xset s off
xset -dpms
xset s noblank
unclutter -idle 3 -root &

CHROME=$(command -v chromium || command -v chromium-browser || echo chromium)
$CHROME --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run --start-fullscreen --autoplay-policy=no-user-gesture-required --use-gl=egl "$URL"
KSK
  chmod +x "$INSTALL_DIR/start-kiosk.sh"

  # Activation page
  cat > "$INSTALL_DIR/activation-page.html" << 'HTML'
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Intrlock Setup</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:linear-gradient(135deg,#0f2440,#081829);color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px}.logo{font-size:48px;font-weight:800;margin-bottom:8px}.sub{font-size:18px;color:rgba(255,255,255,.5);margin-bottom:48px}.qr{background:#fff;border-radius:24px;padding:24px;margin-bottom:32px;box-shadow:0 20px 60px rgba(0,0,0,.3)}.qr img{width:240px;height:240px}.inst{font-size:20px;font-weight:600;margin-bottom:12px}.det{font-size:14px;color:rgba(255,255,255,.4);max-width:400px;line-height:1.6}.mac{font-family:monospace;font-size:14px;color:rgba(255,255,255,.3);margin-top:24px;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.5}}</style></head>
<body><div class="logo">Intrlock</div><div class="sub">Intercom Panel</div><div class="qr"><img src="device-qr.png"></div><div class="inst">Scan QR code to activate</div><div class="det">Open <strong>app.intrlock.io</strong> → Devices → Scan QR</div><div class="mac" id="m"></div>
<script>fetch('config.json').then(r=>r.json()).then(d=>{document.getElementById('m').textContent='MAC: '+d.mac_address}).catch(()=>{});setInterval(()=>{fetch('config.json').then(r=>r.json()).then(d=>{if(d.activated&&d.kiosk_url)location.href=d.kiosk_url}).catch(()=>{})},10000)</script></body></html>
HTML

  # Openbox autostart
  mkdir -p /etc/xdg/openbox
  echo '/opt/intrlock-bridge/start-kiosk.sh &' > /etc/xdg/openbox/autostart

  # Kiosk systemd service - unmask first in case of previous broken install
  systemctl unmask intrlock-kiosk.service 2>/dev/null || true
  rm -f /etc/systemd/system/intrlock-kiosk.service

  KUSER=$(ls /home/ | head -1 || echo pi)
  cat > /etc/systemd/system/intrlock-kiosk.service << KVC
[Unit]
Description=Intrlock Kiosk
After=network-online.target
Wants=network-online.target

[Service]
User=${KUSER}
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 5
ExecStartPre=/bin/bash -c 'rm -f /tmp/.X0-lock /tmp/.X11-unix/X0'
ExecStart=/usr/bin/xinit /usr/bin/openbox-session -- :0 -nocursor
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
KVC

  systemctl daemon-reload
  systemctl enable intrlock-kiosk.service
  systemctl start intrlock-kiosk.service
fi

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   ✅ Installation Complete!                     ║"
echo "╠════════════════════════════════════════════════╣"
echo "║   Device: ${DEVICE_ID}"
echo "║   MAC: ${MAC}"
echo "║   Type: ${DEVICE_TYPE}"
echo "║   QR: ${QR_PAYLOAD}"
echo "╚════════════════════════════════════════════════╝"
echo ""
echo "⚡ Rebooting in 5 seconds... (Ctrl+C to cancel)"
sleep 5
reboot
