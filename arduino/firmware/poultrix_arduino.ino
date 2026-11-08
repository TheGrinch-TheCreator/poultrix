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
// OPERATION
// ============================================================
// Single automatic mode (always-live): temperature and lighting control
// always run, including when the Raspberry Pi is offline. There is no
// SAFE or TEST mode. The Pi heartbeat (SYS:PING) only gates feeding and
// the "Pi offline" indicator.
// Last hopper reading from the weight report. The LCD shows this instead of
// reading the HX711 itself: a second reader stole conversions and made the
// report say HOPPER_WEIGHT:NOT_READY about 19 % of the time (2026-11-08).
long lastHopperRaw = 0;
bool hasHopperRaw = false;
bool piOnline = false;  // set by SYS:PING; cleared by the heartbeat watchdog
const uint8_t GATE_COUNT = 2;  // feed compartments (gates) 1 and 2
extern unsigned long lastSensorRead;  // defined in TIMING below
const bool AUTOMATIC_FEEDING_ENABLED = false; // Unattended scheduling stays disabled.
const bool MANUAL_FEEDING_ENABLED = true; // Only accepted while the Pi is online, outside maintenance.
// Maintenance supports manual heater relay on D28; physical thermal protection required.
bool lcdSimTemperature = false, lcdSimHopper = false;
float lcdSimTempC = 0.0f, lcdSimHopperG = 0.0f;
bool maintenanceActive = false;
unsigned long maintenanceLastPing = 0;
const unsigned long MAINTENANCE_TIMEOUT_MS = 10000UL;
// Entering maintenance changes no output. Automatic control keeps running for
// every output except the ones switched by hand (BYPASS:RELAY), which stay
// manual until maintenance ends.
bool manualFan[4] = {false, false, false, false};
bool manualHeater = false;
bool manualLed = false;
void clearManualOverrides() {
  for (uint8_t i = 0; i < 4; i++) manualFan[i] = false;
  manualHeater = false;
  manualLed = false;
}
extern bool gateActive[];  // defined with the feed gates below
void stopGroups();
void maintenanceOff() {
  // Leave manual bypass and hand the outputs straight back to automatic
  // control. Never switch everything off just because maintenance ended.
  maintenanceActive = false;
  clearManualOverrides();
  lcdSimTemperature = false;
  lcdSimHopper = false;
  // Close maintenance-opened servos, but never cut a feed that is running.
  if (!gateActive[0] && !gateActive[1]) stopGroups();
  for (uint8_t i = 0; i < GATE_COUNT; i++) if (!gateActive[i]) closeGate(i, "STOPPED");
  readLiveSensors();
  controlTemperature();
  controlLiveLighting();
  lastSensorRead = millis();
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
// Two feed compartments ("gates" 1 and 2), each five synchronized servos.
int GATE_CLOSED[GATE_COUNT] = {0, 0};
const int GATE_OPEN[GATE_COUNT] = {90, 90};
const unsigned long GATE_MAX_MS = 10000UL;
extern bool groupRunning;
bool gateActive[GATE_COUNT] = {false, false};
unsigned long gateStart[GATE_COUNT] = {0, 0};
unsigned long gateDuration[GATE_COUNT] = {0, 0};
const char* gateLastStatus[GATE_COUNT] = {"CLOSED", "CLOSED"};

void setPcaAngle(uint8_t channel, int angle);
void setGateAngle(uint8_t gate, int angle) {
  if (gate >= GATE_COUNT) return;
  // Feeding compartments consist of five synchronized PCA9685 servos each.
  // Compartment 1: channels 0-4; compartment 2: channels 11-15.
  for (uint8_t j=0; j<5; j++)
    setPcaAngle(gate == 0 ? j : 11+j, angle);
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
  for (uint8_t i = 0; i < GATE_COUNT; i++) {
    if (gateActive[i] && now - gateStart[i] >= gateDuration[i]) {
      closeGate(i, "COMPLETED");
    }
  }
}

void reportFeedGates() {
  for (uint8_t i = 0; i < GATE_COUNT; i++) {
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
    for (uint8_t j = 0; j < GATE_COUNT; j++) {
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
    for (uint8_t i = 0; i < GATE_COUNT; i++) closeGate(i, "STOPPED");
    return true;
  }
  if (!command.startsWith("FEED:DISPENSE:")) return false;
  if (!piOnline) {
    Serial.println(F("FEED_ERROR:PI_OFFLINE"));
    return true;
  }
  // Maintenance never blocks feeding (owner 2026-11-08); only a running
  // maintenance gate/hole test does, because it uses the same servos.
  if (!MANUAL_FEEDING_ENABLED || groupRunning) {
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
  for (uint8_t j = 0; j < GATE_COUNT; j++) {
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
// BYPASS:HOLE:<compartment 1-2>,<hole 1-5>,<ms 100-10000>: open ONE servo of a
// compartment (maintenance only), e.g. to catch and weigh each hole's output.
// Uses the group timer, so updateGroups()/stopGroups() close it as usual.
bool handleHoleCommand(const String &command) {
  if (!command.startsWith("BYPASS:HOLE:")) return false;
  if (!maintenanceActive) {
    Serial.println(F("BYPASS_ERROR:NOT_ACTIVE")); return true;
  }
  if (groupRunning || gateActive[0] || gateActive[1]) { Serial.println(F("BYPASS_ERROR:BUSY")); return true; }
  String args = command.substring(12);
  if (args.length() < 5 || args[1] != ',' || args[3] != ',' ||
      (args[0] != '1' && args[0] != '2') || args[2] < '1' || args[2] > '5') {
    Serial.println(F("BYPASS_ERROR:INVALID_HOLE")); return true;
  }
  String duration = args.substring(4);
  for (unsigned int i = 0; i < duration.length(); i++) if (!isDigit(duration[i])) {
    Serial.println(F("BYPASS_ERROR:INVALID_DURATION")); return true;
  }
  unsigned long ms = duration.toInt();
  if (ms < 100 || ms > GROUP_MAX_MS) { Serial.println(F("BYPASS_ERROR:INVALID_DURATION")); return true; }
  uint8_t g = args[0] - '1';
  uint8_t h = args[2] - '1';
  groupRunning = true; groupRunningId = g + 1; groupStarted = millis(); groupDuration = ms;
  setPcaAngle(GROUP_CHANNELS[g][h], GROUP_OPEN[g][h]);
  maintenanceLastPing = millis();
  Serial.print(F("BYPASS_ACK:HOLE:")); Serial.print(g + 1); Serial.print(','); Serial.print(h + 1);
  Serial.print(','); Serial.println(ms);
  return true;
}
bool handleGroupCommand(const String &command) {
  if (handleHoleCommand(command)) return true;
  if (command == "BYPASS:GROUP:STOP") {
    stopGroups();
    Serial.println(F("BYPASS_ACK:GROUP:STOP"));
    return true;
  }
  if (!command.startsWith("BYPASS:GROUP:")) return false;
  if (!maintenanceActive) {
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
  for (uint8_t i=0;i<GATE_COUNT;i++) if (gateActive[i]) {
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
  if (piOnline) lcdLine(0, F("POULTRIX MONITOR"));
  else lcdLine(0, F("Pi: OFFLINE"));
  lcdLine(1, String(F("Stage: ")) + getStageName());
  if (lcdSimHopper) {
    lcdLine(2, String(F("Hopper: ")) + String(lcdSimHopperG / 1000.0f, 2) + F(" kg*"));
  } else if (hopperCountsPerGram != 0 && hasHopperRaw) {
    float kg = (lastHopperRaw - hopperZero) / hopperCountsPerGram / 1000.0f;
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
  // Individual servo jogging belonged to the retired TEST mode.
  (void)n; (void)a;
  Serial.println(F("ERROR:MODE_REMOVED"));
  return true;
}


// The HX711 makes about 10 conversions/s. If one isn't waiting at report
// time, wait briefly (max 110 ms, short enough for the 64-byte serial buffer)
// for the next instead of reporting NOT_READY.
const unsigned long HX711_WAIT_MS = 110;
bool readHx711RawWait(byte dout, byte sck, long &raw) {
  unsigned long start = millis();
  while (!readHx711Raw(dout, sck, raw)) {
    if (millis() - start >= HX711_WAIT_MS) return false;
    delay(2);
  }
  return true;
}
void reportOneWeight(const __FlashStringHelper *name, byte dout, byte sck,
                     long zero, float countsPerGram) {
  long raw;
  Serial.print(name);
  if (!readHx711RawWait(dout, sck, raw)) {
    Serial.println(F(":NOT_READY")); return;
  }
  if (dout == HOPPER_DOUT) { lastHopperRaw = raw; hasHopperRaw = true; }
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
  bool healthy = piOnline && piReady && !piFault && !timedOut;
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
  // A transfer corrupted by relay noise times out (25 ms) and resets the bus
  // instead of hanging the whole controller.
  Wire.setWireTimeout(25000, true);
  pwm.begin();
  pwm.setPWMFreq(50);
  lcd.init();
  lcd.backlight();
  lcdLine(0, F("POULTRIX MONITOR"));
  lcdLine(1, F("Starting..."));
  // Initialize both five-servo groups to their configured closed angles.
  stopGroups();

  // ----------------------------------------------------------
  // STARTUP: all relays OFF until the first valid sensor reading,
  // then automatic control takes over (no SAFE mode).
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

  Serial.println(F("BOOT:AUTO"));
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

  // Pi heartbeat lost: keep automatic climate control running with the
  // current stage targets. Only stop feeding and report the Pi offline.
  if (piOnline && millis() - lastHeartbeat >= WATCHDOG_TIMEOUT_MS) {
    piOnline = false;
    stopGroups();
    for (uint8_t i = 0; i < GATE_COUNT; i++) {
      if (gateActive[i]) closeGate(i, "STOPPED");
    }
    Serial.println(F("PI:OFFLINE"));
    reportStatus();
  }

  updateFeedGates();
  reportFeedWeight();
  updateSystemIndicators();
  updateLCD();


  // Automatic control always runs (maintenance suspends it inside the
  // control functions themselves).
  if (millis() - lastSensorRead >= SENSOR_INTERVAL) {
    lastSensorRead = millis();
    readLiveSensors();
    controlTemperature();
    controlLiveLighting();
    reportStatus();
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

    applyAutoHeater(false, true);
    {
      const bool off[4] = {false, false, false, false};
      applyAutoFans(off, true);
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

// Relay chatter guard: a reading that wobbles by 0.1 C around a threshold
// must not flip a relay every 2 s. Each threshold has a dead band, and an
// automatic change to one output waits at least AUTO_MIN_DWELL_MS after its
// last automatic change (fault switch-offs are immediate).
const float HEATER_HYSTERESIS_C = 0.3f;  // on below tempMin, off at tempMin + 0.3
const float FAN_HYSTERESIS_C = 0.3f;     // fan k on above tempMax + (k-1), off at 0.3 below
const unsigned long AUTO_MIN_DWELL_MS = 30000UL;
unsigned long lastAutoFanChange[4] = {0, 0, 0, 0};
unsigned long lastAutoHeaterChange = 0;
unsigned long lastAutoLedChange = 0;

bool autoDwellElapsed(unsigned long last) {
  return last == 0 || millis() - last >= AUTO_MIN_DWELL_MS;
}

void applyAutoFans(const bool want[4], bool force) {
  bool next[4] = {fan1State, fan2State, fan3State, fan4State};
  bool changed = false;
  for (uint8_t i = 0; i < 4; i++) {
    if (manualFan[i] || next[i] == want[i]) continue;
    if (!force && !autoDwellElapsed(lastAutoFanChange[i])) continue;
    next[i] = want[i];
    lastAutoFanChange[i] = millis();
    changed = true;
  }
  if (changed) setFans(next[0], next[1], next[2], next[3]);
}

void applyAutoHeater(bool want, bool force) {
  const bool current = heater1State || heater2State;
  if (manualHeater || current == want) return;
  if (!force && !autoDwellElapsed(lastAutoHeaterChange)) return;
  setHeaters(want, want);
  lastAutoHeaterChange = millis();
}

void applyAutoLed(bool want, bool force) {
  if (manualLed || ledState == want) return;
  if (!force && !autoDwellElapsed(lastAutoLedChange)) return;
  setLED(want);
  lastAutoLedChange = millis();
  Serial.println(want ? F("AUTO_LED:ON_DARK") : F("AUTO_LED:OFF_BRIGHT"));
}

void controlTemperature() {
  // Runs during maintenance too; outputs switched by hand are left alone.

  // Fault response (not a mode): without a valid DHT22 reading the
  // heater and fans are switched off until the next valid reading.
  if (!dhtReadingValid) {
    const bool off[4] = {false, false, false, false};
    applyAutoHeater(false, true);
    applyAutoFans(off, true);
    return;
  }

  // Heater: on below tempMin, off only once tempMin + hysteresis is reached.
  bool heat = heater1State || heater2State;
  if (manualHeater) heat = false;  // a hand-held heater does not drive the automatic decision
  if (temperature < tempMin) heat = true;
  else if (temperature >= tempMin + HEATER_HYSTERESIS_C) heat = false;

  // Fans: fan k (1-4) on above tempMax + (k-1) C, off at hysteresis below it.
  bool fans[4] = {fan1State, fan2State, fan3State, fan4State};
  for (uint8_t i = 0; i < 4; i++) {
    const float threshold = tempMax + i;
    if (temperature > threshold) fans[i] = true;
    else if (temperature <= threshold - FAN_HYSTERESIS_C) fans[i] = false;
  }
  // Never heat and ventilate at the same time.
  if (heat) for (uint8_t i = 0; i < 4; i++) fans[i] = false;

  applyAutoHeater(heat, false);
  applyAutoFans(fans, false);
}


// ============================================================
// AUTOMATIC LIVE LIGHTING CONTROL
// Simple continuous threshold, no periodic LED-off probe.
// Below 50 lux -> ON; above 50 lux -> OFF; at 50 -> unchanged.
// IMPORTANT: Shield the LDR from the LED to avoid feedback flicker.
// ============================================================
const float LIGHT_ON_BELOW_LUX = 50.0f;   // LED on below 50 lux
const float LIGHT_OFF_ABOVE_LUX = 65.0f;  // LED off only above 65 lux (dead band)

void controlLiveLighting() {
  // Runs during maintenance too; a hand-switched LED is left alone.
  // Heater lamps provide light: keep the separate LED off while heating.
  if (heater1State || heater2State) {
    applyAutoLed(false, true);
    return;
  }
  if (liveLux < LIGHT_ON_BELOW_LUX) applyAutoLed(true, false);
  else if (liveLux > LIGHT_OFF_ABOVE_LUX) applyAutoLed(false, false);
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
    if (!piOnline) {
      piOnline = true;
      Serial.println(F("PI:ONLINE"));
    }
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
    // Entering maintenance changes nothing: relays, gates and automatic
    // control stay exactly as they were. Outputs become manual only when
    // switched by hand. Leaving (BYPASS:OFF or ping timeout) clears that.
    if (!maintenanceActive) clearManualOverrides();
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
    if (!maintenanceActive) {
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
    if (n >= 1 && n <= 4) manualFan[n - 1] = true;
    if (n == 5) manualLed = true;
    if (n == 6) manualHeater = true;
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

  // Operating modes were removed (always-live). Reject any MODE:* command
  // without changing outputs.
  if (command.startsWith("MODE:")) {
    Serial.println(F("ERROR:MODE_REMOVED"));
    return;
  }


  // ==========================================================
  // REQUEST STATUS
  // ==========================================================

  // ----------------------------------------------------------
  // SENSOR CHECK - read-only, available at any time
  // ----------------------------------------------------------

  if (command == "SENSOR:CHECK") {

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


  // TEMP:/LUX: injected simulated readings in the retired TEST mode.
  if (command.startsWith("TEMP:") || command.startsWith("LUX:")) {
    Serial.println(F("ERROR:MODE_REMOVED"));
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


    // Re-evaluate lighting

    controlLiveLighting();


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

  // Always "LIVE": kept for protocol compatibility (the Pi, UI and
  // telemetry derive LIVE/OFFLINE from this line).
  Serial.println(F("MODE_STATUS:LIVE"));
  Serial.println(piOnline ? F("PI_STATUS:ONLINE") : F("PI_STATUS:OFFLINE"));


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
  // LIGHT SENSOR DATA
  // ==========================================================


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
