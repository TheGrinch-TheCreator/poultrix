import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardTitle, PageHeader } from "@/components/poultrix/ui";

export const Route = createFileRoute("/bypass")({ component: BypassPage });
const BASE = (import.meta.env.VITE_POULTRIX_API_URL || "http://192.168.1.48:5000").replace(/\/$/, "");
const inputClass = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40 hover:bg-muted";
const names = ["Fan 1", "Fan 2", "Fan 3", "Fan 4", "LED", "Heater 1", "Heater 2"];
function BypassPage() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Maintenance controls are inactive.");
  const [seconds, setSeconds] = useState("2");
  const [stage, setStage] = useState("STARTER");
  const [values, setValues] = useState({temperature:"",ldr:"",hopper:"",trough:""});
  const [relayState, setRelayState] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState<any>(null);
  async function call(path: string, data?: unknown, key = token) {
    const response = await fetch(`${BASE}/api/bypass/${path}`, {
      method: path === "status" ? "GET" : "POST",
      headers: {"Content-Type":"application/json", ...(key ? {"X-Poultrix-Maintenance":key} : {})},
      ...(data ? {body:JSON.stringify(data)} : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  async function perform(path: string, data?:unknown): Promise<boolean> {
    setBusy(true);
    try { const result=await call(path,data);setMessage(result.simulation ? "Simulation override saved; hardware sensors unchanged." : "Command accepted by Raspberry Pi (verify hardware response)."); if(path==="exit"){setToken("");setRelayState({});} }
    catch(e){setMessage(e instanceof Error?e.message:String(e)); if(String(e).includes("Unauthorized"))setToken("");}
    finally{setBusy(false);}
    return true;
  }
  useEffect(()=>{
    if(!token)return;
    const id=window.setInterval(()=>{call("status",undefined,token).then(setStatus).catch(()=>{setToken("");setMessage("Maintenance session expired; controls locked.");});},4000);
    return ()=>window.clearInterval(id);
  },[token]);
  async function login(){setBusy(true);try{const r=await call("login",{password},"");setToken(r.token);setPassword("");setMessage("Maintenance active. Auto-expires after five minutes without commands.");}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <>
    <PageHeader title="Maintenance" subtitle="Manual bypass • Authorized use only" />
    <p className="mb-4 text-xs text-muted-foreground">Hidden from navigation. This page does not replace authentication or physical emergency controls.</p>
    {!token ? <Card><CardTitle>Unlock maintenance controls</CardTitle><div className="mt-4 flex flex-wrap gap-2"><input aria-label="Maintenance password" type="password" autoComplete="off" className={inputClass+" max-w-sm"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Maintenance password"/><button className={btn} disabled={busy||!password} onClick={login}>Enter bypass</button></div></Card> : <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><div><b>Manual bypass active</b><p className="text-xs text-muted-foreground">{status?.expiresSeconds ?? 300}s remaining · Relay outputs reset on exit</p></div><button className={btn} disabled={busy} onClick={()=>perform("exit")}>Exit bypass & close gates</button></div>
      <Card><CardTitle>Servo dispensing</CardTitle><p className="my-2 text-xs text-muted-foreground">D9: 70°/30° · D10: 85°/30° · D11: 100°/45° (closed/open). Max 5 seconds. Test with empty feeder first.</p><label className="block max-w-xs text-sm">Duration (seconds)<input type="number" min="0.1" max="5" step="0.1" className={inputClass+" mt-1"} value={seconds} onChange={e=>setSeconds(e.target.value)}/></label><div className="mt-3 flex flex-wrap gap-2">{[1,2,3,0].map(g=><button key={g} className={btn} disabled={busy||!(Number(seconds)>=0.1&&Number(seconds)<=5)} onClick={()=>{if(window.confirm(`Open ${g?`servo ${g}`:"all three servos"} for ${seconds} seconds?`))perform("action",{action:"dispense",gate:g,seconds:Number(seconds)});}}>{g?`Dispense servo ${g}`:"Dispense all"}</button>)}<button className={btn+" border-red-500 text-red-600"} onClick={()=>perform("action",{action:"stop"})}>STOP ALL GATES</button></div></Card>
      <Card><CardTitle>Relay control</CardTitle><p className="my-2 text-xs text-muted-foreground">Fan and LED relay commands are real. Remote heater ON is blocked for safety.</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{names.map((name,i)=><button key={name} className={btn} disabled={busy||i>=5} onClick={async()=>{const next=!relayState[i+1];setBusy(true);try{await call("action",{action:"relay",relay:i+1,on:next});setRelayState(s=>({...s,[i+1]:next}));setMessage("Relay command sent; verify actual output.");}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>{name}: {i>=5?"Locked":relayState[i+1]?"ON":"OFF"}</button>)}</div></Card>
      <Card><CardTitle>Sensor test readings</CardTitle><p className="my-2 text-xs text-muted-foreground">Simulation only. These values do not overwrite physical measurements or calibrate the HX711.</p><div className="grid gap-3 sm:grid-cols-2">{([['temperature','Temperature °C'],['ldr','LDR raw'],['hopper','Hopper grams'],['trough','Trough grams']] as const).map(([key,label])=><label key={key} className="text-sm">{label}<div className="mt-1 flex gap-2"><input className={inputClass} type="number" value={values[key]} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}/><button className={btn} disabled={busy} onClick={()=>perform("action",{action:"override",key,value:values[key]===""?null:Number(values[key])})}>Set</button></div></label>)}</div></Card>
      <Card><CardTitle>Chicken stage override (simulation)</CardTitle><p className="my-2 text-xs text-muted-foreground">For testing only. Does not overwrite the AI model output or alter the Arduino feeding stage.</p><div className="flex gap-2"><select className={inputClass+" max-w-xs"} value={stage} onChange={e=>setStage(e.target.value)}>{["NO_CHICKEN","STARTER","GROWER","FINISHER"].map(x=><option key={x} value={x}>{x === "NO_CHICKEN" ? "No Chicken Detected" : x}</option>)}</select><button className={btn} disabled={busy} onClick={()=>perform("action",{action:"stage",stage})}>Apply test stage</button></div></Card>
    </div>}
    <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>
  </>;
}
