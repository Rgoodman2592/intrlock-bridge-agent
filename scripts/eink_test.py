#!/usr/bin/env python3
import spidev
import gpiozero
import time

rst = gpiozero.OutputDevice(20)
dc = gpiozero.OutputDevice(16)
cs = gpiozero.OutputDevice(8, initial_value=True)
busy = gpiozero.InputDevice(21)

spi = spidev.SpiDev()
spi.open(0, 0)
spi.max_speed_hz = 2000000

# Hardware reset
rst.off()
time.sleep(0.1)
rst.on()
time.sleep(0.1)

# SW reset
cs.off()
dc.off()
spi.writebytes([0x12])
cs.on()
time.sleep(0.5)

print("BUSY:", busy.value)
print("SPI OK")

# Try a full clear to white
# Driver output control
cs.off(); dc.off(); spi.writebytes([0x01]); dc.on(); spi.writebytes([0xC7, 0x00, 0x00]); cs.on()
# Data entry mode
cs.off(); dc.off(); spi.writebytes([0x11]); dc.on(); spi.writebytes([0x03]); cs.on()
# Set RAM X start/end
cs.off(); dc.off(); spi.writebytes([0x44]); dc.on(); spi.writebytes([0x00, 0x18]); cs.on()
# Set RAM Y start/end
cs.off(); dc.off(); spi.writebytes([0x45]); dc.on(); spi.writebytes([0xC7, 0x00, 0x00, 0x00]); cs.on()
# Border waveform
cs.off(); dc.off(); spi.writebytes([0x3C]); dc.on(); spi.writebytes([0x05]); cs.on()
# Display update control
cs.off(); dc.off(); spi.writebytes([0x21]); dc.on(); spi.writebytes([0x00, 0x80]); cs.on()
# Temp sensor
cs.off(); dc.off(); spi.writebytes([0x18]); dc.on(); spi.writebytes([0x80]); cs.on()
# Set RAM X counter
cs.off(); dc.off(); spi.writebytes([0x4E]); dc.on(); spi.writebytes([0x00]); cs.on()
# Set RAM Y counter
cs.off(); dc.off(); spi.writebytes([0x4F]); dc.on(); spi.writebytes([0xC7, 0x00]); cs.on()

# Write all white to RAM (0xFF = white for this controller)
cs.off(); dc.off(); spi.writebytes([0x24]); dc.on()
white = [0xFF] * 5000
spi.writebytes(white)
cs.on()

# Display update sequence
cs.off(); dc.off(); spi.writebytes([0x22]); dc.on(); spi.writebytes([0xF7]); cs.on()
cs.off(); dc.off(); spi.writebytes([0x20]); cs.on()

# Wait for busy
print("Updating display...")
time.sleep(0.5)
for i in range(60):
    if busy.value == 0:
        break
    time.sleep(0.1)

print("Done - screen should be white")

spi.close()
rst.close()
dc.close()
cs.close()
busy.close()
