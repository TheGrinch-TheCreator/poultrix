import { useEffect, useState } from "react";
export const API_URL = (import.meta.env.VITE_POULTRIX_API_URL || "http://192.168.1.48:5000").replace(/\/$/, "");
export type Hardware = { connected?: boolean; mode?: string; stage?: string; temperature?: number|null; humidity?: number|null; lightRaw?: number|null; fansOn?: number; heatersOn?: number; led?: boolean; temperatureTarget?: {min:number;max:number}; camera?: {connected?:boolean}; ai?: AI };
export type AI = { detectedStage?:string|null; confidence?:number|null; lastInference?:string|null; status?:string; confident?:boolean; error?:string|null; confirmationCount?:number; consecutiveCount?:number; votes?:Record<string,number> };
export function useHardware() {
 const [data,setData]=useState<Hardware|null>(null); const [error,setError]=useState<string|null>(null);
 useEffect(()=>{let active=true; const load=async()=>{try {const r=await fetch(`${API_URL}/api/status`,{cache:"no-store"}); if(!r.ok)throw Error(`HTTP ${r.status}`);const d=await r.json();if(active){setData(d);setError(null)}}catch(e){if(active){setData(null);setError(e instanceof Error?e.message:"Connection failed")}}};void load();const id=setInterval(load,3000);return()=>{active=false;clearInterval(id)}},[]);
 return {data,error};
}
export function useAI() {const [data,setData]=useState<AI|null>(null);const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;const load=async()=>{try{const r=await fetch(`${API_URL}/api/ai/status`,{cache:"no-store"});if(!r.ok)throw Error(`HTTP ${r.status}`);const d=await r.json();if(active){setData(d);setError(null)}}catch(e){if(active){setData(null);setError(e instanceof Error?e.message:"Connection failed")}}};void load();const id=setInterval(load,3000);return()=>{active=false;clearInterval(id)}},[]);
 const classify=async()=>{setBusy(true);try{const r=await fetch(`${API_URL}/api/ai/classify`,{method:"POST"});if(!r.ok)throw Error(`HTTP ${r.status}`);setError(null)}catch(e){setError(e instanceof Error?e.message:"Analysis failed")}finally{setBusy(false)}};
 return {data,error,busy,classify};}
export const display=(v:number|null|undefined,unit="")=>typeof v==="number"&&Number.isFinite(v)?`${v.toFixed(1)}${unit}`:"—";
export const stageName=(v?:string|null)=>v&&["STARTER","GROWER","FINISHER"].includes(v.toUpperCase())?v.charAt(0).toUpperCase()+v.slice(1).toLowerCase():null;
