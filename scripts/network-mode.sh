#!/bin/bash
# Intrlock Bridge — Network Mode Auto-Detection
#
# Determines whether eth0 should run in:
#   CLIENT mode — join existing network via DHCP (customer site)
#   STANDALONE mode — run own DHCP server for direct-connected cameras
#
# Logic:
#   1. Try DHCP on eth0 for 10 seconds
#   2. If we get an IP → CLIENT mode (disable dnsmasq, use DHCP IP)
#   3. If no response → STANDALONE mode (assign static IP, start dnsmasq)
#
# Run this BEFORE intrlock-bridge.service and intrlock-mediamtx.service
# Writes result to /tmp/intrlock-network-mode (read by other services)

set -e

IFACE="eth0"
MODE_FILE="/tmp/intrlock-network-mode"
STATIC_IP="192.168.1.50"
DNSMASQ_CONF="/etc/dnsmasq.d/camera-dhcp.conf"
DHCP_TIMEOUT=10

log() {
    echo "[NETWORK] $1"
    logger -t intrlock-network "$1"
}

# Check if eth0 exists
if ! ip link show "$IFACE" &>/dev/null; then
    log "No $IFACE interface found — skipping network setup"
    echo "none" > "$MODE_FILE"
    exit 0
fi

# Bring interface up
ip link set "$IFACE" up
sleep 2

# Check if eth0 already has a DHCP-assigned IP (from NetworkManager or dhclient)
EXISTING_IP=$(ip -4 addr show "$IFACE" | grep -oP 'inet \K[0-9.]+' | head -1)
if [ -n "$EXISTING_IP" ] && [ "$EXISTING_IP" != "$STATIC_IP" ]; then
    log "eth0 already has IP $EXISTING_IP — CLIENT mode"
    echo "client" > "$MODE_FILE"
    echo "$EXISTING_IP" > /tmp/intrlock-eth0-ip
    # Make sure dnsmasq isn't serving DHCP on this interface
    systemctl stop dnsmasq 2>/dev/null || true
    systemctl disable dnsmasq 2>/dev/null || true
    exit 0
fi

# Try to get a DHCP lease
log "Trying DHCP on $IFACE (${DHCP_TIMEOUT}s timeout)..."

# Flush any static IPs first
ip addr flush dev "$IFACE" 2>/dev/null || true
ip link set "$IFACE" up

# Use dhclient with timeout
DHCP_SUCCESS=false
if command -v dhclient &>/dev/null; then
    timeout "$DHCP_TIMEOUT" dhclient -1 -v "$IFACE" 2>/dev/null && DHCP_SUCCESS=true
elif command -v dhcpcd &>/dev/null; then
    timeout "$DHCP_TIMEOUT" dhcpcd -1 -w "$IFACE" 2>/dev/null && DHCP_SUCCESS=true
else
    # Try nmcli as fallback
    nmcli device connect "$IFACE" 2>/dev/null
    sleep "$DHCP_TIMEOUT"
    NEW_IP=$(ip -4 addr show "$IFACE" | grep -oP 'inet \K[0-9.]+' | head -1)
    if [ -n "$NEW_IP" ]; then
        DHCP_SUCCESS=true
    fi
fi

# Check if we got an IP
GOT_IP=$(ip -4 addr show "$IFACE" | grep -oP 'inet \K[0-9.]+' | head -1)

if [ "$DHCP_SUCCESS" = true ] && [ -n "$GOT_IP" ]; then
    # ── CLIENT MODE ──
    log "DHCP success — got $GOT_IP — CLIENT mode"
    echo "client" > "$MODE_FILE"
    echo "$GOT_IP" > /tmp/intrlock-eth0-ip

    # Disable dnsmasq — don't serve DHCP on someone else's network
    systemctl stop dnsmasq 2>/dev/null || true
    systemctl disable dnsmasq 2>/dev/null || true

    # Remove default route via eth0 if wlan0 has internet
    # (prevents eth0 from becoming default gateway and breaking wifi)
    if ip route | grep -q "default.*wlan0"; then
        ip route del default dev "$IFACE" 2>/dev/null || true
    fi
else
    # ── STANDALONE MODE ──
    log "No DHCP response — STANDALONE mode"
    echo "standalone" > "$MODE_FILE"

    # Assign static IPs for common camera subnets
    ip addr add ${STATIC_IP}/24 dev "$IFACE" 2>/dev/null || true
    ip addr add 169.254.1.1/16 dev "$IFACE" 2>/dev/null || true
    ip addr add 172.16.0.50/24 dev "$IFACE" 2>/dev/null || true
    ip addr add 192.168.0.50/24 dev "$IFACE" 2>/dev/null || true

    echo "$STATIC_IP" > /tmp/intrlock-eth0-ip

    # Remove default route via eth0 (keep internet on wlan0)
    ip route del default dev "$IFACE" 2>/dev/null || true

    # Enable and start dnsmasq for camera DHCP
    systemctl enable dnsmasq 2>/dev/null || true
    systemctl start dnsmasq 2>/dev/null || true
fi

log "Network mode: $(cat $MODE_FILE), eth0 IP: $(cat /tmp/intrlock-eth0-ip)"
