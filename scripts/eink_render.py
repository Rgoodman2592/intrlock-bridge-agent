#!/usr/bin/env python3
"""
Intrlock Bridge — E-ink display renderer
Target hardware: Inland MC221887 1.54" 200x200 e-ink (SSD1681 controller, Waveshare clone)
SPI bus: SPI0 (CE0)
Non-standard GPIO pins configurable via --dc / --rst / --busy flags.
"""

import argparse
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description='Intrlock e-ink renderer')
    p.add_argument('--action', choices=['qr', 'clear', 'status'], required=True)
    p.add_argument('--url',  default='')
    p.add_argument('--text', default='')
    p.add_argument('--dc',   type=int, default=16)
    p.add_argument('--rst',  type=int, default=20)
    p.add_argument('--busy', type=int, default=21)
    return p.parse_args()

# ---------------------------------------------------------------------------
# GPIO helpers — use gpiod (Pi 5 compatible) via gpioset/gpioget subprocess
# ---------------------------------------------------------------------------

GPIOCHIP = 'gpiochip4'  # Pi 5 uses gpiochip4 for the main GPIO bank

def _gpio_set(pin, value):
    """Set a GPIO pin high (1) or low (0) via gpioset."""
    try:
        subprocess.run(
            ['gpioset', '--mode=time', '--usec=1', GPIOCHIP, f'{pin}={value}'],
            check=True, timeout=2
        )
    except Exception:
        # Fallback: try gpiochip0
        try:
            subprocess.run(
                ['gpioset', '--mode=time', '--usec=1', 'gpiochip0', f'{pin}={value}'],
                check=True, timeout=2
            )
        except Exception as e:
            print(f'[EINK-PY] gpioset error on pin {pin}: {e}', file=sys.stderr)


def _gpio_get(pin):
    """Read a GPIO pin via gpioget. Returns 0 or 1."""
    for chip in (GPIOCHIP, 'gpiochip0'):
        try:
            result = subprocess.run(
                ['gpioget', chip, str(pin)],
                capture_output=True, text=True, timeout=2
            )
            return int(result.stdout.strip())
        except Exception:
            continue
    return 0


# ---------------------------------------------------------------------------
# SPI helper — thin wrapper around spidev
# ---------------------------------------------------------------------------

class SpiHelper:
    def __init__(self):
        import spidev
        self.spi = spidev.SpiDev()
        self.spi.open(0, 0)
        self.spi.max_speed_hz = 2000000
        self.spi.mode = 0b00

    def write_byte(self, b):
        self.spi.writebytes([b])

    def write_bytes(self, data):
        # spidev writebytes can handle up to ~4096 bytes; chunk large payloads
        chunk = 4096
        for i in range(0, len(data), chunk):
            self.spi.writebytes(data[i:i + chunk])

    def close(self):
        self.spi.close()


# ---------------------------------------------------------------------------
# EPD1in54 driver — SSD1681 controller
# Commands taken from Waveshare EPD 1.54" V2 reference driver
# ---------------------------------------------------------------------------

class EPD:
    WIDTH  = 200
    HEIGHT = 200

    # SSD1681 command bytes
    CMD_DRIVER_OUTPUT_CONTROL         = 0x01
    CMD_BOOSTER_SOFT_START_CONTROL    = 0x0C
    CMD_GATE_SCAN_START_POSITION      = 0x0F
    CMD_DEEP_SLEEP_MODE               = 0x10
    CMD_DATA_ENTRY_MODE               = 0x11
    CMD_SW_RESET                      = 0x12
    CMD_MASTER_ACTIVATION             = 0x20
    CMD_DISPLAY_UPDATE_CONTROL_1      = 0x21
    CMD_DISPLAY_UPDATE_CONTROL_2      = 0x22
    CMD_WRITE_RAM_BW                  = 0x24
    CMD_WRITE_RAM_RED                 = 0x26
    CMD_WRITE_VCOM_REGISTER           = 0x2C
    CMD_WRITE_LUT_REGISTER            = 0x32
    CMD_SET_DUMMY_LINE_PERIOD         = 0x3A
    CMD_SET_GATE_TIME                 = 0x3B
    CMD_BORDER_WAVEFORM_CONTROL       = 0x3C
    CMD_SET_RAM_X_ADDRESS_START_END   = 0x44
    CMD_SET_RAM_Y_ADDRESS_START_END   = 0x45
    CMD_SET_RAM_X_ADDRESS_COUNTER     = 0x4E
    CMD_SET_RAM_Y_ADDRESS_COUNTER     = 0x4F
    CMD_TERMINATE_FRAME_READ_WRITE    = 0xFF

    # Full update LUT (from Waveshare EPD1in54_V2 reference)
    LUT_FULL_UPDATE = [
        0x80, 0x48, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x40, 0x48, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x80, 0x48, 0x40, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x48, 0x80, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x00, 0x00, 0x00,
    ]

    def __init__(self, dc_pin, rst_pin, busy_pin):
        self.dc_pin   = dc_pin
        self.rst_pin  = rst_pin
        self.busy_pin = busy_pin
        self.spi = SpiHelper()

    # -- low-level helpers --

    def _dc(self, val):
        _gpio_set(self.dc_pin, val)

    def _rst(self, val):
        _gpio_set(self.rst_pin, val)

    def _busy(self):
        return _gpio_get(self.busy_pin)

    def _wait_busy(self, timeout=30):
        start = time.time()
        while self._busy() == 1:          # BUSY pin is active-high on SSD1681
            if time.time() - start > timeout:
                print('[EINK-PY] Busy timeout', file=sys.stderr)
                break
            time.sleep(0.01)

    def _send_command(self, cmd):
        self._dc(0)
        self.spi.write_byte(cmd)

    def _send_data(self, data):
        self._dc(1)
        if isinstance(data, int):
            self.spi.write_byte(data)
        else:
            self.spi.write_bytes(list(data))

    def _hw_reset(self):
        self._rst(1)
        time.sleep(0.2)
        self._rst(0)
        time.sleep(0.002)
        self._rst(1)
        time.sleep(0.2)

    # -- init sequence (SSD1681 / Waveshare 1.54" V2) --

    def init(self):
        self._hw_reset()
        self._wait_busy()

        self._send_command(self.CMD_SW_RESET)
        self._wait_busy()

        self._send_command(self.CMD_DRIVER_OUTPUT_CONTROL)
        self._send_data(0xC7)   # (HEIGHT - 1) & 0xFF = 199 = 0xC7
        self._send_data(0x00)   # ((HEIGHT - 1) >> 8) & 0xFF
        self._send_data(0x00)   # GD=0, SM=0, TB=0

        self._send_command(self.CMD_DATA_ENTRY_MODE)
        self._send_data(0x01)   # X increment, Y decrement (portrait)

        self._send_command(self.CMD_SET_RAM_X_ADDRESS_START_END)
        self._send_data(0x00)
        self._send_data(0x18)   # (WIDTH // 8) - 1 = 24 = 0x18

        self._send_command(self.CMD_SET_RAM_Y_ADDRESS_START_END)
        self._send_data(0xC7)
        self._send_data(0x00)
        self._send_data(0x00)
        self._send_data(0x00)

        self._send_command(self.CMD_BORDER_WAVEFORM_CONTROL)
        self._send_data(0x01)

        self._send_command(self.CMD_WRITE_VCOM_REGISTER)
        self._send_data(0x36)

        self._send_command(self.CMD_SET_GATE_TIME)
        self._send_data(0x0B)

        self._send_command(self.CMD_SET_DUMMY_LINE_PERIOD)
        self._send_data(0x1A)

        self._send_command(self.CMD_WRITE_LUT_REGISTER)
        self._send_data(self.LUT_FULL_UPDATE)

        self._set_cursor(0, 0)

    def _set_cursor(self, x, y):
        self._send_command(self.CMD_SET_RAM_X_ADDRESS_COUNTER)
        self._send_data(x)
        self._send_command(self.CMD_SET_RAM_Y_ADDRESS_COUNTER)
        self._send_data(y & 0xFF)
        self._send_data((y >> 8) & 0xFF)

    def display(self, image_bytes):
        """Push a 200x200 1-bit image to the display (bytes, 1=white 0=black)."""
        self._send_command(self.CMD_WRITE_RAM_BW)
        self._send_data(image_bytes)

        self._send_command(self.CMD_DISPLAY_UPDATE_CONTROL_2)
        self._send_data(0xF7)
        self._send_command(self.CMD_MASTER_ACTIVATION)
        self._wait_busy()

    def clear(self):
        """Fill the display with white."""
        white_buf = [0xFF] * (self.WIDTH * self.HEIGHT // 8)
        self._set_cursor(0, 0)
        self.display(white_buf)

    def sleep(self):
        self._send_command(self.CMD_DEEP_SLEEP_MODE)
        self._send_data(0x01)

    def close(self):
        self.spi.close()


# ---------------------------------------------------------------------------
# Image rendering helpers
# ---------------------------------------------------------------------------

def _render_qr(url, text):
    """Return a 200x200 PIL Image with QR code + label text."""
    from PIL import Image, ImageDraw, ImageFont
    import qrcode

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=5,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color='black', back_color='white').convert('RGB')

    # Scale QR to fit within top 160px of the 200x200 canvas
    qr_size = 160
    qr_img = qr_img.resize((qr_size, qr_size), Image.LANCZOS)

    canvas = Image.new('1', (200, 200), 1)   # white = 1 in mode '1'
    draw   = ImageDraw.Draw(canvas)

    # Paste QR centered horizontally at y=0
    x_offset = (200 - qr_size) // 2
    canvas.paste(qr_img.convert('1'), (x_offset, 0))

    # Draw label text in the bottom 40px strip
    label = text[:28]  # truncate long names
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 14)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), label, font=font)
    text_w = bbox[2] - bbox[0]
    text_x = (200 - text_w) // 2
    draw.text((text_x, 165), label, font=font, fill=0)   # fill=0 = black

    return canvas


def _render_status(text):
    """Return a 200x200 PIL Image with centred status text."""
    from PIL import Image, ImageDraw, ImageFont

    canvas = Image.new('1', (200, 200), 1)
    draw   = ImageDraw.Draw(canvas)

    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
    except Exception:
        font = ImageFont.load_default()

    # Word-wrap simple: split into lines of ~22 chars
    words  = text.split()
    lines  = []
    line   = ''
    for w in words:
        if len(line) + len(w) + 1 > 22:
            if line:
                lines.append(line)
            line = w
        else:
            line = (line + ' ' + w).strip()
    if line:
        lines.append(line)

    line_h  = 20
    total_h = len(lines) * line_h
    y_start = (200 - total_h) // 2

    for i, l in enumerate(lines):
        bbox   = draw.textbbox((0, 0), l, font=font)
        text_w = bbox[2] - bbox[0]
        draw.text(((200 - text_w) // 2, y_start + i * line_h), l, font=font, fill=0)

    return canvas


def _image_to_bytes(img):
    """Convert PIL '1' mode 200x200 image to packed byte buffer for SSD1681."""
    # SSD1681 expects rows of (WIDTH/8) bytes, 1=white 0=black, MSB first
    buf = []
    pixels = img.load()
    for row in range(200):
        for col_byte in range(25):  # 200/8 = 25 bytes per row
            byte = 0
            for bit in range(8):
                col = col_byte * 8 + bit
                px  = pixels[col, row] if col < 200 else 1
                # PIL mode '1': 255 = white, 0 = black
                # SSD1681: bit=1 = white, bit=0 = black
                if px:
                    byte |= (0x80 >> bit)
            buf.append(byte)
    return buf


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    epd = EPD(dc_pin=args.dc, rst_pin=args.rst, busy_pin=args.busy)

    try:
        epd.init()

        if args.action == 'clear':
            epd.clear()

        elif args.action == 'qr':
            if not args.url:
                print('[EINK-PY] --url is required for qr action', file=sys.stderr)
                sys.exit(1)
            img  = _render_qr(args.url, args.text)
            buf  = _image_to_bytes(img)
            epd._set_cursor(0, 0)
            epd.display(buf)

        elif args.action == 'status':
            img  = _render_status(args.text or 'Intrlock')
            buf  = _image_to_bytes(img)
            epd._set_cursor(0, 0)
            epd.display(buf)

        epd.sleep()

    finally:
        epd.close()


if __name__ == '__main__':
    main()
