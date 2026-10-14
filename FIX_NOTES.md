# Repair attempt — server entry and plugin initialization

The prior ZIPs used a custom `src/server.ts` that dynamically imported TanStack Start's generated server entry. This can trigger dependency prebundling in the Cloudflare worker runner before TanStack's virtual `#tanstack-*` imports are available.

Changes:
- Replaced dynamic server-entry import with a direct re-export.
- Removed custom `server.entry` plugin override and dependency optimizer workarounds.
- Moved Cloudflare plugin before TanStack Start to initialize its worker environment first.

**Not runtime verified:** dependency installation timed out in this environment. Please test `npm install`, `npm run dev`, and `npm run build` before deployment. If the same error persists, send the new log; the underlying TanStack/Cloudflare/Vite package compatibility will need investigation.
