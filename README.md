<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# LexPrompt Enterprise

LexPrompt is a collaboration-first contract review app with:
- Template-based clause analysis and risk output.
- Workspace RBAC, comments, statuses, notifications, and activity feeds.
- Durable immutable review sessions per run with deep links.
- UK-first/EU-fallback residency controls.

## Latest Release Notes

- Security hardening for private beta:
  - verified bearer-token auth on API routes
  - workspace-enforced authorization for collaboration and AI proxy actions
  - cryptographically strong invite tokens (hashed at rest, one-time, expiring)
  - rate limiting for auth and AI proxy paths
  - platform-managed key safety (no server provider keys injected into client bundle)
- Findings-first retention by default:
  - source documents are not persisted unless workspace setting explicitly enables retention
- Durable review sessions:
  - immutable saved analysis runs with workspace-scoped deep links
- Collaboration upgrades:
  - comments, status history, activity feed, notifications, and review history in workspace context
- UK/EU beta hosting posture:
  - UK-first with EU fallback policy docs and deployment guides

## Quickstart (Local)

1. Install deps:
   - `npm install`
2. Copy `.env.example` to `.env.local`.
3. For OpenAI-only local testing, set:
   - `OPENAI_API_KEY=...`
   - `VITE_KEY_POLICY=byok`
   - `VITE_ALLOW_CLIENT_SIDE_AI=true`
   - `VITE_USE_AI_PROXY=false`
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
- Local fallback: demo auth via `VITE_ENABLE_DEMO_AUTH=true` plus server `ALLOW_INSECURE_DEMO_AUTH=true`.

## Key Policy Toggle

- `VITE_KEY_POLICY=platform`: users rely on your server-managed provider keys.
- `VITE_KEY_POLICY=byok`: users must enter their own provider key in Engine Settings.
- `VITE_KEY_POLICY=hybrid`: either server-managed or BYOK path is allowed.

## API Security Baseline

- API routes require `Authorization: Bearer <supabase_access_token>`.
- AI proxy (`/api/ai/generate`) requires authenticated workspace membership and `workspaceId` in the request body.
- Private beta allowlist can be enforced with `BETA_ALLOWED_EMAILS` / `BETA_ALLOWED_DOMAINS`.

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
