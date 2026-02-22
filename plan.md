# Implementation Plan (Living)

## Objective
Deliver a durable, collaboration-enabled LexPrompt beta with UK/EU hosting controls, efficient model defaults, and local-to-hosted testability.

## Workstreams

### 1) Durable Collaboration Backend
- [x] Define collaboration entities and API surface.
- [x] Implement API routes for workspace/invite/member/comment/status/activity/events/notifications.
- [x] Replace in-memory-only repository with Supabase-backed persistence (fallback for local dev).
- [x] Add SQL schema + RLS policy starter.

### 2) Model Efficiency
- [x] Refresh model catalog to efficient current models for Google/OpenAI/Anthropic.
- [x] Add task-level default routing (fast extraction/chat vs deep analysis).
- [x] Update UI labels and cost heuristics.

### 3) Developer Experience
- [x] Add UK/EU hosting documentation.
- [x] Add full local test guide (API + collaboration + model checks).
- [x] Add hosted beta checklist (Vercel + Supabase).

## Notes
- Collaboration storage uses Supabase when configured; in-memory fallback remains for local-only fast testing.
- Node.js 20+ should be used for local and hosted builds.

## Current Fix Sprint

### Defaults (Locked)
- Citation mode: **Exact Quote First**
- Progress mode: **Clause Progress Panel**
- Upload mode: **List + Remove + Replace**

### Workstream A: Citation Fidelity and UX
- [x] Add citation sanitation/normalization pipeline in `services/aiService.ts`.
- [x] Enforce exact-quote-only citation instructions in analysis prompting.
- [x] Ensure `citations: string[]` delivered to UI are cleaned and deduplicated.
- [x] Restore citation hover with tooltip (`title`) in `components/ResultsView.tsx`.
- [x] Add clickable citation diagnostics with `onHighlightResult(matches)` in `components/PDFViewer.tsx`.
- [x] Show non-blocking toast when citation has no exact match.

Acceptance criteria:
- `VERBATIM REF` hover shows exact cleaned citation text.
- Clicking a valid citation highlights at least one matching text area.
- Clicking an unmatched citation shows `No exact match found for citation`.

### Workstream B: Clause Progress Panel
- [x] Extend `analyzeContract(...)` with optional per-clause progress callback.
- [x] Execute clause analysis independently with bounded concurrency (`2` default).
- [x] Aggregate clause-level outputs into final normalized findings map.
- [x] Add processor progress state in `App.tsx`.
- [x] Render global progress + per-clause status rows while analysis is running.
- [x] Keep partial-failure behavior: completed clauses render, failed clauses get placeholders.

Acceptance criteria:
- Clauses transition through `queued -> running -> done/error`.
- Users see live per-clause progress while analysis is active.
- Partial failures do not block completed results from rendering.

### Workstream C: Upload Manager (List/Remove/Replace)
- [x] Add uploaded document list panel in processor view under upload area.
- [x] Display metadata (name, type, size; plus char/page counts when available).
- [x] Add row actions: `Remove`, `Replace`; plus `Clear All`.
- [x] Preserve row position on replace.
- [x] Recompute analysis credit/cost immediately after any list mutation.
- [x] Disable upload-edit actions while analysis is active.
- [x] Show `N document(s) ready` near analyze CTA.

Acceptance criteria:
- Uploaded files are visible and manageable before analysis.
- Analyze button is disabled when no documents are present.
- Remove/replace/clear actions update list and cost immediately.

### Follow-up Tuning (Latency + Brevity)
- [x] Reduce per-clause prompt size via local snippet retrieval instead of full-document context.
- [x] Increase safe clause concurrency from `2` to `4`.
- [x] Add per-call output token caps for provider requests.
- [x] Enforce concise `risk_analysis` output in prompt rules.
- [x] Normalize/compact long `risk_analysis` strings post-response.

Acceptance criteria:
- Short/medium agreements complete materially faster than prior full-text-per-clause path.
- `RISK ASSESSMENT` appears as a concise summary instead of long-form legal essay output.

## Current Sprint: Durable Review Sessions + Deep Links

### Defaults (Locked)
- Persistence mode: **File + Findings**
- Share access: **Workspace-gated deep links**
- Versioning: **Immutable sessions per run**
- Auth for beta: **Supabase Magic Link**

### Workstream D: Durable Session Persistence
- [x] Add review session/domain types in `types.ts`.
- [x] Add review persistence schema (`review_sessions`, `review_documents`) in `supabase/schema.sql`.
- [x] Add backend persistence handlers in `api/_lib/collabStore.ts`.
- [x] Add review API routes (`POST/GET /reviews`, `GET/DELETE /reviews/{id}`, `POST /reviews/upload-url`).
- [x] Persist completed analysis runs as immutable review sessions.

Acceptance criteria:
- Completed analyses are saved with findings and document references.
- Each run produces a distinct immutable review session ID.

### Workstream E: Reopen + Deep Link Navigation
- [x] Add deep-link query parsing/sync (`workspaceId`, `reviewId`, `view`) in `App.tsx`.
- [x] Add loader to open persisted review sessions and reconstruct documents.
- [x] Add workspace review-history state and backend fetch flow.
- [x] Add review history UI list with open/delete actions.
- [x] Add graceful missing-document warning while retaining findings view.

Acceptance criteria:
- User can reopen prior analyses from workspace history.
- Query-parameter link opens the exact review for authorized members.

### Workstream F: Sharing + Auth UX
- [x] Add review permalink generator helper.
- [x] Add `Copy Review Link` in results header.
- [x] Add optional `Copy link to this review` inside share modal.
- [x] Replace demo-first login with Supabase magic-link screen when configured.
- [x] Keep explicit demo fallback via env flag for local development.

Acceptance criteria:
- User can copy/share a direct link to the active review.
- Supabase auth flow works for invite-only beta; demo fallback remains opt-in for dev.

### Workstream G: Key Policy Toggle (Platform vs BYOK)
- [x] Add env-driven key policy flag: `VITE_KEY_POLICY=platform|byok|hybrid`.
- [x] Enforce policy in AI execution path (`services/aiService.ts`).
- [x] Add analysis preflight guard for BYOK mode in `App.tsx`.
- [x] Add in-app policy notification banner with Settings shortcut.
- [x] Add policy guidance in Engine Settings modal.
- [x] Update `.env.example` + docs for deployment configuration.

Acceptance criteria:
- In `platform` mode, users are informed they do not need personal keys.
- In `byok` mode, analysis is blocked until user adds a provider key in settings.
- Policy behavior is configurable by env without code changes.

## Current Sprint: Security Audit Hardening (Private Beta)

### Defaults (Locked)
- Security profile: **Essential Hardened**
- Retention policy: **Findings-First**
- Access model: **Invite + Allowlist**
- Production key mode: **Platform Managed**

### Workstream H: Auth and Identity
- [x] Replace header-trusted identity with verified bearer auth on API routes.
- [x] Gate insecure demo auth behind explicit non-production server flag.
- [x] Enforce beta allowlist checks (`BETA_ALLOWED_EMAILS`, `BETA_ALLOWED_DOMAINS`).
- [x] Update frontend API client to send bearer token from Supabase session.
- [x] Enforce workspace membership checks on notifications read/update routes.

### Workstream I: AI Proxy Lockdown
- [x] Require auth + workspace membership for `/api/ai/generate`.
- [x] Require `workspaceId` in AI proxy payload.
- [x] Add model allowlist and payload-size/token caps.
- [x] Add IP + actor rate limiting and audit activity events for AI calls.
- [x] Set `store: false` on OpenAI Responses calls (proxy + BYOK fallback) for minimal retention.

### Workstream J: Invite and Token Security
- [x] Replace weak invite token generation with cryptographic random.
- [x] Store invite token hash only; return raw token once for invite links.
- [x] Enforce short invite expiry (48h) and one-time acceptance.

### Workstream K: Data Minimization
- [x] Add workspace retention setting (`retainSourceDocuments`).
- [x] Add workspace settings API (`GET/PATCH /workspaces/{id}/settings`).
- [x] Default to findings-only persistence; source payload persistence is opt-in.
- [x] Add in-app retention indicator.

### Workstream L: Config, Headers, and Docs
- [x] Remove client bundle injection of server API keys from Vite config.
- [x] Add baseline security headers in `vercel.json`.
- [x] Set secure defaults in `.env.example` and auth service defaults.
- [x] Update docs (`README.md`, `docs/api-reference.md`, `docs/local-testing.md`, `docs/deployment.md`, `docs/security-and-privacy.md`).
- [ ] Replace all third-party runtime CDN scripts with bundled npm dependencies.
  Blocked in this environment due offline npm cache restrictions (`ENOTCACHED`).
