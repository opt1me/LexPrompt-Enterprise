# Security and Privacy

## Secrets and Local Safety

- `.env.local` must never be committed.
- Repo ignore rules include:
  - `.env`
  - `.env.local`
  - `.env.*`
  - `!.env.example`
- Use `.env.example` for non-secret templates only.

## API Key Modes

Controlled by `VITE_KEY_POLICY`:

- `platform`: users rely on server-managed keys.
- `byok`: users must provide keys in Engine Settings.
- `hybrid`: both routes allowed.

## Document Handling

- Documents are processed for clause-level analysis and review rendering.
- Persisted review sessions default to findings-first retention (`retainSourceDocuments=false`).
- Source document payloads are persisted only when workspace retention is explicitly enabled.
- Access to persisted content is workspace-scoped.
- OpenAI Responses requests are sent with `store=false` to minimize provider-side retention.

## Encryption

- In transit: TLS/HTTPS.
- At rest: provider-managed encryption (Vercel/Supabase infrastructure).
- App-layer encryption: not enabled by default in current beta.

## Access Control

- Workspace membership and role checks run on API routes.
- API identity is derived from verified Supabase bearer tokens (not trusted headers).
- Invite and member role changes are tracked in activity events.

## Operational Recommendations

1. Keep `VITE_ALLOW_CLIENT_SIDE_AI=false` in hosted production.
2. Prefer `VITE_KEY_POLICY=platform` for controlled spend/compliance.
3. Rotate provider API keys regularly.
4. Restrict Supabase service role key to server environment only.
5. Keep `ALLOW_INSECURE_DEMO_AUTH=false` in hosted environments.
6. Use `BETA_ALLOWED_EMAILS` / `BETA_ALLOWED_DOMAINS` to restrict private beta access.
7. Review workspace activity and notification feeds during beta.
