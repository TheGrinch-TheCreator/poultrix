import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { saveMyFarm } from "@/lib/farm-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export const Route = createFileRoute("/farm-setup")({ component: FarmSetup });
function FarmSetup() {
 const [name,setName]=useState(""); const [location,setLocation]=useState(""); const [birds,setBirds]=useState(""); const [busy,setBusy]=useState(false);
 async function submit(e: React.FormEvent) { e.preventDefault(); const count=Number(birds); if(!Number.isSafeInteger(count)||count<1){toast.error("Enter a valid number of birds");return;} setBusy(true); try { await saveMyFarm({name:name.trim(),location:location.trim(),bird_count:count}); window.location.replace("/"); } catch(e){toast.error(e instanceof Error?e.message:"Farm setup failed");}finally{setBusy(false);} }
 return <main className="min-h-screen grid place-items-center bg-background p-5"><form onSubmit={submit} className="w-full max-w-md space-y-5 rounded-xl border bg-card p-7 shadow-sm"><div><h1 className="text-2xl font-bold">Set up your poultry farm</h1><p className="mt-2 text-sm text-muted-foreground">Complete this once before accessing Poultrix.</p></div><div className="space-y-2"><Label>Farm name</Label><Input required maxLength={120} value={name} onChange={e=>setName(e.target.value)} placeholder="My Poultry Farm" /></div><div className="space-y-2"><Label>Location</Label><Input required maxLength={200} value={location} onChange={e=>setLocation(e.target.value)} placeholder="Town, province" /></div><div className="space-y-2"><Label>Number of birds</Label><Input required type="number" min="1" step="1" value={birds} onChange={e=>setBirds(e.target.value)} /></div><Button className="w-full" disabled={busy||!name.trim()||!location.trim()}>{busy?"Saving…":"Create farm & open dashboard"}</Button></form></main>;
}
