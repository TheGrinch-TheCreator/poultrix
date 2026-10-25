import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Keep Cloudflare's runtime-only module external to the SSR bundle.
// It is provided by the Cloudflare Worker runtime after deployment.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), viteReact(), tailwindcss()],
  build: {
    rolldownOptions: {
      external: ['cloudflare:workers'],
    },
  },
});
