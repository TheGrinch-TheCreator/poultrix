
#!/usr/bin/env python3
import json
import os
import time
import urllib.request

SOURCE = "http://127.0.0.1:5000/api/status"
TARGET = "https://telemetry-worker.johnkarlduenas.workers.dev/ingest"
TOKEN = os.environ["POULTRIX_INGEST_TOKEN"]

while True:
    try:
        with urllib.request.urlopen(SOURCE, timeout=5) as response:
            data = json.load(response)

        request = urllib.request.Request(
            TARGET,
            data=json.dumps(data).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": "PoultrixTelemetry/1.0",
                "Authorization": "Bearer " + TOKEN,
            },
        )

        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")

        print("Telemetry delivered", flush=True)

    except Exception as exc:
        print(f"Telemetry upload failed: {exc}", flush=True)

    time.sleep(3)
