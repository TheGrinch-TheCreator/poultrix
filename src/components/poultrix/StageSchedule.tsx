// Day-gated stage schedule display (SPEC-stage-schedule.md). Every value
// comes from the Pi's `schedule` object (snapshot → useAI); the day gates
// are never recomputed here.
import { StageBadge } from "@/components/poultrix/ui";
import { stageName, type StageSchedule } from "@/lib/live-hardware";
import type { Stage } from "@/lib/demo-data";

const PHASE_TEXT: Record<StageSchedule["phase"], string> = {
  no_batch_date: "No batch start date",
  stage_unknown: "Waiting for the Arduino stage",
  starter: "Starter period",
  grower_check: "Daily Grower check",
  grower: "Grower period",
  finisher_check: "Daily Finisher check",
  complete: "Finisher confirmed",
};

const RESULT_TEXT: Record<string, string> = {
  running: "in progress",
  confirmed: "confirmed",
  not_confirmed: "not confirmed",
};

function formatCheckTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? "—"
    : when.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function lastAttemptText(schedule: StageSchedule): string | null {
  const attempt = schedule.lastAttempt;
  if (!attempt) return null;
  const detected = stageName(attempt.detectedStage);
  const seen = detected
    ? `${detected}${typeof attempt.confidence === "number" ? ` ${attempt.confidence.toFixed(1)}%` : ""}`
    : "no clear result";
  return `${attempt.date}: ${RESULT_TEXT[attempt.result] ?? attempt.result} after ${attempt.cycles} of ${schedule.maxCyclesPerDay} checks (last seen: ${seen})`;
}

/** Day N, phase, next check and overdue notice for the Batch overview card. */
export function BatchDaySummary({ schedule }: { schedule: StageSchedule | null | undefined }) {
  if (!schedule)
    return <p className="mt-4 text-xs text-muted-foreground">Batch schedule unavailable.</p>;
  if (schedule.phase === "no_batch_date")
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Set the batch start date below. Day 1 is the start date; the AI checks the stage from day{" "}
        {schedule.fromDay.GROWER}.
      </p>
    );
  const overdue = schedule.overdueDays > 0 ? stageName(schedule.overdueStage) : null;
  const last = lastAttemptText(schedule);
  return (
    <div className="mt-4 space-y-2 text-sm">
      <p>
        <span className="text-2xl font-bold">Day {schedule.batchDay}</span>
        <span className="ml-2 text-muted-foreground">
          · {PHASE_TEXT[schedule.phase]}
          {schedule.windowOpen ? " · checking now" : ""}
        </span>
      </p>
      {schedule.phase !== "complete" && schedule.phase !== "stage_unknown" && (
        <p className="text-muted-foreground">
          Next stage check: {formatCheckTime(schedule.nextCheckAt)}
        </p>
      )}
      {overdue && (
        <p role="status" className="rounded-lg border border-warn/40 bg-warn/10 p-2 text-warn">
          {overdue} check overdue: not confirmed for {schedule.overdueDays} day
          {schedule.overdueDays === 1 ? "" : "s"}.{last ? ` Last check ${last}.` : ""}
        </p>
      )}
      {!overdue && last && <p className="text-xs text-muted-foreground">Last check {last}.</p>}
    </div>
  );
}

/** Starter → Grower → Finisher with their start days and the current stage. */
export function BatchTimeline({
  schedule,
  current,
}: {
  schedule: StageSchedule | null | undefined;
  current: Stage | null;
}) {
  if (!schedule)
    return <p className="text-sm text-muted-foreground">Batch schedule unavailable.</p>;
  const order: Stage[] = ["Starter", "Grower", "Finisher"];
  const currentIndex = current ? order.indexOf(current) : -1;
  return (
    <>
      <ol className="grid gap-3 sm:grid-cols-3">
        {order.map((stage, index) => {
          const fromDay = schedule.fromDay[stage.toUpperCase() as keyof StageSchedule["fromDay"]];
          const state =
            currentIndex < 0
              ? "—"
              : index < currentIndex
                ? "Done"
                : index === currentIndex
                  ? "Current"
                  : schedule.overdueStage && stageName(schedule.overdueStage) === stage
                    ? "Overdue"
                    : "Upcoming";
          return (
            <li
              key={stage}
              className={`rounded-xl border p-4 ${index === currentIndex ? "border-primary" : "border-border"}`}
            >
              <StageBadge stage={stage} />
              <p className="mt-2 text-sm">From day {fromDay ?? "—"}</p>
              <p
                className={`text-xs ${state === "Overdue" ? "text-warn" : "text-muted-foreground"}`}
              >
                {state}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">
        From day {schedule.fromDay.GROWER} (Grower) and day {schedule.fromDay.FINISHER} (Finisher),
        the AI checks once a day at {schedule.checkTime} (up to {schedule.maxCyclesPerDay} checks).
        The stage only changes after 3 confident checks in a row, and only forward. The day alone
        never changes the stage.
      </p>
    </>
  );
}
