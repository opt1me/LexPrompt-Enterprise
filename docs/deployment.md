# Deployment Guide (Vercel + Supabase)

## 1) Prepare Environment Variables

Server:

- `OPENAI_API_KEY` (and/or other provider keys)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOW_INSECURE_DEMO_AUTH=false`
- `BETA_ALLOWED_EMAILS=...` (optional)
- `BETA_ALLOWED_DOMAINS=...` (optional)

Client/runtime:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_USE_AI_PROXY=true`
- `VITE_ALLOW_CLIENT_SIDE_AI=false`
- `VITE_KEY_POLICY=platform`
- `VITE_ENABLE_DEMO_AUTH=false`

## 2) Supabase Setup

1. Provision project in UK if available, else EU fallback.
2. Apply `supabase/schema.sql`.
3. Enable Magic Link auth.
4. Confirm required tables and RLS policies exist.

## 3) Vercel Setup

1. Import repository.
2. Configure env vars in project settings.
3. Confirm `vercel.json` function regions (`lhr1` primary, `fra1` fallback).
4. Deploy from protected branch.

## 4) Post-Deploy Validation

1. Sign in via magic link.
2. Create workspace and invite collaborator.
3. Run analysis and verify review appears in history.
4. Copy deep link and open from another session.
5. Confirm non-member access is denied.

## 5) Optional BYOK Release Mode

If you want BYOK:

- `VITE_KEY_POLICY=byok`
- `VITE_USE_AI_PROXY=false`
- `VITE_ALLOW_CLIENT_SIDE_AI=true`

The app will show users they must add keys in Engine Settings.
