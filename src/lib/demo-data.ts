// Demo data modelled on the POULTRIX documentation. Replace with live
// Raspberry Pi feed (REST + WebSocket) once the backend exists.

export type Stage = "Starter" | "Grower" | "Finisher";
export type Health = "ok" | "warn" | "error";

export const STAGES: {
  name: Stage;
  days: [number, number];
  feed: string;
  feedRange: string;
  temp: [number, number];
  tempNote: string;
  light: string;
  lightHours: [number, number];
  lux: [number, number];
  sessions: string[];
  perSession: string;
  lowStockG: number;
}[] = [
  // Philippine tropical climate standards (v3)
  { name: "Starter", days: [1, 10], feed: "Starter Crumble", feedRange: "130–350 g/day for 10 birds, ramping up", temp: [32, 34], tempNote: "32–34°C first week (brooder on), then 28–30°C", light: "23 h (first 3 days), then 18–20 h", lightHours: [18, 23], lux: [20, 40], sessions: ["05:00", "08:00", "11:00", "14:00", "17:00", "20:00"], perSession: "~22–58 g", lowStockG: 200 },
  { name: "Grower", days: [11, 21], feed: "Grower Pellet", feedRange: "500–1,000 g/day for 10 birds", temp: [26, 28], tempNote: "26–28°C", light: "16–18 h/day", lightHours: [16, 18], lux: [10, 20], sessions: ["05:00", "11:00", "17:00", "21:00"], perSession: "~125–250 g", lowStockG: 500 },
  { name: "Finisher", days: [22, 35], feed: "Finisher Pellet", feedRange: "1,200–1,600 g/day for 10 birds", temp: [24, 26], tempNote: "24–26°C", light: "18–20 h, then 20–23 h", lightHours: [18, 23], lux: [5, 10], sessions: ["05:00", "11:00", "17:00", "21:00"], perSession: "~300–400 g", lowStockG: 1000 },
];

export const FEED_TYPES = ["Starter Crumble", "Grower Pellet", "Finisher Pellet"] as const;
export type FeedType = (typeof FEED_TYPES)[number];

export const CYCLE_DAYS = 35;

export const farm = {
  name: "Laylay Broiler House",
  location: "Laylay, Marinduque",
  batch: "Batch 2026-03",
  birds: 10,
  day: 16,
  stage: "Grower" as Stage,
  confidence: 0.91,
  lastClassified: "2 min ago",
  connection: "live" as "live" | "lastKnown" | "offline",
  lastUpdate: "a few seconds ago",
};

export const env = {
  temp: 28.4,
  humidity: 68,
  lightLux: 16,
  lightHoursOn: 11.5,
  lightLabel: "Normal",
  fans: { on: 2, total: 4 },
  heatLamps: { on: 0, total: 2 },
  leds: { on: 2, total: 2 },
};

export const feed = {
  type: "Grower Pellet",
  activeCompartment: 2,
  targetPerFeeding: 225, // g per session
  dispensed: 219,
  leftover: { detected: true, from: 225, to: 190 },
  maeG: 6.4,
  sessionsCount: 58,
  accuracy: 97.1,
  trough: 186,
  lastFeeding: "Today, 05:00",
  nextFeeding: "Today, 11:00",
  status: "Idle — waiting for next feeding" as string,
  compartments: [
    { id: 1, contents: "Starter Crumble", kg: 2.1, capacity: 5, note: "Switch to Finisher Pellet when AI detects Finisher" },
    { id: 2, contents: "Grower Pellet", kg: 4.8, capacity: 5, note: "Active this stage" },
  ],
};

export const hardware: { group: string; items: { name: string; plain: string; status: Health; detail: string; last: string }[] }[] = [
  {
    group: "Computing",
    items: [
      { name: "Raspberry Pi 5", plain: "Main brain", status: "ok", detail: "AI running · 52°C", last: "2s ago" },
      { name: "Arduino Mega 2560", plain: "Device controller", status: "ok", detail: "Serial link OK", last: "1s ago" },
    ],
  },
  {
    group: "Sensors",
    items: [
      { name: "DHT22", plain: "Temperature & humidity", status: "ok", detail: "28.4°C · 68%", last: "3s ago" },
      { name: "GL5528 LDR", plain: "Light sensor", status: "ok", detail: "312 lux", last: "3s ago" },
      { name: "Load cells", plain: "Feed weight", status: "ok", detail: "3 of 3 reading", last: "3s ago" },
      { name: "HX711", plain: "Weight amplifier", status: "ok", detail: "Calibrated", last: "3s ago" },
    ],
  },
  {
    group: "Feeding",
    items: [
      { name: "PCA9685", plain: "Gate driver", status: "ok", detail: "16-ch board ready", last: "5s ago" },
      { name: "10× MG996R servos", plain: "Feed gates", status: "ok", detail: "All gates closed", last: "5s ago" },
      { name: "Feed compartments", plain: "Feed storage", status: "warn", detail: "Comp. 1 at 42%", last: "5s ago" },
    ],
  },
  {
    group: "Environmental control",
    items: [
      { name: "8-channel relay", plain: "Power switches", status: "ok", detail: "2 of 8 on", last: "2s ago" },
      { name: "4 exhaust fans", plain: "Cooling", status: "ok", detail: "All OFF", last: "2s ago" },
      { name: "2 heat lamps", plain: "Warming", status: "ok", detail: "All OFF", last: "2s ago" },
      { name: "2 LED lights", plain: "Lighting", status: "ok", detail: "Both ON", last: "2s ago" },
    ],
  },
  {
    group: "Monitoring",
    items: [
      { name: "Camera", plain: "Flock camera", status: "ok", detail: "Streaming", last: "1s ago" },
      { name: "20×4 LCD", plain: "On-site screen", status: "ok", detail: "Displaying", last: "4s ago" },
      { name: "Wi-Fi / cloud", plain: "Internet link", status: "warn", detail: "Signal fair (-71 dBm)", last: "2s ago" },
    ],
  },
];

export type Alert = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  cause: string;
  action: string;
  time: string;
  status: "Active" | "Resolved" | "Upcoming";
};

export const alerts: Alert[] = [
  {
    id: "a1",
    severity: "warning",
    title: "Feed Compartment 1 running low",
    description: "Starter Crumble supply is at 2.1 kg (42%).",
    cause: "Normal consumption over 16 days.",
    action: "No refill needed — this compartment switches to Finisher Pellet when the AI detects Finisher.",
    time: "Today, 08:14",
    status: "Active",
  },
  {
    id: "a2",
    severity: "warning",
    title: "Wi-Fi signal is fair",
    description: "Updates may be delayed by a few seconds.",
    cause: "Hotspot signal at -71 dBm.",
    action: "Move the hotspot closer to the poultry house if delays continue.",
    time: "Today, 07:52",
    status: "Active",
  },
  {
    id: "a3",
    severity: "info",
    title: "Next: change Compartment 1 feed at Finisher",
    description: "Waiting for the AI to detect the Finisher stage.",
    cause: "Manual step once the flock reaches Finisher.",
    action: "Empty Compartment 1 and refill it with Finisher Pellet when the AI detects Finisher.",
    time: "Upcoming",
    status: "Upcoming",
  },
  {
    id: "a4",
    severity: "critical",
    title: "Temperature was above target",
    description: "Reached 31.2°C (target 26–30°C). Fans turned on automatically.",
    cause: "Afternoon heat.",
    action: "None — returned to normal at 14:37.",
    time: "Yesterday, 14:05",
    status: "Resolved",
  },
  {
    id: "a5",
    severity: "critical",
    title: "Arduino communication lost",
    description: "No data from the device controller for 40 seconds.",
    cause: "USB cable briefly disconnected.",
    action: "None — reconnected automatically.",
    time: "2 days ago, 10:21",
    status: "Resolved",
  },
];

// Deterministic 24-hour series (no randomness at module scope)
export const envHistory = Array.from({ length: 24 }, (_, h) => {
  const t = 28 + 1.8 * Math.sin(((h - 9) / 24) * Math.PI * 2) + 0.3 * Math.sin(h * 1.7);
  const hum = 68 - 6 * Math.sin(((h - 9) / 24) * Math.PI * 2) + Math.cos(h) * 1.2;
  const lux = h >= 4 && h < 23 ? 280 + 40 * Math.sin(h * 0.6) : 12;
  return {
    time: `${String(h).padStart(2, "0")}:00`,
    temp: Math.round(t * 10) / 10,
    humidity: Math.round(hum),
    light: Math.round(lux),
  };
});

export const feedHistory = Array.from({ length: 16 }, (_, i) => {
  const day = i + 1;
  const perBird = day <= 10 ? 15 + day * 0.5 : 60 + (day - 11) * 3;
  const target = Math.round(perBird * 10);
  const actual = Math.round(target * (0.95 + 0.04 * Math.abs(Math.sin(day * 2.3))));
  return { day: `D${day}`, target, actual };
});

export const feedingEvents = [
  { time: "Today, 05:00", stage: "Grower" as Stage, comps: "1 + 2", target: 190, actual: 196, leftover: "Yes — reduced from 225g" },
  { time: "Yesterday, 21:00", stage: "Grower" as Stage, comps: "1 + 2", target: 225, actual: 219, leftover: "No" },
  { time: "Yesterday, 17:00", stage: "Grower" as Stage, comps: "1 + 2", target: 225, actual: 231, leftover: "No" },
  { time: "Yesterday, 11:00", stage: "Grower" as Stage, comps: "1 + 2", target: 225, actual: 218, leftover: "No" },
  { time: "Yesterday, 05:00", stage: "Grower" as Stage, comps: "1 + 2", target: 200, actual: 186, leftover: "Yes — reduced from 225g" },
];

export type ClassResult = "Counted" | "Skipped — low confidence" | "Paused — dark period";
export const classifications: { time: string; stage: Stage | null; confidence: number | null; result: ClassResult; counter: number }[] = [
  { time: "10:35", stage: "Finisher", confidence: 0.71, result: "Counted", counter: 1 },
  { time: "10:30", stage: "Grower", confidence: 0.88, result: "Counted", counter: 0 },
  { time: "10:25", stage: "Finisher", confidence: 0.54, result: "Skipped — low confidence", counter: 0 },
  { time: "10:20", stage: "Grower", confidence: 0.91, result: "Counted", counter: 0 },
  { time: "10:15", stage: "Grower", confidence: 0.89, result: "Counted", counter: 0 },
  { time: "03:00", stage: null, confidence: null, result: "Paused — dark period", counter: 0 },
];

export const stageTransitions = [
  { when: "Batch start", stage: "Starter" as Stage, note: "Batch started — 10 chicks" },
  { when: "AI detected", stage: "Grower" as Stage, note: "AI detected Grower · feed switched to Compartment 2" },
];

export function stageInfo(s: Stage) {
  return STAGES.find((x) => x.name === s)!;
}

export function envStatus(temp: number, stage: Stage) {
  const [lo, hi] = stageInfo(stage).temp;
  if (temp > hi) return { label: "Too hot", tone: "danger" as const, msg: `${(temp - hi).toFixed(1)}°C above target — Fans ON`  };
  if (temp < lo) return { label: "Too cold", tone: "info" as const, msg: stage === "Starter" ? `${(lo - temp).toFixed(1)}°C below target — Heat lamps ON` : `${(lo - temp).toFixed(1)}°C below target — heat lamps stay on standby (Starter only)` };
  return { label: "Normal", tone: "ok" as const, msg: "Within target — no cooling needed" };
}
