#pragma once
#include <Arduino.h>
#include "protocol.h"

// Sensor calibration, kept in flash (NVS) across power cycles.
//
// Gyro bias: the MPU6050's zero-rate offset shifts by up to ~1 °/s between power-ups and
// drifts with die temperature, which climbs several degrees as the chip warms and as a
// cold dumbbell is gripped. So the offset is re-measured whenever the dumbbell is still
// (an "anchor"), and between anchors it is extrapolated with a learned slope:
//     b(T) = anchorBias + slope * (T - anchorT)
// The slope is fitted within each power-up once the temperature has moved >= 3 °C, and
// blended with what earlier power-ups learned.
//
// Accelerometer: per-axis offset and scale, fitted from still poses on all six faces
// (each axis pointing up and down), so that |a| = 1 g in every orientation.
class Calibration {
 public:
  void load();
  void forget();
  // Writes changed values to flash, at most once per SAVE_INTERVAL_MS unless forced.
  void save(uint32_t nowMs, bool force = false);

  void correctGyro(float tempC, const float raw[3], float out[3]) const;
  void correctAccel(const float raw[3], float out[3]) const;

  // One second of stillness: mean raw gyro, mean raw accel and mean temperature.
  void addStill(float tempC, const float gyroMean[3], const float accelMean[3], uint32_t nowMs);

  void startAccel(uint32_t nowMs);
  void cancelAccel();
  void tick(uint32_t nowMs);  // times out an unfinished accelerometer calibration

  bool gyroReady() const { return freshAnchor_; }
  bool accelCalibrated() const { return accelOk_; }
  uint8_t accelProgress() const { return uint8_t(accelState_ << 4) | uint8_t(min(poseCount_, 15)); }
  uint32_t gyroAnchors() const { return anchorCount_; }
  size_t infoJson(char* out, size_t size) const;

 private:
  void fitSlope();
  bool fitAccel();

  // Gyro model.
  bool hasAnchor_ = false;
  bool freshAnchor_ = false;
  float anchorT_ = 0;
  float anchorBias_[3] = {0, 0, 0};
  float savedSlope_[3] = {0, 0, 0};  // from earlier power-ups
  float savedWeight_ = 0;            // °C of temperature span behind savedSlope_
  float slope_[3] = {0, 0, 0};       // in use: savedSlope_ blended with this power-up's fit
  float slopeWeight_ = 0;
  uint32_t anchorCount_ = 0;
  // This power-up's least-squares fit of bias against temperature.
  int fitN_ = 0;
  float fitT_ = 0, fitTT_ = 0, fitB_[3] = {0, 0, 0}, fitTB_[3] = {0, 0, 0};
  float fitMinT_ = 1e9f, fitMaxT_ = -1e9f, lastFitT_ = -1e9f;
  uint32_t lastFitMs_ = 0;

  // Accelerometer model.
  bool accelOk_ = false;
  float offset_[3] = {0, 0, 0};
  float scale_[3] = {1, 1, 1};
  AccelState accelState_ = ACCEL_IDLE;
  uint32_t accelStartMs_ = 0;
  static constexpr int MAX_POSES = 12;
  float poses_[MAX_POSES][3];
  int poseCount_ = 0;

  bool dirty_ = false;
  uint32_t lastSaveMs_ = 0;
};
