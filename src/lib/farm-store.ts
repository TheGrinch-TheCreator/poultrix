import { supabase } from "@/integrations/supabase/client";
export type PoultrixFarm = { id: string; owner_id: string; name: string; location: string; bird_count: number; created_at: string };
export async function getMyFarm(): Promise<PoultrixFarm | null> {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return null;
  const { data, error } = await supabase.from("farms" as never).select("*").eq("owner_id", user.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  return data as PoultrixFarm | null;
}
export async function saveMyFarm(input: { name: string; location: string; bird_count: number }) {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Sign in before registering a farm");
  const { data, error } = await supabase.from("farms" as never).upsert({ ...input, owner_id: user.id }, { onConflict: "owner_id" }).select().single();
  if (error) throw error;
  const farm = data as PoultrixFarm;
  localStorage.setItem("poultrix.birdCount", String(farm.bird_count));
  localStorage.setItem("poultrix.farmName", farm.name);
  localStorage.setItem("poultrix.farmLocation", farm.location);
  window.dispatchEvent(new Event("poultrix:farm-updated"));
  return farm;
}
