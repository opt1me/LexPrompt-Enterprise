# Architecture Overview

## Stack

- Frontend: React + Vite + TypeScript.
- API: Vercel serverless routes under `api/`.
- Persistence: Supabase (with in-memory/local fallback in dev paths).
- AI orchestration: provider router in `services/aiService.ts`.

## Core Domains

- Templates / playbooks: clause-based extraction and risk prompts.
- Analysis runs: per-clause execution with progress reporting.
- Review sessions: immutable persisted outputs with document references.
- Collaboration: workspaces, members, invites, comments, status, activity, notifications.

## Key Application Flows

### 1) Analysis Execution

1. User selects template + documents.
2. `analyzeContract(...)` runs clause-level calls (bounded concurrency).
3. Findings are normalized and rendered in results view.
4. If workspace is active, review session is persisted and appears in history.

### 2) Reopen and Share Reviews

1. Review sessions list loads per workspace.
2. User opens session or deep link (`workspaceId`, `reviewId`, `view=results`).
3. App fetches review detail and reconstructs document list.
4. Findings render with comments/status/activity context.

### 3) Collaboration

1. Workspace membership controls access to routes.
2. Comments and status updates are persisted via API.
3. Activity and notifications are read from workspace-scoped feeds.

## Persistence Layers

- Durable path: Supabase-backed tables in `supabase/schema.sql`.
- Fallback path: local storage/in-memory stores for local development.

## Runtime Configuration

- Auth mode: Supabase magic link or demo fallback.
- Key policy: `platform`, `byok`, `hybrid`.
- Residency policy: UK-first with EU fallback (as configured).
