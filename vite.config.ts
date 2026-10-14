import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Local-first development. No Cloudflare Worker runtime or dependency optimizer override.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), viteReact(), tailwindcss()],
});
