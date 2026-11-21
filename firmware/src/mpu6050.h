#pragma once
#include <Arduino.h>
#include <Wire.h>

// Handles communication with the MPU6050 motion sensor.
// Configures the sensor and reads acceleration, rotation, and temperature.

// Stores the measurements received from the MPU6050.
struct RawSample {
  float accel[3];  
  float gyro[3];  
  float tempC;
  bool saturated;
};

class Mpu6050 {
 public:

  // Initializes the MPU6050 using I2C and configures its measurement settings.
  bool begin(TwoWire& wire, uint8_t address) {
    wire_ = &wire;
    address_ = address;

    // Resets the sensor and checks whether it responds.
    if (!write(0x6B, 0x80)) return false;  
    delay(100);
    uint8_t who = 0;
    if (!read(0x75, &who, 1) || who == 0x00 || who == 0xFF) return false;
    whoAmI_ = who;

    // Wakes the sensor and sets the filtering, sampling rate, and measurement ranges.
    return write(0x6B, 0x01)      
        && write(0x1A, 0x03)      
        && write(0x19, 1000 / 200 - 1)  
        && write(0x1B, 0x10)      
        && write(0x1C, 0x10)      
        && write(0x37, 0x00)      
        && write(0x38, 0x01);    
  }

  // Checks whether a new sensor measurement is available.
  bool dataReady() {
    uint8_t status = 0;
    return read(0x3A, &status, 1) && (status & 0x01);
  }

  // Reads the latest acceleration, rotation, and temperature measurements.
  bool readSample(RawSample& out) {
    uint8_t b[14];

    // Reads 14 bytes containing seven measurements from the sensor.
    if (!read(0x3B, b, sizeof b)) return false;

    // Combines each pair of bytes into one signed 16-bit measurement.
    int16_t v[7];
    for (int i = 0; i < 7; i++) 
      v[i] = int16_t((b[2 * i] << 8) | b[2 * i + 1]);
    
    out.saturated = false;

    // Converts raw acceleration and gyroscope values into physical units.
    for (int i = 0; i < 3; i++) {
      out.accel[i] = v[i] / 4096.0f;
      out.gyro[i] = v[4 + i] / 32.8f;
      if (v[i] <= -32767 || v[i] >= 32767 || v[4 + i] <= -32767 || v[4 + i] >= 32767) out.saturated = true;
    }

    out.tempC = v[3] / 340.0f + 36.53f;
    return true;
  }

  uint8_t whoAmI() const { return whoAmI_; }

 private:

  // Writes a value to a specific MPU6050 register using I2C.
  bool write(uint8_t reg, uint8_t value) {
    wire_->beginTransmission(address_);
    wire_->write(reg);
    wire_->write(value);
    return wire_->endTransmission() == 0;
  }

  // Reads a specified number of bytes from an MPU6050 register using I2C.
  bool read(uint8_t reg, uint8_t* data, size_t length) {
    wire_->beginTransmission(address_);
    wire_->write(reg);
    if (wire_->endTransmission(false) != 0) return false;
    if (wire_->requestFrom(address_, uint8_t(length)) != length) return false;
    for (size_t i = 0; i < length; i++) data[i] = wire_->read();
    return true;
  }

  // Stores the I2C connection, sensor address, and identification value.
  TwoWire* wire_ = nullptr;
  uint8_t address_ = 0x68;
  uint8_t whoAmI_ = 0;
};
