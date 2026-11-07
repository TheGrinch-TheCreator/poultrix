// Build for the maintenance console (a small React app, separate from the
// TanStack main app). `@/` points at the main app's src so UI components and
// styles are shared.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
});
