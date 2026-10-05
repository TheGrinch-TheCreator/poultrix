import { createFileRoute } from "@tanstack/react-router";
import { Switch } from "@/components/ui/switch";
import { farm } from "@/lib/demo-data";
import { Card, CardTitle, PageHeader } from "@/components/poultrix/ui";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — POULTRIX" },
      { name: "description", content: "Farm details, notification preferences and batch settings." },
      { property: "og:title", content: "Settings — POULTRIX" },
      { property: "og:description", content: "Farm details, notification preferences and batch settings." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle>Farm</CardTitle>
          <dl className="space-y-3 text-sm">
            {[["Farm name", farm.name], ["Location", farm.location], ["Current batch", farm.batch], ["Birds", String(farm.birds)]].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b pb-2"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
            ))}
          </dl>
        </Card>
        <Card>
          <CardTitle>Notifications</CardTitle>
          {["Critical alerts", "Low feed warnings", "Finisher stage reminder", "Connection problems"].map((n) => (
            <label key={n} className="flex items-center justify-between border-b py-3 text-sm last:border-0"><span>{n}</span><Switch defaultChecked /></label>
          ))}
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle>Automatic control</CardTitle>
          <p className="text-sm text-muted-foreground">Stage targets for feed, temperature and lighting are set by POULTRIX from the growth cycle. Changing them from the web is TBD / requires implementation decision.</p>
          <p className="mt-2 text-sm font-medium">Defaults use Philippine climate standards: Starter 32–34°C (first week), Grower 26–28°C, Finisher 24–26°C.</p>
        </Card>
      </div>
    </>
  );
}
