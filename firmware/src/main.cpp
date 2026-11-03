// Dumbbell motion sensor: ESP32-S3 + MPU6050.
//
// Reads the MPU6050 at 200 Hz, corrects gyro bias for temperature, tracks orientation
// with a Madgwick filter, removes gravity in the world frame and streams 100 Hz samples
// to the website over Bluetooth LE (see protocol.h). Velocity, power and rep analysis
// happen in the browser (src/vbt.js), next to the camera tracking.
#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <Wire.h>

#include "calibration.h"
#include "config.h"
#include "madgwick.h"
#include "mpu6050.h"
#include "protocol.h"

namespace {
Mpu6050 mpu;
Calibration calibration;
Madgwick orientation;

BLEServer* server = nullptr;
BLECharacteristic* dataChar = nullptr;
BLECharacteristic* infoChar = nullptr;
BLE2902* dataCccd = nullptr;
volatile bool connected = false;
volatile bool restartAdvertising = false;
volatile uint16_t connId = 0;
volatile int pendingCommand = -1;

// Sensor state.
bool sensorOk = false;
uint32_t lastSensorRetryMs = 0;
uint32_t lastSampleUs = 0;
uint32_t lastPollUs = 0;
float tempC = 25;

// Stillness over the last STILL_WINDOW raw samples.
float stillAccel[STILL_WINDOW][3];
float stillGyro[STILL_WINDOW][3];
int stillFill = 0, stillHead = 0;
bool still = false;
// Running means across one continuous still second, for bias measurement.
int biasCount = 0;
float biasGyro[3], biasAccel[3], biasTemp;

// Forced gyro calibration (boot, or CMD_CALIBRATE_GYRO).
bool calibrating = true;
uint32_t calibratingSinceMs = 0;
uint8_t gyroCalCount = 0;
bool levelPending = true;

// Stream: pairs of sensor samples averaged into one streamed sample.
struct Pending { Sample sample; uint32_t ms; };
constexpr int QUEUE = 128;
Pending queue[QUEUE];
int queueHead = 0, queueSize = 0;
uint32_t queueFirstIndex = 0;  // stream index of queue[queueHead]
uint32_t streamIndex = 0;
int decimate = 0;
float sumAccel[3], sumGyro[3];
bool packetSaturated = false;
uint32_t lastTooSmallMs = 0;
uint32_t lastInfoMs = 0;

int16_t clamp16(float value) { return int16_t(constrain(lroundf(value), -32767L, 32767L)); }

void setLed(uint8_t r, uint8_t g, uint8_t b) {
#ifdef RGB_BUILTIN
  neopixelWrite(RGB_BUILTIN, r, g, b);
#endif
}

uint8_t flags() {
  uint8_t f = 0;
  if (still) f |= FLAG_STILL;
  if (calibrating) f |= FLAG_CALIBRATING;
  if (calibration.gyroReady()) f |= FLAG_GYRO_READY;
  if (calibration.accelCalibrated()) f |= FLAG_ACCEL_CALIBRATED;
  if (!sensorOk) f |= FLAG_SENSOR_ERROR;
  if (packetSaturated) f |= FLAG_SATURATED;
  return f;
}

void refreshInfo() {
  char json[512];
  size_t length = calibration.infoJson(json, sizeof json);
  infoChar->setValue(reinterpret_cast<uint8_t*>(json), length);
}

class ServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    connId = param->connect.conn_id;
    connected = true;
    // 7.5-15 ms connection interval keeps latency low for 20 packets a second.
    s->updateConnParams(param->connect.remote_bda, 6, 12, 0, 400);
  }
  void onDisconnect(BLEServer*) override {
    connected = false;
    restartAdvertising = true;
  }
};

class ControlEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (c->getLength() >= 1) pendingCommand = c->getData()[0];
  }
};

void startGyroCalibration(uint32_t now) {
  calibrating = true;
  calibratingSinceMs = now;
}

void runCommand(int command, uint32_t now) {
  switch (command) {
    case CMD_CALIBRATE_GYRO: startGyroCalibration(now); Serial.println("Gyro calibration: hold still"); break;
    case CMD_CALIBRATE_ACCEL: calibration.startAccel(now); Serial.println("Accel calibration: rest on each of 6 faces"); break;
    case CMD_CANCEL: calibration.cancelAccel(); break;
    case CMD_FORGET: calibration.forget(); startGyroCalibration(now); Serial.println("Calibration erased"); break;
    default: return;
  }
  refreshInfo();
}

void setupBle() {
  uint64_t mac = ESP.getEfuseMac();
  char name[24];
  snprintf(name, sizeof name, "%s-%02X%02X", DEVICE_PREFIX, uint8_t(mac >> 32), uint8_t(mac >> 40));
  BLEDevice::init(name);
  BLEDevice::setMTU(247);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerEvents());
  BLEService* service = server->createService(IMU_SERVICE_UUID);

  dataChar = service->createCharacteristic(IMU_DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  dataCccd = new BLE2902();
  dataChar->addDescriptor(dataCccd);
  BLECharacteristic* control = service->createCharacteristic(IMU_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  control->setCallbacks(new ControlEvents());
  infoChar = service->createCharacteristic(IMU_INFO_UUID, BLECharacteristic::PROPERTY_READ);
  refreshInfo();
  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(IMU_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("Advertising as %s\n", name);
}

bool startSensor() {
  sensorOk = mpu.begin(Wire, MPU_ADDRESS);
  if (sensorOk) Serial.printf("MPU6050 ready (WHO_AM_I 0x%02X)\n", mpu.whoAmI());
  else Serial.printf("MPU6050 not found at 0x%02X: check wiring (SDA %d, SCL %d) and power\n", MPU_ADDRESS, PIN_SDA, PIN_SCL);
  return sensorOk;
}

// Updates the stillness flag from one raw sample and, after each still second, hands
// the means to the calibration.
void trackStillness(const RawSample& raw, const float gyro[3], uint32_t now) {
  memcpy(stillAccel[stillHead], raw.accel, sizeof raw.accel);
  memcpy(stillGyro[stillHead], raw.gyro, sizeof raw.gyro);
  stillHead = (stillHead + 1) % STILL_WINDOW;
  if (stillFill < STILL_WINDOW) stillFill++;

  bool quiet = stillFill == STILL_WINDOW;
  for (int axis = 0; quiet && axis < 3; axis++) {
    float aMin = 1e9f, aMax = -1e9f, gMin = 1e9f, gMax = -1e9f;
    for (int i = 0; i < STILL_WINDOW; i++) {
      aMin = min(aMin, stillAccel[i][axis]); aMax = max(aMax, stillAccel[i][axis]);
      gMin = min(gMin, stillGyro[i][axis]); gMax = max(gMax, stillGyro[i][axis]);
    }
    quiet = aMax - aMin < STILL_ACCEL_RANGE_G && gMax - gMin < STILL_GYRO_RANGE_DPS;
  }
  float accelNorm = sqrtf(raw.accel[0] * raw.accel[0] + raw.accel[1] * raw.accel[1] + raw.accel[2] * raw.accel[2]);
  quiet = quiet && fabsf(accelNorm - 1) < 0.15f;
  // A range test cannot see slow steady rotation; a known bias can.
  if (quiet && calibration.gyroReady()) quiet = sqrtf(gyro[0] * gyro[0] + gyro[1] * gyro[1] + gyro[2] * gyro[2]) < STILL_GYRO_MAX_DPS;
  still = quiet;

  if (!still) { biasCount = 0; return; }
  if (biasCount == 0) { memset(biasGyro, 0, sizeof biasGyro); memset(biasAccel, 0, sizeof biasAccel); biasTemp = 0; }
  for (int i = 0; i < 3; i++) { biasGyro[i] += raw.gyro[i]; biasAccel[i] += raw.accel[i]; }
  biasTemp += raw.tempC;
  if (++biasCount < BIAS_WINDOW) return;
  for (int i = 0; i < 3; i++) { biasGyro[i] /= biasCount; biasAccel[i] /= biasCount; }
  calibration.addStill(biasTemp / biasCount, biasGyro, biasAccel, now);
  biasCount = 0;
  if (calibrating) {
    calibrating = false;
    levelPending = true;
    gyroCalCount++;
    Serial.printf("Gyro bias %.3f %.3f %.3f °/s at %.1f °C\n", biasGyro[0], biasGyro[1], biasGyro[2], tempC);
  }
  refreshInfo();
}

void queueSample(const Sample& sample, uint32_t ms) {
  if (!connected) { queueSize = 0; return; }
  if (queueSize == QUEUE) {  // link stalled: drop the oldest, the index gap tells the browser
    queueHead = (queueHead + 1) % QUEUE;
    queueFirstIndex++;
    queueSize--;
  }
  if (queueSize == 0) queueFirstIndex = streamIndex;
  queue[(queueHead + queueSize) % QUEUE] = {sample, ms};
  queueSize++;
}

void sendPackets(uint32_t now) {
  if (!connected || !dataCccd->getNotifications()) { queueSize = 0; return; }
  int payload = int(server->getPeerMTU(connId)) - 3;
  int fit = (payload - int(sizeof(PacketHeader))) / int(sizeof(Sample));
  if (fit < 1) {
    // Default 23-byte MTU: tell the browser once a second instead of sending truncated data.
    if (now - lastTooSmallMs < 1000) return;
    lastTooSmallMs = now;
    PacketHeader header = {PROTOCOL_VERSION, uint8_t(flags() | FLAG_LINK_TOO_SMALL), 0, uint8_t(1000 / STREAM_HZ),
                           streamIndex, now, clamp16(tempC * 100), calibration.accelProgress(), gyroCalCount};
    dataChar->setValue(reinterpret_cast<uint8_t*>(&header), sizeof header);
    dataChar->notify();
    queueSize = 0;
    return;
  }
  int perPacket = min(fit, int(TARGET_SAMPLES_PER_PACKET));
  while (queueSize >= perPacket) {
    uint8_t buffer[sizeof(PacketHeader) + TARGET_SAMPLES_PER_PACKET * sizeof(Sample)];
    PacketHeader header = {PROTOCOL_VERSION, flags(), uint8_t(perPacket), uint8_t(1000 / STREAM_HZ),
                           queueFirstIndex, queue[queueHead].ms, clamp16(tempC * 100),
                           calibration.accelProgress(), gyroCalCount};
    memcpy(buffer, &header, sizeof header);
    for (int i = 0; i < perPacket; i++) {
      memcpy(buffer + sizeof header + i * sizeof(Sample), &queue[queueHead].sample, sizeof(Sample));
      queueHead = (queueHead + 1) % QUEUE;
      queueFirstIndex++;
      queueSize--;
    }
    dataChar->setValue(buffer, sizeof header + perPacket * sizeof(Sample));
    dataChar->notify();
    packetSaturated = false;
  }
}

void processSample(const RawSample& raw, uint32_t now) {
  tempC = raw.tempC;
  float gyro[3], accel[3];
  calibration.correctGyro(raw.tempC, raw.gyro, gyro);
  calibration.correctAccel(raw.accel, accel);
  trackStillness(raw, gyro, now);
  if (raw.saturated) packetSaturated = true;

  // Level from gravity on the first sample, and again after each calibration (taken while still).
  if (levelPending && (still || streamIndex == 0)) {
    orientation.levelFrom(accel);
    levelPending = still ? false : levelPending;
  }
  // Trust the accelerometer for tilt only when it reads close to 1 g, i.e. little motion.
  float accelNorm = sqrtf(accel[0] * accel[0] + accel[1] * accel[1] + accel[2] * accel[2]);
  float beta = still ? 0.4f : fabsf(accelNorm - 1) < 0.1f ? 0.05f : 0.005f;
  constexpr float RAD = DEG_TO_RAD;
  float gyroRad[3] = {gyro[0] * RAD, gyro[1] * RAD, gyro[2] * RAD};
  orientation.update(gyroRad, accel, 1.0f / SENSOR_HZ, beta);

  float world[3];
  orientation.toWorld(accel, world);
  world[2] -= 1;
  for (int i = 0; i < 3; i++) { sumAccel[i] += world[i]; sumGyro[i] += gyro[i]; }
  if (++decimate < int(STREAM_DECIMATION)) return;

  Sample sample;
  for (int i = 0; i < 4; i++) sample.q[i] = clamp16(orientation.q[i] * 32767);
  for (int i = 0; i < 3; i++) {
    sample.accel[i] = clamp16(sumAccel[i] / STREAM_DECIMATION * 1000);
    sample.gyro[i] = clamp16(sumGyro[i] / STREAM_DECIMATION * 10);
    sumAccel[i] = sumGyro[i] = 0;
  }
  decimate = 0;
  queueSample(sample, now);
  streamIndex++;
}

void updateLed(uint32_t now) {
  bool blink = (now / 250) % 2;
  if (!sensorOk) setLed(blink ? 32 : 0, 0, 0);                  // red flashing: sensor missing
  else if (calibrating) setLed(blink ? 24 : 0, blink ? 16 : 0, 0);  // amber flashing: hold still
  else if (connected) setLed(0, 16, 0);                          // green: streaming
  else setLed(0, 0, (now / 1000) % 2 ? 16 : 2);                  // blue breathing: waiting for the website
}

void handleSerial(uint32_t now) {
  while (Serial.available()) {
    switch (Serial.read()) {
      case 'c': runCommand(CMD_CALIBRATE_GYRO, now); break;
      case 'a': runCommand(CMD_CALIBRATE_ACCEL, now); break;
      case 'x': runCommand(CMD_CANCEL, now); break;
      case 'f': runCommand(CMD_FORGET, now); break;
      case 'p': {
        char json[512];
        calibration.infoJson(json, sizeof json);
        Serial.printf("sensor=%s connected=%d still=%d temp=%.2fC q=[%.3f %.3f %.3f %.3f]\n%s\n", sensorOk ? "ok" : "missing",
                      connected, still, tempC, orientation.q[0], orientation.q[1], orientation.q[2], orientation.q[3], json);
        break;
      }
    }
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("Dumbbell sensor firmware %s. Serial commands: c=gyro cal, a=accel cal, x=cancel, f=forget, p=status\n", FIRMWARE_VERSION);
  Wire.begin(PIN_SDA, PIN_SCL, 400000);
  calibration.load();
  startSensor();
  setupBle();
  calibratingSinceMs = millis();
}

void loop() {
  uint32_t now = millis();
  uint32_t nowUs = micros();

  if (restartAdvertising) {
    restartAdvertising = false;
    delay(50);
    BLEDevice::startAdvertising();
  }
  int command = pendingCommand;
  if (command >= 0) {
    pendingCommand = -1;
    runCommand(command, now);
  }
  handleSerial(now);

  if (!sensorOk) {
    if (now - lastSensorRetryMs > 1000) {
      lastSensorRetryMs = now;
      if (startSensor()) startGyroCalibration(now);
    }
  } else if (nowUs - lastPollUs >= 1000) {
    lastPollUs = nowUs;
    if (mpu.dataReady()) {
      RawSample raw;
      if (mpu.readSample(raw)) {
        lastSampleUs = nowUs;
        processSample(raw, now);
      }
    } else if (nowUs - lastSampleUs > 200000) {
      sensorOk = false;  // no data for 200 ms: unplugged or browned out
      Serial.println("MPU6050 stopped responding");
    }
  }

  // Gives up waiting for stillness; the previous (or stored) bias stays in use, and the
  // unchanged gyroCalCount tells the browser the calibration did not happen.
  if (calibrating && now - calibratingSinceMs > GYRO_CAL_TIMEOUT_MS) calibrating = false;
  calibration.tick(now);
  calibration.save(now);
  sendPackets(now);
  if (now - lastInfoMs > 2000) { lastInfoMs = now; refreshInfo(); }
  updateLed(now);
}
