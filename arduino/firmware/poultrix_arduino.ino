#include <DHT.h>
#include <Wire.h>
#include <EEPROM.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_PWMServoDriver.h>

// ============================================================
// POULTRIX - ARDUINO MEGA ENVIRONMENTAL CONTROLLER
// DHT22 + LDR + AUTOMATIC LIGHTING
// ============================================================

// -------------------- DHT22 --------------------
#define DHT_PIN 30
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

// -------------------- LDR ----------------------
#define LDR_PIN A0

// -------------------- RELAYS -------------------
// 8-channel relay module - ACTIVE LOW

#define FAN1_PIN 22
#define FAN2_PIN 23
#define FAN3_PIN 31  // Remapped from D24 (suspected damaged pin)
#define FAN4_PIN 25

#define LED_PIN 32  // Remapped from D26 (suspected damaged pin)

// Pin 27 / Relay CH6 unused

#define HEATER1_PIN 28  // IN7: one relay controls both heat lamps
// D29 unused; do not connect a second heater relay


// ============================================================
// MODES
// ============================================================

enum SystemMode {
  TEST_MODE,
  LIVE_MODE,
  SAFE_MODE
};

SystemMode currentMode = SAFE_MODE;
const bool AUTOMATIC_FEEDING_ENABLED = false; // Unattended scheduling stays disabled.
const bool MANUAL_FEEDING_ENABLED = true; // Only accepted in LIVE, outside maintenance.
// Maintenance supports manual heater relay on D28; physical thermal protection required.
bool lcdSimTemperature = false, lcdSimHopper = false;
float lcdSimTempC = 0.0f, lcdSimHopperG = 0.0f;
bool maintenanceActive = false;
unsigned long maintenanceLastPing = 0;
const unsigned long MAINTENANCE_TIMEOUT_MS = 10000UL;
void maintenanceOff() {
  maintenanceActive = false;
  lcdSimTemperature = false;
  lcdSimHopper = false;
  stopGroups();
  setFans(false,false,false,false);
  setHeaters(false,false);
  setLED(false);
  for (uint8_t i=0;i<3;i++) closeGate(i,"STOPPED");
}



// ============================================================
// BROILER STAGES
// ============================================================

enum BroilerStage {
  STARTER,
  GROWER,
  FINISHER
};

// Persist the LAST ARDUINO-CONFIRMED stage across power cycles.
// EEPROM.update only writes changed bytes, avoiding unnecessary wear.
// The signature prevents treating uninitialized EEPROM as a valid stage.
const int STAGE_EEPROM_SIGNATURE_ADDR = 0;
const int STAGE_EEPROM_VALUE_ADDR = 1;
const uint8_t STAGE_EEPROM_SIGNATURE = 0xB7;
BroilerStage currentStage = STARTER; // fallback only when no saved stage exists

void loadSavedStage() {
  if (EEPROM.read(STAGE_EEPROM_SIGNATURE_ADDR) == STAGE_EEPROM_SIGNATURE) {
    uint8_t saved = EEPROM.read(STAGE_EEPROM_VALUE_ADDR);
    if (saved <= static_cast<uint8_t>(FINISHER)) {
      currentStage = static_cast<BroilerStage>(saved);
      return;
    }
  }
  currentStage = STARTER;
}

void saveCurrentStage() {
  EEPROM.update(STAGE_EEPROM_VALUE_ADDR, static_cast<uint8_t>(currentStage));
  EEPROM.update(STAGE_EEPROM_SIGNATURE_ADDR, STAGE_EEPROM_SIGNATURE);
}



// ============================================================
// SENSOR VALUES
// ============================================================

float temperature = 27.0;
float humidity = 0.0;

// Test Mode simulated lux
float testLux = 15.0;

// Live hardware readings
int lightRaw = 0;
float liveLux = 0.0;


// ============================================================
// TARGET VALUES
// ============================================================

float tempMin = 26.0;
float tempMax = 28.0;

float luxMin = 10.0;
float luxMax = 20.0;


// ============================================================
// OUTPUT STATES
// ============================================================

bool fan1State = false;
bool fan2State = false;
bool fan3State = false;
bool fan4State = false;

bool heater1State = false;
bool heater2State = false;

bool ledState = false;


// ============================================================
// TIMING
// ============================================================

unsigned long lastSensorRead = 0;

const unsigned long SENSOR_INTERVAL = 2000;

// Raspberry Pi communication watchdog
const unsigned long WATCHDOG_TIMEOUT_MS = 10000UL;
unsigned long lastHeartbeat = 0;




// ============================================================
// DIRECT SERVO CONTROL - Arduino Mega pins D9, D10, D11
// Use an external regulated servo power supply and common ground.
// Test physical gate movement without feed before enabling dispensing.
// ============================================================
// PCA9685 channels 0,1,2 are feed gates 1,2,3.
int GATE_CLOSED[3] = {0, 0, 0}; // Legacy calibration, group gates use GROUP_CLOSED
const int GATE_OPEN[3] = {90, 90, 90};
const float GATE_RATE[3] = {22.2222f, 18.6667f, 20.0f}; // estimated g/s
const unsigned long GATE_MAX_MS = 10000UL;
extern bool groupRunning;
bool gateActive[3] = {false, false, false};
unsigned long gateStart[3] = {0, 0, 0};
unsigned long gateDuration[3] = {0, 0, 0};
const char* gateLastStatus[3] = {"CLOSED", "CLOSED", "CLOSED"};

void setPcaAngle(uint8_t channel, int angle);
void setGateAngle(uint8_t gate, int angle) {
  if (gate >= 3) return;
  // Feeding compartments consist of five synchronized PCA9685 servos each.
  // Compartment 1: channels 0-4; compartment 2: channels 11-15.
  if (gate < 2) {
    for (uint8_t j=0; j<5; j++)
      setPcaAngle(gate == 0 ? j : 11+j, angle);
  } else {
    setPcaAngle(gate, angle); // Legacy third gate is never dispensed.
  }
}

void emitGateStatus(uint8_t gate, const char* status) {
  gateLastStatus[gate] = status;
  Serial.print("FEED_GATE:");
  Serial.print(gate + 1);
  Serial.print(",");
  Serial.print(status);
  Serial.print(",");
  Serial.println(gateDuration[gate]);
}

void closeGate(uint8_t gate, const char* status) {
  setGateAngle(gate, GATE_CLOSED[gate]);
  gateActive[gate] = false;
  emitGateStatus(gate, status);
}

void updateFeedGates() {
  unsigned long now = millis();
  for (uint8_t i = 0; i < 2; i++) {
    if (gateActive[i] && now - gateStart[i] >= gateDuration[i]) {
      closeGate(i, "COMPLETED");
    }
  }
}

void reportFeedGates() {
  for (uint8_t i = 0; i < 3; i++) {
    emitGateStatus(i, gateActive[i] ? "DISPENSING" : gateLastStatus[i]);
  }
}

bool handleFeedCommand(String command) {
  // Calibration: FEED:ANGLE:1,80 moves gate 1 to 80 degrees.
  // FEED:SETCLOSED:1,80 saves its closed angle in RAM and closes it.
  if (command.startsWith("FEED:ANGLE:") || command.startsWith("FEED:SETCLOSED:")) {
    bool saveClosed = command.startsWith("FEED:SETCLOSED:");
    String args = command.substring(saveClosed ? 15 : 11);
    int comma = args.indexOf(',');
    if (comma < 1) { Serial.println("FEED_ERROR:INVALID_CALIBRATION"); return true; }
    String id = args.substring(0, comma);
    String degrees = args.substring(comma + 1);
    id.trim(); degrees.trim();
    if (id.length() != 1 || id[0] < '1' || id[0] > '2' || degrees.length() == 0) {
      Serial.println("FEED_ERROR:INVALID_CALIBRATION"); return true;
    }
    for (unsigned int j = 0; j < degrees.length(); j++) {
      if (!isDigit(degrees[j])) { Serial.println("FEED_ERROR:INVALID_CALIBRATION"); return true; }
    }
    long angle = degrees.toInt();
    if (angle < 0 || angle > 180) { Serial.println("FEED_ERROR:INVALID_ANGLE"); return true; }
    for (uint8_t j = 0; j < 3; j++) {
      if (gateActive[j] || groupRunning) { Serial.println("FEED_ERROR:BUSY"); return true; }
    }
    uint8_t gate = id[0] - '1';
    setGateAngle(gate, (int)angle);
    if (saveClosed) GATE_CLOSED[gate] = (int)angle;
    Serial.print(saveClosed ? "FEED_CLOSED_ANGLE:" : "FEED_TEST_ANGLE:");
    Serial.print(gate + 1); Serial.print(','); Serial.println(angle);
    return true;
  }
  if (command == "FEED:STATUS") { reportFeedGates(); return true; }
  if (command == "FEED:STOP") {
    stopGroups(); // Stop either compartment group as well as normal feeding
    for (uint8_t i = 0; i < 3; i++) closeGate(i, "STOPPED");
    return true;
  }
  if (!command.startsWith("FEED:DISPENSE:")) return false;
  if (!MANUAL_FEEDING_ENABLED || currentMode != LIVE_MODE || maintenanceActive || groupRunning) {
    Serial.println(F("FEED_ERROR:DISABLED"));
    return true;
  }
  String args = command.substring(14);
  int comma = args.indexOf(',');
  if (comma <= 0) { Serial.println("FEED_ERROR:INVALID_FORMAT"); return true; }
  String idText = args.substring(0, comma);
  String msText = args.substring(comma + 1);
  idText.trim(); msText.trim();
  if (idText.length() != 1 || idText[0] < '1' || idText[0] > '2' || msText.length() == 0) {
    Serial.println("FEED_ERROR:INVALID_ARGUMENTS"); return true;
  }
  for (unsigned int j = 0; j < msText.length(); j++) {
    if (!isDigit(msText[j])) { Serial.println("FEED_ERROR:INVALID_DURATION"); return true; }
  }
  unsigned long ms = msText.toInt();
  if (ms == 0 || ms > GATE_MAX_MS) { Serial.println("FEED_ERROR:INVALID_DURATION"); return true; }
  uint8_t i = idText[0] - '1';
  for (uint8_t j = 0; j < 3; j++) {
    if (gateActive[j]) { Serial.println("FEED_ERROR:BUSY"); return true; }
  }
  gateDuration[i] = ms;
  gateStart[i] = millis();
  gateActive[i] = true;
  setGateAngle(i, GATE_OPEN[i]);
  emitGateStatus(i, "STARTED");
  return true;
}


// TWO HX711 MODULES: separate hopper and trough estimates.
// Hopper calibration remains PRELIMINARY and shows drift.
// Trough calibration is PROVISIONAL pending repeatability testing.
const byte HOPPER_DOUT = 3, HOPPER_SCK = 2;
const byte TROUGH_DOUT = 5, TROUGH_SCK = 4;
long hopperZero = 1029390L;
float hopperCountsPerGram = 19.746f;
const long troughZero = 377696L; // Updated user calibration
const float troughCountsPerGram = 83.97f; // Updated user calibration
unsigned long lastWeightReport = 0;
const unsigned long WEIGHT_INTERVAL_MS = 2000;

// Green D35 = healthy, yellow D36 = starting/fault.
const byte GREEN_STATUS_LED = 35;
const byte YELLOW_STATUS_LED = 36;
unsigned long lastPiHeartbeat = 0;
const unsigned long HEALTH_TIMEOUT_MS = 12000;
const unsigned long STARTUP_TIMEOUT_MS = 60000;
bool piReady = false;
bool piFault = false;

bool readHx711Raw(byte dout, byte sck, long &raw) {
  if (digitalRead(dout) == HIGH) return false;
  unsigned long value = 0;
  noInterrupts();
  for (byte i = 0; i < 24; ++i) {
    digitalWrite(sck, HIGH); delayMicroseconds(1);
    value = (value << 1) | digitalRead(dout);
    digitalWrite(sck, LOW); delayMicroseconds(1);
  }
  digitalWrite(sck, HIGH); delayMicroseconds(1);
  digitalWrite(sck, LOW);
  interrupts();
  if (value & 0x800000UL) value |= 0xFF000000UL;
  raw = (long)value;
  return true;
}
Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);
LiquidCrystal_I2C lcd(0x27, 20, 4);
// Defined before updateLCD() so the Arduino compiler can see it.
bool dhtReadingValid = false;
// Conservative starting pulse limits. Calibrate for your actual servos.
const uint16_t SERVO_MIN_US = 1000;
const uint16_t SERVO_MAX_US = 2000;
const uint8_t SERVO_COUNT = 16;
uint8_t servoAngles[SERVO_COUNT] = {0};
unsigned long lastLCDUpdate = 0;
const unsigned long LCD_UPDATE_MS = 1500;
// LCD-only simulated values declared above maintenanceOff().
void setPcaAngle(uint8_t channel, int angle) {
  if (channel >= SERVO_COUNT) return;
  angle = constrain(angle, 0, 180);
  uint16_t us = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
  pwm.writeMicroseconds(channel, us);
  servoAngles[channel] = (uint8_t)angle;
}
// Compartment 1: PCA9685 channels 0-4; Compartment 2: channels 11-15.
// All ten gates: 0 degrees CLOSED, 90 degrees OPEN. Verify mechanics before powering.
const uint8_t GROUP_CHANNELS[2][5] = {{0,1,2,3,4},{11,12,13,14,15}};
const uint8_t GROUP_CLOSED[2][5] = {{0,0,0,0,0},{0,0,0,0,0}};
const uint8_t GROUP_OPEN[2][5] = {{90,90,90,90,90},{90,90,90,90,90}};
const unsigned long GROUP_MAX_MS = 10000UL; // supervised group test: 0.1-10 seconds maximum
bool groupRunning = false;
uint8_t groupRunningId = 0;
unsigned long groupStarted = 0, groupDuration = 0;
void stopGroups() {
  for (uint8_t g=0;g<2;g++) for (uint8_t j=0;j<5;j++)
    setPcaAngle(GROUP_CHANNELS[g][j], GROUP_CLOSED[g][j]);
  groupRunning = false;
}
void updateGroups() {
  if (groupRunning && millis()-groupStarted>=groupDuration) {
    uint8_t finished=groupRunningId;
    stopGroups();
    Serial.print(F("BYPASS_GROUP_DONE:")); Serial.println(finished);
  }
}
bool handleGroupCommand(const String &command) {
  if (command == "BYPASS:GROUP:STOP") {
    stopGroups();
    Serial.println(F("BYPASS_ACK:GROUP:STOP"));
    return true;
  }
  if (!command.startsWith("BYPASS:GROUP:")) return false;
  if (!maintenanceActive || (currentMode != SAFE_MODE && currentMode != LIVE_MODE)) {
    Serial.println(F("BYPASS_ERROR:NOT_ACTIVE")); return true;
  }
  if (groupRunning || gateActive[0] || gateActive[1]) { Serial.println(F("BYPASS_ERROR:BUSY")); return true; }
  String args=command.substring(13);
  int comma=args.indexOf(',');
  if (comma!=1 || (args[0]!='1' && args[0]!='2')) {
    Serial.println(F("BYPASS_ERROR:INVALID_GROUP")); return true;
  }
  String duration=args.substring(comma+1);
  if (!duration.length()) { Serial.println(F("BYPASS_ERROR:INVALID_DURATION")); return true; }
  for (unsigned int i=0;i<duration.length();i++) if (!isDigit(duration[i])) {
    Serial.println(F("BYPASS_ERROR:INVALID_DURATION")); return true;
  }
  unsigned long ms=duration.toInt();
  if (ms<100 || ms>GROUP_MAX_MS) { Serial.println(F("BYPASS_ERROR:INVALID_DURATION")); return true; }
  for (uint8_t i=0;i<3;i++) if (gateActive[i]) {
    Serial.println(F("BYPASS_ERROR:FEED_BUSY")); return true;
  }
  uint8_t g=args[0]-'1';
  groupRunning=true; groupRunningId=g+1; groupStarted=millis(); groupDuration=ms;
  for (uint8_t i=0;i<5;i++) setPcaAngle(GROUP_CHANNELS[g][i], GROUP_OPEN[g][i]);
  maintenanceLastPing=millis();
  Serial.print(F("BYPASS_ACK:GROUP:")); Serial.print(g+1); Serial.print(','); Serial.println(ms);
  return true;
}
void lcdLine(uint8_t row, const String &value) {
  lcd.setCursor(0, row);
  for (uint8_t col = 0; col < 20; col++)
    lcd.print(col < value.length() ? value[col] : ' ');
}
String getStageName();
void updateLCD() {
  if (millis() - lastLCDUpdate < LCD_UPDATE_MS) return;
  lastLCDUpdate = millis();
  lcdLine(0, F("POULTRIX MONITOR"));
  lcdLine(1, String(F("Stage: ")) + getStageName());
  long raw;
  if (lcdSimHopper) {
    lcdLine(2, String(F("Hopper: ")) + String(lcdSimHopperG / 1000.0f, 2) + F(" kg*"));
  } else if (hopperCountsPerGram != 0 && readHx711Raw(HOPPER_DOUT, HOPPER_SCK, raw)) {
    float kg = (raw - hopperZero) / hopperCountsPerGram / 1000.0f;
    if (kg < 0) kg = 0;
    lcdLine(2, String(F("Hopper: ")) + String(kg, 2) + F(" kg"));
  } else {
    lcdLine(2, F("Hopper: --.-- kg"));
  }
  lcdLine(3, lcdSimTemperature ? String(F("Temp:   ")) + String(lcdSimTempC, 1) + F(" C*") : (dhtReadingValid ? String(F("Temp:   ")) + String(temperature, 1) + F(" C") : String(F("Temp:   --.- C"))));
}

bool handlePcaCommand(const String &command) {
  if (command == "SERVO:STATUS") {
    for (uint8_t g=0;g<2;g++) for (uint8_t i=0;i<5;i++) {
      uint8_t channel=GROUP_CHANNELS[g][i];
      Serial.print(F("SERVO_CHANNEL:")); Serial.print(channel);
      Serial.print(','); Serial.println(servoAngles[channel]);
    }
    return true;
  }
  if (!command.startsWith("SERVO:ANGLE:")) return false;
  String args = command.substring(12);
  int comma = args.indexOf(',');
  if (comma < 1) { Serial.println(F("SERVO_ERROR:FORMAT")); return true; }
  String id = args.substring(0, comma), deg = args.substring(comma + 1);
  id.trim(); deg.trim();
  if (!id.length() || !deg.length()) { Serial.println(F("SERVO_ERROR:FORMAT")); return true; }
  for (unsigned int i=0;i<id.length();i++) if (!isDigit(id[i])) { Serial.println(F("SERVO_ERROR:FORMAT")); return true; }
  for (unsigned int i=0;i<deg.length();i++) if (!isDigit(deg[i])) { Serial.println(F("SERVO_ERROR:FORMAT")); return true; }
  long n=id.toInt(), a=deg.toInt();
  if (n<1 || n>10 || a<0 || a>180) { Serial.println(F("SERVO_ERROR:RANGE")); return true; }
  // Gate channels 1-3 remain under the existing FEED command safety logic.
  if (n<=3) { Serial.println(F("SERVO_ERROR:USE_FEED_ANGLE_FOR_GATES")); return true; }
  if (currentMode != TEST_MODE || maintenanceActive || groupRunning) { Serial.println(F("SERVO_ERROR:TEST_MODE_REQUIRED")); return true; }
  const uint8_t channel = GROUP_CHANNELS[(n-1)/5][(n-1)%5];
  setPcaAngle(channel, a);
  Serial.print(F("SERVO_OK:")); Serial.print(n); Serial.print(','); Serial.println(a);
  return true;
}


void reportOneWeight(const __FlashStringHelper *name, byte dout, byte sck,
                     long zero, float countsPerGram) {
  long raw;
  Serial.print(name);
  if (!readHx711Raw(dout, sck, raw)) {
    Serial.println(F(":NOT_READY")); return;
  }
  Serial.print(F(":RAW,")); Serial.print(raw);
  if (countsPerGram == 0.0f) {
    Serial.println(F(",UNCALIBRATED")); return;
  }
  float grams = (raw - zero) / countsPerGram;
  Serial.print(F(",ESTIMATED,")); Serial.println(grams, 1);
}
void reportFeedWeight() {
  if (millis() - lastWeightReport < WEIGHT_INTERVAL_MS) return;
  lastWeightReport = millis();
  reportOneWeight(F("HOPPER_WEIGHT"), HOPPER_DOUT, HOPPER_SCK, hopperZero, hopperCountsPerGram);
  reportOneWeight(F("TROUGH_WEIGHT"), TROUGH_DOUT, TROUGH_SCK, troughZero, troughCountsPerGram);
}

void updateSystemIndicators() {
  unsigned long now = millis();
  bool timedOut = lastPiHeartbeat && (now - lastPiHeartbeat > HEALTH_TIMEOUT_MS);
  bool starting = !lastPiHeartbeat && now < STARTUP_TIMEOUT_MS;
  bool healthy = piReady && !piFault && !timedOut;
  digitalWrite(GREEN_STATUS_LED, healthy ? HIGH : LOW);
  digitalWrite(YELLOW_STATUS_LED,
    healthy ? LOW : (starting ? ((now / 500) % 2 ? HIGH : LOW) : HIGH));
}

bool handleSystemCommand(const String &command) {
  if (command == "SYS:INIT") {
    piReady = false; piFault = false; lastPiHeartbeat = 0;
    Serial.println(F("SYSTEM_HEALTH:INITIALIZING")); return true;
  }
  if (command == "SYS:READY" || command == "SYS:FAULT") {
    piReady = command == "SYS:READY";
    piFault = command == "SYS:FAULT";
    lastPiHeartbeat = millis();
    Serial.println(piReady ? F("SYSTEM_HEALTH:READY") : F("SYSTEM_HEALTH:FAULT"));
    return true;
  }
  if (command == "SYS:STATUS") {
    Serial.println(piReady && !piFault ? F("SYSTEM_HEALTH:READY") : F("SYSTEM_HEALTH:FAULT"));
    return true;
  }
  return false;
}

// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(9600);

  pinMode(HOPPER_DOUT, INPUT);
  pinMode(HOPPER_SCK, OUTPUT);
  digitalWrite(HOPPER_SCK, LOW);
  pinMode(TROUGH_DOUT, INPUT);
  pinMode(TROUGH_SCK, OUTPUT);
  digitalWrite(TROUGH_SCK, LOW);
  pinMode(GREEN_STATUS_LED, OUTPUT);
  pinMode(YELLOW_STATUS_LED, OUTPUT);
  digitalWrite(GREEN_STATUS_LED, LOW);
  digitalWrite(YELLOW_STATUS_LED, HIGH);
  dht.begin();

  Wire.begin();
  pwm.begin();
  pwm.setPWMFreq(50);
  lcd.init();
  lcd.backlight();
  lcdLine(0, F("POULTRIX MONITOR"));
  lcdLine(1, F("Starting..."));
  // Initialize both five-servo groups to their configured closed angles.
  stopGroups();

  // ----------------------------------------------------------
  // SAFE STARTUP
  // ACTIVE LOW RELAYS
  //
  // HIGH = OFF
  // LOW  = ON
  //
  // Preload OFF state before configuring pins as outputs.
  // ----------------------------------------------------------

  digitalWrite(FAN1_PIN, HIGH);
  digitalWrite(FAN2_PIN, HIGH);
  digitalWrite(FAN3_PIN, HIGH);
  digitalWrite(FAN4_PIN, HIGH);

  digitalWrite(LED_PIN, HIGH);

  digitalWrite(HEATER1_PIN, HIGH);
  // D29 is not used for heater control.

  pinMode(FAN1_PIN, OUTPUT);
  pinMode(FAN2_PIN, OUTPUT);
  pinMode(FAN3_PIN, OUTPUT);
  pinMode(FAN4_PIN, OUTPUT);

  pinMode(LED_PIN, OUTPUT);

  pinMode(HEATER1_PIN, OUTPUT);
  // D29 left unconfigured (unused).

  pinMode(LDR_PIN, INPUT);


  loadSavedStage();
  updateStageTargets();

  delay(1000);

  Serial.println(F("BOOT:SAFE"));
  reportStatus();
  reportFeedGates();
}


// ============================================================
// MAIN LOOP
// ============================================================

void loop() {

  handleSerialCommands();
  updateGroups();
  if (maintenanceActive && millis() - maintenanceLastPing >= MAINTENANCE_TIMEOUT_MS) {
    maintenanceOff();
    Serial.println(F("BYPASS_ACK:TIMEOUT"));
    reportStatus();
  }

  // Enter SAFE if Raspberry Pi heartbeats stop during LIVE.
  if (
    currentMode == LIVE_MODE &&
    millis() - lastHeartbeat >= WATCHDOG_TIMEOUT_MS
  ) {
    currentMode = SAFE_MODE;
    stopGroups();

    setFans(false, false, false, false);
    setHeaters(false, false);
    setLED(false);

    for (uint8_t i = 0; i < 3; i++) {
      closeGate(i, "STOPPED");
    }

    Serial.println(F("WATCHDOG:TIMEOUT"));
    Serial.println(F("MODE_OK:SAFE"));
    reportStatus();
  }

  updateFeedGates();
  reportFeedWeight();
  updateSystemIndicators();
  updateLCD();


  // Continue physical DHT22/LDR monitoring in SAFE and LIVE.
  // Only LIVE may run automatic actuator controls.
  if (currentMode == LIVE_MODE || currentMode == SAFE_MODE) {
    if (millis() - lastSensorRead >= SENSOR_INTERVAL) {
      lastSensorRead = millis();
      readLiveSensors();
      if (currentMode == LIVE_MODE) {
        controlTemperature();
        controlLiveLighting();
      }
      reportStatus();
    }
  }

}


// ============================================================
// AVERAGED LDR READING
// ============================================================

int readAverageLDR() {

  const int samples = 50;

  long total = 0;


  // Discard first ADC reading
  analogRead(LDR_PIN);

  delay(2);


  for (int i = 0; i < samples; i++) {

    total += analogRead(LDR_PIN);

    delay(2);
  }


  return total / samples;
}


// ============================================================
// LDR RAW -> ESTIMATED LUX
// ============================================================

float convertRawToLux(int rawValue) {

  /*
      POULTRIX LDR CALIBRATION

      Phone Lux     Averaged LDR Raw

      0 lux         8
      5 lux         10
      10 lux        10
      20 lux        12
      30 lux        13
      40 lux        15
      50 lux        17


      Linear approximation:

      Lux = (5.91 × Raw) - 49.62

      NOTE:
      This is estimated lux for the current prototype
      and current LDR installation.
  */


  float estimatedLux =
    (5.91 * rawValue) - 49.62;


  // Do not allow negative lux

  if (estimatedLux < 0.0) {

    estimatedLux = 0.0;
  }


  return estimatedLux;
}


// ============================================================
// READ LIVE SENSORS
// ============================================================

void readLiveSensors() {

  // ----------------------------------------------------------
  // DHT22
  // ----------------------------------------------------------

  float newHumidity =
    dht.readHumidity();

  float newTemperature =
    dht.readTemperature();


  if (
    !isnan(newHumidity) &&
    !isnan(newTemperature)
  ) {

    humidity =
      newHumidity;

    temperature =
      newTemperature;

    dhtReadingValid = true;

    Serial.println("DHT22_STATUS:OK");
  }

  else {

    dhtReadingValid = false;

    if (!maintenanceActive) {
      setHeaters(false, false);
      setFans(false, false, false, false);
    }

    Serial.println("DHT22_STATUS:ERROR");
  }


  // ----------------------------------------------------------
  // LDR
  // ----------------------------------------------------------

  lightRaw =
    readAverageLDR();


  liveLux =
    convertRawToLux(lightRaw);
}


// ============================================================
// UPDATE TARGETS BASED ON BROILER STAGE
// ============================================================

void updateStageTargets() {

  switch (currentStage) {


    // --------------------------------------------------------
    // STARTER
    // Day 1-10
    //
    // Temperature: 28-34 C
    // Lighting:    20-40 lux
    // --------------------------------------------------------

    case STARTER:

      tempMin = 32.2;
      tempMax = 35.0;

      luxMin = 20.0;
      luxMax = 40.0;

      break;


    // --------------------------------------------------------
    // GROWER
    // Day 11-21
    //
    // Temperature: 26-28 C
    // Lighting:    10-20 lux
    // --------------------------------------------------------

    case GROWER:

      tempMin = 26.7;
      tempMax = 29.4;

      luxMin = 10.0;
      luxMax = 20.0;

      break;


    // --------------------------------------------------------
    // FINISHER
    // Day 22-35
    //
    // Temperature: 24-26 C
    // Lighting:    5-10 lux
    // --------------------------------------------------------

    case FINISHER:

      tempMin = 24.0;
      tempMax = 26.0;

      luxMin = 5.0;
      luxMax = 10.0;

      break;
  }
}


// ============================================================
// AUTOMATIC TEMPERATURE CONTROL
// ============================================================

void controlTemperature() {
  // Manual bypass owns relay outputs until explicitly exited or timed out.
  if (maintenanceActive) return;

  // LIVE-first: stage simulation does not suspend physical environmental control.
  // DHT22 validity and internal fault protections still apply.
  if (currentMode == SAFE_MODE) {
    setHeaters(false, false);
    setFans(false, false, false, false);
    return;
  }

  if (currentMode == LIVE_MODE && !dhtReadingValid) {
    setHeaters(false, false);
    setFans(false, false, false, false);
    return;
  }



  // ----------------------------------------------------------
  // TOO COLD
  // ----------------------------------------------------------

  if (temperature < tempMin) {

    setFans(
      false,
      false,
      false,
      false
    );

    setHeaters(
      true,
      true
    );
  }


  // ----------------------------------------------------------
  // NORMAL TEMPERATURE
  // ----------------------------------------------------------

  else if (temperature <= tempMax) {

    setFans(
      false,
      false,
      false,
      false
    );

    setHeaters(
      false,
      false
    );
  }


  // ----------------------------------------------------------
  // UP TO 1 C ABOVE MAX
  // FAN 1
  // ----------------------------------------------------------

  else if (temperature <= tempMax + 1.0) {

    setHeaters(
      false,
      false
    );

    setFans(
      true,
      false,
      false,
      false
    );
  }


  // ----------------------------------------------------------
  // 1-2 C ABOVE MAX
  // FANS 1 + 2
  // ----------------------------------------------------------

  else if (temperature <= tempMax + 2.0) {

    setHeaters(
      false,
      false
    );

    setFans(
      true,
      true,
      false,
      false
    );
  }


  // ----------------------------------------------------------
  // 2-3 C ABOVE MAX
  // FANS 1 + 2 + 3
  // ----------------------------------------------------------

  else if (temperature <= tempMax + 3.0) {

    setHeaters(
      false,
      false
    );

    setFans(
      true,
      true,
      true,
      false
    );
  }


  // ----------------------------------------------------------
  // MORE THAN 3 C ABOVE MAX
  // ALL 4 FANS
  // ----------------------------------------------------------

  else {

    setHeaters(
      false,
      false
    );

    setFans(
      true,
      true,
      true,
      true
    );
  }
}


// ============================================================
// AUTOMATIC LIVE LIGHTING CONTROL
// Simple continuous threshold, no periodic LED-off probe.
// Below 50 lux -> ON; above 50 lux -> OFF; at 50 -> unchanged.
// IMPORTANT: Shield the LDR from the LED to avoid feedback flicker.
// ============================================================
const float LIGHT_THRESHOLD_LUX = 50.0f;

void controlLiveLighting() {
  if (maintenanceActive) return;
  // Bypass stage simulation must not stop real LDR-driven lighting.
  if (currentMode != LIVE_MODE) {
    if (currentMode == SAFE_MODE) setLED(false);
    return;
  }
  // Heater lamps provide light: keep the separate LED off while heating.
  if (heater1State || heater2State) {
    if (ledState) setLED(false);
    return;
  }
  if (liveLux < LIGHT_THRESHOLD_LUX) {
    if (!ledState) {
      setLED(true);
      Serial.println(F("AUTO_LED:ON_DARK"));
    }
  } else if (liveLux > LIGHT_THRESHOLD_LUX) {
    if (ledState) {
      setLED(false);
      Serial.println(F("AUTO_LED:OFF_BRIGHT"));
    }
  }
}

// ============================================================
// TEST MODE LIGHTING CONTROL
// ============================================================

void controlTestLighting() {
  if (maintenanceActive) return;


  // Too dark

  if (testLux < luxMin) {

    setLED(true);
  }


  // Bright enough

  else if (testLux >= luxMax) {

    setLED(false);
  }


  // Between luxMin and luxMax:
  // Keep previous LED state
}


// ============================================================
// FAN CONTROL
// ============================================================

void setFans(
  bool f1,
  bool f2,
  bool f3,
  bool f4
) {

  fan1State = f1;
  fan2State = f2;
  fan3State = f3;
  fan4State = f4;


  // ACTIVE LOW

  digitalWrite(
    FAN1_PIN,
    f1 ? LOW : HIGH
  );

  digitalWrite(
    FAN2_PIN,
    f2 ? LOW : HIGH
  );

  digitalWrite(
    FAN3_PIN,
    f3 ? LOW : HIGH
  );

  digitalWrite(
    FAN4_PIN,
    f4 ? LOW : HIGH
  );
}


// ============================================================
// HEATER CONTROL
// ============================================================

void setHeaters(bool h1, bool h2) {
  // Backward-compatible signature for existing temperature control calls.
  // Both lamps share ONE physical relay on D28 / IN7.
  const bool heaterOn = h1 || h2;
  heater1State = heaterOn;
  heater2State = false;  // No second physical heater output.
  digitalWrite(HEATER1_PIN, heaterOn ? LOW : HIGH); // ACTIVE LOW
}


// ============================================================
// LED CONTROL
// ============================================================

void setLED(bool state) {

  ledState = state;


  // ACTIVE LOW

  digitalWrite(
    LED_PIN,
    state ? LOW : HIGH
  );
}


// ============================================================
// SERIAL COMMAND HANDLER
// ============================================================

void handleSerialCommands() {

  if (!Serial.available()) {

    return;
  }


  String command =
    Serial.readStringUntil('\n');


  command.trim();
  if (handleSystemCommand(command)) return;
  if (handleFeedCommand(command)) return;
  if (handleGroupCommand(command)) return;
  if (handlePcaCommand(command)) return;


  if (command.length() == 0) {

    return;
  }

  if (command == "SYS:PING") {
    lastHeartbeat = millis();
    return;
  }

  if (command == "BYPASS:SIM:CLEAR") {
    lcdSimTemperature = false;
    lcdSimHopper = false;
    return;
  }
  if (command.startsWith("BYPASS:SIM:TEMP:")) {
    if (maintenanceActive) {
      String payload = command.substring(16);
      if (payload == "OFF") lcdSimTemperature = false;
      else { float v = payload.toFloat(); if (v >= -10 && v <= 65) { lcdSimTempC = v; lcdSimTemperature = true; } }
    }
    return;
  }
  if (command.startsWith("BYPASS:SIM:HOPPER:")) {
    if (maintenanceActive) {
      String payload = command.substring(18);
      if (payload == "OFF") lcdSimHopper = false;
      else { float v = payload.toFloat(); if (v >= 0 && v <= 100000) { lcdSimHopperG = v; lcdSimHopper = true; } }
    }
    return;
  }
  if (command == "BYPASS:ON") {
    // Preserve current low-voltage fan/LED states when entering bypass.
    // Disable automatic control and keep mains heaters OFF.
    // Maintenance is independent of LIVE/SAFE operating mode.
    // Suspend automatic outputs while manual control is active.
    // Do not switch LIVE to SAFE just to unlock maintenance.
    setHeaters(false,false);
    for (uint8_t i=0;i<3;i++) closeGate(i,"STOPPED");
    stopGroups();
    maintenanceActive = true;
    maintenanceLastPing = millis();
    Serial.println(F("BYPASS_ACK:ON"));
    reportStatus();
    return;
  }
  if (command == "BYPASS:PING") {
    if (maintenanceActive) maintenanceLastPing = millis();
    return;
  }
  if (command == "BYPASS:OFF") {
    maintenanceOff();
    Serial.println(F("BYPASS_ACK:OFF"));
    reportStatus();
    return;
  }
  if (command.startsWith("BYPASS:RELAY:")) {
    if (!maintenanceActive || (currentMode != SAFE_MODE && currentMode != LIVE_MODE)) {
      Serial.println(F("BYPASS_ERROR:NOT_ACTIVE")); return;
    }
    String args = command.substring(13);
    int comma = args.indexOf(',');
    if (comma < 0 || args.length() != (unsigned int)(comma + 2)) {
      Serial.println(F("BYPASS_ERROR:BAD_RELAY")); return;
    }
    char channel = args.charAt(0);
    char value = args.charAt(comma + 1);
    if (comma != 1 || channel < '1' || channel > '6' || (value != '0' && value != '1')) {
      Serial.println(F("BYPASS_ERROR:BAD_RELAY")); return;
    }
    int n = channel - '0';
    if (n == 1) setFans(value == '1',fan2State,fan3State,fan4State);
    if (n == 2) setFans(fan1State,value == '1',fan3State,fan4State);
    if (n == 3) setFans(fan1State,fan2State,value == '1',fan4State);
    if (n == 4) setFans(fan1State,fan2State,fan3State,value == '1');
    if (n == 5) setLED(value == '1');
    if (n == 6) setHeaters(value == '1', false); // D28 / IN7: both lamps
    maintenanceLastPing = millis();
    Serial.print(F("BYPASS_ACK:RELAY:")); Serial.println(args);
    reportStatus();
    return;
  }

  if (command == "MODE:SAFE") {
    maintenanceOff();
    currentMode = SAFE_MODE;
    stopGroups();
    setFans(false, false, false, false);
    setHeaters(false, false);
    setLED(false);
    for (uint8_t i = 0; i < 3; i++) {
      closeGate(i, "STOPPED");
    }
    Serial.println(F("MODE_OK:SAFE"));
    reportStatus();
    return;
  }


  // ==========================================================
  // SWITCH TO TEST MODE
  // ==========================================================

  if (command == "MODE:TEST") {

    currentMode = SAFE_MODE;
    setFans(false, false, false, false);
    setHeaters(false, false);
    setLED(false);
    Serial.println(F("ERROR:TEST_MODE_DISABLED"));
    reportStatus();
    return;
    currentMode = TEST_MODE;


    Serial.println(
      "MODE_OK:TEST"
    );


    // Apply current test values

    controlTemperature();

    controlTestLighting();


    reportStatus();

    return;
  }


  // ==========================================================
  // SWITCH TO LIVE MODE
  // ==========================================================

  // Tokened LIVE commands prevent stale acknowledgments authorizing recovery.
  // Legacy MODE:LIVE remains available for older clients.
  if (command == "MODE:LIVE" || command.startsWith("MODE:LIVE:")) {
    String liveToken = "";
    if (command.startsWith("MODE:LIVE:")) {
      liveToken = command.substring(10);
      if (liveToken.length() != 32) {
        Serial.println(F("ERROR:INVALID_LIVE_TOKEN"));
        return;
      }
      for (unsigned int j = 0; j < liveToken.length(); j++) {
        char c = liveToken.charAt(j);
        if (!isHexadecimalDigit(c)) {
          Serial.println(F("ERROR:INVALID_LIVE_TOKEN"));
          return;
        }
      }
    }

    maintenanceOff();
    currentMode = SAFE_MODE;
    setFans(false, false, false, false);
    setHeaters(false, false);
    setLED(false);
    readLiveSensors();
    if (!dhtReadingValid) {
      Serial.println(F("ERROR:DHT22_NOT_READY"));
      reportStatus();
      return;
    }
    lastHeartbeat = millis();
    currentMode = LIVE_MODE;


    if (liveToken.length()) {
      Serial.print(F("MODE_ACK:LIVE:"));
      Serial.println(liveToken);
    } else {
      Serial.println(F("MODE_OK:LIVE"));
    }


    // Immediately read real hardware

    readLiveSensors();


    // Immediately apply automatic control

    controlTemperature();

    controlLiveLighting();


    reportStatus();


    lastSensorRead =
      millis();


    return;
  }


  // ==========================================================
  // REQUEST STATUS
  // ==========================================================

  // ----------------------------------------------------------
  // SENSOR CHECK - AVAILABLE IN SAFE MODE
  // Reads sensors without activating environmental controls.
  // ----------------------------------------------------------

  if (command == "SENSOR:CHECK") {

    if (currentMode != SAFE_MODE) {
      Serial.println(F("SENSOR_CHECK:NOT_SAFE"));
      return;
    }

    readLiveSensors();

    if (
      dhtReadingValid &&
      !isnan(liveLux) &&
      lightRaw >= 0 &&
      lightRaw <= 1023
    ) {
      Serial.println(F("SENSOR_CHECK:OK"));
    }
    else {
      Serial.println(F("SENSOR_CHECK:ERROR"));
    }

    Serial.print(F("SENSOR_TEMPERATURE:"));
    Serial.println(temperature, 1);

    Serial.print(F("SENSOR_HUMIDITY:"));
    Serial.println(humidity, 1);

    Serial.print(F("SENSOR_LDR_RAW:"));
    Serial.println(lightRaw);

    Serial.print(F("SENSOR_LUX:"));
    Serial.println(liveLux, 1);

    return;
  }

  if (command == "STATUS") {

    reportStatus();

    return;
  }


  // ==========================================================
  // TEST TEMPERATURE
  // ==========================================================

  if (
    command.startsWith("TEMP:")
  ) {

    if (
      currentMode != TEST_MODE
    ) {

      Serial.println(
        "ERROR:TEST_MODE_REQUIRED"
      );

      return;
    }


    String value =
      command.substring(5);


    temperature =
      value.toFloat();


    controlTemperature();


    reportStatus();

    return;
  }


  // ==========================================================
  // TEST LUX
  // ==========================================================

  if (
    command.startsWith("LUX:")
  ) {

    if (
      currentMode != TEST_MODE
    ) {

      Serial.println(
        "ERROR:TEST_MODE_REQUIRED"
      );

      return;
    }


    String value =
      command.substring(4);


    testLux =
      value.toFloat();


    controlTestLighting();


    reportStatus();

    return;
  }


  // ==========================================================
  // CHANGE BROILER STAGE
  // ==========================================================

  if (
    command.startsWith("STAGE:")
  ) {

    String stage =
      command.substring(6);


    stage.trim();

    stage.toUpperCase();


    if (
      stage == "STARTER"
    ) {

      currentStage =
        STARTER;
    }

    else if (
      stage == "GROWER"
    ) {

      currentStage =
        GROWER;
    }

    else if (
      stage == "FINISHER"
    ) {

      currentStage =
        FINISHER;
    }

    else {

      Serial.println(
        "ERROR:INVALID_STAGE"
      );

      return;
    }


    // Save every accepted stage, including AI-confirmed transitions.
    // After a reboot the LCD will restore this value before reporting status.
    saveCurrentStage();

    // Update temperature/lux targets

    updateStageTargets();


    // Re-evaluate temperature

    controlTemperature();


    // Re-evaluate lighting depending on mode

    if (
      currentMode == TEST_MODE
    ) {

      controlTestLighting();
    }

    else {

      controlLiveLighting();
    }


    Serial.print(
      "STAGE_OK:"
    );

    Serial.println(
      getStageName()
    );


    reportStatus();

    return;
  }


  // ==========================================================
  // UNKNOWN COMMAND
  // ==========================================================

  Serial.println(
    "ERROR:UNKNOWN_COMMAND"
  );
}


// ============================================================
// GET STAGE NAME
// ============================================================

String getStageName() {

  switch (currentStage) {

    case STARTER:

      return "STARTER";


    case GROWER:

      return "GROWER";


    case FINISHER:

      return "FINISHER";
  }


  return "UNKNOWN";
}


// ============================================================
// COUNT ACTIVE FANS
// ============================================================

int countFansOn() {

  int count = 0;


  if (fan1State) count++;

  if (fan2State) count++;

  if (fan3State) count++;

  if (fan4State) count++;


  return count;
}


// ============================================================
// COUNT ACTIVE HEATERS
// ============================================================

int countHeatersOn() {

  int count = 0;


  if (heater1State) count++;

  if (heater2State) count++;


  return count;
}


// ============================================================
// REPORT STATUS TO RASPBERRY PI
// ============================================================

void reportStatus() {


  // ==========================================================
  // MODE
  // ==========================================================

  Serial.print(
    "MODE_STATUS:"
  );


  if (
    currentMode == LIVE_MODE
  ) {

    Serial.println(
      "LIVE"
    );
  }

  else if (currentMode == SAFE_MODE) {

    Serial.println("SAFE");
  }

  else {

    Serial.println("TEST");
  }


  // ==========================================================
  // STAGE
  // ==========================================================

  Serial.print(
    "STAGE_OK:"
  );


  Serial.println(
    getStageName()
  );


  // ==========================================================
  // TEMPERATURE TARGET
  // ==========================================================

  Serial.print(
    "TEMP_TARGET:"
  );


  Serial.print(
    tempMin,
    1
  );


  Serial.print(",");


  Serial.println(
    tempMax,
    1
  );


  // ==========================================================
  // LUX TARGET
  // ==========================================================

  Serial.print(
    "LUX_TARGET:"
  );


  Serial.print(
    luxMin,
    1
  );


  Serial.print(",");


  Serial.println(
    luxMax,
    1
  );


  // ==========================================================
  // FANS
  // ==========================================================

  Serial.print(
    "FANS_ON:"
  );


  Serial.println(
    countFansOn()
  );


  Serial.print(
    "FAN_STATUS:"
  );


  Serial.print(
    fan1State ? 1 : 0
  );


  Serial.print(",");


  Serial.print(
    fan2State ? 1 : 0
  );


  Serial.print(",");


  Serial.print(
    fan3State ? 1 : 0
  );


  Serial.print(",");


  Serial.println(
    fan4State ? 1 : 0
  );


  // ==========================================================
  // HEATERS
  // ==========================================================

  Serial.print(
    "HEATERS_ON:"
  );


  Serial.println(
    countHeatersOn()
  );


  Serial.print(
    "HEATER_STATUS:"
  );


  Serial.print(
    heater1State ? 1 : 0
  );


  Serial.print(",");


  Serial.println(
    heater2State ? 1 : 0
  );


  // ==========================================================
  // LED
  // ==========================================================

  Serial.print(
    "LED_STATUS:"
  );


  Serial.println(
    ledState ? 1 : 0
  );


  // ==========================================================
  // TEMPERATURE
  // ==========================================================

  Serial.print(
    "TEMPERATURE:"
  );


  Serial.println(
    temperature,
    1
  );


  // ==========================================================
  // HUMIDITY
  // ==========================================================

  Serial.print(
    "HUMIDITY:"
  );


  Serial.println(
    humidity,
    1
  );


  // ==========================================================
  // LIVE MODE DATA
  // ==========================================================

  if (currentMode == LIVE_MODE || currentMode == SAFE_MODE) {

    Serial.print(
      "LIGHT_RAW:"
    );


    Serial.println(
      lightRaw
    );


    Serial.print(
      "LUX:"
    );


    Serial.println(
      liveLux,
      1
    );


    Serial.println(
      "SENSOR_SOURCE:DHT22+LDR"
    );
  }


  // ==========================================================
  // TEST MODE DATA
  // ==========================================================

  else {

    Serial.print(
      "LUX:"
    );


    Serial.println(
      testLux,
      1
    );


    Serial.println(
      "SENSOR_SOURCE:TEST"
    );
  }
}
