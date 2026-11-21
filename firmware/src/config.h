#pragma once
#include <stdint.h>

/*
 * ESP32-S3 and MPU6050 Configuration
 *
 * This file stores the main settings for the exercise tracker,
 * including sensor connections, reading speeds, stillness
 * detection, and calibration time limits.
 */

// Sets the pins used to connect the MPU6050 to the ESP32-S3.
// VCC connects to 3V3, GND to GND, SDA to GPIO 8, and SCL to GPIO 9.
constexpr int PIN_SDA = 8;
constexpr int PIN_SCL = 9;

// The I2C address depends on how the AD0 pin is connected.
constexpr uint8_t MPU_ADDRESS = 0x68;

// Stores the device name and current firmware version.
constexpr const char* DEVICE_PREFIX = "Dumbbell";
constexpr const char* FIRMWARE_VERSION = "1.0.0";

// Controls how often sensor readings are collected and sent.
// The sensor takes 200 readings per second and averages pairs
// to produce 100 readings per second.
constexpr uint32_t SENSOR_HZ = 200;
constexpr uint32_t STREAM_DECIMATION = 2;
constexpr uint32_t STREAM_HZ = SENSOR_HZ / STREAM_DECIMATION;


// Groups multiple readings into one packet before sending them
constexpr uint8_t TARGET_SAMPLES_PER_PACKET = 5;

// Sets the limits used to determine when the sensor is still.
// This helps prevent movement from affecting calibration.
constexpr int STILL_WINDOW = 60;
constexpr float STILL_ACCEL_RANGE_G = 0.04f;
constexpr float STILL_GYRO_RANGE_DPS = 2.0f;
constexpr float STILL_GYRO_MAX_DPS = 4.0f;  

// Uses one second of continuous stillness to measure gyroscope bias.
constexpr int BIAS_WINDOW = SENSOR_HZ;

// Sets the maximum time allowed for gyroscope and
// accelerometer calibration.
constexpr uint32_t GYRO_CAL_TIMEOUT_MS = 15000;
constexpr uint32_t ACCEL_CAL_TIMEOUT_MS = 5 * 60 * 1000;

// Limits how frequently updated calibration settings
// are saved to the ESP32's flash memory.
constexpr uint32_t SAVE_INTERVAL_MS = 60 * 1000;
