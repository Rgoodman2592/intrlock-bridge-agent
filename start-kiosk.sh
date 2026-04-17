#!/bin/bash
# Intrlock Kiosk Startup Script
# This runs as the xinitrc - X is already started when this executes

CFG="/opt/intrlock-bridge/config.json"

# Get screen dimensions
sleep 2
SCREEN_RES=$(xrandr 2>/dev/null | grep '*' | awk '{print $1}')
SCREEN_W=$(echo "$SCREEN_RES" | cut -d'x' -f1)
SCREEN_H=$(echo "$SCREEN_RES" | cut -d'x' -f2)

# Disable screensaver and power management
xset s off
xset -dpms
xset s noblank

# Hide cursor after 3 seconds
unclutter -idle 3 -root &

# Determine URL
ACT=$(jq -r '.activated' "$CFG" 2>/dev/null)
KURL=$(jq -r '.kiosk_url' "$CFG" 2>/dev/null)
if [ "$ACT" = "true" ] && [ -n "$KURL" ] && [ "$KURL" != "null" ]; then
  URL="$KURL"
else
  URL="file:///opt/intrlock-bridge/activation-page.html"
fi

# Launch Chromium in kiosk mode
CHROME=$(command -v chromium || command -v chromium-browser || echo chromium)
exec $CHROME \
  --kiosk \
  --no-sandbox \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --no-first-run \
  --start-fullscreen \
  --disable-gpu \
  --autoplay-policy=no-user-gesture-required \
  --window-position=0,0 \
  --window-size=${SCREEN_W:-1280},${SCREEN_H:-720} \
  "$URL"
