# LexPrompt Core — Design

**Date:** 2026-08-26
**Status:** Approved for planning
**Supersedes:** the "LexPrompt Enterprise" direction (Firebase auth, credits, three vendor SDKs)

## 1. Purpose

Return LexPrompt to its original product idea and make it stable enough to host and demo:

1. Pick a contract type. The app generates a review template — a set of clauses a reviewer would normally check for that contract type, each with a prompt that extracts it from a document.
2. Edit that template freely and save it.
3. Run the saved template against one document or a batch.
4. Read the findings as cards, each linking to the exact supporting text, with a document viewer alongside.

The enterprise scaffolding added later (authentication, a simulated credit economy, three provider SDKs) obscured this loop and left the app unable to complete a single AI call in the browser. That scaffolding is removed.

## 2. Constraints

- **No backend.** Static files only. Deployable to Firebase Hosting, Netlify, Vercel, or GitHub Pages with no server, no database, no configuration.
- **Bring your own key, via OpenRouter.** A single OpenAI-compatible endpoint replaces the Gemini, OpenAI and Anthropic SDKs.
- **Feature parity in v1.** Card review, tabular review, risk mode, DOCX export, and the assistant features (chat, draft email, suggest revision) all ship in the first stable version.
- **Stability is the deliverable.** This version is the foundation later features are built on, so correctness and test coverage matter more than new capability.

## 3. What is wrong today

Recorded because the plan must verify each of these is fixed.

| # | Defect | Location | Effect |
|---|---|---|---|
| 1 | `process.stdout.write`, `process.env.DEBUG_AI`, `import fs from 'fs'` in browser code | `services/aiService.ts:58`, `services/ai/providers/openaiProvider.ts:2,32` | `process` is undefined in the browser; Vite only substitutes `process.env.API_KEY`. Every AI call throws. |
| 2 | pdf.js accessed via `window['pdfjs-dist/build/pdf']` while `index.html` initialises `window.pdfjsLib` | `services/docService.ts:12`, `components/PDFViewer.tsx:78` | PDF text extraction and the viewer read an undefined global. |
| 3 | Firestore rules gate on `resource.data.userId`; writes use `createdById`, and the query has no owner filter | `firestore.rules:23`, `services/dbService.ts:32,60` | Every read and write is denied under the deployed rules. |
| 4 | Tailwind class template literals mangled into `flex - 1 py - 3 text - sm` | `components/ResultsView.tsx:184,206,250` | Those elements render unstyled. |
| 5 | Fictional model IDs (`gemini-3.0-pro`, `gpt-5.2`, `claude-opus-4-6`, `gpt-5-mini`) | all three provider files, `services/aiService.ts:88` | No provider accepts these identifiers. |
| 6 | `chunk.text()` called on a getter | `services/ai/providers/geminiProvider.ts:104` | The only defect `tsc --noEmit` reports. |
| 7 | Retry wrapper retries all failures three times with backoff | `services/aiService.ts:55` | An invalid API key takes several seconds and three requests to report. |
| 8 | Single analysis call: one JSON schema of up to 35 properties over 500k characters | `services/aiService.ts:244` | No progress, no partial results, no per-clause retry; one bad clause fails the document. |

Defect 8 is a design problem rather than a bug, and section 5 addresses it.

## 4. Architecture

### 4.1 Module layout

```
index.html
src/
  main.tsx                       mount + error boundary
  App.tsx                        shell: view routing, toast host, settings gate
  types.ts                       shared domain types
  lib/
    openrouter.ts                OpenRouter client (fetch only)
    storage.ts                   template persistence + import/export + migration
    documents.ts                 File -> DocumentFile
    citations.ts                 quote -> page rectangles (pure)
    concurrency.ts               bounded parallel map
    debug.ts                     import.meta.env.DEV logging
  features/
    templates/
      TemplateLibrary.tsx
      TemplateEditor.tsx
      CreateTemplateDialog.tsx
      generateTemplate.ts
    review/
      RunPanel.tsx               upload + run controls
      runReview.ts               orchestrates the doc x clause matrix
      extractClause.ts           one clause against one document
      ResultsView.tsx            card view
      FindingCard.tsx
      DocumentViewer.tsx         PDF or text
      PdfCanvas.tsx              lazy-loaded pdf.js renderer
      exportDocx.ts              lazy-loaded report builder
    tabular/
      TabularReview.tsx          grid view over the same findings map
      CellDetail.tsx
    assistant/
      ChatPanel.tsx
      draftEmail.ts
      suggestRevision.ts
    settings/
      SettingsPanel.tsx          API key + model selection
  components/
    Modal.tsx  Toast.tsx  AutoResizeTextarea.tsx  Button.tsx  RiskBadge.tsx
```

`App.tsx` shrinks from 551 lines to routing and toast hosting. Extracting `citations.ts` from `PDFViewer` is the highest-value structural change in this list: the quote-matching algorithm is the app's most valuable and most regression-prone code, and it is currently untestable because it lives inside a `useMemo` in a React component.

### 4.2 Removed

`firebase`, `@google/genai`, `openai`, `@anthropic-ai/sdk` as dependencies.

`firebase.ts`, `services/dbService.ts`, `components/Login.tsx`, `firestore.rules`, `bench.ts`, `debug_imports.ts`, `test_responses.ts` as files.

The `COSTS` map and every credit check, balance display and top-up control.

The `UserProfile` and `UserRole` types, which no longer have a subject.

The simulated "Modify template with AI" handler (`App.tsx:190`).

All CDN `<script>` tags in `index.html`.

`firebase.json` and `.firebaserc` are both kept. Between them they configure static hosting and name the deploy target, which is what `npm run hosting:on` needs; neither references Firestore or Auth once `firestore.rules` is gone.

The `AnalysisResult`, `TabularData` and `TabularCell` types are superseded by `ReviewRun` and `Finding` (section 6) rather than deleted outright — the tabular view keeps working, but reads the shared findings map instead of its own parallel structure. `DocumentFile` is renamed field-by-field in the same section; every call site moves with it.

### 4.3 Added as npm dependencies

`pdfjs-dist` (with the worker resolved through Vite rather than a CDN global), `mammoth`, `docx`, and `tailwindcss` with its Vite integration. Replacing the CDN globals removes defect 2 as a class of bug rather than as an instance, and CDN Tailwind is explicitly not supported for production use.

`PdfCanvas.tsx` and `exportDocx.ts` are dynamically imported so `pdfjs-dist` and `docx` stay out of the initial bundle.

## 5. The review engine

### 5.1 One engine, two views

Card review and tabular review are two renderings of one data structure, not two pipelines. A single function extracts one clause from one document:

```ts
extractClause(
  doc: DocumentFile,
  clause: Clause,
  template: Template,
  signal: AbortSignal
): Promise<Finding>
```

`runReview` maps it across the document x clause matrix through a bounded concurrency limiter (default 5 in flight, configurable in settings), writing each result into a single findings map as it resolves.

- **Card view** renders one document's column of that map, ordered by the template's clause order.
- **Tabular view** renders the whole matrix, documents as rows, clauses as columns.

This is what makes shipping both views affordable: the second view is a renderer, not a second engine. It also resolves defect 8 — progress is observable, results are partial-safe, a failed clause retries alone, and no document is truncated to fit one oversized request.

### 5.2 Failure isolation

A clause that fails after its retries resolves to `{ status: 'error', error }` rather than rejecting. The run completes. The affected card shows the error and a Retry control that re-invokes `extractClause` for that cell only. A run can be cancelled via `AbortSignal`; in-flight requests abort and queued ones never start.

### 5.3 Template generation

The existing two-phase generator (`services/aiService.ts:116`) is kept substantially as-is, because it is sound: phase one plans the clause list at the requested depth, phase two generates each clause's prompt and risk criteria in parallel. It moves to `features/templates/generateTemplate.ts` and gains the same bounded concurrency and failure isolation as the review engine, so a single failed clause degrades the template rather than failing generation.

## 6. Data model

```ts
type RiskLevel = 'High' | 'Medium' | 'Low' | 'Info';

interface Clause {
  id: string;
  title: string;
  prompt: string;
  riskCriteria?: string;
}

interface Template {
  id: string;
  name: string;
  contractType: string;
  mode: 'extraction' | 'risk';
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance?: string;
  clauses: Clause[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}

interface DocumentFile {
  id: string;
  name: string;
  text: string;
  file: File;
  kind: 'pdf' | 'docx' | 'txt';
  pageImages?: { mime: string; data: string }[];   // scanned pages only
}

interface Finding {
  clauseId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  summary?: string;
  citations: string[];
  riskLevel?: RiskLevel;
  riskAnalysis?: string;
  error?: string;
  edited?: boolean;
}

interface ReviewRun {
  id: string;
  templateSnapshot: Template;      // frozen, so later edits do not rewrite history
  documentIds: string[];
  findings: Record<string, Record<string, Finding>>;   // docId -> clauseId -> Finding
  startedAt: number;
  completedAt?: number;
}
```

`templateSnapshot` is a copy rather than a reference so that editing a template after a run does not silently change what the results claim to have checked.

`schemaVersion` exists so `storage.ts` can migrate templates saved by earlier builds instead of discarding them.

## 7. Storage

`lib/storage.ts` is the only module that touches `localStorage`. Its interface is deliberately narrow and Promise-returning, so a remote implementation can replace it later without changing any caller:

```ts
listTemplates(): Promise<Template[]>
getTemplate(id: string): Promise<Template | null>
saveTemplate(t: Template): Promise<Template>
deleteTemplate(id: string): Promise<void>
exportTemplate(t: Template): Blob
importTemplate(json: string): Promise<Template>
```

Templates are stored under a single versioned key. `importTemplate` validates shape before accepting, and runs the same migration path as load, so a template exported from an older build imports cleanly.

Documents and review runs are session state only. They are held in memory and are not persisted: contract text is the most sensitive thing the app handles, and writing it to `localStorage` on a machine used for demos is not a trade worth making. This is a deliberate decision, not an omission.

**Out of scope, noted:** templates currently in the Firebase project are not migrated automatically. If any are worth keeping, a one-off export is a separate task.

## 8. OpenRouter client

`lib/openrouter.ts` is a single module with no vendor SDK:

```ts
listModels(): Promise<ModelInfo[]>
chat(req: ChatRequest, signal?: AbortSignal): Promise<string>
chatStream(req: ChatRequest, onDelta: (s: string) => void, signal?: AbortSignal): Promise<string>
```

**Model list.** Fetched from `GET https://openrouter.ai/api/v1/models` at runtime and cached for the session, rather than hardcoded. This is what permanently resolves defect 5: there is no static list to fall out of date. The picker surfaces each model's context length and pricing, and marks models that advertise structured-output support so the user is not silently steered onto one that cannot honour a schema.

The first implementation task is to call that endpoint once and record its actual response shape — specifically the field naming for pricing, context length, and advertised capabilities — and write `ModelInfo` against what comes back. Everything downstream of the picker depends on that shape, so it is established from observation before any code is written against it, not assumed.

**Structured output.** Requests that need JSON send a JSON-schema response format where the selected model supports it. Regardless of support, every response is parsed defensively: attempt `JSON.parse`, and on failure extract the first balanced `{...}` block and retry the parse before surfacing an error. Models vary in schema adherence and the app must not fail because one added a prose preamble.

**Retry policy.** Retry with exponential backoff on 429 and 5xx only. Fail fast on 400, 401, 402 and 403 — an invalid key, a malformed request or an exhausted balance are not transient, and retrying them wastes the user's time and money. This replaces defect 7.

**Key handling.** The key is entered in Settings, held in `localStorage`, and sent only to OpenRouter. Because there is no backend, the key necessarily lives in the browser; this is the standard bring-your-own-key posture, and the Settings panel states plainly where the key is stored and where it is sent.

**Multimodal.** Text extracted client-side is the primary input. Page images are attached only for documents that yielded almost no extractable text — a scan — and only when the selected model advertises image support.

## 9. Error handling

- No reference to `process` anywhere in `src/`. `lib/debug.ts` gates on `import.meta.env.DEV`.
- A missing or rejected API key routes the user to the Settings panel with an explanation, rather than a toast that disappears after three seconds.
- Per-clause failures are isolated and individually retryable (5.2).
- The React error boundary is kept. The `window.onerror` handler that injects a red `div` into the DOM (`index.tsx:6`) is removed; it duplicates the boundary and mangles the page.
- Document parse failures are per-file: one unreadable PDF in a batch of twenty is reported against that file, and the other nineteen still run.

## 10. Testing

Vitest is already installed but currently runs only a performance benchmark.

| Suite | Covers |
|---|---|
| `citations.test.ts` | Exact match, prefix/suffix fuzzy fallback, multiple occurrences, short-quote rejection, no-match. Fixtures from `test_docs/`. |
| `storage.test.ts` | CRUD, export/import round-trip, migration from the current template shape, rejection of malformed import. |
| `openrouter.test.ts` | Mocked `fetch`: schema request construction, defensive JSON parse, retry on 429/5xx, immediate failure on 401/402, stream delta parsing, abort. |
| `runReview.test.ts` | Mocked client: concurrency ceiling respected, one failing clause does not fail the run, retry of a single cell, cancellation. |
| `documents.test.ts` | PDF/DOCX/TXT dispatch, scanned-page image fallback, per-file error isolation. |

`citations.test.ts` is the priority. The matcher is the feature whose regression would be least visible — citations would still render, they would just stop landing in the right place.

Deleted: `bench.ts`, `debug_imports.ts`, `test_responses.ts`, `tests/performance.test.ts`.

## 11. Verification

The version is stable when, in a clean browser profile against the fixtures in `test_docs/`:

1. `npx tsc --noEmit` reports no errors.
2. `npm test` passes.
3. `npm run build` emits no externalisation warnings and no CDN references.
4. With a valid OpenRouter key, generating a template for a named contract type produces an editable, saveable clause set.
5. Running that template against a single PDF produces cards whose citation controls scroll and highlight the correct passage in the viewer alongside.
6. Running it against three PDFs at once completes with per-document cards and a populated tabular grid over the same results.
7. Revoking the key mid-session surfaces a Settings prompt, not a silent failure.
8. A clause forced to fail shows an error card with a working Retry, and the rest of the run is unaffected.
9. The built output serves correctly from a static host.

## 12. Out of scope

Multi-user accounts, sharing, and server-side persistence. Migration of existing Firestore templates. Any new review capability beyond what exists today. These are the foundation this version is meant to make buildable, not part of it.
