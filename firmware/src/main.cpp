/*
 * Exercise Tracker - Main ESP32 Firmware
 *
 * Reads acceleration, rotation, and temperature from the MPU6050.
 * Corrects sensor errors, detects when the sensor is still,
 * and tracks the sensor's orientation.
 *
 * Processes the measurements and sends them to the website
 * through Bluetooth Low Energy (BLE).
 *
 * The website uses this data to analyze exercise movements.
 */

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

// ==========================================
// Sensor and Calibration Objects
// ==========================================

Mpu6050 mpu;
Calibration calibration;
Madgwick orientation;

// ==========================================
// Bluetooth Connection
// ==========================================

// Stores the Bluetooth connection and communication information.
BLEServer* server = nullptr;
BLECharacteristic* dataChar = nullptr;
BLECharacteristic* infoChar = nullptr;
BLE2902* dataCccd = nullptr;
volatile bool connected = false;
volatile bool restartAdvertising = false;
volatile uint16_t connId = 0;
volatile int pendingCommand = -1;

// ==========================================
// Sensor Status
// ==========================================

// Tracks whether the sensor is working and when readings are collected.
bool sensorOk = false;
uint32_t lastSensorRetryMs = 0;
uint32_t lastSampleUs = 0;
uint32_t lastPollUs = 0;
float tempC = 25;

// ==========================================
// Stillness Detection
// ==========================================

// Stores recent acceleration and rotation readings to determine whether the sensor is stationary.
float stillAccel[STILL_WINDOW][3];
float stillGyro[STILL_WINDOW][3];
int stillFill = 0, stillHead = 0;
bool still = false;

// Collects readings during one second of continuous stillness to calculate gyroscope calibration values.
int biasCount = 0;
float biasGyro[3], biasAccel[3], biasTemp;

// ==========================================
// Gyroscope Calibration
// ==========================================

// Tracks calibration progress and whether the sensor's
// starting orientation needs to be updated.
bool calibrating = true;
uint32_t calibratingSinceMs = 0;
uint8_t gyroCalCount = 0;
bool levelPending = true;

// ==========================================
// Sensor Data and Transmission
// ==========================================

// Stores processed sensor readings until they can
// be grouped into packets and sent over Bluetooth.
struct Pending { Sample sample; uint32_t ms; };


constexpr int QUEUE = 128;
Pending queue[QUEUE];
int queueHead = 0, queueSize = 0;
uint32_t queueFirstIndex = 0;  
uint32_t streamIndex = 0;
int decimate = 0;
float sumAccel[3], sumGyro[3];
bool packetSaturated = false;
uint32_t lastTooSmallMs = 0;
uint32_t lastInfoMs = 0;

// ==========================================
// Helper Functions
// ==========================================

// Keeps sensor values within the range of a 16-bit integer.
int16_t clamp16(float value) { return int16_t(constrain(lroundf(value), -32767L, 32767L)); }

// Controls the ESP32's built-in RGB LED
void setLed(uint8_t r, uint8_t g, uint8_t b) {
#ifdef RGB_BUILTIN
  neopixelWrite(RGB_BUILTIN, r, g, b);
#endif
}

// Combines sensor and calibration status into one value can be sent to the website.
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

// Updates the calibration information available over Bluetooth.
void refreshInfo() {
  char json[512];
  size_t length = calibration.infoJson(json, sizeof json);
  infoChar->setValue(reinterpret_cast<uint8_t*>(json), length);
}

// ==========================================
// Bluetooth Event Handling
// ==========================================

// Handles Bluetooth connections and disconnections.
class ServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    connId = param->connect.conn_id;
    connected = true;

    // Requests a short connection interval to reduce delays when sending sensor readings..
    s->updateConnParams(param->connect.remote_bda, 6, 12, 0, 400);
  }

  void onDisconnect(BLEServer*) override {
    connected = false;
    restartAdvertising = true;
  }
};

// Receives calibration commands sent from the website.
class ControlEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (c->getLength() >= 1) pendingCommand = c->getData()[0];
  }
};

// ==========================================
// Calibration Commands
// ==========================================

// Starts a new gyroscope calibration session.
void startGyroCalibration(uint32_t now) {
  calibrating = true;
  calibratingSinceMs = now;
}

// Handles commands to start, cancel, or reset calibration.
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

// ==========================================
// Bluetooth Setup
// ==========================================

// Sets up Bluetooth communication so the website can connect to the ESP32 and receive sensor readings.
void setupBle() {
  uint64_t mac = ESP.getEfuseMac();
  char name[24];

  // Creates a device name using part of the ESP32's unique address
  snprintf(name, sizeof name, "%s-%02X%02X", DEVICE_PREFIX, uint8_t(mac >> 32), uint8_t(mac >> 40));

  BLEDevice::init(name);
  BLEDevice::setMTU(247);

  server = BLEDevice::createServer();
  server->setCallbacks(new ServerEvents());
  
  BLEService* service = server->createService(IMU_SERVICE_UUID);

  // Creates the Bluetooth characteristic used to send sensor data.
  dataChar = service->createCharacteristic(IMU_DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);

  dataCccd = new BLE2902();
  dataChar->addDescriptor(dataCccd);

  // Allows the website to send calibration commands.
  BLECharacteristic* control = service->createCharacteristic(IMU_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  control->setCallbacks(new ControlEvents());

  // Allows the website to read sensor and calibration information.
  infoChar = service->createCharacteristic(IMU_INFO_UUID, BLECharacteristic::PROPERTY_READ);
  
  refreshInfo();
  service->start();

  // Makes the ESP32 discoverable by nearby Bluetooth devices.
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(IMU_SERVICE_UUID);
  advertising->setScanResponse(true);
  
  BLEDevice::startAdvertising();
  Serial.printf("Advertising as %s\n", name);
}

// ==========================================
// Sensor Initialization
// ==========================================

// Attempts to connect to the MPU6050 and reports whether the sensor was found successfully.
bool startSensor() {
  sensorOk = mpu.begin(Wire, MPU_ADDRESS);
  if (sensorOk) 
    Serial.printf("MPU6050 ready (WHO_AM_I 0x%02X)\n", mpu.whoAmI());
  else 
    Serial.printf("MPU6050 not found at 0x%02X: check wiring (SDA %d, SCL %d) and power\n", MPU_ADDRESS, PIN_SDA, PIN_SCL);
  
  return sensorOk;
}

// ==========================================
// Stillness Detection and Calibration
// ==========================================

// Checks whether the sensor is stationary using recent
// acceleration and gyroscope readings.
//
// When the sensor stays still for one second, the average
// readings are used to improve calibration.
void trackStillness(const RawSample& raw, const float gyro[3], uint32_t now) {

  // Stores recent readings in a fixed-size buffer.
  memcpy(stillAccel[stillHead], raw.accel, sizeof raw.accel);
  memcpy(stillGyro[stillHead], raw.gyro, sizeof raw.gyro);


  stillHead = (stillHead + 1) % STILL_WINDOW;
  if (stillFill < STILL_WINDOW) stillFill++;

  // Checks whether acceleration and rotation remain
  // within the allowed limits over recent readings.
  bool quiet = stillFill == STILL_WINDOW;

  for (int axis = 0; quiet && axis < 3; axis++) {
    float aMin = 1e9f, aMax = -1e9f, gMin = 1e9f, gMax = -1e9f;


    for (int i = 0; i < STILL_WINDOW; i++) {
      aMin = min(aMin, stillAccel[i][axis]); aMax = max(aMax, stillAccel[i][axis]);
      gMin = min(gMin, stillGyro[i][axis]); gMax = max(gMax, stillGyro[i][axis]);
    }
    quiet = aMax - aMin < STILL_ACCEL_RANGE_G && gMax - gMin < STILL_GYRO_RANGE_DPS;
  }

  // Checks that acceleration is close to the expected
  // gravity reading when the sensor is stationary.
  float accelNorm = sqrtf(raw.accel[0] * raw.accel[0] + raw.accel[1] * raw.accel[1] + raw.accel[2] * raw.accel[2]);
  
  quiet = quiet && fabsf(accelNorm - 1) < 0.15f;
  
  if (quiet && calibration.gyroReady()) quiet = sqrtf(gyro[0] * gyro[0] + gyro[1] * gyro[1] + gyro[2] * gyro[2]) < STILL_GYRO_MAX_DPS;
  still = quiet;

  if (!still) { biasCount = 0; return; }

  if (biasCount == 0) { memset(biasGyro, 0, sizeof biasGyro); memset(biasAccel, 0, sizeof biasAccel); biasTemp = 0; }

  // Collects gyroscope, accelerometer, and temperature
  // readings during continuous stillness.
  for (int i = 0; i < 3; i++) { biasGyro[i] += raw.gyro[i]; biasAccel[i] += raw.accel[i]; }
  
  biasTemp += raw.tempC;

  if (++biasCount < BIAS_WINDOW) return;
  
  // Calculates the average readings and uses them
  // to update sensor calibration.
  for (int i = 0; i < 3; i++) { biasGyro[i] /= biasCount; biasAccel[i] /= biasCount; }

  calibration.addStill(biasTemp / biasCount, biasGyro, biasAccel, now);
  biasCount = 0;

  // Completes the requested gyroscope calibration
  // after a valid stationary measurement is collected.
  if (calibrating) {
    calibrating = false;
    levelPending = true;
    gyroCalCount++;
    Serial.printf("Gyro bias %.3f %.3f %.3f °/s at %.1f °C\n", biasGyro[0], biasGyro[1], biasGyro[2], tempC);
  }
  refreshInfo();
}

// ==========================================
// Sensor Data Queue
// ==========================================

// Stores processed readings until they can be transmitted. If the queue is full, the oldest reading is removed.
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

// ==========================================
// Bluetooth Data Transmission
// ==========================================

// Groups stored sensor readings into Bluetooth packets and sends them to the connected website.
void sendPackets(uint32_t now) {
  if (!connected || !dataCccd->getNotifications()) { queueSize = 0; return; }
  int payload = int(server->getPeerMTU(connId)) - 3;
  int fit = (payload - int(sizeof(PacketHeader))) / int(sizeof(Sample));
  if (fit < 1) {
    
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

  // Sends stored readings in groups that fit
  // within the available Bluetooth packet size.
  while (queueSize >= perPacket) {
    uint8_t buffer[sizeof(PacketHeader) + TARGET_SAMPLES_PER_PACKET * sizeof(Sample)];
    PacketHeader header = {PROTOCOL_VERSION, flags(), uint8_t(perPacket), uint8_t(1000 / STREAM_HZ),
                           queueFirstIndex, queue[queueHead].ms, clamp16(tempC * 100),
                           calibration.accelProgress(), gyroCalCount};
    memcpy(buffer, &header, sizeof header);

     // Adds each sensor reading to the packet.
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

// ==========================================
// Sensor Data Processing
// ==========================================

// Corrects raw sensor readings, estimates orientation,
// removes gravity, and prepares data for transmission.
void processSample(const RawSample& raw, uint32_t now) {
  tempC = raw.tempC;
  float gyro[3], accel[3];

  // Corrects sensor readings using calibration values.
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

// ==========================================
// LED Status
// ==========================================

// Changes the LED colour to show the device's current status.
void updateLed(uint32_t now) {
  bool blink = (now / 250) % 2;
  if (!sensorOk) setLed(blink ? 32 : 0, 0, 0);                  // red flashing: sensor missing
  else if (calibrating) setLed(blink ? 24 : 0, blink ? 16 : 0, 0);  // amber flashing: hold still
  else if (connected) setLed(0, 16, 0);                          // green: streaming
  else setLed(0, 0, (now / 1000) % 2 ? 16 : 2);                  // blue breathing: waiting for the website
}

// ==========================================
// Serial Commands
// ==========================================

// Allows calibration commands and sensor information to be accessed through the Serial Monitor.
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

// ==========================================
// Main Program Setup
// ==========================================

// Runs once when the ESP32 starts.
// Initializes serial communication, the MPU6050, saved calibration values, and Bluetooth.
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("Dumbbell sensor firmware %s. Serial commands: c=gyro cal, a=accel cal, x=cancel, f=forget, p=status\n", FIRMWARE_VERSION);

  // Starts I2C communication with the MPU6050.
  Wire.begin(PIN_SDA, PIN_SCL, 400000);

  calibration.load();
  startSensor();
  setupBle();
  calibratingSinceMs = millis();
}

// ==========================================
// Main Program Loop
// ==========================================

// Runs continuously while the ESP32 is powered on.
// Handles Bluetooth, reads sensor data, checks calibration, and updates the device status.

void loop() {
  uint32_t now = millis();
  uint32_t nowUs = micros();

  // Restarts Bluetooth advertising after a disconnection
  // so the website can connect again.
  if (restartAdvertising) {
    restartAdvertising = false;
    delay(50);
    BLEDevice::startAdvertising();
  }

  // Processes calibration commands received over Bluetooth.
  int command = pendingCommand;

  if (command >= 0) {
    pendingCommand = -1;
    runCommand(command, now);
  }
  handleSerial(now);

  // Attempts to reconnect to the MPU6050 if it is missing or has stopped responding.
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
      sensorOk = false; 
      Serial.println("MPU6050 stopped responding");
    }
  }

  if (calibrating && now - calibratingSinceMs > GYRO_CAL_TIMEOUT_MS) calibrating = false;

  // Checks calibration progress and saves updated values.
  calibration.tick(now);
  calibration.save(now);

  // Sends available sensor readings to the website.
  sendPackets(now);

  // Refreshes the calibration information every two seconds.
  if (now - lastInfoMs > 2000) { lastInfoMs = now; refreshInfo(); }

  // Updates the LED to show the current device status.
  updateLed(now);
}
