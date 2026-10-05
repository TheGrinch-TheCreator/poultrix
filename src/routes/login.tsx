import { createFileRoute, useNavigate } from "@tanstack/react-router";
import flockImg from "@/assets/flock-camera.jpg";

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
        <form
          className="w-full max-w-sm space-y-4"
          onSubmit={(e) => { e.preventDefault(); nav({ to: "/" }); }}
        >
          <h1 className="text-3xl font-bold">Sign in</h1>
          <p className="text-muted-foreground">Demo mode — any details will work.</p>
          <input required type="email" placeholder="Email" className="w-full rounded-xl border bg-card px-4 py-3.5" />
          <input required type="password" placeholder="Password" className="w-full rounded-xl border bg-card px-4 py-3.5" />
          <button className="w-full rounded-xl bg-primary py-3.5 font-semibold text-primary-foreground hover:bg-primary/90">Sign in</button>
        </form>
      </div>
    </div>
  );
}
