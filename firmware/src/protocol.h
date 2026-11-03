#pragma once
#include <stdint.h>

// Bluetooth LE protocol shared with the website. The browser side is src/imu.js;
// change both together and bump PROTOCOL_VERSION when the layout changes.

#define IMU_SERVICE_UUID "6e0a0001-7c3b-4d9a-9f3e-2b1d5a8c4f10"
#define IMU_DATA_UUID    "6e0a0002-7c3b-4d9a-9f3e-2b1d5a8c4f10"  // notify: PacketHeader + Sample[count]
#define IMU_CONTROL_UUID "6e0a0003-7c3b-4d9a-9f3e-2b1d5a8c4f10"  // write: one Command byte
#define IMU_INFO_UUID    "6e0a0004-7c3b-4d9a-9f3e-2b1d5a8c4f10"  // read: JSON device and calibration info

constexpr uint8_t PROTOCOL_VERSION = 1;

enum Flag : uint8_t {
  FLAG_STILL = 1 << 0,             // the last 0.3 s were motionless
  FLAG_CALIBRATING = 1 << 1,       // waiting for stillness to measure gyro bias
  FLAG_GYRO_READY = 1 << 2,        // gyro bias measured this power-up
  FLAG_ACCEL_CALIBRATED = 1 << 3,  // a saved accelerometer calibration is applied
  FLAG_SENSOR_ERROR = 1 << 4,      // the MPU6050 is not answering; samples are missing
  FLAG_SATURATED = 1 << 5,         // a sample in this packet hit the sensor's range limit
  FLAG_LINK_TOO_SMALL = 1 << 6,    // the Bluetooth MTU cannot carry one sample; count is 0
};

enum Command : uint8_t {
  CMD_CALIBRATE_GYRO = 1,   // re-measure gyro bias at the next stillness and level the orientation
  CMD_CALIBRATE_ACCEL = 2,  // collect still poses on all six faces, then fit offsets and scales
  CMD_CANCEL = 3,           // stop an accelerometer calibration
  CMD_FORGET = 4,           // erase all saved calibration
};

// High nibble of PacketHeader.accelProgress; the low nibble counts captured poses.
enum AccelState : uint8_t { ACCEL_IDLE = 0, ACCEL_COLLECTING = 1, ACCEL_DONE = 2, ACCEL_FAILED = 3 };

#pragma pack(push, 1)
// All fields little-endian.
struct PacketHeader {
  uint8_t version;
  uint8_t flags;
  uint8_t count;        // samples that follow
  uint8_t periodMs;     // spacing between samples
  uint32_t firstIndex;  // stream index of the first sample; a jump means samples were lost
  uint32_t firstMs;     // device millis() of the first sample
  int16_t tempCenti;    // die temperature, 0.01 °C
  uint8_t accelProgress;
  uint8_t gyroCalCount; // increments on every successful gyro calibration
};
struct Sample {
  int16_t q[4];      // orientation w, x, y, z, scaled by 32767 (sensor frame to world, z up)
  int16_t accel[3];  // world-frame acceleration with gravity removed, mg
  int16_t gyro[3];   // sensor-frame angular rate, bias corrected, 0.1 °/s
};
#pragma pack(pop)

static_assert(sizeof(PacketHeader) == 16, "header layout is part of the protocol");
static_assert(sizeof(Sample) == 20, "sample layout is part of the protocol");
