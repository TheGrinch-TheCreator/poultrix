import { FeedingPlanner } from "@/components/poultrix/FeedingPlanner";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/live-hardware";

type WeightSensor = { status:string; raw:number|null; weightGrams:number|null; updatedAt:string|null };
type WeightReadings = { connected:boolean; hopper:WeightSensor; trough:WeightSensor };

type Feed = { id:string; name:string; stages:string[] };
type Compartment = { id:number; feedId:string; feed:Feed|null; estimatedGrams:number|null; lowFeed:boolean; stageCompatible:boolean };
type Inventory = { feeds:Feed[]; compartments:Compartment[]; confirmedStage:string; eligibleCompartments:number[]; selectedCompartment:number|null; combinedActualGrams:number|null; combinedWeightStatus:string|null; combinedEstimatedGrams:number|null; discrepancyGrams:number|null; automaticFeedingEnabled:boolean; alerts:{type:string;message:string;compartment?:number}[];refills:{compartment:number;kilograms:number;timestamp:string}[] };

function LiveCompartmentManager(){
 const [data,setData]=useState<Inventory|null>(null);
 const [weights,setWeights]=useState<WeightReadings|null>(null);
 const [weightError,setWeightError]=useState("");
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [refills,setRefills]=useState<Record<number,string>>({1:"",2:""});
 const [name,setName]=useState("");
 const [stages,setStages]=useState<string[]>([]);
 const [starting,setStarting]=useState<Record<number,string>>({1:"",2:""});
 const load=async()=>{try{const r=await fetch(`${API_URL}/api/feeding/inventory`,{cache:"no-store"});if(!r.ok)throw Error(`Backend HTTP ${r.status}`);setData(await r.json());setError("");}catch(e){setError(e instanceof Error?e.message:"Connection failed");}};
 const loadWeights=async()=>{try{const r=await fetch(`${API_URL}/api/feeding/weight`,{cache:"no-store"});if(!r.ok)throw Error(`HTTP ${r.status}`);setWeights(await r.json());setWeightError("");}catch(e){setWeightError(e instanceof Error?e.message:"Sensor connection failed");}};
 useEffect(()=>{void load();void loadWeights();const timer=setInterval(()=>{void load();void loadWeights();},2000);return()=>clearInterval(timer);},[]);
 const post=async(path:string,payload:unknown)=>{setBusy(true);try{const r=await fetch(`${API_URL}/api/feeding/inventory/${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const result=await r.json();if(!r.ok)throw Error(result.error||`HTTP ${r.status}`);setError("");await load();}catch(e){setError(e instanceof Error?e.message:"Operation failed");}finally{setBusy(false);}};
 const kg=(v:number|null)=>v===null?"Not initialized":`${(v/1000).toFixed(2)} kg estimated`;
 return <section className="mb-6 space-y-4">
  <div><h2 className="text-xl font-bold">Feed compartments</h2><p className="text-sm text-muted-foreground">Independent feed assignments and refill ledger • physical dispensing locked during calibration</p></div>
  {error&&<div role="alert" className="rounded-lg border border-red-400 p-3 text-sm text-red-600">{error}</div>}
  <div className="grid gap-4 md:grid-cols-2">
  {[1,2].map(id=>{const c=data?.compartments.find(x=>x.id===id);const green=id===1;return <div key={id} className="rounded-2xl border p-5 space-y-4" style={{borderColor:green?"#8acb32":"#f59a30",background:green?"rgba(138,203,50,.07)":"rgba(245,154,48,.07)"}}>
   <div className="flex items-center gap-3"><span className="h-5 w-5 rounded-md" style={{background:green?"#8acb32":"#f59a30"}}/><h3 className="font-bold">Compartment {id}</h3></div>
   <label className="block text-sm font-medium">Feed type</label>
   <select aria-label={`Compartment ${id} feed`} className="w-full rounded-lg border bg-background p-2" disabled={busy||!data} value={c?.feedId||""} onChange={e=>void post("assign",{compartment:id,feedId:e.target.value})}>{data?.feeds.map(f=><option key={f.id} value={f.id}>{f.name} — {f.stages.join("/")}</option>)}</select>
   <p className="text-sm">{kg(c?.estimatedGrams??null)}</p>
   <p className="text-xs text-muted-foreground">Estimated from refill records, not individually measured by a load cell.</p>
   <p className={`text-sm font-medium ${c?.stageCompatible?"text-green-700":"text-orange-700"}`}>{c?.stageCompatible?"Compatible with confirmed stage":"Not compatible with confirmed stage"}</p>
   {c?.lowFeed&&<p className="text-sm font-semibold text-red-600">Low estimated feed — refill soon</p>}
   <div className="flex gap-2"><input aria-label={`Refill compartment ${id} kilograms`} type="number" min="0.01" max="100" step="0.01" placeholder="Refill kg" className="min-w-0 flex-1 rounded-lg border bg-background p-2" value={refills[id]} onChange={e=>setRefills(p=>({...p,[id]:e.target.value}))}/><button className="rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy||!data||!(Number(refills[id])>0)} onClick={()=>{if(window.confirm(`Confirm adding ${refills[id]} kg to compartment ${id}?`))void post("refill",{compartment:id,kilograms:Number(refills[id])}).then(()=>setRefills(p=>({...p,[id]:""})));}}>Record refill</button></div>
   <p className="text-xs text-muted-foreground">Five servos • PCA9685 {id===1?"CH 0–4":"CH 11–15"} • closed 0°, open 90°</p>
  </div>})}
  </div>
  <div className="rounded-xl border p-4 space-y-3"><h3 className="font-semibold">Live load cell readings</h3><p className="text-xs text-muted-foreground">Read directly from Arduino through the Raspberry Pi, refreshed every 2 seconds.</p>{weightError&&<p role="alert" className="text-sm text-red-600">{weightError}</p>}<div className="grid gap-3 md:grid-cols-2">{(["hopper","trough"] as const).map(sensor=>{const reading=weights?.[sensor];const grams=reading?.weightGrams;const connected=weights?.connected;return <div key={sensor} className="rounded-lg border p-3 space-y-1"><h4 className="font-medium capitalize">{sensor} weight</h4><p className="text-xl font-semibold">{connected&&grams!=null?`${(grams/1000).toFixed(3)} kg`:"-- kg"}</p><p className="text-xs">Status: {connected?(reading?.status??"WAITING"):"DISCONNECTED"}</p><p className="text-xs text-muted-foreground">Raw: {reading?.raw??"--"}</p><p className="text-xs text-muted-foreground">Last reading: {reading?.updatedAt?new Date(reading.updatedAt).toLocaleTimeString():"Waiting"}</p></div>;})}</div></div>
  <div className="rounded-xl border p-4 space-y-2"><h3 className="font-semibold">Combined hopper sensor</h3><p className="text-lg font-bold">{data?.combinedActualGrams==null?"Actual weight unavailable":`${(data.combinedActualGrams/1000).toFixed(2)} kg actual`}</p><p className="text-sm">Combined inventory estimate: {kg(data?.combinedEstimatedGrams??null)}</p><p className="text-sm">Confirmed chicken stage: {data?.confirmedStage||"Unknown"} • Eligible compartment(s): {data?.eligibleCompartments.join(", ")||"None"}</p>{data?.discrepancyGrams!=null&&<p className="text-sm">Actual minus estimated: {(data.discrepancyGrams/1000).toFixed(2)} kg</p>}{data?.alerts.map((a,i)=><p key={i} role="status" className="text-sm text-orange-700">{a.message}{a.compartment?` (Compartment ${a.compartment})`:""}</p>)}</div>
  {data?.compartments.some(c=>c.estimatedGrams===null)&&<div className="rounded-xl border p-4 space-y-3"><h3 className="font-semibold">Initialize verified starting stock</h3><p className="text-xs text-muted-foreground">Enter the measured feed quantities in BOTH compartments before using refill tracking. This replaces prior estimates.</p><div className="grid grid-cols-2 gap-3">{[1,2].map(id=><label key={id} className="text-sm">Compartment {id} (kg)<input type="number" min="0" max="100" step="0.01" className="mt-1 w-full rounded-lg border bg-background p-2" value={starting[id]} onChange={e=>setStarting(p=>({...p,[id]:e.target.value}))}/></label>)}</div><button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy||[1,2].some(id=>starting[id]===""||!Number.isFinite(Number(starting[id]))||Number(starting[id])<0)} onClick={()=>{if(window.confirm("Confirm both starting quantities are verified?"))void post("initialize",{kilograms:[Number(starting[1]),Number(starting[2])]});}}>Initialize inventory</button></div>}
  <div className="rounded-xl border p-4 space-y-3"><h3 className="font-semibold">Create custom feed</h3><input aria-label="Custom feed name" className="w-full rounded-lg border bg-background p-2" placeholder="Custom feed name" value={name} onChange={e=>setName(e.target.value)}/><p className="text-sm">Confirm the stages this feed is suitable for:</p><div className="flex flex-wrap gap-4">{["STARTER","GROWER","FINISHER"].map(s=><label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stages.includes(s)} onChange={e=>setStages(p=>e.target.checked?[...p,s]:p.filter(v=>v!==s))}/>{s}</label>)}</div><button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy||!name.trim()||!stages.length} onClick={()=>void post("feed",{name:name.trim(),stages}).then(()=>{setName("");setStages([]);})}>Save custom feed</button></div>
  <p className="text-xs text-muted-foreground">Refill quantities are user-entered estimates. Automatic dispensing is disabled until servo travel, dispense rates, and inventory reconciliation are calibrated.</p>
 </section>;
}

import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { farm, feed, feedHistory, feedingEvents, stageInfo } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, Meter, PageHeader, Pill, StageBadge } from "@/components/poultrix/ui";
import { DeclarationForm, FeedHoldAlert, FeedSchedulePanel, FeedStockPanel, LeftoverNotice, MaeCard } from "@/components/poultrix/v3";
import { FeedBars } from "@/components/poultrix/charts";

export const Route = createFileRoute("/feeding")({
  head: () => ({
    meta: [
      { title: "Feeding — POULTRIX" },
      { name: "description", content: "Stage-based feed dispensing, compartment levels, trough weight and feeding accuracy." },
      { property: "og:title", content: "Feeding — POULTRIX" },
      { property: "og:description", content: "Stage-based feed dispensing, compartment levels, trough weight and feeding accuracy." },
    ],
  }),
  component: FeedingPage,
});

const STEPS = ["Growth stage", "Feed type", "Target amount", "Gates open", "Weighing", "Target reached", "Complete"];

function FeedingPage() {
 return <main className="space-y-4"><FeedingPlanner manual /><LiveCompartmentManager /></main>;
}
