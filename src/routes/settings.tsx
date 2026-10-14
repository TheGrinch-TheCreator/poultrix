import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/poultrix/ThemeToggle";
import { Switch } from "@/components/ui/switch";
import { farm } from "@/lib/demo-data";
import { Card, CardTitle, PageHeader } from "@/components/poultrix/ui";

const FARM_NAME_KEY = "poultrix.farmName";
const FARM_LOCATION_KEY = "poultrix.farmLocation";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — POULTRIX" },
      { name: "description", content: "Farm details, notification preferences and system settings." },
      { property: "og:title", content: "Settings — POULTRIX" },
      { property: "og:description", content: "Farm details, notification preferences and system settings." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const [farmName, setFarmName] = useState(farm.name);
  const [farmLocation, setFarmLocation] = useState(farm.location);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    try {
      setFarmName(localStorage.getItem(FARM_NAME_KEY) ?? farm.name);
      setFarmLocation(localStorage.getItem(FARM_LOCATION_KEY) ?? farm.location);
    } catch {
      setSaveError("Browser storage is unavailable. Changes cannot be saved on this device.");
    }
  }, []);

  function saveFarmDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = farmName.trim();
    const location = farmLocation.trim();
    if (!name || !location) {
      setSaved(false);
      setSaveError("Enter both the farm name and location.");
      return;
    }
    try {
      localStorage.setItem(FARM_NAME_KEY, name);
      localStorage.setItem(FARM_LOCATION_KEY, location);
      setFarmName(name);
      setFarmLocation(location);
      setSaved(true);
      setSaveError("");
      window.dispatchEvent(new Event("poultrix:farm-updated"));
    } catch {
      setSaved(false);
      setSaveError("Unable to save farm details in this browser.");
    }
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle>Farm</CardTitle>
          <form onSubmit={saveFarmDetails} className="mt-4 space-y-4">
            <label className="block text-sm font-medium">
              Farm name
              <input
                type="text"
                value={farmName}
                maxLength={100}
                required
                onChange={(event) => { setFarmName(event.target.value); setSaved(false); }}
                placeholder="Enter farm name"
                className="mt-2 w-full rounded-lg border bg-background px-3 py-2"
              />
            </label>
            <label className="block text-sm font-medium">
              Location
              <input
                type="text"
                value={farmLocation}
                maxLength={160}
                required
                onChange={(event) => { setFarmLocation(event.target.value); setSaved(false); }}
                placeholder="Enter farm location"
                className="mt-2 w-full rounded-lg border bg-background px-3 py-2"
              />
            </label>
            <div className="flex items-center gap-3">
              <button type="submit" className="rounded-lg bg-[#010736] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 dark:bg-blue-700">
                Save changes
              </button>
              {saved && <span role="status" className="text-sm text-green-600 dark:text-green-400">Farm details saved</span>}
            </div>
            {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
            <p className="text-xs text-muted-foreground">
              Farm details are saved in this browser. Manage the number of birds on the Flock page.
            </p>
          </form>
        </Card>
        <Card>
          <CardTitle>Appearance</CardTitle>
          <ThemeToggle />
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
      <div className="mt-8 text-center">
        <a href="/bypass" className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground focus-visible:underline" aria-label="Open maintenance controls">Changing</a>
      </div>
    </>
  );
}
