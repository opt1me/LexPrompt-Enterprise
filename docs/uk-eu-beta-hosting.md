# UK/EU Beta Hosting Guide

## Goal
Host LexPrompt beta in UK first, with EU fallback, and keep AI keys server-side.

## Platform Mapping
- Frontend + API: Vercel.
- Auth/DB/Realtime: Supabase (UK if available, otherwise EU).
- AI proxy: `api/ai/generate.ts` on Vercel serverless.

## Region Policy
- Primary region: UK (London).
- Fallback region: EU (Frankfurt or Ireland).
- No US region for production beta workloads.

## Required Environment Variables
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `VITE_AI_PROXY_URL=/api/ai/generate`
- `VITE_ALLOW_CLIENT_SIDE_AI=false`
- `VITE_USE_AI_PROXY=true`
- `VITE_KEY_POLICY=platform`
- `VITE_ENABLE_DEMO_AUTH=false`
- `ALLOW_INSECURE_DEMO_AUTH=false`
- `BETA_ALLOWED_EMAILS=...` and/or `BETA_ALLOWED_DOMAINS=...`

## Optional BYOK Mode
- Set `VITE_KEY_POLICY=byok` to force users to add their own keys in Engine Settings.
- In BYOK mode, keep `VITE_ALLOW_CLIENT_SIDE_AI=true` so client-side provider calls are allowed.
- The app shows an in-product policy banner for both `platform` and `byok`.

## Vercel Configuration
- `vercel.json` pins serverless functions to `lhr1` with `fra1` fallback.
- Deploy production only from protected branch.

## Supabase Setup
1. Create project in UK region if available, else EU region.
2. Enable email magic link authentication.
3. Apply collaboration schema from `supabase/schema.sql`.
4. Add row-level security policies for workspace isolation.
5. Keep storage and logs in the same selected geography.

## Compliance Notes
- App enforces residency settings in UI and analysis metadata.
- Analysis events are recorded with `provider/model/region/policyVersion` for audit review.
- Keep client-side AI fallback disabled in hosted beta.

## Operational Runbook
1. If UK region unavailable for a required service, use EU fallback and record exception.
2. Maintain approved model list by region.
3. Review audit events weekly during beta for region/policy drift.

## Model Profile (Efficiency-First)
- Google fast path: `gemini-2.5-flash-lite`
- Google balanced: `gemini-2.5-flash`
- OpenAI fast path: `gpt-5-nano`
- OpenAI balanced: `gpt-5-mini`
- Anthropic fast path: `claude-haiku-4-5`
- Anthropic balanced: `claude-sonnet-4-5`
