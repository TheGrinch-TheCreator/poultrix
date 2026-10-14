# Poultrix local setup

Run `npm install` then `npm run dev`.

This package removes Cloudflare-specific Vite integration and the custom server entry to allow TanStack Start to generate its normal development entry. Your UI code is unchanged.

The original project still requires your own Supabase environment variables for authenticated features. Do not deploy until `npm run build` succeeds.
