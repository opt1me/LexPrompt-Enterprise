<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# LexPrompt Enterprise

LexPrompt is a collaboration-first contract review app with:
- Template-based clause analysis and risk output.
- Workspace RBAC, comments, statuses, notifications, and activity feeds.
- Durable immutable review sessions per run with deep links.
- UK-first/EU-fallback residency controls.

## Quickstart (Local)

1. Install deps:
   - `npm install`
2. Copy `.env.example` to `.env.local`.
3. For OpenAI-only local testing, set:
   - `OPENAI_API_KEY=...`
   - `VITE_ALLOW_CLIENT_SIDE_AI=true` (or configure proxy route envs)
   - `VITE_KEY_POLICY=hybrid`
4. Run:
   - `npm run dev`
5. Open:
   - `http://localhost:3000`

Full local flow is documented in `docs/local-testing.md`.

## Durable Review Sessions + Deep Links

- Every completed analysis can be persisted as an immutable review session.
- Review sessions are scoped to a workspace and can be reopened later with:
  - original document viewer
  - clause findings
  - risk outputs
  - collaboration state (comments/status/activity)
- Direct links use query params: `?workspaceId=...&reviewId=...&view=results`
- Access is server-validated by workspace membership.

## Collaboration API

Implemented routes under `api/v1/...`:
- `POST/GET /api/v1/workspaces`
- `POST /api/v1/workspaces/{id}/invites`
- `POST/GET /api/v1/workspaces/{id}/members`
- `PATCH /api/v1/workspaces/{id}/members/{userId}`
- `GET/POST /api/v1/workspaces/{id}/events`
- `POST/GET /api/v1/findings/{findingId}/comments`
- `PATCH/GET /api/v1/findings/{findingId}/status`
- `GET /api/v1/activity?workspaceId=...`
- `GET/PATCH /api/v1/notifications?workspaceId=...`
- `POST/GET /api/v1/workspaces/{id}/reviews`
- `GET/DELETE /api/v1/workspaces/{id}/reviews/{reviewId}`
- `POST /api/v1/workspaces/{id}/reviews/upload-url`

## Auth Modes

- Hosted beta: Supabase Magic Link (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- Local fallback: demo auth via `VITE_ENABLE_DEMO_AUTH=true`.

## Key Policy Toggle

- `VITE_KEY_POLICY=platform`: users rely on your server-managed provider keys.
- `VITE_KEY_POLICY=byok`: users must enter their own provider key in Engine Settings.
- `VITE_KEY_POLICY=hybrid`: either server-managed or BYOK path is allowed.

## Residency + Hosting

- UK-first with EU fallback policy and no-training/min-retention controls.
- See:
  - `docs/uk-eu-beta-hosting.md`
  - `docs/local-testing.md`

## Documentation Suite

- `docs/README.md` (documentation index)
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/security-and-privacy.md`
- `docs/deployment.md`
- `docs/troubleshooting.md`

## Secret Safety

- Never commit `.env.local`.
- Use `.env.example` for template values only.
- Repo ignore policy explicitly excludes `.env*` secrets while allowing `.env.example`.
