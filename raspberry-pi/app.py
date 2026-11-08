from flask import Flask, jsonify, request, Response
import os, secrets, random
from picamera2 import Picamera2
from ultralytics import YOLO

import serial
import serial.tools.list_ports
import threading
import time
import io
import socket
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import json

import stage_schedule


# ============================================================
# POULTRIX API CONFIGURATION
# ============================================================

app = Flask(__name__)
# No CORS: browsers never call Flask directly. All access goes through the
# authenticated Cloudflare Worker gateway via the tunnel (SPEC-remote-access).


def request_user():
    """User reported by the Cloudflare Worker gateway (X-Poultrix-User).

    Only trusted for requests arriving through the tunnel (cloudflared connects
    from localhost). Direct LAN callers are identified by address instead."""
    if request.remote_addr in ("127.0.0.1", "::1"):
        user = request.headers.get("X-Poultrix-User", "").strip()
        if user:
            return user[:120]
    return f"lan:{request.remote_addr}"


@app.before_request
def audit_state_changes():
    if request.method in ("POST", "PUT", "DELETE") and request.path.startswith("/api/"):
        print(f"[AUDIT] {request.method} {request.path} by {request_user()}", flush=True)

ARDUINO_BAUD_RATE = 9600
ARDUINO_RECONNECT_DELAY = 2
# Require incoming serial data, not merely an open USB device.
ARDUINO_RX_TIMEOUT_SECONDS = 15

CAMERA_WIDTH = 1280
CAMERA_HEIGHT = 720
CAMERA_FPS = 15

AI_MODEL_PATH = "best.pt"

# Inside the daily stage-check window, run a cycle every 5 minutes
# (stage_schedule.py: 10:00 Manila, at most 6 cycles, day-gated).
AI_INTERVAL_SECONDS = 300
# How often the AI worker checks whether the daily window is due.
AI_SCHEDULE_POLL_SECONDS = 30
STAGE_SCHEDULE_PATH = Path(__file__).with_name("stage_schedule.json")

# Predictions below 60% are reported but not considered confident.
AI_MIN_CONFIDENCE = 60.0

# 30-second multi-frame AI analysis cycle.
AI_CYCLE_DURATION_SECONDS = 30
AI_SAMPLE_INTERVAL_SECONDS = 1.0

# Require 3 consecutive confident scheduled cycles agreeing on an allowed
# (day-gated, forward-only) stage before it is sent to the Arduino.
AI_TRANSITION_CONFIRMATIONS_REQUIRED = 3

AI_AUTO_STAGE_TRANSITIONS = True
AI_MIN_WINNING_VOTE_FRACTION = 0.60
AI_MIN_VALID_FRAMES = 10
AI_STAGE_ACK_TIMEOUT_SECONDS = 5.0


# ============================================================
# HELPERS
# ============================================================

def utc_timestamp():
    return datetime.now(
        timezone.utc
    ).isoformat(timespec="milliseconds")


# ============================================================
# SYSTEM STATE
# ============================================================

state = {
    "connected": False,
    "arduinoPort": None,
    "hopperWeight": {"status": "WAITING", "raw": None, "weightGrams": None, "updatedAt": None},
    "troughWeight": {"status": "WAITING", "raw": None, "weightGrams": None, "updatedAt": None},
    "feedWeightGrams": None,
    "feedWeightRaw": None,
    "feedWeightStatus": "WAITING",
    "feedWeightUpdatedAt": None,

    # Always "live" with the always-live firmware (compat constant).
    "mode": "unknown",
    # Arduino's view of the Pi heartbeat (PI_STATUS:/PI:). None = not reported.
    "piSeenByArduino": None,
    "lastBootAt": None,
    "stage": "GROWER",

    "temperature": None,
    "humidity": None,

    # Test-mode simulated lux.
    "lux": None,

    # Real LDR ADC value.
    "lightRaw": None,

    "temperatureTarget": {
        "min": 26.0,
        "max": 28.0
    },

    "luxTarget": {
        "min": 10.0,
        "max": 20.0
    },

    "fansOn": 0,
    "fans": [
        False,
        False,
        False,
        False
    ],

    "heatersOn": 0,
    "heaters": [
        False,
        False
    ],

    "led": False,

    "sensorSource": "UNKNOWN",

    "lastSeen": None
}

state_lock = threading.Lock()
feeding_lock = threading.Lock()
feeding_gates = {str(i): {"status": "UNKNOWN", "durationMs": 0, "estimatedGrams": None, "updatedAt": None} for i in range(1, 3)}
feeding_events = deque(maxlen=100)
feeding_rates = {1: 101.39, 2: 103.00}  # estimated g/s from user measurements; not a measured delivered weight
feeding_pending = None
feeding_last_error = None



# ============================================================
# AI STATE
# ============================================================

ai_state = {
    "enabled": True,

    "modelLoaded": False,

    "status": "starting",

    "detectedStage": None,

    "confidence": None,

    "confident": False,

    "minimumConfidence": AI_MIN_CONFIDENCE,

    "lastInference": None,

    "inferenceTimeMs": None,

    # Multi-frame cycle information.
    "cycleDuration": None,
    "framesAnalyzed": 0,
    "votes": {
        "Starter": 0,
        "Grower": 0,
        "Finisher": 0
    },
    "cycleRunning": False,
    "failedFrames": 0,
    "lastTransitionResult": None,

    # Stage-transition monitoring.
    "transitionCandidate": None,
    "transitionConfirmations": 0,
    "transitionRequired": AI_TRANSITION_CONFIRMATIONS_REQUIRED,
    "transitionConfirmed": False,
    "confirmedTransitionStage": None,
    "transitionStatus": "idle",
    "hardwareTransitionEnabled": AI_AUTO_STAGE_TRANSITIONS,
    "hardwareTransitionStatus": "idle",
    "hardwareTransitionError": None,
    "lastHardwareTransition": None,

    # GROWER -> FINISHER safeguard.
    "finisherAcknowledgementRequired": False,
    "finisherTransitionPending": False,
    "finisherPendingSince": None,

    "error": None
}

ai_state_lock = threading.Lock()
ai_cycle_lock = threading.Lock()

# Today's (or the last) daily stage-check attempt, persisted so a restart
# never runs the window twice. See stage_schedule.py.
schedule_lock = threading.Lock()
schedule_attempt = stage_schedule.load_attempt(STAGE_SCHEDULE_PATH)

ai_model = None


# ============================================================
# ARDUINO STATE
# ============================================================

arduino = None
arduino_lock = threading.Lock()


# ============================================================
# CAMERA STATE
# ============================================================

camera = None
camera_error = None

camera_lock = threading.Lock()

camera_state = {
    "connected": False,

    "width": CAMERA_WIDTH,

    "height": CAMERA_HEIGHT,

    "fps": CAMERA_FPS,

    "error": None
}


# ============================================================
# ARDUINO USB AUTO-DETECTION
# ============================================================

def find_arduino():
    ports = list(
        serial.tools.list_ports.comports()
    )

    # Prefer a device explicitly identified as Arduino.
    for port in ports:
        description = (
            str(port.description or "")
            + " "
            + str(port.manufacturer or "")
            + " "
            + str(port.product or "")
        ).lower()

        if "arduino" in description:
            return port.device

    # Fallback for Arduino Mega USB serial devices.
    for port in ports:
        if port.device.startswith(
            "/dev/ttyACM"
        ):
            return port.device

    return None


def disconnect_arduino():
    # The Arduino keeps automatic control on its own; nothing to re-authorize.
    global arduino
    with arduino_lock:
        if arduino is not None:
            try:
                arduino.close()
            except Exception:
                pass

        arduino = None

    global feeding_pending, feeding_last_error
    with feeding_lock:
        feeding_last_error = None
        for gate in feeding_gates.values():
            gate["status"] = "UNKNOWN"
            gate["updatedAt"] = utc_timestamp()
        feeding_pending = None
    with state_lock:
        state["connected"] = False
        state["arduinoPort"] = None
        state["mode"] = "unknown"
        state["piSeenByArduino"] = None
        state["lastSeen"] = None
        state["temperature"] = None
        state["humidity"] = None
        state["lux"] = None
        state["lightRaw"] = None
        state["sensorSource"] = "UNKNOWN"
        state["dht22Status"] = "UNKNOWN"
        state["systemHealth"] = "UNKNOWN"
        for name in ("hopperWeight", "troughWeight"):
            state[name] = {"status": "WAITING", "raw": None,
                           "weightGrams": None, "updatedAt": None}

    print("[ARDUINO] Disconnected")


def connect_arduino():
    global arduino

    port = find_arduino()

    if port is None:
        return False

    try:
        connection = serial.Serial(
            port,
            ARDUINO_BAUD_RATE,
            timeout=1,
            write_timeout=2
        )

        # Arduino Mega may reset when serial opens.
        time.sleep(2)

        with arduino_lock:
            arduino = connection

        with state_lock:
            state["connected"] = True
            state["arduinoPort"] = port

        print(
            f"[ARDUINO] Connected: {port}"
        )

        reset_sensor_check()
        send_command("SYS:INIT")
        send_command("STATUS")

        return True

    except Exception as error:
        print(
            f"[ARDUINO] Connection error: "
            f"{error}"
        )

        disconnect_arduino()

        return False


# ============================================================
# ARDUINO COMMANDS
# ============================================================

def send_command(command):
    with arduino_lock:
        if (
            arduino is None
            or not arduino.is_open
        ):
            return False

        try:
            arduino.write(
                (
                    command.strip()
                    + "\n"
                ).encode("utf-8")
            )

            arduino.flush()

            print(
                f"[ARDUINO TX] {command}"
            )

            return True

        except Exception as error:
            print(
                f"[ARDUINO] Write error: "
                f"{error}"
            )

            return False



# Sensor-check tracking. Updated only by Arduino responses.
sensor_check = {
    "status": "NOT_CHECKED",
    "temperature": None,
    "humidity": None,
    "lightRaw": None,
    "lux": None,
    "checkedAt": None,
    "checkedMono": None,
}
sensor_check_lock = threading.Lock()


def reset_sensor_check():
    with sensor_check_lock:
        sensor_check.update({
            "status": "NOT_CHECKED",
            "temperature": None,
            "humidity": None,
            "lightRaw": None,
            "lux": None,
            "checkedAt": None,
            "checkedMono": None,
        })


# ============================================================
# ARDUINO MESSAGE PARSER
# ============================================================

def parse_bool_list(value, count):
    values = (
        value
        .replace(" ", "")
        .split(",")
    )

    result = []

    for item in values[:count]:
        result.append(
            item.lower()
            in (
                "1",
                "true",
                "on"
            )
        )

    while len(result) < count:
        result.append(False)

    return result


def process_message(message):
    message = message.strip()

    if not message:
        return

    print(
        f"[ARDUINO RX] {message}"
    )

    if message.startswith(("HOPPER_WEIGHT:", "TROUGH_WEIGHT:")):
        try:
            key, payload = message.split(":", 1)
            parts = payload.split(",")
            sensor = "hopperWeight" if key == "HOPPER_WEIGHT" else "troughWeight"
            with state_lock:
                current = dict(state[sensor])
                current["status"] = parts[0]
                current["updatedAt"] = utc_timestamp()
                if parts[0] == "RAW" and len(parts) >= 3:
                    current["raw"] = int(parts[1])
                    current["status"] = parts[2]
                    current["weightGrams"] = float(parts[3]) if parts[2] == "ESTIMATED" and len(parts) >= 4 else None
                else:
                    current["weightGrams"] = None
                state[sensor] = current
        except (ValueError, TypeError, IndexError):
            pass
        return
    if message.startswith("FEED_GATE:"):
        try:
            gate_id, status, duration = message.split(":", 1)[1].split(",")
            if gate_id not in feeding_gates or status not in ("STARTED", "DISPENSING", "COMPLETED", "CLOSED", "STOPPED"):
                return
            ms = int(duration)
            with feeding_lock:
                global feeding_pending
                gate = feeding_gates[gate_id]
                previous = gate["status"]
                gate.update(status="DISPENSING" if status in ("STARTED", "DISPENSING") else status,
                            durationMs=ms, estimatedGrams=(round(ms / 1000 * feeding_rates[int(gate_id)], 1) if feeding_rates[int(gate_id)] is not None else None),
                            updatedAt=utc_timestamp())
                if status == "STARTED":
                    feeding_pending = None
                    feeding_events.appendleft({"gate": int(gate_id), "event": "STARTED", "durationMs": ms,
                                               "estimatedGrams": gate["estimatedGrams"], "timestamp": gate["updatedAt"]})
                elif status in ("COMPLETED", "STOPPED") and previous == "DISPENSING":
                    feeding_events.appendleft({"gate": int(gate_id), "event": status, "durationMs": ms,
                                               "estimatedGrams": gate["estimatedGrams"] if status == "COMPLETED" else None,
                                               "timestamp": gate["updatedAt"]})
        except (ValueError, TypeError):
            pass
        return
    if message.startswith("FEED_ERROR:"):
        global feeding_last_error
        with feeding_lock:
            feeding_last_error = message
            feeding_pending = None
            feeding_events.appendleft({"gate": None, "event": "ERROR", "message": message,
                                       "timestamp": utc_timestamp()})
        return

    if message.startswith("BYPASS_ACK:") or message.startswith("BYPASS_ERROR:"):
        global bypass_ack_message
        bypass_ack_message = message
        bypass_ack_event.set()
        return

    if message.startswith("BOOT:"):
        # Arduino reset (power, USB open or brownout). It resumes automatic
        # control by itself; the event is logged to history.
        print(f"[ARDUINO] Boot detected: {message}", flush=True)
        with state_lock:
            state["lastBootAt"] = utc_timestamp()
            state["piSeenByArduino"] = False
        return

    if message in ("PI:ONLINE", "PI:OFFLINE"):
        print(f"[ARDUINO] {message}", flush=True)
        with state_lock:
            state["piSeenByArduino"] = message == "PI:ONLINE"
        return

    if ":" not in message:
        return

    key, value = message.split(
        ":",
        1
    )

    key = key.strip().upper()
    value = value.strip()

    with state_lock:
        try:

            if key == "SENSOR_CHECK":
                with sensor_check_lock:
                    sensor_check.update({
                        "status": (
                            "COLLECTING" if value.upper() == "OK"
                            else "ERROR"
                        ),
                        "temperature": None,
                        "humidity": None,
                        "lightRaw": None,
                        "lux": None,
                        "checkedAt": None,
                        "checkedMono": None,
                    })

            elif key == "SENSOR_TEMPERATURE":
                with sensor_check_lock:
                    sensor_check["temperature"] = float(value)

            elif key == "SENSOR_HUMIDITY":
                with sensor_check_lock:
                    sensor_check["humidity"] = float(value)

            elif key == "SENSOR_LDR_RAW":
                with sensor_check_lock:
                    sensor_check["lightRaw"] = int(value)

            elif key == "SENSOR_LUX":
                import math

                with sensor_check_lock:
                    sensor_check["lux"] = float(value)

                    t = sensor_check["temperature"]
                    h = sensor_check["humidity"]
                    raw = sensor_check["lightRaw"]
                    lux = sensor_check["lux"]

                    valid = (
                        sensor_check["status"] == "COLLECTING"
                        and all(
                            isinstance(v, (int, float))
                            and not isinstance(v, bool)
                            and math.isfinite(v)
                            for v in (t, h, raw, lux)
                        )
                        and 0 <= t <= 60
                        and 0 < h <= 100
                        and 0 <= raw <= 1023
                        and 0 <= lux <= 100000
                    )

                    sensor_check["status"] = (
                        "OK" if valid else "ERROR"
                    )
                    sensor_check["checkedAt"] = (
                        utc_timestamp() if valid else None
                    )
                    sensor_check["checkedMono"] = time.monotonic() if valid else None

            elif key == "FEED_WEIGHT_GRAMS":
                state["feedWeightGrams"] = float(value)
                state["feedWeightUpdatedAt"] = utc_timestamp()
            elif key == "FEED_WEIGHT_RAW":
                state["feedWeightRaw"] = int(value)
            elif key == "FEED_WEIGHT_STATUS":
                state["feedWeightStatus"] = value.upper()
            elif key == "MODE_STATUS":
                # Compatibility constant: the always-live firmware reports LIVE.
                state["mode"] = value.lower()

            elif key == "PI_STATUS":
                state["piSeenByArduino"] = value.upper() == "ONLINE"


            elif key == "STAGE_OK":

                state["stage"] = (
                    value.upper()
                )


            elif key == "TEMPERATURE":

                state["temperature"] = (
                    float(value)
                )


            elif key == "HUMIDITY":

                state["humidity"] = (
                    float(value)
                )


            elif key == "LUX":

                state["lux"] = (
                    float(value)
                )


            elif key == "LIGHT_RAW":

                state["lightRaw"] = int(
                    float(value)
                )


            elif key == "TEMP_TARGET":

                minimum, maximum = (
                    value.split(",")
                )

                state["temperatureTarget"] = {
                    "min": float(minimum),
                    "max": float(maximum)
                }


            elif key == "LUX_TARGET":

                minimum, maximum = (
                    value.split(",")
                )

                state["luxTarget"] = {
                    "min": float(minimum),
                    "max": float(maximum)
                }


            elif key == "FANS_ON":

                state["fansOn"] = int(
                    value
                )


            elif key == "FAN_STATUS":

                state["fans"] = (
                    parse_bool_list(
                        value,
                        4
                    )
                )


            elif key == "HEATERS_ON":

                state["heatersOn"] = int(
                    value
                )


            elif key == "HEATER_STATUS":

                state["heaters"] = (
                    parse_bool_list(
                        value,
                        2
                    )
                )


            elif key == "LED_STATUS":

                state["led"] = (
                    value.lower()
                    in (
                        "1",
                        "true",
                        "on"
                    )
                )


            elif key == "SYSTEM_HEALTH":
                state["systemHealth"] = value.strip().upper()

            elif key == "SYSTEM_ERROR":
                state["systemError"] = value.strip()

            elif key == "DHT22_STATUS":
                state["dht22Status"] = value.strip().upper()

            elif key == "SENSOR_SOURCE":

                state["sensorSource"] = (
                    value
                )


            elif key == "DHT22_READ_ERROR":

                print(
                    "[SENSOR] "
                    "DHT22 reading failed"
                )


            else:
                return

            state["lastSeen"] = (
                utc_timestamp()
            )

        except (
            ValueError,
            TypeError
        ) as error:

            print(
                "[PARSER] "
                f"Invalid message: {error}"
            )



# ============================================================
# ARDUINO HEARTBEAT
# ============================================================

def arduino_heartbeat_worker():
    print("[HEARTBEAT] Worker started", flush=True)

    while True:
        time.sleep(2)
        with state_lock:
            connected = state.get("connected") is True
        if connected:
            send_command("SYS:PING")


def telemetry_fresh_locked():
    """Call with state_lock held. True if a status line arrived recently."""
    stamp = state.get("lastSeen")
    if not stamp:
        return False
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
    except (ValueError, TypeError):
        return False
    return age < ARDUINO_RX_TIMEOUT_SECONDS


def arduino_online_locked():
    """Call with state_lock held. Connected with fresh telemetry."""
    return state.get("connected") is True and telemetry_fresh_locked()


def controller_ready_locked():
    """Call with state_lock held. Ready for feeding / stage commands:
    online, healthy, and the Arduino is not reporting the Pi as offline."""
    return (arduino_online_locked()
            and state.get("mode") == "live"
            and state.get("piSeenByArduino") is not False
            and state.get("systemHealth") in ("OK", "READY"))


@app.route("/api/environment/standards", methods=["GET"])
def environment_standards():
    return jsonify({"lightingThresholdLux": 50.0, "heaterOverridesLed": True,
      "stages": {"Starter": {"referenceDays":"1–10", "temperatureMin":32.2, "temperatureMax":35.0, "provisional":False},
                 "Grower": {"referenceDays":"11–24", "temperatureMin":26.7, "temperatureMax":29.4, "provisional":False},
                 "Finisher": {"referenceDays":"25–42", "temperatureMin":24.0, "temperatureMax":26.0, "provisional":True}}})

@app.route("/api/recovery/status", methods=["GET"])
def get_recovery_status():
    # Alias kept for one release; the same fields are in /api/status.
    with state_lock:
        connected = state.get("connected") is True
        mode = str(state.get("mode") or "unknown").lower()
        online = arduino_online_locked()
        pi_seen = state.get("piSeenByArduino")
    return jsonify({"connected": connected, "mode": mode,
                    "arduinoOnline": online, "piSeenByArduino": pi_seen})


# ============================================================
# ARDUINO BACKGROUND WORKER
# ============================================================

def serial_worker():
    # Only this worker reads from the Arduino. A USB port that opens but
    # never sends data is NOT a healthy Arduino connection.
    last_rx_mono = None
    active_connection = None
    while True:
        try:
            with arduino_lock:
                connection = arduino
            if connection is None or not connection.is_open:
                if not connect_arduino():
                    time.sleep(ARDUINO_RECONNECT_DELAY)
                    continue
                with arduino_lock:
                    connection = arduino
                active_connection = connection
                last_rx_mono = time.monotonic()

            if connection is not active_connection:
                active_connection = connection
                last_rx_mono = time.monotonic()

            line = connection.readline().decode("utf-8", errors="ignore").strip()
            if line:
                last_rx_mono = time.monotonic()
                process_message(line)
            elif (last_rx_mono is not None and
                  time.monotonic() - last_rx_mono > ARDUINO_RX_TIMEOUT_SECONDS):
                print("[ARDUINO] No serial RX for 15 seconds; reconnecting", flush=True)
                # The Arduino keeps automatic control by itself.
                pause_bypass_on_serial_loss()
                disconnect_arduino()
                active_connection = None
                last_rx_mono = None
                time.sleep(ARDUINO_RECONNECT_DELAY)
        except (serial.SerialException, OSError, AttributeError) as error:
            print(f"[ARDUINO] Serial error: {error}", flush=True)
            pause_bypass_on_serial_loss()
            disconnect_arduino()
            active_connection = None
            last_rx_mono = None
            time.sleep(ARDUINO_RECONNECT_DELAY)
        except Exception as error:
            # A malformed telemetry message must not silently kill the sole
            # serial reader, leaving the web UI forever stuck at UNKNOWN.
            print(f"[ARDUINO] Serial worker unexpected error: {error}", flush=True)
            time.sleep(1)


# ============================================================
# PI CAMERA V3
# ============================================================

def initialize_camera():
    global camera
    global camera_error

    try:

        print(
            "[CAMERA] "
            "Initializing Pi Camera V3..."
        )

        new_camera = Picamera2()

        configuration = (
            new_camera
            .create_video_configuration(
                main={
                    "size": (
                        CAMERA_WIDTH,
                        CAMERA_HEIGHT
                    ),

                    "format": "RGB888"
                },

                controls={
                    "FrameRate":
                        CAMERA_FPS
                }
            )
        )

        new_camera.configure(
            configuration
        )

        new_camera.start()

        # Give auto exposure/white balance
        # a moment to settle.
        time.sleep(1)

        camera = new_camera
        camera_error = None

        camera_state["connected"] = True
        camera_state["error"] = None

        print(
            "[CAMERA] "
            "Pi Camera started successfully"
        )

    except Exception as error:

        camera = None

        camera_error = str(error)

        camera_state["connected"] = False
        camera_state["error"] = (
            camera_error
        )

        print(
            "[CAMERA] "
            f"Initialization failed: "
            f"{error}"
        )


# ============================================================
# CAMERA LIVE STREAM
# ============================================================

def generate_camera_frames():

    while camera is not None:

        try:

            with camera_lock:

                buffer = io.BytesIO()

                camera.capture_file(
                    buffer,
                    format="jpeg"
                )

                frame = (
                    buffer.getvalue()
                )

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Cache-Control: no-cache\r\n"
                b"\r\n"
                + frame
                + b"\r\n"
            )

            time.sleep(
                1 / CAMERA_FPS
            )

        except GeneratorExit:
            break

        except Exception as error:

            camera_state["error"] = (
                str(error)
            )

            print(
                "[CAMERA] "
                f"Streaming error: "
                f"{error}"
            )

            break


# ============================================================
# AI MODEL INITIALIZATION
# ============================================================

def initialize_ai():
    global ai_model

    try:

        print(
            "[AI] Loading Poultrix "
            "YOLOv8s-cls model..."
        )

        ai_model = YOLO(
            AI_MODEL_PATH
        )

        with ai_state_lock:

            ai_state["modelLoaded"] = True

            ai_state["status"] = "ready"

            ai_state["error"] = None

        print(
            "[AI] Model loaded successfully"
        )

        print(
            f"[AI] Classes: "
            f"{ai_model.names}"
        )

    except Exception as error:

        ai_model = None

        with ai_state_lock:

            ai_state["modelLoaded"] = False

            ai_state["status"] = "error"

            ai_state["error"] = str(
                error
            )

        print(
            "[AI] Model loading failed: "
            f"{error}"
        )


# ============================================================
# AI CLASSIFICATION
# ============================================================

def classify_current_frame(update_state=True):
    """
    Capture and classify one frame.

    update_state=True preserves the old single-frame behavior for debugging.
    The 30-second cycle calls this with update_state=False so only the final
    majority-vote result is published to the website.
    """

    if ai_model is None:
        return {
            "success": False,
            "error": "AI model not loaded"
        }

    if camera is None:
        return {
            "success": False,
            "error": "Camera unavailable"
        }

    try:
        start_time = time.perf_counter()

        # Share the same Picamera2 instance with the MJPEG stream.
        with camera_lock:
            frame = camera.capture_array()

        results = ai_model.predict(
            source=frame,
            imgsz=224,
            verbose=False
        )

        result = results[0]

        if result.probs is None:
            raise RuntimeError(
                "Model did not return classification probabilities"
            )

        class_id = int(result.probs.top1)
        confidence = float(result.probs.top1conf) * 100.0
        stage = str(result.names[class_id])

        inference_time_ms = (
            (time.perf_counter() - start_time) * 1000.0
        )

        confident = confidence >= AI_MIN_CONFIDENCE

        if update_state:
            with ai_state_lock:
                ai_state["detectedStage"] = stage
                ai_state["confidence"] = round(confidence, 2)
                ai_state["confident"] = confident
                ai_state["lastInference"] = utc_timestamp()
                ai_state["inferenceTimeMs"] = round(
                    inference_time_ms,
                    1
                )
                ai_state["cycleDuration"] = None
                ai_state["framesAnalyzed"] = 1
                ai_state["votes"] = {
                    "Starter": 1 if stage.lower() == "starter" else 0,
                    "Grower": 1 if stage.lower() == "grower" else 0,
                    "Finisher": 1 if stage.lower() == "finisher" else 0
                }
                ai_state["status"] = (
                    "ready"
                    if confident
                    else "low_confidence"
                )
                ai_state["error"] = None

        return {
            "success": True,
            "stage": stage,
            "confidence": round(confidence, 2),
            "confident": confident,
            "inferenceTimeMs": round(inference_time_ms, 1)
        }

    except Exception as error:
        if update_state:
            with ai_state_lock:
                ai_state["status"] = "error"
                ai_state["error"] = str(error)

        print(
            "[AI] Classification error: "
            f"{error}"
        )

        return {
            "success": False,
            "error": str(error)
        }


def reset_transition_candidate(status):
    with ai_state_lock:
        ai_state.update(transitionCandidate=None, transitionConfirmations=0,
                        transitionConfirmed=False, confirmedTransitionStage=None,
                        transitionStatus=status)


def apply_confirmed_stage_to_arduino(target_stage):
    """Send a validated stage only; never initiate a feeding command."""
    target = str(target_stage or "").strip().upper()
    with state_lock:
        current = str(state.get("stage") or "").strip().upper()
        connected = controller_ready_locked()
    if target not in ("STARTER", "GROWER", "FINISHER") or current not in ("STARTER", "GROWER", "FINISHER") or target == current:
        return {"success": False, "status": "invalid_or_same_stage"}
    if not AI_AUTO_STAGE_TRANSITIONS or not connected or bypass_active():
        return {"success": False, "status": "hardware_busy_or_offline"}
    with feeding_lock:
        if feeding_pending is not None or any(g.get("status") == "DISPENSING" for g in feeding_gates.values()):
            return {"success": False, "status": "feeding_active_retry_after_next_cycle"}
    with ai_state_lock:
        ai_state["hardwareTransitionStatus"] = "sending"
        ai_state["hardwareTransitionError"] = None
    if not send_command("STAGE:" + target):
        with ai_state_lock:
            ai_state["hardwareTransitionStatus"] = "send_failed"
            ai_state["hardwareTransitionError"] = "Serial command failed"
            ai_state["lastTransitionResult"] = {"status": "send_failed", "from": current, "to": target, "timestamp": utc_timestamp()}
        return {"success": False, "status": "send_failed"}
    deadline = time.monotonic() + AI_STAGE_ACK_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        with state_lock:
            observed = str(state.get("stage") or "").strip().upper()
        if observed == target:
            timestamp = utc_timestamp()
            with ai_state_lock:
                ai_state["hardwareTransitionStatus"] = "applied"
                ai_state["hardwareTransitionError"] = None
                ai_state["lastHardwareTransition"] = {"from": current, "to": target, "timestamp": timestamp}
                ai_state["lastTransitionResult"] = {"status": "applied", "from": current, "to": target, "timestamp": timestamp}
            return {"success": True, "status": "applied", "from": current, "to": target, "timestamp": timestamp}
        time.sleep(0.1)
    with ai_state_lock:
        ai_state["hardwareTransitionStatus"] = "ack_timeout"
        ai_state["hardwareTransitionError"] = "Arduino did not confirm STAGE_OK:" + target
        ai_state["lastTransitionResult"] = {"status": "ack_timeout", "from": current, "to": target, "timestamp": utc_timestamp()}
    return {"success": False, "status": "ack_timeout", "targetStage": target}


def apply_finisher_after_acknowledgement():
    """Legacy endpoint retained; no longer needed for AI stage transitions."""
    return {"success": False, "status": "obsolete_endpoint_ai_transitions_are_validated_automatically"}


def batch_start_date():
    with feed_config_lock:
        return _read_feed_config().get("batchStartDate")


def current_schedule_status():
    with state_lock:
        current = state.get("stage")
    with schedule_lock:
        attempt = schedule_attempt
    return stage_schedule.schedule_status(batch_start_date(), current, stage_schedule.local_now(), attempt)


def evaluate_stage_transition(detected_stage, confident, scheduled=False):
    """Day-gated, forward-only (SPEC-stage-schedule). Only scheduled cycles
    count: a detection must be an allowed target for today's batch day, and
    3 consecutive confident cycles must agree before the stage is applied."""
    with state_lock:
        current = str(state.get("stage") or "").strip().upper()
    detected = str(detected_stage or "").strip().upper()
    valid = stage_schedule.STAGES
    if not scheduled:
        # Analyze now / maintenance analysis: camera check only. The scheduled
        # candidate is left untouched.
        return {"currentStage": current, "detectedStage": detected or None,
                "confirmed": False, "status": "manual_check_only"}
    day = stage_schedule.batch_day(batch_start_date(), stage_schedule.local_date(stage_schedule.local_now()))
    allowed = stage_schedule.allowed_targets(day, current)
    with ai_state_lock:
        ai_state["finisherAcknowledgementRequired"] = False
        ai_state["finisherTransitionPending"] = False
        ai_state["finisherPendingSince"] = None
        if day is None:
            status = "no_batch_date"
        elif not confident or detected not in valid or current not in valid:
            status = "low_confidence_or_unknown"
        elif detected == current:
            status = "same_stage"
        elif valid.index(detected) < valid.index(current):
            status = "backward_ignored"
        elif detected not in allowed:
            status = "not_allowed_yet"
        else:
            status = None
        if status is not None:
            ai_state["transitionCandidate"] = None
            ai_state["transitionConfirmations"] = 0
            ai_state["transitionConfirmed"] = False
            ai_state["confirmedTransitionStage"] = None
            ai_state["transitionStatus"] = status
        else:
            if ai_state["transitionCandidate"] == detected:
                ai_state["transitionConfirmations"] += 1
            else:
                ai_state["transitionCandidate"] = detected
                ai_state["transitionConfirmations"] = 1
            ai_state["transitionConfirmations"] = min(ai_state["transitionConfirmations"], AI_TRANSITION_CONFIRMATIONS_REQUIRED)
            confirmed = ai_state["transitionConfirmations"] >= AI_TRANSITION_CONFIRMATIONS_REQUIRED
            ai_state["transitionConfirmed"] = confirmed
            ai_state["confirmedTransitionStage"] = detected if confirmed else None
            ai_state["transitionStatus"] = "confirmed" if confirmed else "pending"
        result = {"currentStage": current, "detectedStage": detected or None,
                  "candidate": ai_state["transitionCandidate"],
                  "confirmations": ai_state["transitionConfirmations"],
                  "required": AI_TRANSITION_CONFIRMATIONS_REQUIRED,
                  "confirmed": ai_state["transitionConfirmed"],
                  "confirmedStage": ai_state["confirmedTransitionStage"],
                  "status": ai_state["transitionStatus"],
                  "batchDay": day, "allowedTargets": list(allowed)}
    if result["confirmed"]:
        hardware = apply_confirmed_stage_to_arduino(detected)
        result["hardware"] = hardware
        if hardware.get("success"):
            reset_transition_candidate("applied")
    return result


def run_ai_cycle(scheduled=False):
    """
    Run a 30-second classification cycle.

    One frame is sampled approximately once per second. The stage with the
    most votes wins. Confidence is the average confidence of the frames that
    voted for the winning stage.

    Only scheduled cycles (the daily window in ai_worker) can lead to a stage
    change; manual cycles are camera checks (SPEC-stage-schedule).
    """

    if ai_model is None:
        return {
            "success": False,
            "error": "AI model not loaded"
        }

    if camera is None:
        return {
            "success": False,
            "error": "Camera unavailable"
        }

    # Prevent the automatic worker and Analyze Now from running cycles
    # simultaneously.
    if not ai_cycle_lock.acquire(blocking=False):
        return {
            "success": False,
            "error": "AI analysis cycle already running",
            "busy": True
        }

    cycle_start = time.monotonic()
    deadline = cycle_start + AI_CYCLE_DURATION_SECONDS

    votes = {
        "Starter": 0,
        "Grower": 0,
        "Finisher": 0
    }

    confidence_by_stage = {
        "Starter": [],
        "Grower": [],
        "Finisher": []
    }

    inference_times = []
    frames_analyzed = 0
    failed_frames = 0

    try:
        with ai_state_lock:
            ai_state["status"] = "classifying"
            ai_state["cycleRunning"] = True
            ai_state["status"] = "classifying"
            ai_state["framesAnalyzed"] = 0
            ai_state["failedFrames"] = 0
            ai_state["votes"] = {"Starter": 0, "Grower": 0, "Finisher": 0}
            ai_state["error"] = None

        print(
            "[AI] Starting 30-second "
            "multi-frame analysis cycle..."
        )

        next_sample = cycle_start

        while time.monotonic() < deadline:
            now = time.monotonic()

            if now < next_sample:
                time.sleep(
                    min(next_sample - now, 0.05)
                )
                continue

            prediction = classify_current_frame(
                update_state=False
            )

            if prediction["success"]:
                raw_stage = str(
                    prediction["stage"]
                ).strip().lower()

                stage_map = {
                    "starter": "Starter",
                    "grower": "Grower",
                    "finisher": "Finisher"
                }

                stage = stage_map.get(raw_stage)

                if stage is not None:
                    votes[stage] += 1
                    confidence_by_stage[stage].append(
                        float(prediction["confidence"])
                    )
                    inference_times.append(
                        float(prediction["inferenceTimeMs"])
                    )
                    frames_analyzed += 1

                    print(
                        "[AI CYCLE] "
                        f"Frame {frames_analyzed}: "
                        f"{stage} "
                        f"({prediction['confidence']:.2f}%)"
                    )
                else:
                    failed_frames += 1
            else:
                failed_frames += 1
                print(
                    "[AI CYCLE] Frame failed: "
                    f"{prediction.get('error', 'unknown error')}"
                )

            # Publish each processed frame to the status endpoint immediately.
            with ai_state_lock:
                ai_state["votes"] = dict(votes)
                ai_state["framesAnalyzed"] = frames_analyzed
                ai_state["failedFrames"] = failed_frames

            next_sample += AI_SAMPLE_INTERVAL_SECONDS

        if frames_analyzed == 0:
            if scheduled:
                reset_transition_candidate("no_valid_frames")
            raise RuntimeError(
                "No valid AI frames were analyzed during the cycle"
            )

        max_votes = max(votes.values())
        winners = [
            stage
            for stage, count in votes.items()
            if count == max_votes
        ]

        # A tied vote is intentionally rejected rather than guessing.
        if len(winners) != 1:
            if scheduled:
                reset_transition_candidate("tie")
            cycle_duration = time.monotonic() - cycle_start

            with ai_state_lock:
                ai_state["detectedStage"] = None
                ai_state["confidence"] = None
                ai_state["confident"] = False
                ai_state["lastInference"] = utc_timestamp()
                ai_state["inferenceTimeMs"] = (
                    round(
                        sum(inference_times) / len(inference_times),
                        1
                    )
                    if inference_times
                    else None
                )
                ai_state["cycleDuration"] = round(
                    cycle_duration,
                    1
                )
                ai_state["framesAnalyzed"] = frames_analyzed
                ai_state["votes"] = dict(votes)
                ai_state["status"] = "tie"
                ai_state["error"] = "AI cycle ended in a tied vote"

            print(
                "[AI CYCLE] Rejected: tied vote "
                f"{votes}"
            )

            return {
                "success": True,
                "detectedStage": None,
                "stage": None,
                "confidence": None,
                "confident": False,
                "status": "tie",
                "cycleDuration": round(cycle_duration, 1),
                "framesAnalyzed": frames_analyzed,
                "failedFrames": failed_frames,
                "votes": votes
            }

        winning_stage = winners[0]

        winning_confidences = (
            confidence_by_stage[winning_stage]
        )

        winning_confidence = (
            sum(winning_confidences)
            / len(winning_confidences)
        )

        confident = (
            winning_confidence >= AI_MIN_CONFIDENCE
            and frames_analyzed >= AI_MIN_VALID_FRAMES
            and max_votes / frames_analyzed >= AI_MIN_WINNING_VOTE_FRACTION
        )

        average_inference_ms = (
            sum(inference_times)
            / len(inference_times)
            if inference_times
            else None
        )

        cycle_duration = (
            time.monotonic()
            - cycle_start
        )

        status = (
            "ready"
            if confident
            else "low_confidence"
        )

        with ai_state_lock:
            ai_state["detectedStage"] = winning_stage
            ai_state["confidence"] = round(
                winning_confidence,
                2
            )
            ai_state["confident"] = confident
            ai_state["lastInference"] = utc_timestamp()
            ai_state["inferenceTimeMs"] = (
                round(average_inference_ms, 1)
                if average_inference_ms is not None
                else None
            )
            ai_state["cycleDuration"] = round(
                cycle_duration,
                1
            )
            ai_state["framesAnalyzed"] = frames_analyzed
            ai_state["failedFrames"] = failed_frames
            ai_state["votes"] = dict(votes)
            ai_state["status"] = status
            ai_state["error"] = None

        transition = evaluate_stage_transition(
            winning_stage,
            confident,
            scheduled
        )

        print(
            "[AI CYCLE] Result: "
            f"{winning_stage} "
            f"({winning_confidence:.2f}%) "
            f"| votes={votes} "
            f"| frames={frames_analyzed}"
        )

        return {
            "success": True,

            # Keep "stage" for compatibility with the current frontend.
            "stage": winning_stage,

            # New explicit cycle-result field.
            "detectedStage": winning_stage,

            "confidence": round(
                winning_confidence,
                2
            ),
            "confident": confident,
            "status": status,
            "minimumConfidence": AI_MIN_CONFIDENCE,
            "cycleDuration": round(
                cycle_duration,
                1
            ),
            "framesAnalyzed": frames_analyzed,
            "failedFrames": failed_frames,
            "votes": votes,
            "transition": transition,
            "inferenceTimeMs": (
                round(average_inference_ms, 1)
                if average_inference_ms is not None
                else None
            )
        }

    except Exception as error:
        with ai_state_lock:
            ai_state["status"] = "error"
            ai_state["error"] = str(error)

        print(
            "[AI CYCLE] Error: "
            f"{error}"
        )

        return {
            "success": False,
            "error": str(error)
        }

    finally:
        with ai_state_lock:
            ai_state["cycleRunning"] = False

        ai_cycle_lock.release()


# ============================================================
# AI BACKGROUND WORKER
# ============================================================

def run_scheduled_check():
    """One cycle of the daily stage-check window. Returns True if a cycle ran."""
    global schedule_attempt
    with schedule_lock:
        attempt = schedule_attempt
    today = stage_schedule.local_date(stage_schedule.local_now()).isoformat()
    if not attempt or attempt.get("date") != today:
        # A new window starts with a fresh candidate.
        reset_transition_candidate("window_started")
    result = run_ai_cycle(scheduled=True)
    if result.get("busy"):
        return False  # Analyze now is running; try again shortly.
    hardware = (result.get("transition") or {}).get("hardware") or {}
    with schedule_lock:
        schedule_attempt = stage_schedule.record_cycle(
            schedule_attempt, stage_schedule.local_now(),
            result.get("detectedStage") if result.get("success") else None,
            result.get("confidence") if result.get("success") else None,
            applied=bool(hardware.get("success")))
        attempt = schedule_attempt
        try:
            stage_schedule.save_attempt(STAGE_SCHEDULE_PATH, attempt)
        except OSError as error:
            print(f"[SCHEDULE] Could not save attempt: {error}", flush=True)
    print(f"[SCHEDULE] cycle {attempt['cycles']}/{stage_schedule.DAILY_MAX_CYCLES}: "
          f"{attempt['detectedStage']} ({attempt['confidence']}) -> {attempt['result']}", flush=True)
    if attempt["result"] == "not_confirmed":
        reset_transition_candidate("window_closed_not_confirmed")
    return True


def ai_worker():
    """Automatic AI cycles run only in the daily stage-check window
    (stage_schedule.window_due). Outside it, nothing runs."""

    # Allow the camera/API to finish
    # starting before first inference.
    time.sleep(3)
    print("[SCHEDULE] AI worker started (daily window "
          f"{stage_schedule.DAILY_CHECK_TIME.strftime('%H:%M')} Asia/Manila)", flush=True)

    while True:
        ran = False
        try:
            with ai_state_lock:
                enabled = ai_state["enabled"]
            with state_lock:
                current = state.get("stage")
            with schedule_lock:
                attempt = schedule_attempt
            due = stage_schedule.window_due(stage_schedule.local_now(), batch_start_date(), current, attempt)
            if enabled and due and not (bypass_active() and bypass_overrides.get("stage")):
                ran = run_scheduled_check()
        except Exception as error:  # the worker must never die
            print(f"[SCHEDULE] Worker error: {error}", flush=True)
        time.sleep(AI_INTERVAL_SECONDS if ran else AI_SCHEDULE_POLL_SECONDS)


# ============================================================
# API: HOME
# ============================================================


# MAINTENANCE BYPASS (trusted LAN only; never expose Flask port publicly)
BYPASS_SECRET = os.environ.get("POULTRIX_BYPASS_SECRET", "")
bypass_lock = threading.RLock()
bypass_token = None
bypass_expires = 0.0
bypass_paused = False  # authenticated session retained; Arduino manual bypass disabled
bypass_connection_lost_at = None  # UTC timestamp of the serial loss that paused bypass
# A maintenance login survives page navigation and browser refresh.
# Server-side expiration remains enforced; logout/exit revokes immediately.
BYPASS_SESSION_SECONDS = 8 * 60 * 60
bypass_overrides = {"temperature":None,"ldr":None,"hopper":None,"trough":None,"stage":None}
# Current simulated readings are generated centrally, every two seconds.
# Baselines stay in bypass_overrides; do not modify physical sensor calibration.
sim_readings = {"temperature":None,"ldr":None,"hopper":None,"trough":None}
sim_last_updated = None
SIM_INTERVAL_SECONDS = 2.0

def simulation_reading_worker():
    global sim_last_updated
    rng = random.SystemRandom()
    while True:
        time.sleep(SIM_INTERVAL_SECONDS)
        if not bypass_active():
            continue
        with bypass_lock:
            for key in sim_readings:
                base = bypass_overrides.get(key)
                if base is None:
                    sim_readings[key] = None
                    continue
                # Small independent noise around the entered baseline.
                spread = {"temperature":0.25,"ldr":3.0,"hopper":3.0,"trough":2.0}[key]
                val = float(base) + rng.uniform(-spread,spread)
                if key == "temperature": val = round(max(-10,min(65,val)),1)
                elif key == "ldr": val = int(round(max(0,min(1023,val))))
                else: val = round(max(0,val),1)
                sim_readings[key] = val
            sim_last_updated = utc_timestamp()
            temp = sim_readings["temperature"]
            hopper = sim_readings["hopper"]
        # LCD values originate from the same Pi readings as the website.
        if temp is not None: send_command(f"BYPASS:SIM:TEMP:{temp:.1f}")
        if hopper is not None: send_command(f"BYPASS:SIM:HOPPER:{hopper:.1f}")

simulation_state = {"active": False, "stage": None, "running": False, "framesAnalyzed": 0, "confidence": None, "votes": {}, "samples": [], "generation": 0, "lastInference": None, "confirmations": 0, "transitionStatus": "idle", "hardwareTransitionStatus": "idle", "hardwareTransitionError": None}
simulation_cycle_lock = threading.Lock()
def simulation_snapshot():
    with bypass_lock:
        return {k:(list(v) if isinstance(v,list) else dict(v) if isinstance(v,dict) else v) for k,v in simulation_state.items()}

def simulation_clear():
    with bypass_lock:
        simulation_state.update(active=False, stage=None, running=False, framesAnalyzed=0, confidence=None, votes={}, samples=[], lastInference=None, confirmations=0, transitionStatus="idle", hardwareTransitionStatus="idle", hardwareTransitionError=None)
        simulation_state["generation"] += 1
        bypass_overrides["stage"] = None

def simulation_select(stage):
    # Selection is not an analysis. No result or hardware command is produced.
    with bypass_lock:
        if simulation_state["running"]:
            return False
        simulation_state["generation"] += 1
        simulation_state.update(active=True, stage=stage, running=False, framesAnalyzed=0, confidence=None, votes={}, samples=[], lastInference=None, confirmations=0, transitionStatus="idle", hardwareTransitionStatus="idle", hardwareTransitionError=None)
        bypass_overrides["stage"] = stage
    return True

def simulation_start_analysis():
    if not simulation_cycle_lock.acquire(blocking=False):
        return {"success":False,"error":"Analysis already running","busy":True}
    try:
        with bypass_lock:
            stage = bypass_overrides.get("stage")
            if not bypass_active() or not stage:
                return {"success":False,"error":"No active maintenance test target"}
            if simulation_state["running"]:
                return {"success":False,"error":"Analysis already running","busy":True}
            generation = simulation_state["generation"]
            simulation_state.update(running=True, framesAnalyzed=0, confidence=None, votes={"Starter":0,"Grower":0,"Finisher":0}, samples=[], hardwareTransitionError=None)
        rng = random.SystemRandom()
        for i in range(30):
            with bypass_lock:
                if generation != simulation_state["generation"] or not bypass_active():
                    return {"success":False,"error":"Test cancelled"}
                if stage != "NO_CHICKEN":
                    confidence = round(rng.uniform(95,99.5),2)
                    simulation_state["samples"].append(confidence)
                    simulation_state["confidence"] = round(sum(simulation_state["samples"])/len(simulation_state["samples"]),2)
                    simulation_state["votes"][stage.title()] = i+1
                simulation_state["framesAnalyzed"] = i+1
            time.sleep(1)
        with bypass_lock:
            if generation != simulation_state["generation"] or not bypass_active():
                return {"success":False,"error":"Test cancelled"}
            simulation_state["running"] = False
            simulation_state["lastInference"] = utc_timestamp()
            if stage == "NO_CHICKEN":
                simulation_state["confirmations"] = 0
                simulation_state["transitionStatus"] = "no_chicken"
                return {"success":True,"stage":None,"testMode":True}
        with state_lock:
            current = str(state.get("stage") or "").upper()
            connected = state.get("connected") is True
        if stage == current:
            with bypass_lock:
                simulation_state["confirmations"] = 0
                simulation_state["transitionStatus"] = "same_stage"
            return {"success":True,"stage":stage,"testMode":True,"transitionStatus":"same_stage"}
        with bypass_lock:
            simulation_state["confirmations"] += 1
            count = simulation_state["confirmations"]
            simulation_state["transitionStatus"] = "pending" if count < 3 else "confirmed"
        if count < 3:
            return {"success":True,"stage":stage,"testMode":True,"confirmations":count}
        with feeding_lock:
            feeding_busy = feeding_pending is not None or any(g.get("status")=="DISPENSING" for g in feeding_gates.values())
        with state_lock:
            online = arduino_online_locked()
        if not connected or not online or feeding_busy:
            error = "Hardware must be connected and online with no active feeding session"
            with bypass_lock:
                simulation_state["hardwareTransitionStatus"] = "blocked"
                simulation_state["hardwareTransitionError"] = error
            return {"success":False,"error":error,"testMode":True}
        with bypass_lock:
            simulation_state["hardwareTransitionStatus"] = "sending"
        if not send_command("STAGE:" + stage):
            error = "Unable to send stage to Arduino"
        else:
            error = "Arduino did not acknowledge the new stage"
            deadline = time.monotonic()+5
            while time.monotonic() < deadline:
                with state_lock:
                    observed = str(state.get("stage") or "").upper()
                if observed == stage:
                    with bypass_lock:
                        simulation_state["hardwareTransitionStatus"] = "applied"
                        simulation_state["transitionStatus"] = "applied"
                        simulation_state["hardwareTransitionError"] = None
                        simulation_state["confirmations"] = 0
                    return {"success":True,"stage":stage,"testMode":True,"hardwareTransitionStatus":"applied"}
                time.sleep(.1)
        with bypass_lock:
            simulation_state["hardwareTransitionStatus"] = "ack_timeout"
            simulation_state["hardwareTransitionError"] = error
        return {"success":False,"error":error,"testMode":True}
    finally:
        with bypass_lock:
            simulation_state["running"] = False
        simulation_cycle_lock.release()

bypass_ack_lock = threading.Lock()
bypass_ack_event = threading.Event()
bypass_ack_message = ""
def bypass_send_confirmed(command, expected):
    global bypass_ack_message
    with bypass_ack_lock:
        bypass_ack_message = ""
        bypass_ack_event.clear()
        if not send_command(command): return False
        if not bypass_ack_event.wait(3): return False
        return bypass_ack_message == expected


def bypass_authorized():
    supplied = request.headers.get("X-Poultrix-Maintenance", "")
    with bypass_lock:
        return bool(bypass_token and time.monotonic()<bypass_expires and secrets.compare_digest(supplied,bypass_token))

def bypass_active():
    with bypass_lock: return bool(bypass_token and time.monotonic()<bypass_expires and not bypass_paused)

def pause_bypass_on_serial_loss():
    # Keep the login (token + expiry) but pause manual control. The Arduino's
    # own 10 s maintenance timeout has returned it to automatic control.
    # Nothing is sent over the broken link; Resume re-sends BYPASS:ON.
    global bypass_paused, bypass_connection_lost_at
    with bypass_lock:
        if not bypass_token:
            return
        bypass_paused = True
        bypass_connection_lost_at = utc_timestamp()
        for key in bypass_overrides:
            bypass_overrides[key] = None
        for key in sim_readings:
            sim_readings[key] = None
    print("[BYPASS] Serial lost; manual control paused (session kept)", flush=True)
    cancel_schedule_test()
    simulation_clear()
    bypass_ack_event.set()  # Unblock an in-flight request; it will fail ACK check.

def bypass_shutdown():
    global bypass_token,bypass_expires,bypass_paused,bypass_connection_lost_at
    send_command("FEED:STOP")
    bypass_send_confirmed("BYPASS:OFF", "BYPASS_ACK:OFF")
    with bypass_lock:
        bypass_token=None;bypass_expires=0.0;bypass_paused=False;bypass_connection_lost_at=None
        for key in bypass_overrides:bypass_overrides[key]=None
    with bypass_lock:
        for key in sim_readings: sim_readings[key] = None
    simulation_clear()

def bypass_watchdog():
    while True:
        time.sleep(2)
        with bypass_lock:
            expired=bool(bypass_token and time.monotonic()>=bypass_expires)
        if expired:bypass_shutdown()
        elif bypass_active():send_command("BYPASS:PING")

BYPASS_LOGIN_MAX_FAILURES = 5
BYPASS_LOGIN_WINDOW_SECONDS = 600
bypass_login_failures = {}  # user -> deque of monotonic failure times
bypass_login_lock = threading.Lock()


def _bypass_failures(who, now):
    entries = bypass_login_failures.setdefault(who, deque())
    while entries and now - entries[0] > BYPASS_LOGIN_WINDOW_SECONDS:
        entries.popleft()
    return entries


def bypass_login_blocked(who):
    with bypass_login_lock:
        return len(_bypass_failures(who, time.monotonic())) >= BYPASS_LOGIN_MAX_FAILURES


def bypass_login_failed(who):
    now = time.monotonic()
    with bypass_login_lock:
        _bypass_failures(who, now).append(now)
        if len(bypass_login_failures) > 500:  # bound memory
            for key in [k for k, v in bypass_login_failures.items() if not v][:250]:
                del bypass_login_failures[key]


@app.route("/api/bypass/login",methods=["POST"])
def bypass_login():
    global bypass_token,bypass_expires,bypass_paused,bypass_connection_lost_at
    if not BYPASS_SECRET or len(BYPASS_SECRET)<4:
        return jsonify(error="Configure POULTRIX_BYPASS_SECRET (4+ characters) on the Pi"),503
    who = request_user()
    if bypass_login_blocked(who):
        return jsonify(error="Too many failed attempts. Wait 10 minutes."),429
    value=str((request.get_json(silent=True) or {}).get("password", ""))
    if not secrets.compare_digest(value,BYPASS_SECRET):
        bypass_login_failed(who)
        print(f"[BYPASS] Failed login by {who}", flush=True)
        return jsonify(error="Unauthorized"),403
    # Bypass authorization is separate from the operating mode.
    # Do not revoke the previously confirmed LIVE startup preference.
    if not bypass_send_confirmed("BYPASS:ON", "BYPASS_ACK:ON"):
        return jsonify(error="Arduino did not confirm maintenance mode"),503
    with bypass_lock:
        bypass_token=secrets.token_urlsafe(32);bypass_expires=time.monotonic()+BYPASS_SESSION_SECONDS;bypass_paused=False;bypass_connection_lost_at=None
        token=bypass_token
    return jsonify(token=token,expiresSeconds=BYPASS_SESSION_SECONDS)

# Accelerated maintenance schedule test. Never represented as a real schedule.
schedule_test_lock = threading.RLock()
schedule_test = {"status":"idle", "slot":None, "stage":None, "birdCount":None,
                 "targetGrams":None, "compartment":None, "durationMs":None,
                 "deadline":None, "error":None, "updatedAt":None}
schedule_test_cancel = threading.Event()

def schedule_test_snapshot():
    with schedule_test_lock:
        result = dict(schedule_test)
    deadline = result.pop("deadline", None)
    result["remainingSeconds"] = max(0, int(__import__('math').ceil(deadline-time.monotonic()))) if deadline else 0
    result["testMode"] = result["status"] in ("countdown", "dispensing", "completed", "fault")
    return result

def cancel_schedule_test():
    schedule_test_cancel.set()
    with schedule_test_lock:
        if schedule_test["status"] in ("countdown", "dispensing"):
            schedule_test.update(status="cancelled", deadline=None, updatedAt=utc_timestamp())

def schedule_test_worker(compartment, milliseconds):
    try:
        while True:
            with schedule_test_lock: deadline=schedule_test["deadline"]
            if schedule_test_cancel.is_set() or not bypass_active(): return
            if deadline is None or time.monotonic() >= deadline: break
            time.sleep(.1)
        with schedule_test_lock:
            if schedule_test_cancel.is_set() or not bypass_active(): return
            schedule_test.update(status="dispensing", deadline=None, updatedAt=utc_timestamp())
        if not bypass_send_confirmed(f"BYPASS:GROUP:{compartment},{milliseconds}",f"BYPASS_ACK:GROUP:{compartment},{milliseconds}"):
            raise RuntimeError("Arduino did not acknowledge timed feed")
        # ACK indicates acceptance, not delivered weight or gate closure.
        time.sleep(milliseconds/1000+.25)
        if not schedule_test_cancel.is_set():
            with schedule_test_lock: schedule_test.update(status="completed",updatedAt=utc_timestamp())
    except Exception as exc:
        with schedule_test_lock: schedule_test.update(status="fault",error=str(exc),updatedAt=utc_timestamp())

@app.route("/api/schedule-test/status",methods=["GET"])
def schedule_test_status():
    return jsonify(schedule_test_snapshot())

@app.route("/api/bypass/schedule-test",methods=["POST"])
def schedule_test_start():
    if not bypass_authorized(): return jsonify(error="Unauthorized"),403
    if not bypass_active(): return jsonify(error="Resume maintenance first"),409
    body=request.get_json(silent=True) or {}
    try:
        slot=str(body.get("slot"))
        countdown=int(body.get("countdownSeconds"))
        if not 1<=countdown<=3600: raise ValueError("Countdown must be 1–3600 seconds")
        with bypass_lock: override=bypass_overrides.get("stage")
        with state_lock: real_stage=str(state.get("stage") or "").upper()
        stage=override if override in FEED_SESSIONS else real_stage
        if stage not in FEED_SESSIONS: raise ValueError("Choose a valid stage")
        plan=_feed_plan(_read_feed_config(),stage)
        if slot not in plan["times"]: raise ValueError("Choose a schedule slot for the selected stage")
        target=plan["targetGrams"]
        if target is None or target<=0: raise ValueError("Save the number of birds in Feeding first")
        with inventory_lock: inv=_inventory_snapshot(_inventory_read())
        compartment=inv.get("selectedCompartment")
        if compartment not in FEED_RATES or compartment not in inv.get("eligibleCompartments",[]):
            raise ValueError("No eligible feed compartment assigned to this stage")
        ms=round(target/FEED_RATES[compartment]*1000)
        if not 100<=ms<=10000: raise ValueError("Calculated feeding exceeds 10-second gate limit; test cannot start")
        with schedule_test_lock:
            if schedule_test["status"] in ("countdown","dispensing"):
                return jsonify(error="Schedule test already running"),409
            schedule_test_cancel.clear()
            schedule_test.update(status="countdown",slot=slot,stage=stage,birdCount=_read_feed_config()["birdCount"],
                                 targetGrams=target,compartment=compartment,durationMs=ms,
                                 deadline=time.monotonic()+countdown,error=None,updatedAt=utc_timestamp())
        threading.Thread(target=schedule_test_worker,args=(compartment,ms),daemon=True).start()
        return jsonify(success=True,**schedule_test_snapshot()),202
    except (ValueError,TypeError) as exc:
        return jsonify(error=str(exc)),400

@app.route("/api/bypass/schedule-test/cancel",methods=["POST"])
def schedule_test_cancel_api():
    if not bypass_authorized():return jsonify(error="Unauthorized"),403
    cancel_schedule_test()
    send_command("FEED:STOP")
    return jsonify(success=True,**schedule_test_snapshot())

@app.route("/api/bypass/status",methods=["GET"])
def bypass_status():
    if not bypass_authorized():return jsonify(error="Unauthorized"),403
    with bypass_lock:
        remaining=max(0,int(bypass_expires-time.monotonic()))
        overrides=dict(bypass_overrides)
        readings=dict(sim_readings)
        readings_at=sim_last_updated
        lost_at=bypass_connection_lost_at
    with state_lock:
        relays=list(state.get("fans", [False]*4)) + [bool(state.get("led",False))] + list(state.get("heaters",[False]*2))[:1]
    return jsonify(active=not bypass_paused,maintenanceAuthenticated=True,manualControlsPaused=bypass_paused,connectionLostAt=lost_at,expiresSeconds=remaining,overrides=overrides,readings=readings,readingsUpdatedAt=readings_at,relays=relays,simulation=simulation_snapshot(),manualStageHistory=_manual_history()[-5:],schedule=current_schedule_status())

STAGE_MANUAL_PATH = Path(__file__).with_name("stage_manual.json")
STAGE_MANUAL_HISTORY = 20


def _manual_history():
    try:
        data = json.loads(STAGE_MANUAL_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


@app.route("/api/bypass/confirm-stage", methods=["POST"])
def bypass_confirm_stage():
    """Owner sets the real stage by hand (any direction). The Arduino stage
    changes; the AI's own fields are not touched (SPEC-stage-schedule §9)."""
    if not bypass_authorized():
        return jsonify(error="Unauthorized"), 403
    target = str((request.get_json(silent=True) or {}).get("stage") or "").strip().upper()
    if target not in stage_schedule.STAGES:
        return jsonify(error="Stage must be STARTER, GROWER or FINISHER"), 400
    with state_lock:
        current = str(state.get("stage") or "").strip().upper()
        online = arduino_online_locked()
    if not online:
        return jsonify(error="Arduino offline; the stage was not changed"), 503
    if target == current:
        return jsonify(success=True, stage=target, changed=False)
    with feeding_lock:
        if feeding_pending is not None or any(g.get("status") == "DISPENSING" for g in feeding_gates.values()):
            return jsonify(error="Feed is being dispensed; try again when it finishes"), 409
    if not send_command("STAGE:" + target):
        return jsonify(error="Unable to send the stage to the Arduino"), 503
    deadline = time.monotonic() + AI_STAGE_ACK_TIMEOUT_SECONDS
    observed = current
    while time.monotonic() < deadline:
        with state_lock:
            observed = str(state.get("stage") or "").strip().upper()
        if observed == target:
            break
        time.sleep(0.1)
    if observed != target:
        return jsonify(error="Arduino did not confirm the new stage"), 504
    # A new stage starts a fresh AI candidate; status stays neutral.
    reset_transition_candidate("idle")
    entry = {"at": utc_timestamp(), "from": current or None, "to": target, "by": request_user()}
    history = (_manual_history() + [entry])[-STAGE_MANUAL_HISTORY:]
    try:
        tmp = STAGE_MANUAL_PATH.with_name(STAGE_MANUAL_PATH.name + ".tmp")
        tmp.write_text(json.dumps(history, indent=2), encoding="utf-8")
        os.replace(tmp, STAGE_MANUAL_PATH)
    except OSError as error:
        print(f"[SCHEDULE] Could not save manual stage history: {error}", flush=True)
    print(f"[AUDIT] manual stage {current or '-'} -> {target} by {request_user()}", flush=True)
    return jsonify(success=True, stage=target, changed=True, previous=current or None,
                   schedule=current_schedule_status())


@app.route("/api/bypass/action",methods=["POST"])
def bypass_action():
    global bypass_expires
    if not bypass_authorized():return jsonify(error="Unauthorized"),403
    if not bypass_active():return jsonify(error="Manual controls paused. Click Resume Bypass first."),409
    data=request.get_json(silent=True) or {};action=data.get("action")
    command=None
    if action=="relay":
        index=data.get("relay");enabled=data.get("on")
        if type(index)!=int or index not in range(1,7) or type(enabled)!=bool:return jsonify(error="Invalid relay"),400
        command=f"BYPASS:RELAY:{index},{int(enabled)}"
    elif action=="dispense":
        # Supervised BYPASS group testing only; normal target/scheduled feeding
        # remains subject to its separate calibration and readiness checks.
        group=data.get("group",data.get("compartment",data.get("gate")))
        seconds=data.get("seconds")
        if type(group) is not int or group not in (1,2):
            return jsonify(error="Select compartment/group 1 or 2"),400
        if type(seconds) not in (int,float) or isinstance(seconds,bool) or not __import__('math').isfinite(seconds) or not 0.1<=seconds<=10:
            return jsonify(error="Duration must be 0.1 to 10 seconds"),400
        milliseconds=round(seconds*1000)
        command=f"BYPASS:GROUP:{group},{milliseconds}"

    elif action=="stop":command="FEED:STOP"
    elif action=="stage":
        stage=data.get("stage")
        if stage not in ("NO_CHICKEN","STARTER","GROWER","FINISHER"):return jsonify(error="Invalid stage"),400
        with bypass_lock:bypass_overrides["stage"]=stage
        if not simulation_select(stage):return jsonify(error="Wait for the current analysis to finish"),409
    elif action=="simulate-again":
        with bypass_lock: selected=bypass_overrides.get("stage")
        if not selected:return jsonify(error="No stage override"),409
        if not simulation_select(selected):return jsonify(error="Analysis in progress"),409
    elif action=="override":
        key=data.get("key");value=data.get("value")
        if key not in ("temperature","ldr","hopper","trough"):return jsonify(error="Invalid key"),400
        try:
            if value is not None:value=float(value)
        except (ValueError,TypeError):return jsonify(error="Invalid value"),400
        if value is not None and (not __import__('math').isfinite(value) or not -50<=value<=100000):return jsonify(error="Out of range"),400
        # Sensor simulations in maintenance mode drive only the low-voltage
        # fan / LED relay tests; no simulated input may energize a heater.
        if key == "ldr" and value is not None and not 0 <= value <= 1023:
            return jsonify(error="LDR raw must be 0-1023"),400
        if key in ("hopper","trough") and value is not None and value < 0:
            return jsonify(error="Weight must be nonnegative"),400
        if key == "temperature" and value is not None and not -10 <= value <= 65:
            return jsonify(error="Temperature test range is -10 to 65 C"),400
        if key in ("temperature","ldr") and value is not None:
            with state_lock:
                targets = dict(state["temperatureTarget"] if key == "temperature" else state["luxTarget"])
                current_fans = list(state.get("fans", [False]*4))
                current_led = bool(state.get("led", False))
            if key == "temperature":
                max_temp = float(targets["max"])
                fan_count = 0 if value <= max_temp else min(4,max(1,int(__import__('math').ceil(value-max_temp))))
                desired = [i < fan_count for i in range(4)]
                for i,(old,new) in enumerate(zip(current_fans,desired),1):
                    if old != new and not bypass_send_confirmed(f"BYPASS:RELAY:{i},{int(new)}",f"BYPASS_ACK:RELAY:{i},{int(new)}"):
                        return jsonify(error=f"Arduino did not acknowledge Fan {i}"),503
            else:
                simulated_lux = max(0.0,5.91*value-49.62)
                led = True if simulated_lux < float(targets["min"]) else False if simulated_lux >= float(targets["max"]) else current_led
                if led != current_led and not bypass_send_confirmed(f"BYPASS:RELAY:5,{int(led)}",f"BYPASS_ACK:RELAY:5,{int(led)}"):
                    return jsonify(error="Arduino did not acknowledge LED"),503
        with bypass_lock:
            bypass_overrides[key]=value
            sim_readings[key]=value
        if key in ("temperature","hopper"):
            suffix = "TEMP" if key == "temperature" else "HOPPER"
            if not send_command(f"BYPASS:SIM:{suffix}:{value:.1f}" if value is not None else f"BYPASS:SIM:{suffix}:OFF"):
                return jsonify(error="Arduino unavailable for LCD simulation"),503
    else:return jsonify(error="Unknown action"),400
    if command:
        if action == "relay":
            expected = f"BYPASS_ACK:RELAY:{index},{int(enabled)}"
            if not bypass_send_confirmed(command, expected):
                return jsonify(error="Arduino did not confirm relay change"),503
        elif action == "dispense":
            if not bypass_send_confirmed(command, f"BYPASS_ACK:GROUP:{group},{milliseconds}"):
                return jsonify(error="Arduino did not acknowledge group dispense. Check BYPASS_ERROR in backend logs, Arduino serial stability, PCA9685 wiring and servo power."),503
        elif not send_command(command):return jsonify(error="Arduino unavailable"),503
    with bypass_lock:bypass_expires=time.monotonic()+BYPASS_SESSION_SECONDS
    return jsonify(success=True,action=action,group=group if action=="dispense" else None, durationMs=milliseconds if action=="dispense" else None, acknowledged=bool(action in ("relay","dispense")),simulation=action in ("stage","override"))

@app.route("/api/bypass/analyse-real",methods=["POST"])
def bypass_analyse_real():
    if not bypass_authorized(): return jsonify(error="Unauthorized"),403
    simulation_clear()
    result = run_ai_cycle()
    return jsonify(result), (200 if result.get("success") else 503)

@app.route("/api/bypass/return-live",methods=["POST"])
def bypass_return_live():
    global bypass_paused
    if not bypass_authorized(): return jsonify(error="Unauthorized"),403
    # Cancel countdown before changing controller mode.
    cancel_schedule_test()
    # Clear physical manual overrides first, without invalidating the login token.
    if not send_command("FEED:STOP"):
        return jsonify(error="Arduino unavailable; overrides not cleared"),503
    if not bypass_send_confirmed("BYPASS:OFF", "BYPASS_ACK:OFF"):
        return jsonify(error="Arduino did not confirm return to automatic control"),503
    with bypass_lock:
        bypass_paused = True
        for key in bypass_overrides: bypass_overrides[key] = None
        for key in sim_readings: sim_readings[key] = None
    cancel_schedule_test()
    simulation_clear()
    # BYPASS_ACK:OFF means the Arduino is back under automatic control.
    return jsonify(success=True,status="automatic",maintenanceAuthenticated=True,manualControlsPaused=True),200

@app.route("/api/bypass/resume",methods=["POST"])
def bypass_resume():
    global bypass_paused, bypass_expires, bypass_connection_lost_at
    if not bypass_authorized(): return jsonify(error="Unauthorized"),403
    with bypass_lock:
        if not bypass_paused:
            return jsonify(success=True,manualControlsPaused=False)
    if not bypass_send_confirmed("BYPASS:ON", "BYPASS_ACK:ON"):
        return jsonify(error="Arduino did not confirm manual bypass"),503
    with bypass_lock:
        bypass_paused = False
        bypass_connection_lost_at = None
        bypass_expires = time.monotonic() + BYPASS_SESSION_SECONDS
    return jsonify(success=True,manualControlsPaused=False)

@app.route("/api/bypass/exit",methods=["POST"])
def bypass_exit():
    if not bypass_authorized():return jsonify(error="Unauthorized"),403
    cancel_schedule_test()
    bypass_shutdown();return jsonify(success=True)

@app.route(
    "/",
    methods=["GET"]
)
def home():

    return jsonify({
        "name": "Poultrix API",

        "status": "running",

        "features": [
            "Arduino Mega Integration",
            "DHT22 Temperature and Humidity",
            "LDR Light Sensor",
            "Fan and Heater Control",
            "LED Control",
            "Test and Live Modes",
            "Pi Camera V3 Live Stream",
            "YOLOv8s-cls Growth Stage Classification"
        ]
    })


# ============================================================
# API: SYSTEM STATUS
# ============================================================

@app.route(
    "/api/status",
    methods=["GET"]
)
def get_status():

    with state_lock:

        result = dict(state)

        result[
            "temperatureTarget"
        ] = dict(
            state[
                "temperatureTarget"
            ]
        )

        result[
            "luxTarget"
        ] = dict(
            state[
                "luxTarget"
            ]
        )

        result["fans"] = list(
            state["fans"]
        )

        result["heaters"] = list(
            state["heaters"]
        )

    # A successful USB open is not evidence of functioning telemetry.
    # The reader watchdog performs reconnects; this reports truthfully.
    if not result.get("lastSeen"):
        result["connected"] = False

    # LIVE/OFFLINE is observed, not a user-selectable mode.
    # Keep underlying firmware mode for troubleshooting, but expose one UI status.
    from datetime import datetime as _dt
    fresh = False
    try:
        stamp = _dt.fromisoformat(result.get("lastSeen") or "")
        fresh = (datetime.now(timezone.utc) - stamp).total_seconds() < ARDUINO_RX_TIMEOUT_SECONDS
    except (ValueError, TypeError):
        pass
    # Always automatic: LIVE means connected, fresh telemetry and healthy.
    # The always-live firmware always reports MODE_STATUS:LIVE; the mode check
    # stays so old SAFE-first firmware (now never switched to LIVE) shows OFFLINE.
    live = (result.get("connected") is True and fresh
            and str(result.get("mode", "")).lower() == "live"
            and result.get("systemHealth") in ("OK", "READY"))
    result["arduinoOnline"] = result.get("connected") is True and fresh
    result["operatingStatus"] = "LIVE" if live else "OFFLINE"
    result["telemetryFresh"] = fresh
    # Maintenance simulation changes API presentation only, and only for the
    # maintenance site (valid token). The main app always gets real readings
    # and no sign of maintenance (SPEC-stage-schedule §9).
    maintenance_view = bypass_authorized()
    if maintenance_view:
        result["maintenanceActive"] = bypass_active()
    result["actualTemperature"] = result.get("temperature")
    result["temperatureSource"] = "DHT22"
    result["temperatureSimulated"] = False
    with bypass_lock:
        if maintenance_view and bypass_token and time.monotonic() < bypass_expires:
            override_temperature = sim_readings.get("temperature")
            if override_temperature is not None:
                result["temperature"] = override_temperature
                result["temperatureSource"] = "BYPASS_SIMULATION"
                result["temperatureSimulated"] = True
            raw_override = sim_readings.get("ldr")
            if raw_override is not None:
                result["actualLightRaw"] = result.get("lightRaw")
                result["actualLux"] = result.get("lux")
                result["lightRaw"] = int(raw_override)
                result["lux"] = round(max(0.0,5.91*raw_override-49.62),1)
                result["luxSimulated"] = True

    result["camera"] = {
        "connected":
            camera_state[
                "connected"
            ],

        "width":
            camera_state[
                "width"
            ],

        "height":
            camera_state[
                "height"
            ],

        "fps":
            camera_state[
                "fps"
            ],

        "error":
            camera_state[
                "error"
            ]
    }

    with ai_state_lock:
        result["ai"] = dict(
            ai_state
        )

    return jsonify(result)


# ============================================================
# API: AI STATUS
# ============================================================

@app.route(
    "/api/ai/status",
    methods=["GET"]
)
def get_ai_status():

    with ai_state_lock:
        result = dict(
            ai_state
        )

    if bypass_authorized():
        result["simulation"] = simulation_snapshot()
    result["schedule"] = current_schedule_status()
    return jsonify(result)


# ============================================================
# API: MANUAL AI CLASSIFICATION
# ============================================================

@app.route(
    "/api/ai/classify",
    methods=["POST"]
)
def manual_ai_classification():
    """Analyze now: always a real camera check that never changes the stage
    (SPEC-stage-schedule). It never runs the maintenance simulation."""

    result = (
        run_ai_cycle()
    )

    if not result["success"]:

        return jsonify(
            result
        ), 503

    return jsonify(result)


# ============================================================
# API: MODE SWITCHING (REMOVED)
# ============================================================

@app.route("/api/mode/live", methods=["POST"])
@app.route("/api/mode/safe", methods=["POST"])
@app.route("/api/mode/test", methods=["POST"])
def retired_mode_switch():
    return jsonify(success=False, error="Mode switching removed; Poultrix is always automatic"), 410


# ============================================================
# API: SENSOR CHECK
# ============================================================

@app.route("/api/sensors/check/status", methods=["GET"])
def get_sensor_check_status():
    with sensor_check_lock:
        result = dict(sensor_check)

    with state_lock:
        connected = state.get("connected", False)
        mode = state.get("mode", "unknown")

    return jsonify({
        "connected": connected,
        "mode": mode,
        "sensorCheck": result
    })


@app.route("/api/sensors/check", methods=["POST"])
def check_live_sensors():
    with state_lock:
        connected = state.get("connected") is True

    if not connected:
        return jsonify({
            "success": False,
            "error": "Arduino not connected"
        }), 503

    if not send_command("SENSOR:CHECK"):
        return jsonify({
            "success": False,
            "error": "Could not send sensor check"
        }), 503

    return jsonify({
        "success": True,
        "message": "Sensor check requested; awaiting Arduino result"
    }), 202


# ============================================================
# API: REQUEST ARDUINO STATUS
# ============================================================

@app.route(
    "/api/arduino/status",
    methods=["POST"]
)
def request_arduino_status():

    if not send_command(
        "STATUS"
    ):

        return jsonify({
            "success": False,
            "error":
                "Arduino not connected"
        }), 503

    return jsonify({
        "success": True,
        "message":
            "Status requested"
    })


# ============================================================
# API: CAMERA STATUS
# ============================================================

@app.route(
    "/api/camera/status",
    methods=["GET"]
)
def get_camera_status():

    return jsonify({
        "connected":
            camera_state[
                "connected"
            ],

        "width":
            CAMERA_WIDTH,

        "height":
            CAMERA_HEIGHT,

        "fps":
            CAMERA_FPS,

        "error":
            camera_state[
                "error"
            ]
    })


# ============================================================
# API: CAMERA LIVE STREAM
# ============================================================

# ============================================================
# API: CAMERA SNAPSHOT (for authenticated Cloudflare proxy)
# ============================================================
@app.route("/api/camera/snapshot", methods=["GET"])
def camera_snapshot():
    if camera is None:
        return jsonify({"success": False, "error": "Camera unavailable"}), 503
    try:
        with camera_lock:
            buffer = io.BytesIO()
            camera.capture_file(buffer, format="jpeg")
            frame = buffer.getvalue()
        return Response(frame, mimetype="image/jpeg", headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        })
    except Exception:
        app.logger.exception("Camera snapshot failed")
        return jsonify({"success": False, "error": "Camera capture failed"}), 503


@app.route(
    "/api/camera/stream",
    methods=["GET"]
)
def camera_stream():

    if camera is None:

        return jsonify({
            "success": False,
            "error":
                "Camera unavailable"
        }), 503

    return Response(
        generate_camera_frames(),

        mimetype=(
            "multipart/x-mixed-replace; "
            "boundary=frame"
        ),

        headers={
            "Cache-Control":
                "no-cache",

            "Pragma":
                "no-cache",

            "X-Content-Type-Options":
                "nosniff"
        }
    )


# ============================================================
# START POULTRIX
# ============================================================


@app.route("/api/ai/acknowledge-finisher", methods=["POST"])
def acknowledge_finisher_transition():
    """
    Farmer acknowledgement endpoint for a confirmed GROWER -> FINISHER
    transition. The Arduino is changed only after this explicit POST.
    """
    result = apply_finisher_after_acknowledgement()
    return jsonify(result), (200 if result.get("success") else 409)



# ============================================================
# API: PCA9685 FEED DISPENSING
# ============================================================
@app.route("/api/feeding/status", methods=["GET"])
def feeding_status():
    with feeding_lock:
        result = {"gates": {k: dict(v) for k, v in feeding_gates.items()},
                  "events": list(feeding_events), "pending": feeding_pending}
    with state_lock:
        result["connected"] = bool(state["connected"])
    return jsonify(result)

@app.route("/api/feeding/dispense", methods=["POST"])
def feeding_dispense():
    if bypass_active() and not bypass_authorized():
        return jsonify(error="Hardware busy, try again in a few minutes"),423
    global feeding_pending
    payload = request.get_json(silent=True) or {}
    gate = payload.get("compartment", payload.get("gate"))
    duration = payload.get("durationMs")
    if type(gate) is not int or gate not in (1, 2) or type(duration) is not int or not (1 <= duration <= 10000):
        return jsonify({"success": False, "error": "compartment (gate) must be 1-2 and durationMs must be 1-10000"}), 400
    # Supervised, bounded pulse only. No automatic schedule or multi-pulse batching.
    # Calibration is a time-based estimate, NOT a reliable weight-based cutoff.
    with state_lock:
        ready = controller_ready_locked()
    if not ready or bypass_active():
        return jsonify(success=False,error="Online, healthy hardware (Pi seen by Arduino) required; hardware busy, try again in a few minutes"),423
    if not (100 <= duration <= 1500):
        return jsonify(success=False,error="Pulse must be between 100 and 1500 ms"),400
    # Continue to the single-pulse serial dispatch below.
    with feeding_lock:
        if feeding_pending and time.monotonic() - feeding_pending["at"] > 5:
            feeding_pending = None
        if feeding_pending or any(v["status"] == "DISPENSING" for v in feeding_gates.values()):
            return jsonify({"success": False, "error": "A feeding operation is already pending or active"}), 409
        feeding_pending = {"gate": gate, "durationMs": duration, "at": time.monotonic()}
    if not send_command(f"FEED:DISPENSE:{gate},{duration}"):
        with feeding_lock:
            feeding_pending = None
        return jsonify({"success": False, "error": "Arduino unavailable"}), 503
    return jsonify({"success": True, "status": "sent_waiting_for_arduino", "gate": gate, "durationMs": duration}), 202

@app.route("/api/feeding/stop", methods=["POST"])
def feeding_stop():
    global feeding_pending
    if not send_command("FEED:STOP"):
        return jsonify({"success": False, "error": "Arduino unavailable"}), 503
    with feeding_lock:
        feeding_pending = None
    return jsonify({"success": True, "status": "stop_sent_waiting_for_arduino"}), 202


# ============================================================
# POULTRIX HEALTH MONITOR
# ============================================================
# SYS:READY and SYS:FAULT are sent every 3 seconds. The Arduino
# firmware times out after 12 seconds without a health message.
# These are software checks, not physical fan/heater feedback.

HEALTH_CHECK_SECONDS = 3
INTERNET_CHECK_HOST = "1.1.1.1"
INTERNET_CHECK_PORT = 443

health_lock = threading.Lock()
health_state = {
    "status": "INITIALIZING",
    "internet": False,
    "arduino": False,
    "camera": False,
    "aiModel": False,
    "dht22": None,
    "issues": ["System starting"],
    "lastChecked": None,
}

def internet_available():
    try:
        with socket.create_connection(
            (INTERNET_CHECK_HOST, INTERNET_CHECK_PORT),
            timeout=2
        ):
            return True
    except OSError:
        return False

def evaluate_system_health():
    with state_lock:
        arduino_ok = bool(state["connected"] and state.get("lastSeen"))
        live_mode = True  # always automatic
        dht_status = state.get("dht22Status")
        arduino_report = state.get("systemHealth")

    with camera_lock:
        camera_ok = bool(camera_state["connected"])

    with ai_state_lock:
        ai_ok = bool(ai_state["modelLoaded"])

    internet_ok = internet_available()
    issues = []

    if not arduino_ok:
        issues.append("Arduino disconnected")
    if not internet_ok:
        issues.append("Internet connectivity check failed")
    if not camera_ok:
        issues.append("Camera unavailable")
    if not ai_ok:
        issues.append("AI model not loaded")
    if live_mode and dht_status != "OK":
        issues.append("DHT22 has not reported a valid live reading")
    if arduino_report == "FAULT" and live_mode and dht_status != "OK":
        # Already represented by the DHT22 issue.
        pass

    result = {
        "status": "FAULT" if issues else "READY",
        "internet": internet_ok,
        "arduino": arduino_ok,
        "camera": camera_ok,
        "aiModel": ai_ok,
        "dht22": dht_status,
        "issues": issues,
        "lastChecked": utc_timestamp(),
    }
    with health_lock:
        health_state.update(result)
    return result

def system_health_worker():
    # The serial worker is the only reader of the Arduino serial port.
    # This thread only sends short commands through send_command().
    while True:
        try:
            result = evaluate_system_health()
            if result["arduino"]:
                command = (
                    "SYS:READY"
                    if result["status"] == "READY"
                    else "SYS:FAULT"
                )
                send_command(command)
        except Exception as error:
            print(f"[HEALTH] Monitor error: {error}")
            with health_lock:
                health_state.update(
                    status="FAULT",
                    issues=[f"Health monitor error: {error}"],
                    lastChecked=utc_timestamp()
                )
            send_command("SYS:FAULT")
        time.sleep(HEALTH_CHECK_SECONDS)

@app.route("/api/system/health", methods=["GET"])
def get_system_health():
    with health_lock:
        snapshot = dict(health_state)
        snapshot["issues"] = list(health_state["issues"])
    return jsonify(snapshot)



def _view_json(view):
    """Run an existing GET view and return (status_code, json body)."""
    result = view()
    status = 200
    if isinstance(result, tuple):
        result, status = result[0], result[1]
    return status, result.get_json(silent=True)


@app.route("/api/snapshot", methods=["GET"])
def get_snapshot():
    """Status, AI, weights, health and feeding gates in one response, so the
    remote dashboard needs one request per poll (Workers request budget)."""
    parts = {"status": get_status, "ai": get_ai_status, "weight": get_feeding_weight,
             "health": get_system_health, "feedingStatus": feeding_status}
    body, errors = {}, {}
    for key, view in parts.items():
        try:
            code, data = _view_json(view)
            body[key] = data
            if code >= 400:
                errors[key] = f"HTTP {code}"
        except Exception as exc:  # one failing part must not hide the rest
            body[key] = None
            errors[key] = type(exc).__name__
    body["errors"] = errors
    body["generatedAt"] = utc_timestamp()
    return jsonify(body)


@app.route("/api/feeding/weight", methods=["GET"])
def get_feeding_weight():
    with state_lock:
        connected = bool(state.get("connected"))
        hopper = dict(state["hopperWeight"])
        trough = dict(state["troughWeight"])
    if not connected:
        hopper["status"] = "DISCONNECTED"
        trough["status"] = "DISCONNECTED"
    maintenance_view = bypass_authorized()
    with bypass_lock:
        if maintenance_view and bypass_token and time.monotonic() < bypass_expires:
            for key,record in (("hopper",hopper),("trough",trough)):
                simulated = sim_readings.get(key)
                if simulated is not None:
                    record["actualWeightGrams"] = record.get("weightGrams")
                    record["weightGrams"] = simulated
                    record["status"] = "SIMULATED"
                    record["simulated"] = True
    return jsonify({"connected": connected, "estimated": True,
                    "hopper": hopper, "trough": trough,
                    "weightGrams": hopper["weightGrams"],
                    "status": hopper["status"]})

# Feeding schedule: persistent configuration and target preview only.
# Automatic actuation is intentionally LOCKED until both sensors are calibrated,
# mechanical output is verified, and a supervised safety test is completed.
import json as _json
from pathlib import Path as _Path
from zoneinfo import ZoneInfo as _ZoneInfo
from datetime import datetime as _datetime
FEED_CONFIG_PATH = _Path(__file__).with_name("feeding_config.json")
# Fixed stage-based daily allowance (g/bird/day), configurable prototype estimates.
FEED_FIXED_DAILY_GRAMS = {"STARTER": 35.0, "GROWER": 90.0, "FINISHER": 135.0}
FEED_SESSIONS = {"STARTER": 6, "GROWER": 4, "FINISHER": 4}
FEED_RATES = {1: 101.39, 2: 103.00}  # grams/sec, preliminary all-five-gate measurements
DEFAULT_FEED_CONFIG = {"birdCount": None, "batchStartDate": None, "times": [], "timezone": "Asia/Manila", "automaticEnabled": False}

def _feed_plan(config, stage):
    from datetime import date
    from zoneinfo import ZoneInfo
    from datetime import datetime
    start = config.get("batchStartDate")
    try:
        age = (datetime.now(ZoneInfo("Asia/Manila")).date() - date.fromisoformat(start)).days + 1 if start else None
    except (TypeError, ValueError):
        age = None
    sessions = FEED_SESSIONS.get(stage)
    birds = config.get("birdCount")
    per_bird = FEED_FIXED_DAILY_GRAMS.get(stage)
    times = config.get("times") or ([f"{h:02d}:00" for h in (6,9,12,15,18,21)] if sessions == 6 else ["06:00","10:00","14:00","18:00"] if sessions == 4 else [])
    return {"batchAgeDays":age,"ageBracket":"Fixed stage allowance" if per_bird is not None else None,
            "feedPerBirdDailyGrams":per_bird,"feedPerBirdDailyRangeGrams":None,
            "feedPerBirdSessionGrams":round(per_bird/sessions,2) if per_bird and sessions else None,
            "dailyFlockGrams":round(birds*per_bird,1) if birds and per_bird else None,
            "targetGrams":round(birds*per_bird/sessions,1) if birds and per_bird and sessions else None,
            "sessionsPerDay":sessions,"times":times}

feed_config_lock = threading.Lock()

def _read_feed_config():
    try:
        result = _json.loads(FEED_CONFIG_PATH.read_text())
        return {**DEFAULT_FEED_CONFIG, **result, "automaticEnabled": False}
    except (OSError, ValueError, TypeError):
        return dict(DEFAULT_FEED_CONFIG)

def start_new_batch(start):
    """A changed batch start date: clear the daily attempt and the AI
    candidate; on days 1-10 set the Arduino to STARTER (owner decision 4)."""
    global schedule_attempt
    with schedule_lock:
        schedule_attempt = None
        stage_schedule.save_attempt(STAGE_SCHEDULE_PATH, None)
    reset_transition_candidate("new_batch")
    day = stage_schedule.batch_day(start, stage_schedule.local_date(stage_schedule.local_now()))
    result = {"batchStartDate": start, "batchDay": day, "starterApplied": False, "status": "no_stage_change"}
    if day is not None and day < stage_schedule.GROWER_FROM_DAY:
        with state_lock:
            current = str(state.get("stage") or "").strip().upper()
        if current == "STARTER":
            result["status"] = "already_starter"
        else:
            hardware = apply_confirmed_stage_to_arduino("STARTER")
            result["starterApplied"] = bool(hardware.get("success"))
            result["status"] = hardware.get("status")
    print(f"[AUDIT] new batch {start} (day {day}) by {request_user()}: {result['status']}", flush=True)
    return result


@app.route("/api/feeding/config", methods=["GET", "POST"])
def feeding_config_api():
    new_batch = None
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        try:
            from datetime import date
            count = int(body.get("birdCount"))
            start = body.get("batchStartDate")
            times = body.get("times", [])
            if not 1 <= count <= 100000 or not isinstance(times, list) or len(times) > 12:
                raise ValueError("Invalid count or times")
            if not isinstance(start, str) or date.fromisoformat(start) > _datetime.now(_ZoneInfo("Asia/Manila")).date():
                raise ValueError("A valid past or current batch start date is required")
            if any(not isinstance(t, str) or not __import__('re').fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", t) for t in times):
                raise ValueError("Times must be HH:MM")
            if len(set(times)) != len(times):
                raise ValueError("Duplicate schedule times")
            config = {"birdCount": count, "batchStartDate": start, "times": sorted(times),
                      "timezone": "Asia/Manila", "automaticEnabled": False}
            with feed_config_lock:
                previous_start = _read_feed_config().get("batchStartDate")
                FEED_CONFIG_PATH.write_text(_json.dumps(config, indent=2))
        except (ValueError, TypeError) as exc:
            return jsonify({"success": False, "error": str(exc)}), 400
        if start != previous_start:
            new_batch = start_new_batch(start)
    with feed_config_lock:
        config = _read_feed_config()
    with state_lock:
        stage = str(state.get("stage") or "").upper()
    plan = _feed_plan(config, stage)
    with inventory_lock:
        inventory = _inventory_snapshot(_inventory_read())
    compartment = inventory.get("selectedCompartment")
    target = plan.get("targetGrams")
    return jsonify({**config, **plan, "confirmedStage": stage,
                    **({"newBatch": new_batch} if new_batch else {}),
                    "selectedCompartment": compartment,
                    "estimatedSeconds": round(target / FEED_RATES[compartment], 3) if target and compartment in FEED_RATES else None,
                    "calibrationRatesGramsPerSecond": FEED_RATES,
                    "troughCalibration": {"zeroOffsetRaw": 377696, "countsPerGram": 83.97, "referenceMassGrams": 500, "twoPointMeasured": True, "commissioned": FEED_TROUGH_CALIBRATED, "verificationRequired": not FEED_TROUGH_CALIBRATED},
                    "dispensingRatesCommissioned": True,
                    "automaticEnabled": bool(config.get("automaticEnabled")) and FEED_AUTOMATION_COMMISSIONED,
                    "automationStatus": "COMMISSIONED" if FEED_AUTOMATION_COMMISSIONED else "LOCKED_PENDING_TIMED_FEED_VERIFICATION",
                    "serverTime": _datetime.now(_ZoneInfo("Asia/Manila")).isoformat()})

@app.route("/api/feeding/manual/preview", methods=["POST"])
def manual_feed_preview():
    body = request.get_json(silent=True) or {}
    try:
        compartment = int(body.get("compartment"))
        grams = float(body.get("targetGrams"))
        if compartment not in FEED_RATES or not __import__("math").isfinite(grams) or not 0 < grams <= 10000:
            raise ValueError("Invalid compartment or target")
    except (TypeError, ValueError) as exc:
        return jsonify(success=False,error=str(exc)),400
    with inventory_lock:
        inventory = _inventory_snapshot(_inventory_read())
    try:
        calculation = _feed_inputs(grams, compartment)
        ready, reason = True, None
    except RuntimeError as exc:
        calculation = {"leftoverGrams":None,"feedToAddGrams":None,"estimatedSeconds":None,
                       "rateGramsPerSecond":FEED_RATES[compartment]}
        ready, reason = False, str(exc)
    return jsonify(success=True, compartment=compartment, targetGrams=grams,
                   **calculation, stageCompatible=compartment in inventory["eligibleCompartments"],
                   dispensingEnabled=ready, status="READY" if ready else "BLOCKED",
                   error=reason, method="TIMED_FULL_TARGET_TROUGH_MONITOR_ONLY")


# ============================================================
# FEEDING EXECUTION: measured, bounded pulse sequence
# ============================================================
feed_job_lock = threading.RLock()
feed_job = {"status":"idle", "targetGrams":None, "measuredGrams":None,
            "compartment":None,"error":None,"source":None,"updatedAt":None}
feed_job_stop = threading.Event()
feed_job_thread = None
# Unattended schedules require deliberate commissioning, never enabled by an API call alone.
FEED_AUTOMATION_COMMISSIONED = os.environ.get("POULTRIX_FEED_AUTOMATION_COMMISSIONED") == "YES_VERIFIED"
FEED_PULSE_SECONDS_MAX = 1.0

# Time-controlled dispensing, with trough leftovers deducted from BOTH manual and
# scheduled requests. Physical weight is a pre-session input, not a stop signal.
# ESTIMATED is the existing Arduino telemetry label, not proof of calibration.
# Operator must explicitly commission calibrated load-cell data before actuation.
FEED_TROUGH_CALIBRATED = os.environ.get("POULTRIX_TROUGH_CALIBRATED") == "YES_VERIFIED"
FEED_RATES_CALIBRATED = os.environ.get("POULTRIX_FEED_RATES_CALIBRATED") == "YES_VERIFIED"
FEED_TOTAL_SECONDS_MAX = 10.0
FEED_ACK_TIMEOUT_SECONDS = 5.0

def _feed_inputs(target, compartment):
    """Full-target timed dispensing; trough sensor is informational only."""
    import math
    with state_lock:
        ready = controller_ready_locked()
        record = dict(state.get("troughWeight") or {})
    if not ready or bypass_active():
        raise RuntimeError("Online healthy hardware required; hardware busy, try again in a few minutes")
    rate = FEED_RATES.get(compartment)
    if not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0:
        raise RuntimeError("Invalid dispensing rate")
    duration = target / rate
    if duration > FEED_TOTAL_SECONDS_MAX:
        raise RuntimeError("Required gate duration exceeds per-job safety limit")
    leftover = record.get("weightGrams")
    if not isinstance(leftover, (int, float)) or not math.isfinite(leftover):
        leftover = None
    return {"leftoverGrams": round(leftover, 2) if leftover is not None else None,
            "feedToAddGrams": round(target, 2),
            "estimatedSeconds": round(duration, 3), "rateGramsPerSecond": rate}

def _feed_job_run(compartment, target, source, calculation):
    global feeding_last_error
    try:
        # Revalidate LIVE state and sensor input immediately before actuation.
        fresh = _feed_inputs(target, compartment)
        with feed_job_lock:
            feed_job.update(status="running", measuredGrams=0, error=None, updatedAt=utc_timestamp())
        remaining_ms = round(target / calculation["rateGramsPerSecond"] * 1000)
        if remaining_ms <= 0:
            with feed_job_lock:
                feed_job.update(status="completed", estimatedDispensedGrams=0, updatedAt=utc_timestamp())
            return
        elapsed_ms = 0
        while remaining_ms > 0:
            if feed_job_stop.is_set():
                raise RuntimeError("Stopped by operator")
            # Never continue a job if the controller goes offline or unhealthy.
            with state_lock:
                healthy = controller_ready_locked()
            if not healthy or bypass_active():
                raise RuntimeError("Controller not ready during dispensing")
            ms = min(10000, remaining_ms)
            with feeding_lock:
                if feeding_pending is not None or any(g.get("status") in ("DISPENSING", "STARTED") for g in feeding_gates.values()):
                    raise RuntimeError("Another gate operation is active")
                feeding_last_error = None
                feeding_gates[str(compartment)]["status"] = "AWAITING_ACK"
            if not send_command(f"FEED:DISPENSE:{compartment},{ms}"):
                raise RuntimeError("Arduino serial command failed")
            deadline = time.monotonic() + max(FEED_ACK_TIMEOUT_SECONDS, ms/1000 + 3)
            while time.monotonic() < deadline:
                if feed_job_stop.is_set():
                    raise RuntimeError("Stopped by operator")
                with feeding_lock:
                    gate = dict(feeding_gates[str(compartment)])
                    last_error = feeding_last_error
                if last_error:
                    raise RuntimeError("Arduino rejected feeding: " + str(last_error))
                if gate.get("status") == "COMPLETED":
                    break
                with state_lock:
                    if not arduino_online_locked() or state.get("piSeenByArduino") is False:
                        raise RuntimeError("Controller offline during gate operation")
                time.sleep(.05)
            else:
                raise RuntimeError("Gate completion was not confirmed")
            elapsed_ms += ms
            remaining_ms -= ms
            with feed_job_lock:
                feed_job.update(estimatedDispensedGrams=round(elapsed_ms / 1000 * calculation["rateGramsPerSecond"], 2),
                                updatedAt=utc_timestamp())
            time.sleep(.15)
        with feed_job_lock:
            feed_job.update(status="completed", updatedAt=utc_timestamp())
    except Exception as exc:
        with feed_job_lock:
            feed_job.update(status="stopped" if feed_job_stop.is_set() else "fault",
                            error=str(exc), updatedAt=utc_timestamp())
    finally:
        send_command("FEED:STOP")

def _start_feed_job(compartment, grams, source):
    global feed_job_thread
    import math
    if type(compartment) != int or compartment not in (1, 2):
        return {"success":False,"error":"Select compartment 1 or 2"},400
    if type(grams) not in (int,float) or not math.isfinite(grams) or not 1 <= grams <= 10000:
        return {"success":False,"error":"Target must be 1–10000 g"},400
    with feed_job_lock:
        if feed_job.get("status") in ("starting", "running"):
            return {"success":False,"error":"Feeding already running"},409
        try:
            calculation = _feed_inputs(grams, compartment)
        except RuntimeError as exc:
            return {"success":False,"error":str(exc)},423
        feed_job_stop.clear()
        feed_job.update(status="starting", targetGrams=grams, measuredGrams=None,
                        estimatedDispensedGrams=0, compartment=compartment, source=source,
                        **calculation, error=None, updatedAt=utc_timestamp())
        feed_job_thread = threading.Thread(target=_feed_job_run,
            args=(compartment, grams, source, calculation), daemon=True)
        feed_job_thread.start()
    return {"success":True,"status":"starting",**calculation},202

@app.route("/api/feeding/job",methods=["GET"])
def feed_job_status():
    with feed_job_lock: snapshot=dict(feed_job)
    return jsonify({**snapshot,"automationCommissioned":FEED_AUTOMATION_COMMISSIONED})

@app.route("/api/feeding/manual/start",methods=["POST"])
def feed_manual_start():
    body=request.get_json(silent=True) or {}
    try: compartment=int(body.get("compartment")); grams=float(body.get("targetGrams"))
    except (ValueError,TypeError): return jsonify(success=False,error="Invalid target or compartment"),400
    result,status=_start_feed_job(compartment,grams,"manual")
    return jsonify(result),status

@app.route("/api/feeding/job/stop",methods=["POST"])
def feed_job_stop_api():
    feed_job_stop.set()
    sent=send_command("FEED:STOP")
    return jsonify(success=sent,status="stop_requested"),202 if sent else 503

# Automatic scheduling is guarded by commissioning AND a saved explicit enable flag.
# Each local-date session is attempted once. Missed sessions are not replayed.
feed_schedule_attempted=set()
def feed_schedule_worker():
    from datetime import datetime
    from zoneinfo import ZoneInfo
    while True:
        time.sleep(5)
        if not FEED_AUTOMATION_COMMISSIONED: continue
        try:
            config=_read_feed_config()
            if not config.get("automaticEnabled"): continue
            now=datetime.now(ZoneInfo("Asia/Manila"))
            slot=now.strftime("%H:%M")
            day=now.date().isoformat()
            with state_lock: stage=str(state.get("stage") or "").upper()
            plan=_feed_plan(config,stage)
            if slot not in plan["times"] or not plan.get("targetGrams"): continue
            key=(day,slot)
            if key in feed_schedule_attempted: continue
            feed_schedule_attempted.add(key)
            with inventory_lock: compartment=_inventory_snapshot(_inventory_read()).get("selectedCompartment")
            if compartment is not None:
                _start_feed_job(compartment,float(plan["targetGrams"]),"automatic")
            if len(feed_schedule_attempted)>100:
                feed_schedule_attempted.intersection_update({x for x in feed_schedule_attempted if x[0]==day})
        except Exception as exc:
            print("[FEED SCHEDULE]",exc,flush=True)
threading.Thread(target=feed_schedule_worker,daemon=True).start()

# ============================================================
# PERSISTENT READ-ONLY TELEMETRY HISTORY (SQLite)
# ============================================================
import sqlite3 as _history_sqlite3
import json as _history_json
import math as _history_math
from pathlib import Path as _HistoryPath

HISTORY_DB_PATH = _HistoryPath(os.environ.get(
    "POULTRIX_HISTORY_DB", "/home/raspberry/poultrix-api/poultrix_history.sqlite3"))
_history_last_ai = None
_history_last_environment = 0.0

def _history_connection():
    HISTORY_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = _history_sqlite3.connect(str(HISTORY_DB_PATH), timeout=5)
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS environment_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL,
        temperature_c REAL, humidity_pct REAL, light_raw INTEGER, lux REAL,
        mode TEXT, sensor_source TEXT, dht22_status TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS feed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL,
        gate INTEGER, event_type TEXT NOT NULL, duration_ms INTEGER,
        estimated_dispensed_grams REAL, stage TEXT, message TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS ai_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL,
        detected_stage TEXT, confidence_pct REAL, status TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS system_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL,
        event_type TEXT NOT NULL, detail TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS alert_acknowledgements (
        alert_id TEXT PRIMARY KEY, acknowledged_at TEXT NOT NULL,
        acknowledged_by TEXT NOT NULL)""")
    conn.commit()
    return conn

def _history_insert(table, fields, values):
    try:
        with _history_connection() as conn:
            cols = ",".join(fields)
            params = ",".join("?" for _ in fields)
            conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({params})", values)
    except Exception as exc:
        print(f"[HISTORY] Save failed ({table}): {exc}", flush=True)

def _history_finite(value):
    try:
        v = float(value)
        return v if _history_math.isfinite(v) else None
    except (ValueError, TypeError):
        return None

def history_worker():
    global _history_last_ai
    try:
        with _history_connection():
            pass
    except Exception as exc:
        print(f"[HISTORY] Database initialization failed: {exc}", flush=True)
    while True:
        time.sleep(15)
        with state_lock:
            snapshot = dict(state)
        source = str(snapshot.get("sensorSource") or "").upper()
        dht_ok = str(snapshot.get("dht22Status") or "").upper() == "OK"
        # Do not persist TEST, disconnected, or failed sensor readings as real measurements.
        if (snapshot.get("connected") and source == "DHT22+LDR" and dht_ok
                and time.monotonic() - _history_last_environment < 10):
            _history_insert("environment_readings",
                ["recorded_at","temperature_c","humidity_pct","light_raw","lux","mode","sensor_source","dht22_status"],
                [utc_timestamp(), _history_finite(snapshot.get("temperature")),
                 _history_finite(snapshot.get("humidity")), snapshot.get("lightRaw"),
                 _history_finite(snapshot.get("lux")), snapshot.get("mode"), source, "OK"])
        with ai_state_lock:
            ai = dict(ai_state)
        inference = ai.get("lastInference")
        if inference and inference != _history_last_ai:
            _history_last_ai = inference
            _history_insert("ai_checks",
                ["recorded_at","detected_stage","confidence_pct","status"],
                [inference, ai.get("detectedStage"), _history_finite(ai.get("confidence")), ai.get("status")])

_original_process_message = process_message
def process_message(message):
    global _history_last_environment
    _original_process_message(message)
    if message.startswith("SENSOR_SOURCE:DHT22+LDR"):
        _history_last_environment = time.monotonic()
    if message.startswith("FEED_GATE:"):
        try:
            gate, event, duration = message.split(":",1)[1].split(",")
            if event not in ("STARTED","COMPLETED","STOPPED"):
                return
            ms = int(duration)
            with state_lock:
                stage = state.get("stage")
            estimated = (round(ms / 1000 * feeding_rates[int(gate)], 1) if feeding_rates.get(int(gate)) is not None else None) if event == "COMPLETED" else None
            _history_insert("feed_events",
                ["recorded_at","gate","event_type","duration_ms","estimated_dispensed_grams","stage","message"],
                [utc_timestamp(),int(gate),event,ms,estimated,stage,None])
        except (ValueError, IndexError, KeyError):
            pass
    elif message.startswith("FEED_ERROR:"):
        _history_insert("feed_events",
            ["recorded_at","gate","event_type","duration_ms","estimated_dispensed_grams","stage","message"],
            [utc_timestamp(),None,"ERROR",None,None,None,message])
    elif message.startswith(("BOOT:","PI:","WATCHDOG:","SYSTEM_ERROR:")):
        _history_insert("system_events",["recorded_at","event_type","detail"],
                        [utc_timestamp(),message.split(":",1)[0],message.split(":",1)[1]])

def _history_query(table, days, limit):
    cutoff = datetime.fromtimestamp(time.time() - days * 86400, timezone.utc).isoformat()
    with _history_connection() as conn:
        conn.row_factory = _history_sqlite3.Row
        rows = conn.execute(f"SELECT * FROM {table} WHERE recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?",
                            (cutoff, limit)).fetchall()
    return [dict(row) for row in rows]

@app.route("/api/history", methods=["GET"])
def api_history():
    try:
        days = max(1,min(30,int(request.args.get("days",1))))
        return jsonify({
            "environment":_history_query("environment_readings",days,1500),
            "feeding":_history_query("feed_events",days,500),
            "ai":_history_query("ai_checks",days,200),
            "system":_history_query("system_events",days,500),
            "source":"raspberry_pi_sqlite",
            "days":days
        })
    except (ValueError, _history_sqlite3.Error) as exc:
        return jsonify(error=str(exc)), 500

# ============================================================
# SHARED ALERT ACKNOWLEDGEMENTS (private VPC endpoint)
# These endpoints are not intended to be exposed publicly. The Worker
# authenticates the Supabase user before forwarding requests.
# ============================================================
import re as _alert_re

_ALERT_ID_RE = _alert_re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")

def _alert_rows():
    with _history_connection() as conn:
        conn.row_factory = _history_sqlite3.Row
        return [dict(row) for row in conn.execute(
            "SELECT alert_id, acknowledged_at, acknowledged_by FROM alert_acknowledgements ORDER BY acknowledged_at DESC LIMIT 500"
        ).fetchall()]

@app.route("/api/alerts/acknowledgements", methods=["GET", "POST", "DELETE"])
def api_alert_acknowledgements():
    try:
        if request.method == "GET":
            return jsonify({"acknowledgements": _alert_rows()})
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="JSON object required"), 400
        alert_id = payload.get("id")
        if not isinstance(alert_id, str) or not _ALERT_ID_RE.fullmatch(alert_id):
            return jsonify(error="Invalid alert ID"), 400
        user_id = request.headers.get("X-Poultrix-User", "")
        if not user_id or len(user_id) > 128:
            return jsonify(error="Authenticated user required"), 403
        with _history_connection() as conn:
            if request.method == "POST":
                conn.execute("""INSERT INTO alert_acknowledgements
                    (alert_id, acknowledged_at, acknowledged_by) VALUES (?, ?, ?)
                    ON CONFLICT(alert_id) DO UPDATE SET
                    acknowledged_at=excluded.acknowledged_at,
                    acknowledged_by=excluded.acknowledged_by""",
                    (alert_id, utc_timestamp(), user_id))
            else:
                conn.execute("DELETE FROM alert_acknowledgements WHERE alert_id=?", (alert_id,))
        return jsonify({"success": True, "acknowledgements": _alert_rows()})
    except _history_sqlite3.Error as exc:
        app.logger.exception("Alert acknowledgement database error")
        return jsonify(error="Acknowledgement storage unavailable"), 503


# ============================================================
# TWO COMPARTMENT FEED INVENTORY (sensor total + ledger estimates)
# ============================================================
import json as _inventory_json
import math as _inventory_math
import tempfile as _inventory_tempfile
from pathlib import Path as _InventoryPath
INVENTORY_PATH = _InventoryPath(os.environ.get("POULTRIX_FEED_INVENTORY", str(_InventoryPath(__file__).with_name("feed_inventory.json"))))
inventory_lock = threading.RLock()
DEFAULT_INVENTORY = {
    "feeds": [
        {"id": "booster", "name": "Booster", "stages": ["STARTER"]},
        {"id": "integra2", "name": "Integra 2", "stages": ["GROWER", "FINISHER"]}
    ],
    "compartments": [
        {"id": 1, "feedId": "booster", "estimatedGrams": None, "lowThresholdGrams": 1000},
        {"id": 2, "feedId": "integra2", "estimatedGrams": None, "lowThresholdGrams": 1000}
    ],
    "refills": []
}

def _inventory_read():
    try:
        saved = _inventory_json.loads(INVENTORY_PATH.read_text())
        if isinstance(saved, dict) and isinstance(saved.get("feeds"), list) and len(saved.get("compartments", [])) == 2:
            return saved
    except (OSError, ValueError, TypeError):
        pass
    return _inventory_json.loads(_inventory_json.dumps(DEFAULT_INVENTORY))

def _inventory_write(data):
    INVENTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = _inventory_tempfile.mkstemp(dir=str(INVENTORY_PATH.parent), prefix=".feed-")
    try:
        with os.fdopen(fd, "w") as f:
            _inventory_json.dump(data, f, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(temp, INVENTORY_PATH)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def _inventory_snapshot(data):
    with state_lock:
        weight = dict(state.get("hopperWeight") or {})
        stage = str(state.get("stage") or "").upper()
        connected = state.get("connected") is True
    measured = weight.get("weightGrams") if connected and weight.get("status") == "OK" else None
    if not isinstance(measured, (int, float)) or not _inventory_math.isfinite(measured): measured = None
    else: measured = max(0, measured)
    entries = []
    for compartment in data["compartments"]:
        item = dict(compartment)
        feed = next((f for f in data["feeds"] if f["id"] == item["feedId"]), None)
        item["feed"] = feed
        item["stageCompatible"] = bool(feed and stage in feed["stages"])
        amount = item.get("estimatedGrams")
        item["lowFeed"] = amount is not None and amount <= item.get("lowThresholdGrams",1000)
        entries.append(item)
    estimates = [c.get("estimatedGrams") for c in entries]
    estimated_total = sum(estimates) if all(x is not None for x in estimates) else None
    eligible = [c["id"] for c in entries if c["stageCompatible"] and (c["estimatedGrams"] is None or c["estimatedGrams"] > c["lowThresholdGrams"])]
    # Prefer higher estimated stock when both are eligible; never issue a servo command here.
    eligible.sort(key=lambda cid: (entries[cid-1]["estimatedGrams"] is not None, entries[cid-1]["estimatedGrams"] or 0), reverse=True)
    return {"feeds": data["feeds"], "compartments": entries, "refills": data["refills"][-30:][::-1],
            "confirmedStage": stage, "eligibleCompartments": eligible, "selectedCompartment": eligible[0] if eligible else None,
            "combinedActualGrams": measured, "combinedWeightStatus": weight.get("status"),
            "combinedEstimatedGrams": estimated_total,
            "discrepancyGrams": round(measured-estimated_total,1) if measured is not None and estimated_total is not None else None,
            "automaticFeedingEnabled": False,
            "alerts": ([{"type":"NO_COMPATIBLE_FEED", "message":"No suitable feed compartment for the current stage"}] if not eligible else []) +
                      [{"type":"LOW_FEED", "compartment": c["id"], "message":"Estimated compartment inventory is low"} for c in entries if c["lowFeed"]] +
                      ([{"type":"INVENTORY_DISCREPANCY", "message":"Combined sensor weight differs from estimated inventory"}] if measured is not None and estimated_total is not None and abs(measured-estimated_total)>500 else [])}

@app.route("/api/feeding/inventory", methods=["GET"])
def inventory_get():
    with inventory_lock: return jsonify(_inventory_snapshot(_inventory_read()))

@app.route("/api/feeding/inventory/feed", methods=["POST"])
def inventory_create_feed():
    body=request.get_json(silent=True) or {}
    name=body.get("name")
    stages=body.get("stages")
    if not isinstance(name,str) or not (1<=len(name.strip())<=60) or not isinstance(stages,list) or not stages or len(stages)>3 or any(s not in ("STARTER","GROWER","FINISHER") for s in stages):
        return jsonify(error="Feed name and confirmed compatible stages required"),400
    with inventory_lock:
        data=_inventory_read()
        if any(f["name"].lower()==name.strip().lower() for f in data["feeds"]): return jsonify(error="Feed already exists"),409
        feed={"id": "custom-"+secrets.token_hex(6), "name":name.strip(), "stages":sorted(set(stages))}
        data["feeds"].append(feed);_inventory_write(data)
        return jsonify(feed),201

@app.route("/api/feeding/inventory/assign", methods=["POST"])
def inventory_assign():
    body=request.get_json(silent=True) or {}
    cid=body.get("compartment");fid=body.get("feedId")
    if type(cid)!=int or cid not in (1,2) or not isinstance(fid,str): return jsonify(error="Invalid compartment or feed"),400
    with inventory_lock:
        data=_inventory_read()
        if not any(f["id"]==fid for f in data["feeds"]):return jsonify(error="Unknown feed"),400
        comp=data["compartments"][cid-1]
        if comp["feedId"]!=fid and comp.get("estimatedGrams") not in (None,0):
            return jsonify(error="Clear or consume existing inventory before changing feed type"),409
        comp["feedId"]=fid;_inventory_write(data)
        return jsonify(_inventory_snapshot(data))

@app.route("/api/feeding/inventory/refill", methods=["POST"])
def inventory_refill():
    body=request.get_json(silent=True) or {}
    cid=body.get("compartment");kg=body.get("kilograms")
    if type(cid)!=int or cid not in (1,2) or type(kg) not in (int,float) or not _inventory_math.isfinite(kg) or not 0<kg<=100:
        return jsonify(error="Specify compartment 1/2 and a refill of 0-100 kg"),400
    with inventory_lock:
        data=_inventory_read();comp=data["compartments"][cid-1]
        if comp["estimatedGrams"] is None:
            return jsonify(error="Inventory not initialized. Set a verified starting quantity first."),409
        comp["estimatedGrams"] = round(comp["estimatedGrams"] + kg*1000,1)
        data["refills"].append({"compartment":cid,"kilograms":kg,"feedId":comp["feedId"],"timestamp":utc_timestamp()})
        data["refills"]=data["refills"][-100:];_inventory_write(data)
        return jsonify(_inventory_snapshot(data))

@app.route("/api/feeding/inventory/initialize", methods=["POST"])
def inventory_initialize():
    body=request.get_json(silent=True) or {};amounts=body.get("kilograms")
    if not isinstance(amounts,list) or len(amounts)!=2 or any(type(v) not in (int,float) or not _inventory_math.isfinite(v) or not 0<=v<=100 for v in amounts):
        return jsonify(error="Provide verified starting kilograms for both compartments"),400
    with inventory_lock:
        data=_inventory_read()
        for i,kg in enumerate(amounts):data["compartments"][i]["estimatedGrams"]=round(kg*1000,1)
        _inventory_write(data)
        return jsonify(_inventory_snapshot(data))

# ============================================================
# SYSTEM POWER (SPEC-system-power.md): owner-only safe reboot / power-off
# ============================================================
# Fixed commands only (no shell, nothing built from request data). The Pi 5
# RTC wake alarm powers the board back on after a timed power-off. The
# Arduino is USB-powered by the Pi, so climate control may stop while off.
import subprocess as _subprocess

SYSTEM_POWER_WAKE_MINUTES = (5, 15, 30)
SYSTEM_POWER_DELAY_SECONDS = 2.0
RTC_WAKEALARM = "/sys/class/rtc/rtc0/wakealarm"
system_power_lock = threading.Lock()
system_power_pending = None


def _owner_emails():
    return {e.strip().lower() for e in os.environ.get("POULTRIX_OWNER_EMAILS", "").split(",") if e.strip()}


def _sudo(args, input_text=None):
    return _subprocess.run(["sudo", "-n", *args], input=input_text, text=True,
                           capture_output=True, timeout=15)


def _write_wakealarm(value):
    result = _sudo(["tee", RTC_WAKEALARM], value + "\n")
    if result.returncode != 0:
        raise RuntimeError(f"wakealarm write failed: {result.stderr.strip()[:200]}")


def set_wake_alarm(seconds):
    """Clear, set +seconds, then read back. Returns the wake epoch or raises."""
    _write_wakealarm("0")
    _write_wakealarm(f"+{int(seconds)}")
    expected = time.time() + seconds
    stored = int((Path(RTC_WAKEALARM).read_text().strip() or "0"))
    if abs(stored - expected) > 10:
        raise RuntimeError(f"wakealarm read back {stored}, expected about {int(expected)}")
    return stored


def clear_wake_alarm():
    _write_wakealarm("0")


def _feeding_busy():
    with feeding_lock:
        if feeding_pending is not None or any(g.get("status") in ("DISPENSING", "STARTED") for g in feeding_gates.values()):
            return True
    with feed_job_lock:
        return feed_job.get("status") in ("starting", "running")


def _prepare_for_power_action():
    """Stop feeding and end any maintenance session before going down."""
    feed_job_stop.set()
    cancel_schedule_test()
    send_command("FEED:STOP")
    with bypass_lock:
        maintenance = bool(bypass_token)
    if maintenance:
        bypass_shutdown()


def _run_power_command(args):
    global system_power_pending
    time.sleep(SYSTEM_POWER_DELAY_SECONDS)
    print(f"[SYSTEM] running: sudo -n {' '.join(args)}", flush=True)
    try:
        result = _sudo(args)
        failed = result.returncode != 0
        detail = result.stderr.strip()[:200]
    except Exception as error:  # timeout or missing sudo
        failed, detail = True, str(error)
    if failed:
        print(f"[SYSTEM] {' '.join(args)} failed: {detail}", flush=True)
        with system_power_lock:
            system_power_pending = None


def _system_power(action):
    global system_power_pending
    user = request_user()
    if user.lower() not in _owner_emails():
        return jsonify(error="Only the farm owner can do this", code="OWNER_ONLY"), 403
    body = request.get_json(silent=True) or {}
    if body.get("confirm") != ("REBOOT" if action == "reboot" else "POWEROFF"):
        return jsonify(error="Confirmation required"), 400
    minutes, stay_off = None, False
    if action == "power-off":
        stay_off = body.get("stayOff") is True
        minutes = body.get("minutes")
        if stay_off and minutes is not None:
            return jsonify(error="Stay off takes no wake time"), 400
        if not stay_off and (type(minutes) is not int or minutes not in SYSTEM_POWER_WAKE_MINUTES):
            return jsonify(error="Wake time must be 5, 15 or 30 minutes"), 400
    if _feeding_busy():
        return jsonify(error="Feed is being dispensed; try again when it finishes"), 409
    with system_power_lock:
        if system_power_pending:
            return jsonify(error="A restart or power-off is already in progress"), 409
        system_power_pending = action
    wake_at = None
    try:
        if action == "power-off":
            if stay_off:
                clear_wake_alarm()
            else:
                wake_at = set_wake_alarm(minutes * 60)
    except Exception as error:
        with system_power_lock:
            system_power_pending = None
        print(f"[SYSTEM] wake alarm failed, not powering off: {error}", flush=True)
        return jsonify(error="The wake timer could not be set, so the Pi was not powered off"), 500
    _prepare_for_power_action()
    wake_iso = datetime.fromtimestamp(wake_at, timezone.utc).isoformat() if wake_at else None
    what = "reboot" if action == "reboot" else ("power-off, stay off" if stay_off else f"power-off {minutes} min (wake {wake_iso})")
    print(f"[AUDIT] system {what} by {user}", flush=True)
    args = ["systemctl", "reboot"] if action == "reboot" else ["systemctl", "poweroff"]
    threading.Thread(target=_run_power_command, args=(args,), daemon=True).start()
    return jsonify(success=True, action=action, minutes=minutes, stayOff=stay_off, wakeAt=wake_iso), 202


@app.route("/api/system/reboot", methods=["POST"])
def system_reboot():
    return _system_power("reboot")


@app.route("/api/system/power-off", methods=["POST"])
def system_power_off():
    return _system_power("power-off")


if __name__ == "__main__":

    print("")
    print(
        "===================================="
    )
    print(
        "          POULTRIX API"
    )
    print(
        "===================================="
    )

    # Camera must start before AI.
    initialize_camera()

    # Load trained YOLO classifier.
    initialize_ai()

    # Arduino background connection.
    serial_thread = threading.Thread(
        target=serial_worker,
        daemon=True
    )

    serial_thread.start()

    heartbeat_thread = threading.Thread(
        target=arduino_heartbeat_worker,
        daemon=True
    )
    heartbeat_thread.start()

    health_thread = threading.Thread(
        target=system_health_worker,
        daemon=True
    )
    health_thread.start()
    threading.Thread(target=bypass_watchdog, daemon=True).start()
    threading.Thread(target=simulation_reading_worker, daemon=True).start()


    threading.Thread(target=history_worker, daemon=True).start()

    # AI periodic classification.
    ai_thread = threading.Thread(
        target=ai_worker,
        daemon=True
    )

    ai_thread.start()

    print(
        "[AI] Automatic 30-second analysis cycle: "
        "every 5 minutes"
    )

    print(
        "[AI] Monitoring-only mode: "
        "Arduino stage will NOT be "
        "changed automatically"
    )

    print(
        "[API] Starting Flask server "
        "on port 5000"
    )

    # Localhost only: cloudflared (VPC service -> 127.0.0.1:5000) and the
    # telemetry uploader connect locally. Nothing on the LAN can reach the
    # unauthenticated control API directly.
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False,
        threaded=True,
        use_reloader=False
    )
