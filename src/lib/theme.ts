import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export const THEME_KEY = "px-theme";

/** Inline, render-blocking script placed in <head> so the saved theme applies before first paint (no flash). */
export const themeInitScript = `try{var t=localStorage.getItem('${THEME_KEY}');var d=document.documentElement;if(t==='dark'){d.classList.add('dark');d.style.colorScheme='dark'}else{d.style.colorScheme='light'}}catch(e){}`;

function apply(theme: Theme, animate: boolean) {
  const root = document.documentElement;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (animate && !reduce) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 260);
  }
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/** Single source of truth for the theme. Syncs across tabs via the storage event. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    setThemeState(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      const next: Theme = e.newValue === "dark" ? "dark" : "light";
      apply(next, true);
      setThemeState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    apply(next, true);
    setThemeState(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  }, []);

  return { theme, setTheme };
}
