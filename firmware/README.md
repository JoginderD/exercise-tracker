# Dumbbell sensor firmware (ESP32-S3 + MPU6050)

Streams the dumbbell's motion to the Exercise Tracker website over Bluetooth LE. The
website then measures each rep's lifting speed, range, power and the speed drop across
a set (velocity-based training), next to the camera's form checks.

What runs where:

| On the ESP32 (200 Hz) | In the browser (`src/vbt.js`) |
| --- | --- |
| MPU6050 read, ±8 g / ±1000 °/s, 42 Hz filter | Velocity with zero-velocity resets at rest and turnarounds |
| Gyro bias learned at rest, corrected for temperature | Rep and set detection, mean/peak velocity, range of motion |
| Accelerometer offset/scale calibration | Power `P = m(g + a)v`, work, velocity loss |
| Madgwick orientation, gravity removed in world frame | Saved with the session, shown to the coach, in the CSV |

## Wiring

| MPU6050 | ESP32-S3 DevKitC |
| --- | --- |
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO 8 |
| SCL | GPIO 9 |
| AD0 | leave unconnected (address 0x68) |

Other pins work: change `PIN_SDA` / `PIN_SCL` in `src/config.h`. If AD0 is tied to 3V3,
set `MPU_ADDRESS` to `0x69`.

Mount the sensor **rigidly** to the dumbbell (handle end or a plate, glued or
strapped tight). Any orientation works, because the firmware works out which way is
up, but it must not wobble on its mount.

## Flash it

You need [PlatformIO](https://platformio.org/): either the VS Code extension, or the CLI
(`pip install platformio`).

```sh
cd firmware
pio run -t upload        # builds, then flashes over USB
pio device monitor       # optional: logs at 115200 baud
```

In VS Code: open the `firmware` folder, then click the PlatformIO → (Upload) arrow in
the status bar.

The first build downloads the ESP32 toolchain (a few hundred MB), and later builds take
seconds. If the upload can't find the board, hold **BOOT**, tap **RESET**, release BOOT
and upload again. Either USB-C port works; logs appear on the one you flashed through.

## First use

1. Power the sensor and **set it down still for a second**. The LED flashes amber while
   it measures gyro bias, then breathes blue while it waits for the website.
2. Open the tracker in **Chrome or Edge** (desktop or Android) over `https://` or
   `http://localhost`. Web Bluetooth does not work in Safari, Firefox or over plain
   http on a LAN address.
3. Under **Dumbbell sensor**, press **Connect sensor** and pick `Dumbbell-XXXX`. The
   LED turns green.
4. Once, press **Calibrate accelerometer**, then rest the sensor (or the dumbbell)
   still for 2 seconds on each of its 6 sides. The panel counts the positions, and the
   calibration is saved on the sensor.
5. Enter the dumbbell weight (for power), choose the hand, and start the camera. Reps
   appear in the video overlay. A speed drop of more than 25% from the fastest rep in
   the set shows a "consider ending the set" warning.

Gyro bias is re-measured automatically whenever the dumbbell rests for a second, and
the temperature slope is learned over time and kept in flash. **Calibrate gyro**
forces a fresh measurement.

## LED

| LED | Meaning |
| --- | --- |
| Blue, breathing | Waiting for the website |
| Green | Connected and streaming |
| Amber, flashing | Calibrating: keep it still |
| Red, flashing | MPU6050 not answering: check wiring |

## Serial commands (115200 baud)

`c` calibrate gyro · `a` start accelerometer calibration · `x` cancel ·
`f` forget all saved calibration · `p` print status and calibration.

## Accuracy and limits

- In simulation with large sensor errors (0.5 m/s² bias, drift and noise), every rep
  is counted and mean concentric velocity is within about 2-4% on regular reps and
  6-9% on the slowest reps of a slowing set. Velocity loss reads slightly low. Real
  sensors have not been validated yet. Do that against a 240 fps phone video or a
  linear encoder before relying on the numbers clinically.
- Rep results appear about half a rep cycle late (the method needs to see past each
  turnaround).
- Only vertical movement is measured. A purely horizontal movement (such as a fly at
  the top) has no vertical range and is not counted.
- Without a magnetometer, heading drifts. This doesn't affect vertical measurements.
- Anyone nearby can connect while the sensor advertises. It streams motion data only.

## Protocol

`src/protocol.h` defines the BLE service. The browser side is `src/imu.js`, so change
both together and bump `PROTOCOL_VERSION` when the layout changes. Each notification
is a 16-byte header followed by up to 5 samples of 20 bytes (100 Hz). If the
Bluetooth MTU is too small to carry a sample, the device sends header-only packets
flagged `FLAG_LINK_TOO_SMALL`, and the page explains the problem.
