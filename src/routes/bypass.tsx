import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardTitle, PageHeader } from "@/components/poultrix/ui";

export const Route = createFileRoute("/bypass")({ component: BypassPage });
const BASE = (import.meta.env.VITE_POULTRIX_API_URL || "http://192.168.1.48:5000").replace(/\/$/, "");
const inputClass = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40 hover:bg-muted";
const SESSION_KEY = "poultrix_maintenance_token";
const names = ["Fan 1", "Fan 2", "Fan 3", "Fan 4", "LED", "Heater Lamps (2 × D28/IN7)"];
function BypassPage() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(() => { try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Maintenance controls are inactive.");
  const [seconds, setSeconds] = useState("0.5");
  const [stage, setStage] = useState("STARTER");
  const [values, setValues] = useState({temperature:"",ldr:"",hopper:"",trough:""});
  const [relayState, setRelayState] = useState<Record<number, boolean>>({});
  const [relayReady, setRelayReady] = useState(false);
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
  function clearSession() { setToken(""); try { localStorage.removeItem(SESSION_KEY); } catch {} }
  async function perform(path: string, data?:unknown): Promise<boolean> {
    setBusy(true);
    try {
      const result=await call(path,data);
      if (path === "return-live") {
        setRelayState({}); setRelayReady(false);
        setMessage(result.status === "live" ? "Real sensor readings and automatic LIVE control restored. Maintenance login remains unlocked." : "Overrides cleared; Arduino is not confirmed LIVE. Maintenance login remains unlocked. Use system LIVE controls when safe.");
        setStatus((prev:any) => ({...prev,active:false,manualControlsPaused:true,readings:{}}));
      } else if (path === "resume") {
        setMessage("Manual bypass resumed. Maintenance login remains unlocked.");
        setStatus((prev:any) => ({...prev,active:true,manualControlsPaused:false}));
      } else {
        setMessage(path === "action" && result.action === "dispense" ? `Arduino acknowledged compartment ${result.group} for ${Number(result.durationMs)/1000}s. Verify physical gate movement and closure.` : result.simulation ? "Test override saved. Fan/LED responses (when applicable) were acknowledged; physical sensors and HX711 calibration unchanged." : "Command accepted by Raspberry Pi (verify hardware response).");
        if(path === "exit") {clearSession();setRelayState({});setRelayReady(false);}
      }
    }
    catch(e){setMessage(e instanceof Error?e.message:String(e)); if(String(e).includes("Unauthorized"))clearSession();}
    finally{setBusy(false);}
    return true;
  }
  useEffect(()=>{
    if(!token)return;
    const refresh = () => call("status",undefined,token).then(result=>{
      setStatus(result);
      if (Array.isArray(result.relays) && result.relays.length === 6) {
        setRelayState(Object.fromEntries(result.relays.map((v:boolean,i:number)=>[i+1,Boolean(v)])));
        setRelayReady(true);
      }
    }).catch((error)=>{
      setStatus(null); setRelayReady(false);
      if (String(error).includes("Unauthorized")) { clearSession(); setMessage("Maintenance session expired or revoked; please sign in again."); }
      else setMessage("Unable to reach Raspberry Pi. Session saved; controls disabled until connection returns.");
    });
    refresh();
    const id=window.setInterval(refresh,2000);
    return ()=>window.clearInterval(id);
  },[token]);
  async function analyseReal(){setBusy(true);try{await call("analyse-real");setMessage("Real camera analysis completed; simulation cleared.");setStatus(null);}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function login(){setBusy(true);try{const r=await call("login",{password},"");setToken(r.token);try { localStorage.setItem(SESSION_KEY,r.token); } catch {} setPassword("");setMessage("Maintenance active. Session retained across navigation and refresh; expires after eight hours or when exited.");}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <>
    <PageHeader title="Maintenance" subtitle="Manual bypass • Authorized use only" />
    <p className="mb-4 text-xs text-muted-foreground">Hidden from navigation. This page does not replace authentication or physical emergency controls.</p>
    {!token ? <Card><CardTitle>Unlock maintenance controls</CardTitle><div className="mt-4 flex flex-wrap gap-2"><input aria-label="Maintenance password" type="password" autoComplete="off" className={inputClass+" max-w-sm"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Maintenance password"/><button className={btn} disabled={busy||!password} onClick={login}>Enter bypass</button></div></Card> : <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><div><b>Manual bypass active</b><p className="text-xs text-muted-foreground">{status?.expiresSeconds != null ? `${Math.ceil(status.expiresSeconds / 60)} min remaining` : "Checking session…"} · Return to LIVE restores real readings and automatic controls without logging out</p></div><div className="flex flex-wrap gap-2"><button className={btn} disabled={busy} onClick={()=>perform("exit")}>Exit bypass & close gates</button><button className={btn+" border-green-600 text-green-700"} disabled={busy} onClick={()=>{if(window.confirm("Clear all manual overrides and request LIVE mode? Check that fans and lights can activate automatically."))perform("return-live");}}>Return to LIVE Mode</button>{status?.manualControlsPaused && <button className={btn} disabled={busy} onClick={()=>perform("resume")}>Resume Manual Bypass</button>}</div></div>
      <Card><CardTitle>Servo control — 2 compartments (10 servos)</CardTitle>
        <p className="my-2 text-xs text-muted-foreground">Supervised timed group dispensing. One PCA9685 driver controls all 10 servos. Closed: 0° · Open: 90°. Arduino automatically closes the selected group after the requested duration (maximum 10 seconds). Only one group may run at a time. Keep feed compartments empty for initial testing.</p>
        <label className="block max-w-xs text-sm">Requested duration (seconds)
          <input type="number" min="0.1" max="10" step="0.1" className={inputClass+" mt-1"} value={seconds} onChange={e=>setSeconds(e.target.value)}/>
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {([1,2] as const).map(group=><div key={group} className="rounded-lg border p-4">
            <p className="font-medium">Compartment {group} — 5 servos</p>
            <p className="mt-1 text-xs text-muted-foreground">PCA9685 channels: {group===1?"0, 1, 2, 3, 4":"11, 12, 13, 14, 15"}</p>
            <p className="mt-2 text-xs text-muted-foreground">0° CLOSED · 90° OPEN</p>
            <button className={btn+" mt-3 w-full border-blue-600 text-blue-700"}
              disabled={busy||!status?.active||!Number.isFinite(Number(seconds))||Number(seconds)<0.1||Number(seconds)>10}
              onClick={()=>{if(window.confirm(`Dispense compartment ${group}: open all 5 servos for ${seconds} seconds? Confirm gates are empty and supervised.`))perform("action",{action:"dispense",group,seconds:Number(seconds)});}}>
              Dispense Group {group}
            </button>
          </div>)}
        </div>
        <button className={btn+" mt-3 border-red-500 text-red-600"} onClick={()=>perform("action",{action:"stop"})}>STOP ALL GATES</button>
      </Card>
      <Card><CardTitle>Relay control</CardTitle><p className="my-2 text-xs text-muted-foreground">Fan, LED, and the single heater relay (D28 / IN7, both lamps together) require Arduino acknowledgment. All manual outputs turn OFF when bypass ends or the safety timeout expires.</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{names.map((name,i)=><button key={name} className={btn} disabled={busy||!relayReady||!status?.active} onClick={async()=>{const next=!relayState[i+1];setBusy(true);try{await call("action",{action:"relay",relay:i+1,on:next});setRelayState(s=>({...s,[i+1]:next}));setMessage("Relay command sent; verify actual output.");}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>{name}: {relayState[i+1]?"ON":"OFF"}</button>)}</div></Card>
      <Card><CardTitle>Sensor test readings</CardTitle><p className="my-2 text-xs text-muted-foreground">Temperature test values drive fan relay logic; LDR raw test values drive LED relay logic. All four values fluctuate every 2 seconds around the entered baseline. Temperature and hopper values also appear on the Arduino LCD (marked *). Hopper and trough values appear as SIMULATED on the weight API/dashboard, without changing HX711 calibration. Heater outputs are controlled manually; simulations do not activate heaters.</p><div className="grid gap-3 sm:grid-cols-2">{([['temperature','Temperature °C'],['ldr','LDR raw'],['hopper','Hopper grams'],['trough','Trough grams']] as const).map(([key,label])=><label key={key} className="text-sm">{label}<div className="mt-1 flex gap-2"><input className={inputClass} type="number" value={values[key]} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}/><button className={btn} disabled={busy||!status?.active} onClick={()=>perform("action",{action:"override",key,value:values[key]===""?null:Number(values[key])})}>Set</button>{status?.readings?.[key] != null && <p className="mt-1 text-xs text-muted-foreground" aria-live="off">Live simulated reading: <span className="font-semibold tabular-nums">{key === "temperature" ? Number(status.readings[key]).toFixed(1) : key === "ldr" ? Math.round(Number(status.readings[key])) : Number(status.readings[key]).toFixed(1)}</span> {key === "temperature" ? "°C" : key === "ldr" ? "raw" : "g"} · updates every 2s</p>}</div></label>)}</div></Card>
      <Card><CardTitle>Chicken stage test target</CardTitle><p className="my-2 text-xs text-muted-foreground">Sets a test target only. Press Analyze now on AI Growth Stage three times to confirm and apply a real hardware stage change.</p><div className="flex gap-2"><select className={inputClass+" max-w-xs"} value={stage} onChange={e=>setStage(e.target.value)}>{["NO_CHICKEN","STARTER","GROWER","FINISHER"].map(x=><option key={x} value={x}>{x === "NO_CHICKEN" ? "No Chicken Detected" : x}</option>)}</select><button className={btn} disabled={busy||!status?.active} onClick={()=>perform("action",{action:"stage",stage})}>Apply Stage</button><button className={btn} disabled={busy||!status?.active} onClick={analyseReal}>Analyse Real Stage</button></div>{status?.simulation?.active && <p className="mt-2 text-sm">{status.simulation.stage === "NO_CHICKEN" ? "No Chicken Detected · simulated" : `SIMULATED ${status.simulation.stage} · ${status.simulation.framesAnalyzed}/30 · ${status.simulation.confidence ?? "—"}%`}</p>}</Card>
    </div>}
    <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>
  </>;
}
