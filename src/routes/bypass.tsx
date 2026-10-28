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
  const [seconds, setSeconds] = useState("2");
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
        // HTTP 202 only means LIVE was requested. Wait for the Arduino acknowledgment.
        let confirmed = false;
        for (let i=0; i<12; i++) {
          await new Promise(resolve=>window.setTimeout(resolve,500));
          const response = await fetch(`${BASE}/api/recovery/status`,{cache:"no-store"});
          if (!response.ok) throw new Error("Unable to verify Arduino mode");
          const mode = await response.json();
          if (mode.connected && mode.mode === "live" && mode.liveAuthorized && !mode.livePending) { confirmed=true; break; }
          if (mode.recoveryBlocked || (!mode.livePending && mode.mode !== "live")) break;
        }
        if (!confirmed) throw new Error("LIVE not confirmed by Arduino; check recovery status");
        clearSession(); setRelayState({}); setRelayReady(false); setMessage("Arduino confirmed LIVE mode.");
      } else {
        setMessage(result.simulation ? "Test override saved. Fan/LED responses (when applicable) were acknowledged; physical sensors and HX711 calibration unchanged." : "Command accepted by Raspberry Pi (verify hardware response).");
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
    }).catch(()=>{clearSession();setRelayReady(false);setMessage("Maintenance session expired; controls locked.");});
    refresh();
    const id=window.setInterval(refresh,4000);
    return ()=>window.clearInterval(id);
  },[token]);
  async function analyseReal(){setBusy(true);try{await call("analyse-real");setMessage("Real camera analysis completed; simulation cleared.");setStatus(null);}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function login(){setBusy(true);try{const r=await call("login",{password},"");setToken(r.token);try { localStorage.setItem(SESSION_KEY,r.token); } catch {} setPassword("");setMessage("Maintenance active. Auto-expires after five minutes without commands.");}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <>
    <PageHeader title="Maintenance" subtitle="Manual bypass • Authorized use only" />
    <p className="mb-4 text-xs text-muted-foreground">Hidden from navigation. This page does not replace authentication or physical emergency controls.</p>
    {!token ? <Card><CardTitle>Unlock maintenance controls</CardTitle><div className="mt-4 flex flex-wrap gap-2"><input aria-label="Maintenance password" type="password" autoComplete="off" className={inputClass+" max-w-sm"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Maintenance password"/><button className={btn} disabled={busy||!password} onClick={login}>Enter bypass</button></div></Card> : <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><div><b>Manual bypass active</b><p className="text-xs text-muted-foreground">{status?.expiresSeconds ?? 300}s remaining · Fan/LED states preserved on entry; outputs reset on exit</p></div><div className="flex flex-wrap gap-2"><button className={btn} disabled={busy} onClick={()=>perform("exit")}>Exit bypass & close gates</button><button className={btn+" border-green-600 text-green-700"} disabled={busy} onClick={()=>{if(window.confirm("Clear all manual overrides and request LIVE mode? Check that fans and lights can activate automatically."))perform("return-live");}}>Return to LIVE Mode</button></div></div>
      <Card><CardTitle>Servo control — 10 channels</CardTitle>
        <p className="my-2 text-xs text-muted-foreground">All 10 servos are listed for maintenance inspection. Physical movement is locked until the Arduino firmware and Raspberry Pi API support confirmed, supervised servo commands. The existing backend currently rejects dispensing with HTTP 423; this interface does not bypass that safety lock.</p>
        <label className="block max-w-xs text-sm">Requested duration (seconds)
          <input type="number" min="0.1" max="5" step="0.1" className={inputClass+" mt-1"} value={seconds} onChange={e=>setSeconds(e.target.value)}/>
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({length:10},(_,i)=>i+1).map(id=><div key={id} className="rounded-lg border p-3">
            <p className="font-medium">Servo {id}</p>
            <p className="mt-1 text-xs text-muted-foreground">{id<=3?"Feed gate channel":"Additional servo channel"}</p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Movement locked</p>
            <button className={btn+" mt-3 w-full"} disabled title="Requires verified Arduino and backend servo support">Activate</button>
          </div>)}
        </div>
        <button className={btn+" mt-3 border-red-500 text-red-600"} disabled={busy} onClick={()=>perform("action",{action:"stop"})}>STOP ALL GATES</button>
      </Card>
      <Card><CardTitle>Relay control</CardTitle><p className="my-2 text-xs text-muted-foreground">Fan, LED, and the single heater relay (D28 / IN7, both lamps together) require Arduino acknowledgment. All manual outputs turn OFF when bypass ends or the safety timeout expires.</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{names.map((name,i)=><button key={name} className={btn} disabled={busy||!relayReady} onClick={async()=>{const next=!relayState[i+1];setBusy(true);try{await call("action",{action:"relay",relay:i+1,on:next});setRelayState(s=>({...s,[i+1]:next}));setMessage("Relay command sent; verify actual output.");}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>{name}: {relayState[i+1]?"ON":"OFF"}</button>)}</div></Card>
      <Card><CardTitle>Sensor test readings</CardTitle><p className="my-2 text-xs text-muted-foreground">Temperature test values drive fan relay logic; LDR raw test values drive LED relay logic. Hopper and trough values appear as SIMULATED on the weight API/dashboard, without changing HX711 calibration. Heater outputs are controlled manually; simulations do not activate heaters.</p><div className="grid gap-3 sm:grid-cols-2">{([['temperature','Temperature °C'],['ldr','LDR raw'],['hopper','Hopper grams'],['trough','Trough grams']] as const).map(([key,label])=><label key={key} className="text-sm">{label}<div className="mt-1 flex gap-2"><input className={inputClass} type="number" value={values[key]} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}/><button className={btn} disabled={busy} onClick={()=>perform("action",{action:"override",key,value:values[key]===""?null:Number(values[key])})}>Set</button></div></label>)}</div></Card>
      <Card><CardTitle>Chicken stage override (simulation)</CardTitle><p className="my-2 text-xs text-muted-foreground">For testing only. Does not overwrite the AI model output or alter the Arduino feeding stage.</p><div className="flex gap-2"><select className={inputClass+" max-w-xs"} value={stage} onChange={e=>setStage(e.target.value)}>{["NO_CHICKEN","STARTER","GROWER","FINISHER"].map(x=><option key={x} value={x}>{x === "NO_CHICKEN" ? "No Chicken Detected" : x}</option>)}</select><button className={btn} disabled={busy} onClick={()=>perform("action",{action:"stage",stage})}>Apply Stage</button><button className={btn} disabled={busy} onClick={analyseReal}>Analyse Real Stage</button></div>{status?.simulation?.active && <p className="mt-2 text-sm">{status.simulation.stage === "NO_CHICKEN" ? "No Chicken Detected · simulated" : `SIMULATED ${status.simulation.stage} · ${status.simulation.framesAnalyzed}/30 · ${status.simulation.confidence ?? "—"}%`}</p>}</Card>
    </div>}
    <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>
  </>;
}
