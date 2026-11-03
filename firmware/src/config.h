#pragma once
#include <stdint.h>

// Wiring (ESP32-S3 DevKitC): MPU6050 VCC -> 3V3, GND -> GND, SDA -> GPIO 8, SCL -> GPIO 9.
// Any free GPIOs work; change these to match your board.
constexpr int PIN_SDA = 8;
constexpr int PIN_SCL = 9;
// 0x68 with AD0 low or unconnected, 0x69 with AD0 tied to 3V3.
constexpr uint8_t MPU_ADDRESS = 0x68;

constexpr const char* DEVICE_PREFIX = "Dumbbell";
constexpr const char* FIRMWARE_VERSION = "1.0.0";

// The sensor runs at 200 Hz; pairs are averaged into a 100 Hz stream.
constexpr uint32_t SENSOR_HZ = 200;
constexpr uint32_t STREAM_DECIMATION = 2;
constexpr uint32_t STREAM_HZ = SENSOR_HZ / STREAM_DECIMATION;
// Samples per notification once the link allows it: 5 at 100 Hz is one packet every 50 ms.
constexpr uint8_t TARGET_SAMPLES_PER_PACKET = 5;

// Stillness: every axis must stay inside these ranges for STILL_WINDOW samples (0.3 s).
constexpr int STILL_WINDOW = 60;
constexpr float STILL_ACCEL_RANGE_G = 0.04f;
constexpr float STILL_GYRO_RANGE_DPS = 2.0f;
constexpr float STILL_GYRO_MAX_DPS = 4.0f;  // after bias correction, once calibrated
// One bias measurement per second of continuous stillness.
constexpr int BIAS_WINDOW = SENSOR_HZ;

constexpr uint32_t GYRO_CAL_TIMEOUT_MS = 15000;
constexpr uint32_t ACCEL_CAL_TIMEOUT_MS = 5 * 60 * 1000;
// Flash is rewritten at most this often when the bias model changes.
constexpr uint32_t SAVE_INTERVAL_MS = 60 * 1000;
