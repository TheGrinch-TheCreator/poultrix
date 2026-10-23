import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { type ReactNode } from "react";

import appCss from "../styles.css?url";
import { AppShell } from "@/components/poultrix/AppShell";
import { themeInitScript } from "@/lib/theme";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import { getMyFarm } from "@/lib/farm-store";
import { PageSkeleton } from "@/components/poultrix/PageSkeleton";
import { useRef } from "react";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">The page you're looking for doesn't exist or has been moved.</p>
        <div className="mt-6">
          <Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">Something went wrong on our end. You can try refreshing or head back home.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <a href="/" className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent">
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "POULTRIX — Automated Broiler Management" },
      { name: "description", content: "Monitor feeding, temperature, lighting and AI growth stage of your broiler flock." },
      { name: "author", content: "POULTRIX Team" },
      { property: "og:title", content: "POULTRIX — Automated Broiler Management" },
      { property: "og:description", content: "Monitor feeding, temperature, lighting and AI growth stage of your broiler flock." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Figtree:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Keep the verified account view during client-side route remounts.
// This cache is per browser page load, not persisted across reloads.
let accountVerifiedThisPage = false;

function RootComponent() {
  const router = useRouter();
  const { queryClient } = Route.useRouteContext();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const bare = path === "/login" || path === "/farm-setup";
  const [guard, setGuard] = useState<"checking" | "ready" | "error">(accountVerifiedThisPage ? "ready" : "checking");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const navigating = useRouterState({ select: (s) => s.isLoading });

  useEffect(() => {
    let alive = true;
    const withTimeout = <T,>(promise: PromiseLike<T>, label: string): Promise<T> =>
      Promise.race([
        Promise.resolve(promise),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after 12 seconds. Check Supabase URL, network, and database policies.`)), 12000)),
      ]);

    // Revalidate in the background after initial verification; do not blank every page.
    if (!accountVerifiedThisPage) setGuard("checking");
    setMessage("");
    (async () => {
      try {
        const { data, error } = await withTimeout(supabase.auth.getSession(), "Authentication");
        if (error) throw error;
        if (!alive) return;
        if (!data.session) {
          accountVerifiedThisPage = false;
          if (pathRef.current !== "/login") { await router.navigate({ to: "/login", replace: true }); return; }
        } else {
          const farm = await withTimeout(getMyFarm(), "Farm lookup");
          if (!alive) return;
          if (!farm && pathRef.current !== "/farm-setup") { await router.navigate({ to: "/farm-setup", replace: true }); return; }
          if (farm && (pathRef.current === "/login" || pathRef.current === "/farm-setup")) { await router.navigate({ to: "/", replace: true }); return; }
        }
        if (alive) {
          accountVerifiedThisPage = true;
          setGuard("ready");
        }
      } catch (err) {
        console.error("Poultrix account check failed:", err);
        if (alive) {
          setMessage(err instanceof Error ? err.message : "Unable to check your account.");
          if (!accountVerifiedThisPage) setGuard("error");
        }
      }
    })();
    return () => { alive = false; };
  }, [attempt, router]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      // Do not query Supabase from within the auth callback: it can deadlock token refresh.
      if (event === "SIGNED_OUT") {
        accountVerifiedThisPage = false;
        setGuard("checking");
      }
      router.invalidate();
      setAttempt((n) => n + 1);
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      {guard === "checking" ? (
        <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Checking your account…</div>
      ) : guard === "error" ? (
        <div className="flex min-h-screen items-center justify-center bg-background px-4">
          <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 text-center">
            <h1 className="text-xl font-semibold text-foreground">Account check failed</h1>
            <p className="break-words text-sm text-muted-foreground">{message}</p>
            <p className="text-xs text-muted-foreground">Check that your Supabase project is reachable and the farms table exists with the correct policies.</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Try again</button>
          </div>
        </div>
      ) : bare ? <Outlet /> : <AppShell>{navigating ? <PageSkeleton path={path} /> : <Outlet />}</AppShell>}
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  );
}
