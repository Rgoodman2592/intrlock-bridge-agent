#!/usr/bin/env python3
"""
Intrlock Bridge TFT Display — renders system health + activation codes to /dev/fb1.

Shows live system stats by default. Switches to activation code when one is active.

Usage:
  python3 display-activation.py              # Show health once
  python3 display-activation.py --loop       # Continuous refresh (run as service)
  python3 display-activation.py --generate   # Generate activation code + display
"""

import sys
import os
import json
import time
import urllib.request

API_BASE = "http://localhost:3000/api"
W, H = 480, 320  # Landscape render size

# Auto-detect the SPI TFT framebuffer device (could be fb0 or fb1)
def detect_fb_device():
    for fb in ["fb0", "fb1"]:
        try:
            with open(f"/sys/class/graphics/{fb}/name") as f:
                name = f.read().strip()
                if "ili" in name.lower() or "fbtft" in name.lower() or "fb_ili" in name.lower():
                    return f"/dev/{fb}", fb
        except:
            pass
    # Fallback: check virtual_size for 320x480 (SPI TFT signature)
    for fb in ["fb0", "fb1"]:
        try:
            with open(f"/sys/class/graphics/{fb}/virtual_size") as f:
                size = f.read().strip()
                if size in ("320,480", "480,320"):
                    return f"/dev/{fb}", fb
        except:
            pass
    return "/dev/fb0", "fb0"

FB_DEVICE, FB_NAME = detect_fb_device()

def get_fb_size():
    try:
        with open(f"/sys/class/graphics/{FB_NAME}/virtual_size") as f:
            w, h = f.read().strip().split(",")
            return int(w), int(h)
    except:
        return 320, 480

FB_WIDTH, FB_HEIGHT = get_fb_size()

# Colors
BG       = (0x0a, 0x0a, 0x1a)
SURFACE  = (0x14, 0x1e, 0x36)
ACCENT   = (0xe9, 0x45, 0x60)
GREEN    = (0x4a, 0xde, 0x80)
YELLOW   = (0xfb, 0xbf, 0x24)
RED      = (0xf8, 0x71, 0x71)
WHITE    = (0xee, 0xee, 0xee)
DIM      = (0x77, 0x77, 0x77)
BLUE     = (0x60, 0xa5, 0xfa)

def rgb_to_rgb565(r, g, b):
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)

def api_call(path, method="GET", data=None):
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode()
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}

def load_fonts():
    from PIL import ImageFont
    fonts = {}
    for font_path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]:
        if os.path.exists(font_path):
            try:
                fonts['huge']  = ImageFont.truetype(font_path, 72)
                fonts['large'] = ImageFont.truetype(font_path, 36)
                fonts['med']   = ImageFont.truetype(font_path, 20)
                fonts['small'] = ImageFont.truetype(font_path, 16)
                fonts['tiny']  = ImageFont.truetype(font_path, 13)
                return fonts
            except:
                pass
    default = ImageFont.load_default()
    return {'huge': default, 'large': default, 'med': default, 'small': default, 'tiny': default}

def draw_health(draw, fonts, sys_data, cam_data, rec_data):
    """Draw system health dashboard."""

    # ── Header ──
    draw.rectangle([(0, 0), (W, 32)], fill=SURFACE)
    draw.text((8, 6), "INTRLOCK CAMERA BRIDGE", fill=WHITE, font=fonts['small'])
    # Status dot
    draw.ellipse([(430, 10), (442, 22)], fill=GREEN)
    draw.text((446, 6), "LIVE", fill=GREEN, font=fonts['small'])

    # ── CPU + Memory Row ──
    y = 42
    cpu_temp = sys_data.get("cpu_temp")
    cpu_load = sys_data.get("cpu_load")
    mem_pct = sys_data.get("memory_percent")
    mem_used = sys_data.get("memory_used_mb")
    mem_total = sys_data.get("memory_total_mb")
    uptime = sys_data.get("uptime_seconds", 0)

    # CPU Temp — big number
    temp_str = f"{cpu_temp:.0f}°" if cpu_temp else "--"
    temp_color = GREEN if cpu_temp and cpu_temp < 65 else YELLOW if cpu_temp and cpu_temp < 80 else RED
    draw.text((10, y), "CPU", fill=DIM, font=fonts['tiny'])
    draw.text((10, y + 14), temp_str, fill=temp_color, font=fonts['large'])

    # CPU Load
    load_str = f"{cpu_load}%" if cpu_load is not None else "--"
    load_color = GREEN if cpu_load and cpu_load < 50 else YELLOW if cpu_load and cpu_load < 80 else RED
    draw.text((120, y), "LOAD", fill=DIM, font=fonts['tiny'])
    draw.text((120, y + 14), load_str, fill=load_color, font=fonts['large'])

    # Memory
    mem_str = f"{mem_pct}%" if mem_pct is not None else "--"
    mem_color = GREEN if mem_pct and mem_pct < 70 else YELLOW if mem_pct and mem_pct < 90 else RED
    draw.text((230, y), "RAM", fill=DIM, font=fonts['tiny'])
    draw.text((230, y + 14), mem_str, fill=mem_color, font=fonts['large'])
    if mem_used and mem_total:
        draw.text((230, y + 52), f"{mem_used}/{mem_total}MB", fill=DIM, font=fonts['tiny'])

    # Uptime
    hrs = uptime // 3600
    mins = (uptime % 3600) // 60
    up_str = f"{hrs}h {mins}m" if hrs > 0 else f"{mins}m"
    draw.text((350, y), "UPTIME", fill=DIM, font=fonts['tiny'])
    draw.text((350, y + 14), up_str, fill=BLUE, font=fonts['large'])

    # ── Divider ──
    draw.line([(10, 110), (470, 110)], fill=SURFACE, width=1)

    # ── Network ──
    y = 118
    draw.text((10, y), "NETWORK", fill=DIM, font=fonts['tiny'])
    net = sys_data.get("network", {})
    ny = y + 16
    for iface, info in net.items():
        ip = info.get("ip", "")
        draw.text((10, ny), f"{iface}:", fill=DIM, font=fonts['small'])
        draw.text((70, ny), ip, fill=WHITE, font=fonts['small'])
        ny += 20
        if ny > 170:
            break

    # ── Services ──
    draw.text((250, 118), "SERVICES", fill=DIM, font=fonts['tiny'])
    services = sys_data.get("services", {})
    sy = 134
    for name, status in services.items():
        color = GREEN if status == "active" else RED if status == "failed" else DIM
        draw.ellipse([(250, sy + 3), (258, sy + 11)], fill=color)
        draw.text((264, sy), name, fill=WHITE, font=fonts['small'])
        sy += 20
        if sy > 210:
            break

    # ── Divider ──
    draw.line([(10, 218), (470, 218)], fill=SURFACE, width=1)

    # ── Cameras ──
    y = 226
    draw.text((10, y), "CAMERAS", fill=DIM, font=fonts['tiny'])
    cameras = cam_data if isinstance(cam_data, list) else []
    if cameras:
        cx = 10
        for cam in cameras[:4]:
            name = cam.get("name", cam.get("id", "?"))[:12]
            rec = cam.get("recording_active", False)
            draw.text((cx, y + 16), name, fill=WHITE, font=fonts['tiny'])
            if rec:
                draw.ellipse([(cx + len(name) * 7 + 4, y + 19), (cx + len(name) * 7 + 12, y + 27)], fill=RED)
            cx += 120
    else:
        draw.text((10, y + 16), "No cameras", fill=DIM, font=fonts['small'])

    # ── DHCP Leases ──
    y = 264
    draw.text((10, y), "DHCP LEASES", fill=DIM, font=fonts['tiny'])
    leases = sys_data.get("dhcp_leases", [])
    if leases:
        lx = 10
        for lease in leases[:3]:
            ip = lease.get("ip", "")
            host = lease.get("hostname", "*")[:12]
            draw.text((lx, y + 16), f"{ip} ({host})", fill=DIM, font=fonts['tiny'])
            lx += 170
    else:
        draw.text((10, y + 16), "No leases", fill=DIM, font=fonts['tiny'])

    # ── Footer ──
    draw.text((W // 2, 305), sys_data.get("hostname", "intrlock-bridge"), fill=(0x30, 0x30, 0x50), font=fonts['tiny'], anchor="mm")

def draw_activation(draw, fonts, code_str, expires_in):
    """Draw activation code screen."""
    formatted = f"{code_str[:3]} - {code_str[3:]}"
    draw.text((W // 2, 45), "ACTIVATION CODE", fill=WHITE, font=fonts['med'], anchor="mm")
    draw.text((W // 2, 130), formatted, fill=ACCENT, font=fonts['huge'], anchor="mm")

    if expires_in > 0:
        mins = expires_in // 60
        secs = expires_in % 60
        timer_text = f"Expires in {mins}:{secs:02d}"
        color = DIM if expires_in > 180 else YELLOW if expires_in > 60 else RED
        draw.text((W // 2, 195), timer_text, fill=color, font=fonts['med'], anchor="mm")

    draw.text((W // 2, 260), "Enter this code in the", fill=DIM, font=fonts['small'], anchor="mm")
    draw.text((W // 2, 280), "Intrlock dashboard", fill=DIM, font=fonts['small'], anchor="mm")

def render_frame(fonts, sys_data, cam_data, rec_data, activation_code=None, activation_expires=0):
    """Render a single frame to the framebuffer."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    if activation_code and activation_expires > 0:
        draw_activation(draw, fonts, activation_code, activation_expires)
    else:
        draw_health(draw, fonts, sys_data, cam_data, rec_data)

    # Rotate for portrait framebuffer
    if FB_WIDTH == 320 and FB_HEIGHT == 480:
        img = img.rotate(-90, expand=True)

    write_rgb565(img)

def write_rgb565(img):
    if not os.path.exists(FB_DEVICE):
        img.save("/tmp/bridge-display.png")
        print("Saved to /tmp/bridge-display.png")
        return

    pixels = img.load()
    actual_w, actual_h = img.size
    buf = bytearray(FB_WIDTH * FB_HEIGHT * 2)

    for y in range(min(FB_HEIGHT, actual_h)):
        for x in range(min(FB_WIDTH, actual_w)):
            r, g, b = pixels[x, y]
            rgb565 = rgb_to_rgb565(r, g, b)
            offset = (y * FB_WIDTH + x) * 2
            buf[offset] = rgb565 & 0xFF
            buf[offset + 1] = (rgb565 >> 8) & 0xFF

    with open(FB_DEVICE, "wb") as fb:
        fb.write(buf)

def main():
    from PIL import ImageFont  # Ensure PIL is available
    loop_mode = "--loop" in sys.argv
    generate = "--generate" in sys.argv

    fonts = load_fonts()
    activation_code = None

    # Generate activation code if requested
    if generate:
        result = api_call("/activation/generate", method="POST")
        if result.get("ok"):
            activation_code = result["code"]
            print(f"Generated code: {activation_code} (expires in {result['expires_in']}s)")
        else:
            print(f"Generate failed: {result.get('message', result.get('error', 'unknown'))}")

    frame = 0
    while True:
        # Fetch system data
        sys_data = api_call("/system")
        cam_data = api_call("/cameras")
        rec_data = api_call("/recording/status")

        # Check for active activation code
        act_status = api_call("/activation/status")
        act_expires = act_status.get("expires_in", 0) if act_status.get("active") else 0

        render_frame(fonts, sys_data, cam_data, rec_data, activation_code, act_expires)

        if frame == 0:
            print(f"Display running ({FB_WIDTH}x{FB_HEIGHT})" + (" [loop]" if loop_mode else ""))

        if not loop_mode:
            break

        frame += 1
        time.sleep(2)  # Refresh every 2 seconds

if __name__ == "__main__":
    main()
