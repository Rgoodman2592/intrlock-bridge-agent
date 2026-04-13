# Intrlock Bridge

Raspberry Pi relay controller for access control systems. Bridges local GPIO control with AWS IoT Core for cloud-based device management and automation.

## Quick Start

1. **Flash SD Card** — Use Raspberry Pi Imager to install Raspberry Pi OS on your SD card
2. **Wire Relay Board** — Connect Inland 350892 relay board using GPIO pins (see diagram below)
3. **Run Install Script** — Execute the automated setup:
   ```
   curl -sSL https://raw.githubusercontent.com/Rgoodman2592/intrlock-bridge-agent/main/install.sh | sudo bash
   ```
4. **Claim on Dashboard** — Register your device at the command center to enable remote control

## GPIO Wiring Diagram

Connect Inland 350892 relay board to Raspberry Pi 5:

| Relay Pin | Raspberry Pi Pin | GPIO |
|-----------|------------------|------|
| VCC       | Pin 2 (5V)       | —    |
| GND       | Pin 6 (GND)      | —    |
| IN1       | Pin 11           | GPIO17 |
| IN2       | Pin 13           | GPIO27 |
| IN3       | Pin 15           | GPIO22 |
| IN4       | Pin 16           | GPIO23 |

## Requirements

- Raspberry Pi 5
- Node.js 20 or higher
- Inland 350892 relay board or compatible
- AWS IoT Core certificates (device key and certificate)

## Endpoints

- **IoT Endpoint:** `a2hqnbt5x2s8et-ats.iot.us-east-1.amazonaws.com`
- **API Endpoint:** `https://ovle12ewnh.execute-api.us-east-1.amazonaws.com`

## Configuration

Device configuration is stored at `/opt/intrlock-bridge/config.json` and automatically generated on first run. Update the configuration through the dashboard or by directly editing the config file.

## Support

For issues or questions, contact DHS support or visit the Intrlock command center dashboard.
