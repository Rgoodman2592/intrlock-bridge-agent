#!/usr/bin/env python3
"""
Render activation code on the SPI TFT display (320x480 framebuffer, landscape via rotation).
Fetches code from the local dashboard API and draws it to /dev/fb1.

Usage:
  python3 display-activation.py          # Generate + display
  python3 display-activation.py --loop   # Continuously update until expired
"""

import sys
import os
import json
import time
import urllib.request

API_BASE = "http://localhost:3000/api"
FB_DEVICE = "/dev/fb1"

# Detect framebuffer size from sysfs, fall back to 320x480
def get_fb_size():
    try:
        with open("/sys/class/graphics/fb1/virtual_size") as f:
            w, h = f.read().strip().split(",")
            return int(w), int(h)
    except:
        return 320, 480

FB_WIDTH, FB_HEIGHT = get_fb_size()

# Colors (RGB)
BG_COLOR = (0x0a, 0x0a, 0x1a)
ACCENT_COLOR = (0xe9, 0x45, 0x60)
TEXT_COLOR = (0xee, 0xee, 0xee)
DIM_COLOR = (0x88, 0x88, 0x88)

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

def draw_to_framebuffer(code_str, expires_in):
    """Draw activation code to framebuffer. Renders in landscape (480x320) then rotates to match fb."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("ERROR: python3-pil not installed")
        sys.exit(1)

    # Draw in landscape orientation (480 wide x 320 tall)
    W, H = 480, 320
    img = Image.new("RGB", (W, H), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Load fonts
    font_code = font_label = font_small = None
    for font_path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]:
        if os.path.exists(font_path):
            try:
                font_code = ImageFont.truetype(font_path, 80)
                font_label = ImageFont.truetype(font_path, 22)
                font_small = ImageFont.truetype(font_path, 18)
                break
            except:
                pass

    if not font_code:
        font_code = ImageFont.load_default()
        font_label = font_code
        font_small = font_code

    if code_str and code_str != "------":
        # ── Show activation code ──
        formatted = f"{code_str[:3]} - {code_str[3:]}"

        # Code centered and huge
        draw.text((W // 2, 120), formatted, fill=ACCENT_COLOR, font=font_code, anchor="mm")

        # Label above
        draw.text((W // 2, 45), "ACTIVATION CODE", fill=TEXT_COLOR, font=font_label, anchor="mm")

        # Timer below
        if expires_in > 0:
            mins = expires_in // 60
            secs = expires_in % 60
            timer_text = f"Expires in {mins}:{secs:02d}"
            color = DIM_COLOR
            if expires_in <= 60:
                color = ACCENT_COLOR
            elif expires_in <= 180:
                color = (0xfb, 0xbf, 0x24)
            draw.text((W // 2, 185), timer_text, fill=color, font=font_label, anchor="mm")

        # Instructions
        draw.text((W // 2, 250), "Enter this code in the", fill=DIM_COLOR, font=font_small, anchor="mm")
        draw.text((W // 2, 275), "Intrlock dashboard", fill=DIM_COLOR, font=font_small, anchor="mm")

    else:
        # ── No code ──
        draw.text((W // 2, 140), "No active code", fill=DIM_COLOR, font=font_label, anchor="mm")
        draw.text((W // 2, 180), "Generate from dashboard", fill=DIM_COLOR, font=font_small, anchor="mm")

    # Rotate image to match framebuffer orientation
    # FB is 320x480 (portrait), we drew 480x320 (landscape)
    # Rotate 90° clockwise so landscape content displays correctly
    if FB_WIDTH == 320 and FB_HEIGHT == 480:
        img = img.rotate(-90, expand=True)

    # Write to framebuffer as RGB565
    write_rgb565(img, FB_WIDTH, FB_HEIGHT)

def write_rgb565(img, width, height):
    """Convert PIL image to RGB565 and write to framebuffer device."""
    if not os.path.exists(FB_DEVICE):
        print(f"Framebuffer {FB_DEVICE} not found.")
        img.save("/tmp/activation-display.png")
        print("Saved preview to /tmp/activation-display.png")
        return

    pixels = img.load()
    actual_w, actual_h = img.size
    buf = bytearray(width * height * 2)

    for y in range(min(height, actual_h)):
        for x in range(min(width, actual_w)):
            r, g, b = pixels[x, y]
            rgb565 = rgb_to_rgb565(r, g, b)
            offset = (y * width + x) * 2
            buf[offset] = rgb565 & 0xFF
            buf[offset + 1] = (rgb565 >> 8) & 0xFF

    with open(FB_DEVICE, "wb") as fb:
        fb.write(buf)
    print(f"Written {len(buf)} bytes to {FB_DEVICE} ({width}x{height})")

def main():
    loop_mode = "--loop" in sys.argv
    generate = "--generate" in sys.argv or not loop_mode

    result = {}
    if generate:
        result = api_call("/activation/generate", method="POST")
        if result.get("ok"):
            print(f"Generated code: {result['code']} (expires in {result['expires_in']}s)")
        elif result.get("error"):
            print(f"API error: {result['error']}")
        else:
            print(f"Generate failed: {result.get('message', 'unknown error')}")

    while True:
        status = api_call("/activation/status")
        if status.get("active") and result.get("ok"):
            code = result["code"]
            expires_in = status.get("expires_in", 0)
            draw_to_framebuffer(code, expires_in)
        elif status.get("active"):
            draw_to_framebuffer("------", status.get("expires_in", 0))
        else:
            draw_to_framebuffer(None, 0)

        if not loop_mode:
            break

        time.sleep(1)

if __name__ == "__main__":
    main()
