#!/bin/bash
set -e

MEDIAMTX_VERSION="1.9.0"
INSTALL_DIR="/opt/mediamtx"

echo "[CAMERA] Installing MediaMTX v${MEDIAMTX_VERSION}..."

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  aarch64) TARBALL="mediamtx_v${MEDIAMTX_VERSION}_linux_arm64v8.tar.gz" ;;
  armv7l)  TARBALL="mediamtx_v${MEDIAMTX_VERSION}_linux_armv7.tar.gz" ;;
  armv6l)  TARBALL="mediamtx_v${MEDIAMTX_VERSION}_linux_armv6.tar.gz" ;;
  x86_64)  TARBALL="mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz" ;;
  *)       echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
esac

URL="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/${TARBALL}"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "  Downloading ${TARBALL}..."
curl -sSL "$URL" -o mediamtx.tar.gz
tar xzf mediamtx.tar.gz
rm -f mediamtx.tar.gz
chmod +x mediamtx

echo "  MediaMTX installed to ${INSTALL_DIR}/mediamtx"

# Install v4l-utils for USB camera support
echo "  Installing v4l-utils..."
apt-get install -y -qq v4l-utils 2>/dev/null || true

# Install libcamera for Pi camera support
echo "  Installing libcamera tools..."
apt-get install -y -qq libcamera-tools 2>/dev/null || true

echo "[CAMERA] MediaMTX installation complete"
