import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, UserRound } from "lucide-react";
import { NAV } from "@/components/poultrix/AppShell";
import { PageHeader } from "@/components/poultrix/ui";

export const Route = createFileRoute("/more")({
  head: () => ({
    meta: [
      { title: "Menu — POULTRIX" },
      { name: "description", content: "All POULTRIX sections." },
      { property: "og:title", content: "Menu — POULTRIX" },
      { property: "og:description", content: "All POULTRIX sections." },
    ],
  }),
  component: MorePage,
});

function MorePage() {
  return (
    <>
      <PageHeader title="Menu" />
      <div className="card-surface divide-y">
        {[...NAV.filter((n) => !["/", "/feeding", "/environment", "/ai-stage"].includes(n.to)), { to: "/profile", label: "Profile", icon: UserRound } as const].map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className="flex items-center gap-3 p-4 font-semibold">
            <Icon className="h-5 w-5 text-primary" /><span className="flex-1">{label}</span><ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </>
  );
}
