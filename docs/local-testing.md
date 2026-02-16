# Local Testing Guide (Before Hosting)

## 1) Prerequisites
- Node.js 20+ (required by current dependencies).
- npm 10+ recommended.

## 2) Install dependencies
```bash
npm install
```

## 3) Configure environment
Create `.env.local` from `.env.example`.

Minimum local config (OpenAI-only test path):
```env
OPENAI_API_KEY=your_key
VITE_AI_PROXY_URL=/api/ai/generate
VITE_USE_AI_PROXY=auto
VITE_USE_COLLAB_API=auto
VITE_ALLOW_CLIENT_SIDE_AI=true
VITE_ENABLE_DEMO_AUTH=true
VITE_KEY_POLICY=hybrid
```

`GEMINI_API_KEY` and `ANTHROPIC_API_KEY` can be omitted for OpenAI-only local testing.

For durable collaboration testing with Supabase:
```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_ALLOW_CLIENT_SIDE_AI=false
VITE_ENABLE_DEMO_AUTH=false
VITE_KEY_POLICY=platform
```

Policy mode examples:
- `VITE_KEY_POLICY=platform` and `VITE_USE_AI_PROXY=true`: users do not need personal keys.
- `VITE_KEY_POLICY=byok` and `VITE_ALLOW_CLIENT_SIDE_AI=true`: users must add provider keys in Engine Settings.

## 4) (Optional but recommended) Provision Supabase schema
1. Open Supabase SQL editor.
2. Run `supabase/schema.sql`.
3. Confirm tables exist:
   - `workspaces`
   - `workspace_members`
   - `workspace_invites`
   - `review_sessions`
   - `review_documents`
   - `finding_comments`
   - `finding_status_history`
   - `activity_events`
   - `collaboration_events`
   - `notifications`

## 5) Run the app
```bash
npm run dev
```
Open `http://localhost:3000`.

## 6) Validate core collaboration flows
1. Login:
   - Supabase configured: use Magic Link login screen.
   - local fallback: use demo login.
2. Create/select a workspace from the header switcher.
3. Open Share Project modal and invite another email.
4. Open Members modal and change a member role.
5. Run an analysis and open results.
6. Add a discussion comment with mention (example: `@colleague@company.com`).
7. Change finding status (`open` -> `needs-review` -> `approved`).
8. Confirm activity timeline updates.
9. Confirm notifications show mention and can be marked read.

## 7) Validate durable review sessions + deep links
1. Complete an analysis and wait for success toast.
2. Return to dashboard and confirm entry appears under `Review History`.
3. Click `Open` and verify findings + document reopen correctly.
4. Click `Copy Link`, paste into a new browser tab, and confirm direct load to results.
5. Confirm link access is denied for non-members.
6. Delete a review (owner/admin) and verify it disappears from history and link no longer resolves.

OpenAI-only expected behavior:
- Template generation, analysis, chat, and table operations should all run with OpenAI when only `OPENAI_API_KEY` is configured.
- Gemini/Anthropic models remain selectable for BYOK users but are not required for local smoke testing.

## 8) Validate residency + provider metadata
1. Open Engine Settings and set residency mode/region.
2. Run analysis and verify provider/model/region tags appear in results header.
3. Confirm audit preview in settings updates with new analysis events.

## 9) Build verification
```bash
npm run build
```

## Notes
- If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not set, collaboration uses in-memory fallback for local-only testing.
- Hosted beta should disable client-side AI fallback:
  - `VITE_ALLOW_CLIENT_SIDE_AI=false`
