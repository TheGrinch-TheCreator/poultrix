import { useState } from "react";
import { piErrorMessage, piFetch } from "@/lib/pi-client";
import { refreshSnapshot, usePiSnapshot } from "@/lib/pi-snapshot";
export type Hardware = { connected?: boolean; arduinoOnline?: boolean; piSeenByArduino?: boolean|null; operatingStatus?: string; mode?: string; stage?: string; temperature?: number|null; humidity?: number|null; lightRaw?: number|null; fansOn?: number; heatersOn?: number; led?: boolean; temperatureTarget?: {min:number;max:number}; camera?: {connected?:boolean}; ai?: AI };
export type AI = { detectedStage?:string|null; confidence?:number|null; lastInference?:string|null; status?:string; confident?:boolean; error?:string|null; confirmationCount?:number; consecutiveCount?:number; votes?:Record<string,number>; cycleRunning?:boolean; framesAnalyzed?:number; failedFrames?:number; transitionStatus?:string; transitionConfirmations?:number; transitionRequired?:number; hardwareTransitionStatus?:string; hardwareTransitionError?:string|null; lastTransitionResult?:{status:string;from:string;to:string;timestamp?:string}|null; transitionCandidate?:string|null; schedule?: StageSchedule; lastAgreeingDetection?: {stage:string;confidence:number;at:string}|null };
// Day-gated stage schedule reported by the Pi (SPEC-stage-schedule.md §6).
export type StageSchedule = { batchStartDate:string|null; batchDay:number|null; phase:"no_batch_date"|"stage_unknown"|"starter"|"grower_pre_check"|"grower_check"|"grower"|"finisher_pre_check"|"finisher_check"|"complete"; currentStage:string|null; allowedTargets:string[]; fromDay:{STARTER:number;GROWER:number;FINISHER:number}; checkTime:string; maxCyclesPerDay:number; confirmationsRequired?:number; preCheckDays?:{GROWER?:number;FINISHER?:number}; preCheckStage?:string|null; readyAlert?:{stage:string;date:string;fromDay:number}|null; windowOpen:boolean; nextCheckAt:string|null; nextStage:string|null; nextStageFromDay:number|null; daysUntilNextStage:number|null; overdueDays:number; overdueStage:string|null; lastAttempt:{date:string;cycles:number;result:string;target:string|null;detectedStage:string|null;confidence:number|null;finishedAt:string|null;startedAt?:string|null;kind?:"check"|"pre_check";preCheckStage?:string|null}|null };
// Live data comes from the shared snapshot poller (one /api/pi/snapshot
// request per 5 s through the authenticated Worker gateway).
export function useHardware() {
 const { snapshot, error } = usePiSnapshot();
 return { data: snapshot?.status ?? null, error: error ? piErrorMessage(error) : null, errorCode: error?.code ?? null };
}
export function useAI() {
 const { snapshot, error } = usePiSnapshot();
 const [busy,setBusy]=useState(false); const [actionError,setActionError]=useState<string|null>(null);
 const classify=async()=>{setBusy(true);try{await piFetch("/ai/classify",{method:"POST"});setActionError(null);await refreshSnapshot()}catch(e){setActionError(piErrorMessage(e))}finally{setBusy(false)}};
 return { data: snapshot?.ai ?? null, error: actionError ?? (error ? piErrorMessage(error) : null), busy, classify };
}
export const display=(v:number|null|undefined,unit="")=>typeof v==="number"&&Number.isFinite(v)?`${v.toFixed(1)}${unit}`:"—";
// Owner choice (SPEC-stage-schedule §9, option 2): the main app shows an AI
// detection only when it agrees with the confirmed (Arduino) stage; otherwise
// it shows nothing. Values are never altered. The maintenance site shows the
// real detection always.
export const sameStage=(a?:string|null,b?:string|null)=>!!a&&!!b&&a.toUpperCase()===b.toUpperCase();
export function agreeingDetection(ai:AI|null|undefined,confirmed?:string|null){
 if(!ai||!sameStage(ai.detectedStage,confirmed))return null;
 return {stage:stageName(ai.detectedStage),confidence:typeof ai.confidence==="number"&&Number.isFinite(ai.confidence)?ai.confidence:null};
}
export const stageName=(v?:string|null)=>v&&["STARTER","GROWER","FINISHER"].includes(v.toUpperCase())?v.charAt(0).toUpperCase()+v.slice(1).toLowerCase():null;
