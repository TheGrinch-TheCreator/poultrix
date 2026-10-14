import { Moon, Sun } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-3 text-sm">
      <span className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-surface text-foreground">
          {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </span>
        <span>
          <span className="block font-medium">Dark mode</span>
          <span className="block text-xs text-muted-foreground">{dark ? "Dark navy theme is on" : "Light theme is on"} · saved on this device</span>
        </span>
      </span>
      <Switch checked={dark} onCheckedChange={(v) => setTheme(v ? "dark" : "light")} aria-label="Dark mode" />
    </label>
  );
}
