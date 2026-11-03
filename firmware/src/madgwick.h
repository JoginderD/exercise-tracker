#pragma once
#include <math.h>

// Madgwick gradient-descent orientation filter (gyro + accelerometer, no magnetometer).
// q rotates sensor-frame vectors into a world frame whose z axis points up; yaw is
// unobservable without a magnetometer and drifts slowly, which vertical motion ignores.
class Madgwick {
 public:
  float q[4] = {1, 0, 0, 0};

  // Levels the orientation from a still accelerometer reading (yaw set to zero).
  void levelFrom(const float a[3]) {
    float norm = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (norm < 0.5f) return;
    float x = a[0] / norm, y = a[1] / norm, z = a[2] / norm;
    // Shortest rotation taking the measured up-vector (x, y, z) onto world z.
    float w = 1 + z;
    if (w < 1e-6f) { q[0] = 0; q[1] = 1; q[2] = 0; q[3] = 0; return; }
    float n = sqrtf(w * w + y * y + x * x);
    q[0] = w / n; q[1] = y / n; q[2] = -x / n; q[3] = 0;
  }

  // gyro in rad/s, accel in any unit, dt in seconds. beta trades gyro trust for accel trust.
  void update(const float g[3], const float a[3], float dt, float beta) {
    float q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];
    float qDot0 = 0.5f * (-q1 * g[0] - q2 * g[1] - q3 * g[2]);
    float qDot1 = 0.5f * (q0 * g[0] + q2 * g[2] - q3 * g[1]);
    float qDot2 = 0.5f * (q0 * g[1] - q1 * g[2] + q3 * g[0]);
    float qDot3 = 0.5f * (q0 * g[2] + q1 * g[1] - q2 * g[0]);

    float norm = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (norm > 1e-6f && beta > 0) {
      float ax = a[0] / norm, ay = a[1] / norm, az = a[2] / norm;
      // Gradient of the error between measured and predicted gravity direction.
      float f0 = 2 * (q1 * q3 - q0 * q2) - ax;
      float f1 = 2 * (q0 * q1 + q2 * q3) - ay;
      float f2 = 2 * (0.5f - q1 * q1 - q2 * q2) - az;
      float s0 = -2 * q2 * f0 + 2 * q1 * f1;
      float s1 = 2 * q3 * f0 + 2 * q0 * f1 - 4 * q1 * f2;
      float s2 = -2 * q0 * f0 + 2 * q3 * f1 - 4 * q2 * f2;
      float s3 = 2 * q1 * f0 + 2 * q2 * f1;
      float sn = sqrtf(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
      if (sn > 1e-9f) {
        qDot0 -= beta * s0 / sn;
        qDot1 -= beta * s1 / sn;
        qDot2 -= beta * s2 / sn;
        qDot3 -= beta * s3 / sn;
      }
    }
    q0 += qDot0 * dt; q1 += qDot1 * dt; q2 += qDot2 * dt; q3 += qDot3 * dt;
    float qn = sqrtf(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
    q[0] = q0 / qn; q[1] = q1 / qn; q[2] = q2 / qn; q[3] = q3 / qn;
  }

  // Rotates a sensor-frame vector into the world frame.
  void toWorld(const float v[3], float out[3]) const {
    float q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];
    out[0] = (1 - 2 * (q2 * q2 + q3 * q3)) * v[0] + 2 * (q1 * q2 - q0 * q3) * v[1] + 2 * (q1 * q3 + q0 * q2) * v[2];
    out[1] = 2 * (q1 * q2 + q0 * q3) * v[0] + (1 - 2 * (q1 * q1 + q3 * q3)) * v[1] + 2 * (q2 * q3 - q0 * q1) * v[2];
    out[2] = 2 * (q1 * q3 - q0 * q2) * v[0] + 2 * (q2 * q3 + q0 * q1) * v[1] + (1 - 2 * (q1 * q1 + q2 * q2)) * v[2];
  }
};
