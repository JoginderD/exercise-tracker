/*
 * MPU Calibration Module
 *
 * Handles calibration of the accelerometer and gyroscope.
 *
 * Main responsibilities:
 * - Correct gyroscope bias using stationary measurements.
 * - Compensate for gyroscope drift caused by temperature changes.
 * - Calibrate accelerometer offsets and scaling factors.
 * - Save and restore calibration settings using ESP32 Preferences.
 * - Validate calibration results before applying them.
 */

#include "calibration.h"
#include <Preferences.h>
#include "config.h"

namespace {
Preferences prefs;
constexpr const char* NAMESPACE = "imu-cal";
// Datasheet limits: zero-rate offset ±20 °/s, its drift well under 0.3 °/s per °C.
constexpr float MAX_BIAS_DPS = 25;
constexpr float MAX_SLOPE = 0.3f;
constexpr float MIN_SPAN_C = 3;
constexpr float MAX_SAVED_WEIGHT_C = 30;

// Calculates the dot product of two 3D vectors.
float dot3(const float a[3], const float b[3]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// Calculates the magnitude of a 3D vector
float norm3(const float a[3]) { return sqrtf(dot3(a, a)); }

/*
 * Solves a system of six linear equations using Gaussian elimination.
 *
 * Parameters:
 * A - 6x6 coefficient matrix, modified during elimination.
 * b - Right-hand-side vector, modified during elimination.
 * x - Array receiving the calculated solution.
 *
 * Returns true if the system is solved successfully.
 * Returns false if a suitable pivot cannot be found.
 *
 * Partial pivoting improves numerical stability.
 */

bool solve6(float A[6][6], float b[6], float x[6]) {
  for (int col = 0; col < 6; col++) {
    int pivot = col;
    for (int row = col + 1; row < 6; row++) if (fabsf(A[row][col]) > fabsf(A[pivot][col])) pivot = row;
    if (fabsf(A[pivot][col]) < 1e-9f) return false;
    if (pivot != col) {
      for (int k = 0; k < 6; k++) { float t = A[col][k]; A[col][k] = A[pivot][k]; A[pivot][k] = t; }
      float t = b[col]; b[col] = b[pivot]; b[pivot] = t;
    }
    for (int row = col + 1; row < 6; row++) {
      float factor = A[row][col] / A[col][col];
      for (int k = col; k < 6; k++) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }
  for (int row = 5; row >= 0; row--) {
    float sum = b[row];
    for (int k = row + 1; k < 6; k++) sum -= A[row][k] * x[k];
    x[row] = sum / A[row][row];
  }
  return true;
}
}  

/*
 * Loads previously saved calibration data from ESP32 storage.
 *
 * Restores gyroscope bias, temperature compensation parameters,
 * and accelerometer calibration values.
 *
 * If accelerometer calibration data is missing, default values
 * are used until a successful calibration is performed.
 */

void Calibration::load() {
  prefs.begin(NAMESPACE, true);
  hasAnchor_ = prefs.getBytes("anchor", anchorBias_, sizeof anchorBias_) == sizeof anchorBias_;
  anchorT_ = prefs.getFloat("anchorT", 25);
  if (prefs.getBytes("slope", savedSlope_, sizeof savedSlope_) != sizeof savedSlope_) memset(savedSlope_, 0, sizeof savedSlope_);
  savedWeight_ = prefs.getFloat("slopeW", 0);
  accelOk_ = prefs.getBytes("offset", offset_, sizeof offset_) == sizeof offset_ &&
             prefs.getBytes("scale", scale_, sizeof scale_) == sizeof scale_;
  if (!accelOk_) { memset(offset_, 0, sizeof offset_); for (float& s : scale_) s = 1; }
  prefs.end();
  memcpy(slope_, savedSlope_, sizeof slope_);
  slopeWeight_ = savedWeight_;
  freshAnchor_ = false;
}

/**
 * Clears all saved IMU calibration data.
 *
 * Removes stored gyroscope and accelerometer calibration
 * settings and resets the calibration object to its
 * default state.
 */

void Calibration::forget() {
  prefs.begin(NAMESPACE, false);
  prefs.clear();
  prefs.end();
  *this = Calibration();
}

/*
 * Saves updated calibration parameters to non-volatile storage.
 *
 * Avoids unnecessary writes by checking whether calibration
 * data has changed and whether enough time has passed.
 *
 * A forced save bypasses the minimum time interval.
 */

void Calibration::save(uint32_t nowMs, bool force) {
  if (!dirty_ || (!force && nowMs - lastSaveMs_ < SAVE_INTERVAL_MS)) return;
  prefs.begin(NAMESPACE, false);
  if (hasAnchor_) {
    prefs.putBytes("anchor", anchorBias_, sizeof anchorBias_);
    prefs.putFloat("anchorT", anchorT_);
  }
  prefs.putBytes("slope", slope_, sizeof slope_);
  prefs.putFloat("slopeW", min(slopeWeight_, MAX_SAVED_WEIGHT_C));
  if (accelOk_) {
    prefs.putBytes("offset", offset_, sizeof offset_);
    prefs.putBytes("scale", scale_, sizeof scale_);
  }
  prefs.end();
  dirty_ = false;
  lastSaveMs_ = nowMs;
}

/*
 * Corrects gyroscope readings by removing estimated sensor bias.
 *
 * Uses the measured temperature to compensate for changes
 * in gyroscope offset.
 *
 * The corrected readings are stored in the output array.
 */

void Calibration::correctGyro(float tempC, const float raw[3], float out[3]) const {
  for (int i = 0; i < 3; i++) {
    float bias = hasAnchor_ ? anchorBias_[i] + slope_[i] * (tempC - anchorT_) : 0;
    out[i] = raw[i] - bias;
  }
}

/*
 * Corrects accelerometer measurements using previously
 * calculated offset and scale values for each axis.
 *
 * Corrected = (Raw - Offset) / Scale
 */

void Calibration::correctAccel(const float raw[3], float out[3]) const {
  for (int i = 0; i < 3; i++) out[i] = (raw[i] - offset_[i]) / scale_[i];
}

/*
 * Processes measurements collected while the IMU is stationary.
 *
 * Updates gyroscope bias estimates and collects temperature
 * information for drift compensation.
 *
 * During accelerometer calibration, collects measurements
 * from sufficiently different device orientations.
 *
 * Rejects unsuitable measurements and attempts calibration
 * once the required orientation coverage is achieved.
 */

void Calibration::addStill(float tempC, const float gyroMean[3], const float accelMean[3], uint32_t nowMs) {
  if (fabsf(gyroMean[0]) < MAX_BIAS_DPS && fabsf(gyroMean[1]) < MAX_BIAS_DPS && fabsf(gyroMean[2]) < MAX_BIAS_DPS) {
    memcpy(anchorBias_, gyroMean, sizeof anchorBias_);
    anchorT_ = tempC;
    hasAnchor_ = true;
    freshAnchor_ = true;
    anchorCount_++;
    dirty_ = true;
    if (fabsf(tempC - lastFitT_) >= 0.25f || nowMs - lastFitMs_ >= 30000) {
      fitN_++;
      fitT_ += tempC;
      fitTT_ += tempC * tempC;
      for (int i = 0; i < 3; i++) { fitB_[i] += gyroMean[i]; fitTB_[i] += tempC * gyroMean[i]; }
      fitMinT_ = min(fitMinT_, tempC);
      fitMaxT_ = max(fitMaxT_, tempC);
      lastFitT_ = tempC;
      lastFitMs_ = nowMs;
      fitSlope();
    }
  }

  if (accelState_ != ACCEL_COLLECTING) return;
  // A new pose must point at least 40° away from every pose already captured.
  float n = norm3(accelMean);
  if (n < 0.7f || n > 1.3f) return;
  for (int p = 0; p < poseCount_; p++) {
    if (dot3(poses_[p], accelMean) / (norm3(poses_[p]) * n) > cosf(40 * DEG_TO_RAD)) return;
  }
  memcpy(poses_[poseCount_++], accelMean, sizeof poses_[0]);
  bool covered = true;
  for (int axis = 0; axis < 3; axis++) {
    bool up = false, down = false;
    for (int p = 0; p < poseCount_; p++) { up |= poses_[p][axis] > 0.6f; down |= poses_[p][axis] < -0.6f; }
    covered &= up && down;
  }
  if (covered) {
    accelState_ = fitAccel() ? ACCEL_DONE : ACCEL_FAILED;
    if (accelState_ == ACCEL_DONE) save(nowMs, true);
  } else if (poseCount_ == MAX_POSES) {
    accelState_ = ACCEL_FAILED;
  }
}

/*
 * Estimates how gyroscope bias changes with temperature.
 *
 * Uses linear regression on stationary measurements.
 * Requires enough samples and sufficient temperature variation.
 *
 * Rejects unrealistic slopes and combines the new estimate
 * with previously saved calibration information.
 */

void Calibration::fitSlope() {
  float span = fitMaxT_ - fitMinT_;
  if (fitN_ < 4 || span < MIN_SPAN_C) return;
  float denominator = fitN_ * fitTT_ - fitT_ * fitT_;
  if (fabsf(denominator) < 1e-6f) return;
  float session[3];
  for (int i = 0; i < 3; i++) {
    session[i] = (fitN_ * fitTB_[i] - fitT_ * fitB_[i]) / denominator;
    if (fabsf(session[i]) > MAX_SLOPE) return;  
  }
  for (int i = 0; i < 3; i++) slope_[i] = (savedSlope_[i] * savedWeight_ + session[i] * span) / (savedWeight_ + span);
  slopeWeight_ = savedWeight_ + span;
  dirty_ = true;
}

/*
 * Calculates accelerometer offsets and scale factors.
 *
 * Uses Gauss-Newton optimization to fit measurements from
 * different stationary orientations to a unit sphere.
 *
 * Rejects results with unrealistic parameters or excessive
 * residual error.
 *
 * Returns true if calibration succeeds, otherwise false.
 */

bool Calibration::fitAccel() {
  float p[6] = {0, 0, 0, 1, 1, 1};
  for (int iteration = 0; iteration < 20; iteration++) {
    float JtJ[6][6] = {};
    float Jtr[6] = {};
    for (int k = 0; k < poseCount_; k++) {
      float u[3];
      for (int i = 0; i < 3; i++) u[i] = (poses_[k][i] - p[i]) / p[3 + i];
      float n = norm3(u);
      float r = n - 1;
      float J[6];
      for (int i = 0; i < 3; i++) {
        J[i] = -u[i] / (p[3 + i] * n);
        J[3 + i] = -u[i] * u[i] / (p[3 + i] * n);
      }
      for (int a = 0; a < 6; a++) {
        Jtr[a] += J[a] * r;
        for (int b = 0; b < 6; b++) JtJ[a][b] += J[a] * J[b];
      }
    }
    for (int a = 0; a < 6; a++) { JtJ[a][a] += 1e-6f; Jtr[a] = -Jtr[a]; }
    float step[6];
    if (!solve6(JtJ, Jtr, step)) return false;
    float size = 0;
    for (int a = 0; a < 6; a++) { p[a] += step[a]; size += step[a] * step[a]; }
    if (size < 1e-12f) break;
  }
  float squared = 0;
  for (int k = 0; k < poseCount_; k++) {
    float u[3];
    for (int i = 0; i < 3; i++) u[i] = (poses_[k][i] - p[i]) / p[3 + i];
    float r = norm3(u) - 1;
    squared += r * r;
  }
  float rms = sqrtf(squared / poseCount_);
  for (int i = 0; i < 3; i++) {
    if (fabsf(p[i]) > 0.25f || p[3 + i] < 0.9f || p[3 + i] > 1.1f) return false;
  }
  if (rms > 0.02f) return false;
  memcpy(offset_, p, sizeof offset_);
  memcpy(scale_, p + 3, sizeof scale_);
  accelOk_ = true;
  dirty_ = true;
  return true;
}

// Begins collecting accelerometer calibration measurements
void Calibration::startAccel(uint32_t nowMs) {
  accelState_ = ACCEL_COLLECTING;
  accelStartMs_ = nowMs;
  poseCount_ = 0;
}

// Stops an active calibration
void Calibration::cancelAccel() {
  if (accelState_ == ACCEL_COLLECTING) accelState_ = ACCEL_IDLE;
  poseCount_ = 0;
}

// Checks whether calibration has exceeded the time limit
void Calibration::tick(uint32_t nowMs) {
  if (accelState_ == ACCEL_COLLECTING && nowMs - accelStartMs_ > ACCEL_CAL_TIMEOUT_MS) accelState_ = ACCEL_FAILED;
}


/** 
 * Generates a JSON summary of IMU calibration information.
 * 
 * Includes firmware details, sensor settings, gyroscope
 * calibration status, and accelerometer calibration parameters.
 *
 * @param out Buffer used to store the generated JSON string.
 * @param size Maximum capacity of the output buffer.
 * @return Number of characters written, excluding the null terminator,
 *         or zero if formatting fails.
 */

size_t Calibration::infoJson(char* out, size_t size) const {
  int written = snprintf(out, size,
    "{\"protocol\":%u,\"firmware\":\"%s\",\"rateHz\":%u,\"accelRangeG\":8,\"gyroRangeDps\":1000,"
    "\"gyroReady\":%s,\"gyroAnchorC\":%.2f,\"gyroBiasDps\":[%.3f,%.3f,%.3f],\"gyroSlopeDpsPerC\":[%.4f,%.4f,%.4f],"
    "\"gyroSlopeSpanC\":%.1f,\"accelCalibrated\":%s,\"accelOffsetG\":[%.4f,%.4f,%.4f],\"accelScale\":[%.4f,%.4f,%.4f]}",
    PROTOCOL_VERSION, FIRMWARE_VERSION, unsigned(STREAM_HZ),
    freshAnchor_ ? "true" : "false", anchorT_, anchorBias_[0], anchorBias_[1], anchorBias_[2],
    slope_[0], slope_[1], slope_[2], slopeWeight_,
    accelOk_ ? "true" : "false", offset_[0], offset_[1], offset_[2], scale_[0], scale_[1], scale_[2]);
  return written < 0 ? 0 : min(size_t(written), size - 1);
}
