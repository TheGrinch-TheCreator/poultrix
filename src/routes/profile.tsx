import { createFileRoute, Link } from "@tanstack/react-router";
import { UserRound } from "lucide-react";
import { farm } from "@/lib/demo-data";
import { Card, PageHeader } from "@/components/poultrix/ui";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "Profile — POULTRIX" },
      { name: "description", content: "Your POULTRIX account and farm access." },
      { property: "og:title", content: "Profile — POULTRIX" },
      { property: "og:description", content: "Your POULTRIX account and farm access." },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  return (
    <>
      <PageHeader title="Profile" />
      <Card className="max-w-xl">
        <div className="flex items-center gap-4">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-secondary text-secondary-foreground"><UserRound className="h-7 w-7" /></div>
          <div>
            <div className="font-display text-xl font-bold">John Karl Dueñas</div>
            <div className="text-sm text-muted-foreground">Farm owner · {farm.name}</div>
          </div>
        </div>
        <Link to="/login" className="mt-6 inline-flex rounded-lg border px-4 py-2 text-sm font-semibold hover:bg-muted">Sign out</Link>
      </Card>
    </>
  );
}
