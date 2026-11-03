#pragma once
#include <Arduino.h>
#include <Wire.h>

// Minimal register-level MPU6050 driver: ±8 g, ±1000 °/s, 42 Hz low-pass, 200 Hz output.
struct RawSample {
  float accel[3];  // g
  float gyro[3];   // °/s
  float tempC;
  bool saturated;
};

class Mpu6050 {
 public:
  bool begin(TwoWire& wire, uint8_t address) {
    wire_ = &wire;
    address_ = address;
    if (!write(0x6B, 0x80)) return false;  // PWR_MGMT_1: reset
    delay(100);
    uint8_t who = 0;
    if (!read(0x75, &who, 1) || who == 0x00 || who == 0xFF) return false;
    whoAmI_ = who;  // 0x68 on genuine parts; clones report other values but share this register map
    return write(0x6B, 0x01)      // wake, clock from the gyro PLL
        && write(0x1A, 0x03)      // CONFIG: DLPF 44 Hz accel / 42 Hz gyro, 1 kHz gyro rate
        && write(0x19, 1000 / 200 - 1)  // SMPLRT_DIV: 1 kHz / 5 = 200 Hz
        && write(0x1B, 0x10)      // GYRO_CONFIG: ±1000 °/s
        && write(0x1C, 0x10)      // ACCEL_CONFIG: ±8 g
        && write(0x37, 0x00)      // INT_PIN_CFG: status clears when INT_STATUS is read
        && write(0x38, 0x01);     // INT_ENABLE: data ready
  }

  // True once per new sample; reading INT_STATUS clears it.
  bool dataReady() {
    uint8_t status = 0;
    return read(0x3A, &status, 1) && (status & 0x01);
  }

  bool readSample(RawSample& out) {
    uint8_t b[14];
    if (!read(0x3B, b, sizeof b)) return false;
    int16_t v[7];
    for (int i = 0; i < 7; i++) v[i] = int16_t((b[2 * i] << 8) | b[2 * i + 1]);
    out.saturated = false;
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
  bool write(uint8_t reg, uint8_t value) {
    wire_->beginTransmission(address_);
    wire_->write(reg);
    wire_->write(value);
    return wire_->endTransmission() == 0;
  }
  bool read(uint8_t reg, uint8_t* data, size_t length) {
    wire_->beginTransmission(address_);
    wire_->write(reg);
    if (wire_->endTransmission(false) != 0) return false;
    if (wire_->requestFrom(address_, uint8_t(length)) != length) return false;
    for (size_t i = 0; i < length; i++) data[i] = wire_->read();
    return true;
  }

  TwoWire* wire_ = nullptr;
  uint8_t address_ = 0x68;
  uint8_t whoAmI_ = 0;
};
