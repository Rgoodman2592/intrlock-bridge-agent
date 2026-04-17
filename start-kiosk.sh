#!/bin/bash
# Intrlock Kiosk Startup Script
# This runs as the xinitrc - X is already started when this executes

CFG="/opt/intrlock-bridge/config.json"

# Rotate display for horizontal 5" screen
xrandr --output DSI-1 --rotate right 2>/dev/null

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
  "$URL"
