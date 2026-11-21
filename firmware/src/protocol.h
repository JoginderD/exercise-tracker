#pragma once
#include <stdint.h>

// Defines the Bluetooth communication protocol between the ESP32 and the website.
// Contains the Bluetooth UUIDs, calibration commands, sensor status flags,
// and data structures used to send sensor measurements.
// The website reads these measurements using src/imu.js.

#define IMU_SERVICE_UUID "6e0a0001-7c3b-4d9a-9f3e-2b1d5a8c4f10"
#define IMU_DATA_UUID    "6e0a0002-7c3b-4d9a-9f3e-2b1d5a8c4f10"  
#define IMU_CONTROL_UUID "6e0a0003-7c3b-4d9a-9f3e-2b1d5a8c4f10"  
#define IMU_INFO_UUID    "6e0a0004-7c3b-4d9a-9f3e-2b1d5a8c4f10"  

constexpr uint8_t PROTOCOL_VERSION = 1;

enum Flag : uint8_t {
  FLAG_STILL = 1 << 0,          
  FLAG_CALIBRATING = 1 << 1,      
  FLAG_GYRO_READY = 1 << 2,      
  FLAG_ACCEL_CALIBRATED = 1 << 3,  
  FLAG_SENSOR_ERROR = 1 << 4,     
  FLAG_SATURATED = 1 << 5,         
  FLAG_LINK_TOO_SMALL = 1 << 6,    
};

enum Command : uint8_t {
  CMD_CALIBRATE_GYRO = 1,   
  CMD_CALIBRATE_ACCEL = 2,  
  CMD_CANCEL = 3,           
  CMD_FORGET = 4,           
};

enum AccelState : uint8_t { ACCEL_IDLE = 0, ACCEL_COLLECTING = 1, ACCEL_DONE = 2, ACCEL_FAILED = 3 };

#pragma pack(push, 1)

struct PacketHeader {
  uint8_t version;
  uint8_t flags;
  uint8_t count;        
  uint8_t periodMs;    
  uint32_t firstIndex;  
  uint32_t firstMs;    
  int16_t tempCenti;    
  uint8_t accelProgress;
  uint8_t gyroCalCount; 
};
struct Sample {
  int16_t q[4];      
  int16_t accel[3];  
  int16_t gyro[3];   
};
#pragma pack(pop)

static_assert(sizeof(PacketHeader) == 16, "header layout is part of the protocol");
static_assert(sizeof(Sample) == 20, "sample layout is part of the protocol");
