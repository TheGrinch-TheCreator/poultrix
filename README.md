# Poultrix — Independent Web Application

React 19 + TypeScript + TanStack Start + Tailwind CSS + Supabase. The original pages, dark/light mode, and skeleton loading components are retained.

## Local development

1. Install Node.js 22+ and run `npm install`.
2. Copy `.env.example` to `.env` and supply **your own** Supabase URL and publishable key.
3. Run `npm run dev`.

## Production deployment (Cloudflare Workers)

This project uses the Cloudflare Vite plugin. Set matching `VITE_SUPABASE_*` build variables and server-side `SUPABASE_*` variables in your deployment. Run `npm run build`, then `npx wrangler deploy`. Connect the GitHub repository to Cloudflare for automatic deployments.

## Important authentication and database notes

Google OAuth now uses standard `supabase.auth.signInWithOAuth`. Configure Google OAuth in **your own** Supabase project and whitelist your deployment URL as a redirect URL. The original project's Supabase database is **not** included in this ZIP; SQL migrations are retained in `supabase/migrations`. Review and apply them to your own project before expecting persistent data or working accounts.

The application contains demo data. This cleanup does not turn simulated data into live hardware telemetry. Never use demo data as evidence that sensors or actuators are connected.

## Changes

Removed proprietary build and authentication packages, editor preview session brokering, editor telemetry, project metadata, old hosted-service environment values, and generated dependency lockfile. Added standard Vite/TanStack/Cloudflare config and independent OAuth integration. Regenerate a lockfile with `npm install`.
