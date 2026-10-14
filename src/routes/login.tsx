import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import flockImg from "@/assets/flock-camera.jpg";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — POULTRIX" },
      { name: "description", content: "Sign in to monitor your POULTRIX broiler house." },
      { property: "og:title", content: "Sign in — POULTRIX" },
      { property: "og:description", content: "Sign in to monitor your POULTRIX broiler house." },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name.trim() }, emailRedirectTo: window.location.origin },
      });
      if (error) toast.error(error.message);
      else if (!data.session) toast.success("Check your email to confirm your account.");
      else nav({ to: "/farm-setup" });
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) toast.error(error.message);
      else nav({ to: "/" });
    }
    setBusy(false);
  }

  async function signInWithGoogle() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) toast.error(error.message);
    setBusy(false);
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden lg:block">
        <img src={flockImg} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-sidebar/70" />
        <div className="relative flex h-full flex-col justify-end p-12 text-sidebar-foreground">
          <div className="font-display text-5xl font-extrabold">POULTRIX</div>
          <p className="mt-3 max-w-md text-lg opacity-90">Know how your chickens are doing — feeding, temperature and growth — in seconds.</p>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <form className="w-full max-w-sm space-y-5" onSubmit={submit}>
          <div>
            <h1 className="text-3xl font-bold">{mode === "signin" ? "Sign in" : "Create account"}</h1>
            <p className="mt-1 text-muted-foreground">Manage your flock from anywhere.</p>
          </div>
          {mode === "signup" && (
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input id="name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Juan Dela Cruz" className="h-12" />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="h-12" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" required minLength={6} type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" className="h-12" />
          </div>
          <Button disabled={busy} size="lg" className="h-12 w-full">{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</Button>
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
          <Button disabled={busy} type="button" variant="outline" size="lg" className="h-12 w-full" onClick={signInWithGoogle}>Continue with Google</Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "New to POULTRIX? Create account" : "Already have an account? Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
