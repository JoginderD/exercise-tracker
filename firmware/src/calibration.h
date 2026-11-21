#pragma once
#include <Arduino.h>
#include "protocol.h"

/*
 * MPU6050 IMU Calibration
 *
 * This class improves the accuracy of the MPU6050 sensor
 * by correcting gyroscope and accelerometer readings.
 *
 * It also accounts for temperature changes and saves
 * calibration settings for future use.
 */

class Calibration {
 public:

  // Loads previously saved calibration values.
  void load();

  // Deletes saved calibration values and resets them.
  void forget();

  // Saves updated calibration values.
  // Normally waits between saves to avoid writing too often.
  void save(uint32_t nowMs, bool force = false);

  // Removes errors from gyroscope readings.
  // Uses temperature to improve the correction.
  void correctGyro(float tempC, const float raw[3], float out[3]) const;

  // Corrects accelerometer readings using saved values.
  void correctAccel(const float raw[3], float out[3]) const;

  // Uses readings collected while the sensor is still
  // to improve gyroscope and accelerometer calibration.
  void addStill(float tempC, const float gyroMean[3], const float accelMean[3], uint32_t nowMs);

  // Starts collecting readings for accelerometer calibration.
  void startAccel(uint32_t nowMs);

  // Stops an active accelerometer calibration.
  void cancelAccel();

   // Checks whether accelerometer calibration has taken too long
  void tick(uint32_t nowMs);  

  // Checks if a new gyroscope calibration was completed
  // since the device was turned on.
  bool gyroReady() const { return freshAnchor_; }

  // Checks whether accelerometer calibration is available.
  bool accelCalibrated() const { return accelOk_; }

  // Returns the calibration stage and number of positions collected.
  // Both values are stored together in one byte.
  uint8_t accelProgress() const { return uint8_t(accelState_ << 4) | uint8_t(min(poseCount_, 15)); }

  // Returns how many stationary gyroscope readings were accepted.
  uint32_t gyroAnchors() const { return anchorCount_; }

  // Creates a JSON summary of the sensor calibration information.
  size_t infoJson(char* out, size_t size) const;

 private:
  void fitSlope();

  // Calculates values needed to correct accelerometer readings.
  // Returns true if calibration is successful.
  bool fitAccel();

  // ==========================================
  // Gyroscope Calibration
  // ==========================================

  bool hasAnchor_ = false;
  bool freshAnchor_ = false;
  float anchorT_ = 0;
  float anchorBias_[3] = {0, 0, 0};
  float savedSlope_[3] = {0, 0, 0};  
  float savedWeight_ = 0;           
  float slope_[3] = {0, 0, 0};       
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
