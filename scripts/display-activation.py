#!/usr/bin/env python3
"""
Render activation code on the SPI TFT display (480x320 framebuffer).
Fetches code from the local dashboard API and draws it to /dev/fb1.

Usage:
  python3 display-activation.py          # Generate + display
  python3 display-activation.py --loop   # Continuously update until expired
"""

import sys
import os
import json
import struct
import time
import urllib.request

API_BASE = "http://localhost:3000/api"
FB_DEVICE = "/dev/fb1"
WIDTH = 480
HEIGHT = 320

# Colors (RGB565)
BG_COLOR = (0x1a, 0x1a, 0x2e)       # Dark navy
ACCENT_COLOR = (0xe9, 0x45, 0x60)    # Red/pink
TEXT_COLOR = (0xee, 0xee, 0xee)      # White
DIM_COLOR = (0x99, 0x99, 0x99)       # Gray
GREEN_COLOR = (0x4a, 0xde, 0x80)     # Green

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

def draw_to_framebuffer(code_str, expires_in, hostname="intrlock-bridge"):
    """Draw activation code screen to framebuffer using PIL."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("ERROR: python3-pil not installed. Run: sudo apt install python3-pil")
        sys.exit(1)

    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Try to load a monospace font, fall back to default
    font_large = None
    font_medium = None
    font_small = None
    for font_path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]:
        if os.path.exists(font_path):
            try:
                font_large = ImageFont.truetype(font_path, 72)
                font_medium = ImageFont.truetype(font_path, 24)
                font_small = ImageFont.truetype(font_path, 16)
                break
            except:
                pass

    if not font_large:
        font_large = ImageFont.load_default()
        font_medium = font_large
        font_small = font_large

    # Header bar
    draw.rectangle([(0, 0), (WIDTH, 40)], fill=(0x16, 0x21, 0x3e))
    draw.text((12, 8), "INTRLOCK CAMERA BRIDGE", fill=TEXT_COLOR, font=font_small)

    # Status dot
    draw.ellipse([(440, 14), (452, 26)], fill=GREEN_COLOR)
    draw.text((456, 8), "OK", fill=GREEN_COLOR, font=font_small)

    # Title
    draw.text((WIDTH // 2, 70), "ACTIVATION CODE", fill=DIM_COLOR, font=font_medium, anchor="mm")

    # Code display
    if code_str:
        formatted = f"{code_str[:3]}  –  {code_str[3:]}"
        draw.text((WIDTH // 2, 155), formatted, fill=ACCENT_COLOR, font=font_large, anchor="mm")

        # Timer
        if expires_in > 0:
            mins = expires_in // 60
            secs = expires_in % 60
            timer_text = f"Expires in {mins}:{secs:02d}"
            color = DIM_COLOR
            if expires_in <= 60:
                color = ACCENT_COLOR
            elif expires_in <= 180:
                color = (0xfb, 0xbf, 0x24)  # Yellow
            draw.text((WIDTH // 2, 210), timer_text, fill=color, font=font_medium, anchor="mm")
        else:
            draw.text((WIDTH // 2, 210), "EXPIRED", fill=ACCENT_COLOR, font=font_medium, anchor="mm")
    else:
        draw.text((WIDTH // 2, 150), "No active code", fill=DIM_COLOR, font=font_medium, anchor="mm")
        draw.text((WIDTH // 2, 185), "Generate from dashboard", fill=DIM_COLOR, font=font_small, anchor="mm")

    # Footer
    draw.text((WIDTH // 2, 265), "Enter this code in the Intrlock dashboard", fill=DIM_COLOR, font=font_small, anchor="mm")
    draw.text((WIDTH // 2, 285), "to link this bridge's cameras", fill=DIM_COLOR, font=font_small, anchor="mm")

    # Hostname + IP
    draw.text((WIDTH // 2, 310), hostname, fill=(0x0f, 0x34, 0x60), font=font_small, anchor="mm")

    # Convert to RGB565 and write to framebuffer
    write_rgb565(img)

def write_rgb565(img):
    """Convert PIL image to RGB565 and write to framebuffer device."""
    if not os.path.exists(FB_DEVICE):
        print(f"Framebuffer {FB_DEVICE} not found. Display overlay may not be loaded.")
        # Save as PNG for debugging
        img.save("/tmp/activation-display.png")
        print("Saved preview to /tmp/activation-display.png")
        return

    pixels = img.load()
    buf = bytearray(WIDTH * HEIGHT * 2)
    for y in range(HEIGHT):
        for x in range(WIDTH):
            r, g, b = pixels[x, y]
            rgb565 = rgb_to_rgb565(r, g, b)
            offset = (y * WIDTH + x) * 2
            buf[offset] = rgb565 & 0xFF
            buf[offset + 1] = (rgb565 >> 8) & 0xFF

    with open(FB_DEVICE, "wb") as fb:
        fb.write(buf)
    print(f"Written {len(buf)} bytes to {FB_DEVICE}")

def main():
    loop_mode = "--loop" in sys.argv
    generate = "--generate" in sys.argv or not loop_mode

    # Generate a new code if requested
    if generate:
        result = api_call("/activation/generate", method="POST")
        if result.get("ok"):
            print(f"Generated code: {result['code']} (expires in {result['expires_in']}s)")
        elif result.get("error"):
            print(f"API error: {result['error']}")
        else:
            print(f"Generate failed: {result.get('message', 'unknown error')}")

    # Display loop
    while True:
        status = api_call("/activation/status")
        if status.get("active"):
            # We need the actual code — generate returns it, status doesn't
            # If we just generated, use that. Otherwise show masked.
            if generate and result.get("ok"):
                code = result["code"]
            else:
                code = "------"
            expires_in = status.get("expires_in", 0)
            draw_to_framebuffer(code, expires_in)
        else:
            draw_to_framebuffer(None, 0)

        if not loop_mode:
            break

        time.sleep(1)

if __name__ == "__main__":
    main()
