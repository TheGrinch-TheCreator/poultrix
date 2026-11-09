import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import loginVideo from "@/assets/poultrix-login-bg.mp4";
import poultrixLogo from "@/assets/poultrix-logo-login.png";
import poultrixLogoLight from "@/assets/poultrix-logo-light.png";
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

  // Only large screens show (and download) the 6.9 MB montage video.
  const [wideScreen, setWideScreen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWideScreen(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <div className="grid min-h-screen content-start lg:grid-cols-2 lg:content-stretch">
      {/* Phones: just the logo at the top. Light theme uses a copy with a dark subtitle
          (the original's subtitle is white); dark theme uses the original. */}
      <div className="flex justify-center px-6 pt-10 pb-2 lg:hidden">
        <img src={poultrixLogoLight} alt="POULTRIX" className="w-64 max-w-full dark:hidden" />
        <img src={poultrixLogo} alt="POULTRIX" className="hidden w-64 max-w-full dark:block" />
      </div>
      {/* Large screens (layout per src/assets/login-preview.jpg): dark navy panel, the
          looping montage near the top fading into the navy, logo + text at the bottom. */}
      <div className="relative hidden overflow-hidden bg-[#12172a] lg:block">
        <div
          className="absolute inset-x-0 top-[4%]"
          style={{ maskImage: "linear-gradient(to bottom, black 60%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent)" }}
        >
          {wideScreen ? (
            <video
              src={loginVideo}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              aria-hidden="true"
              className="block h-auto w-full motion-reduce:hidden"
            />
          ) : null}
        </div>
        {/* Soft navy fade at the bottom so the logo and text stay readable. */}
        <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-[#090d19]/95 via-[#12172a]/50 to-transparent" />
        <div className="relative flex h-full flex-col justify-end p-12 text-white">
          <img src={poultrixLogo} alt="POULTRIX" className="w-[26rem] max-w-full drop-shadow-lg" />
          <p className="mt-3 max-w-md text-lg opacity-95 drop-shadow">Know how your chickens are doing — feeding, temperature and growth — in seconds.</p>
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
          <Button disabled={busy} type="button" variant="outline" size="lg" className="h-12 w-full gap-3" onClick={signInWithGoogle}>
            <GoogleLogo />
            Continue with Google
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "New to POULTRIX? Create account" : "Already have an account? Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}

/** Google "G" mark for the sign-in button (Google sign-in branding guidelines). */
function GoogleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-5 w-5 shrink-0">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}
