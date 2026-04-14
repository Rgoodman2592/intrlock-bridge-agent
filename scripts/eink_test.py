#!/usr/bin/env python3
"""E-ink test — SPI CS handled by hardware (CE0), not gpiozero."""
import spidev
import gpiozero
import time

rst = gpiozero.OutputDevice(20)
dc = gpiozero.OutputDevice(16)
busy = gpiozero.InputDevice(21)

spi = spidev.SpiDev()
spi.open(0, 0)  # SPI0, CE0 — hardware handles CS on GPIO8
spi.max_speed_hz = 2000000
spi.mode = 0b00

def cmd(c):
    dc.off()
    spi.writebytes([c])

def data(d):
    dc.on()
    if isinstance(d, int):
        spi.writebytes([d])
    else:
        for i in range(0, len(d), 4096):
            spi.writebytes(d[i:i+4096])

def wait_busy():
    for _ in range(100):
        if busy.value == 0:
            return
        time.sleep(0.05)
    print("WARN: busy timeout")

# Hardware reset
rst.off(); time.sleep(0.2); rst.on(); time.sleep(0.2)

# SW reset
cmd(0x12); time.sleep(1.0)
wait_busy()
print("BUSY after reset:", busy.value)

# Init sequence for SSD1681 / Waveshare 1.54" V2
cmd(0x01); data([0xC7, 0x00, 0x01])  # Driver output control: 200 lines
cmd(0x11); data(0x01)                 # Data entry mode: Y dec, X inc
cmd(0x44); data([0x00, 0x18])         # RAM X: 0-24 (25 bytes = 200 bits)
cmd(0x45); data([0xC7, 0x00, 0x00, 0x00])  # RAM Y: 199-0
cmd(0x3C); data(0x05)                 # Border: white
cmd(0x18); data(0x80)                 # Temp sensor: internal
cmd(0x4E); data(0x00)                 # RAM X counter
cmd(0x4F); data([0xC7, 0x00])         # RAM Y counter

# Write white to RAM
cmd(0x24)
data([0xFF] * 5000)

# Update display
cmd(0x22); data(0xF7)
cmd(0x20)
wait_busy()

print("Display should be white now")

spi.close()
rst.close()
dc.close()
busy.close()
