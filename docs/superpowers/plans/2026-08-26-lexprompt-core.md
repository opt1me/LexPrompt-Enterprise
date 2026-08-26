# LexPrompt Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild LexPrompt as a statically-hostable, backend-free contract review app: generate a review template for a contract type, edit and save it, run it over one document or a batch, and read findings as cards with citations that highlight in a document viewer alongside.

**Architecture:** All persistence is `localStorage`; all AI goes through one `fetch`-based OpenRouter client with a user-supplied key. One extraction function (`extractClause`) runs across a document × clause matrix behind a concurrency limiter, writing into a single findings map. The card view and the tabular grid are two renderers over that one map, not two pipelines.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, Tailwind CSS 4 (`@tailwindcss/vite`), `pdfjs-dist` 6, `mammoth`, `docx`, Vitest 3 + jsdom.

**Spec:** `docs/superpowers/specs/2026-08-26-lexprompt-core-design.md`

## Global Constraints

- **No backend.** Build output must be servable as static files. No server, no database, no auth provider.
- **No `process` references in `src/`.** Use `import.meta.env.DEV`. The current `process.stdout.write` / `process.env.DEBUG_AI` / `import fs from 'fs'` usage is what makes every AI call throw today.
- **No CDN `<script>` tags.** Every library is an npm dependency resolved by Vite.
- **One AI provider.** OpenRouter only. `firebase`, `@google/genai`, `openai`, `@anthropic-ai/sdk` are all removed from `package.json`.
- **Retry only on 429 and 5xx.** Fail fast on 400, 401, 402, 403.
- **Never `git add` a file containing an `sk-` or `sk-proj-` literal.** Three files currently hold a live OpenAI key (Task 1 deletes them). They are untracked and absent from history; keep it that way.
- **Documents and review runs are never persisted.** Contract text stays in memory only. Only templates and settings touch `localStorage`.
- **Every task ends green:** `npx tsc --noEmit` clean and `npm test` passing before the commit.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/citations.ts` | Pure quote → page-rectangle matcher. No React, no pdf.js. |
| `src/lib/storage.ts` | Template CRUD, import/export, schema migration. Only module touching `localStorage`. |
| `src/lib/openrouter.ts` | OpenRouter client: model list, chat, streaming, retry policy, defensive JSON parse. |
| `src/lib/documents.ts` | `File` → `DocumentFile` via pdfjs-dist / mammoth / text. |
| `src/lib/concurrency.ts` | Bounded parallel map with abort support. |
| `src/lib/debug.ts` | Dev-only logging gated on `import.meta.env.DEV`. |
| `src/types.ts` | Shared domain types. |
| `src/features/review/extractClause.ts` | One clause against one document → `Finding`. |
| `src/features/review/runReview.ts` | Orchestrates the doc × clause matrix. |
| `src/features/templates/generateTemplate.ts` | Two-phase template generator. |
| `src/features/*/**.tsx` | View layer, split by feature. |
| `src/components/*.tsx` | Shared primitives. |

Ordering rationale: Tasks 1–8 build and test pure `src/lib` modules while the old app is left untouched and still compiling. Tasks 9–11 build the engine on top. Tasks 12–19 swap the UI over and delete the old code. Nothing is deleted before its replacement passes tests.

---

### Task 1: Test harness, secret removal, dead file deletion

**Files:**
- Create: `vitest.config.ts`
- Create: `src/lib/debug.ts`
- Create: `src/lib/debug.test.ts`
- Delete: `bench.ts`, `test_responses.ts`, `tests/performance.test.ts`, `tests/` (directory)
- Modify: `package.json` (scripts, devDependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: `debug(...args: unknown[]): void` from `src/lib/debug.ts`. A working `npm test`.

**Why first:** Three deleted files contain a live `sk-proj-` OpenAI key. Nothing else should happen until they are gone, and no test infrastructure exists yet to verify any later task.

- [ ] **Step 1: Confirm the secret-bearing files are untracked before deleting**

```bash
git ls-files bench.ts test_responses.ts tests/
```

Expected: empty output. If any path prints, STOP — the key is in git history and needs history rewriting plus immediate rotation before continuing.

- [ ] **Step 2: Delete the dead files**

```bash
rm -f bench.ts test_responses.ts debug_imports.ts
rm -rf tests/
```

`debug_imports.ts` is a 238-byte scratch file with no importers.

- [ ] **Step 3: Verify no secret literal remains in the working tree**

```bash
grep -rn 'sk-proj-C1JzKMAoWAVwYuh' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .
```

Expected: no matches. (`App.tsx` contains the harmless placeholder string `"sk-proj-..."`; that is not a match for this pattern.)

- [ ] **Step 4: Create the Vitest config**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
```

- [ ] **Step 5: Write the failing test**

```ts
// src/lib/debug.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { debug } from './debug';

describe('debug', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw when called', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => debug('hello', 1)).not.toThrow();
    spy.mockRestore();
  });

  it('never touches process', () => {
    // The bug this guards: services/aiService.ts:58 called process.stdout.write,
    // which is undefined in a browser and threw on every AI retry.
    const source = debug.toString();
    expect(source).not.toContain('process');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/lib/debug.test.ts`
Expected: FAIL — cannot resolve `./debug`.

- [ ] **Step 7: Write the minimal implementation**

```ts
// src/lib/debug.ts
export function debug(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log('[lexprompt]', ...args);
  }
}
```

- [ ] **Step 8: Update package.json scripts and drop the browser-test dep**

Set `"test": "vitest run"`, `"test:watch": "vitest"`. Remove the `test:ui`, `test:bench`, and `raw-bench` scripts (their targets are deleted). Remove `@vitest/browser` from devDependencies — it pulls Playwright and nothing uses it.

Then: `npm install`

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: tests PASS. `tsc` reports exactly one pre-existing error, `geminiProvider.ts(104,45)`, which Task 12 removes with the file. Record it; do not fix it here.

- [ ] **Step 10: Commit**

```bash
git add vitest.config.ts src/lib/debug.ts src/lib/debug.test.ts package.json package-lock.json
git commit -m "chore: add vitest harness, remove benchmark files containing a hardcoded key"
```

---

### Task 2: Pure citation matcher

**Files:**
- Create: `src/lib/citations.ts`
- Create: `src/lib/citations.test.ts`
- Source to port: `components/PDFViewer.tsx:97-160` (the `activeRects` `useMemo`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PdfTextItem { str: string; transform: number[]; width: number; height?: number }
  export interface PdfPageText { pageNum: number; items: PdfTextItem[] }
  export interface QuoteRect { pageNum: number; x: number; y: number; w: number; h: number }
  export function normalizeForMatch(text: string): string
  export function findQuoteRects(pages: PdfPageText[], quotes: string[]): QuoteRect[]
  ```

**Why this is the priority test:** this algorithm is the app's most valuable code and its regressions are invisible — citations would still render, they would just stop landing on the right text. It is currently untestable because it lives inside a `useMemo`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/citations.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeForMatch, findQuoteRects, type PdfPageText } from './citations';

// Builds a page where each word is its own text item on one line,
// mirroring how pdf.js splits a text layer.
function page(pageNum: number, words: string[]): PdfPageText {
  return {
    pageNum,
    items: words.map((str, i) => ({
      str: str + ' ',
      transform: [1, 0, 0, 1, 10 + i * 40, 700],
      width: 38,
      height: 12,
    })),
  };
}

describe('normalizeForMatch', () => {
  it('strips punctuation and casing so quotes survive re-typesetting', () => {
    expect(normalizeForMatch('The "Term" is 5 years.')).toBe('thetermis5years');
  });

  it('collapses whitespace differences', () => {
    expect(normalizeForMatch('a  b\nc')).toBe(normalizeForMatch('a b c'));
  });
});

describe('findQuoteRects', () => {
  const pages = [
    page(1, ['The', 'landlord', 'shall', 'maintain', 'the', 'roof']),
    page(2, ['The', 'tenant', 'shall', 'pay', 'the', 'rent']),
  ];

  it('finds an exact quote and returns one rect per covered item', () => {
    const rects = findQuoteRects(pages, ['landlord shall maintain']);
    expect(rects.length).toBe(3);
    expect(rects.every(r => r.pageNum === 1)).toBe(true);
  });

  it('matches across punctuation and casing differences', () => {
    const rects = findQuoteRects(pages, ['"Landlord shall, maintain"']);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects[0].pageNum).toBe(1);
  });

  it('finds a quote on a later page', () => {
    const rects = findQuoteRects(pages, ['tenant shall pay']);
    expect(rects.every(r => r.pageNum === 2)).toBe(true);
  });

  it('ignores quotes shorter than 5 normalized characters', () => {
    expect(findQuoteRects(pages, ['the'])).toEqual([]);
  });

  it('returns nothing for a quote that is not present', () => {
    expect(findQuoteRects(pages, ['force majeure provisions apply'])).toEqual([]);
  });

  it('returns rects for every occurrence, not just the first', () => {
    const repeated = [page(1, ['alpha', 'bravo', 'charlie', 'alpha', 'bravo', 'delta'])];
    const rects = findQuoteRects(repeated, ['alpha bravo']);
    const xs = new Set(rects.map(r => r.x));
    expect(xs.size).toBeGreaterThan(2);
  });

  it('falls back to prefix/suffix matching when the middle differs', () => {
    // Long quote whose interior was mis-transcribed by the model.
    const long = [page(1, [
      'Notwithstanding', 'any', 'provision', 'to', 'the', 'contrary',
      'the', 'liability', 'cap', 'shall', 'not', 'exceed', 'the', 'fees', 'paid',
    ])];
    const quote = 'Notwithstanding any XXXXX to the contrary the liability cap shall not exceed the fees paid';
    const rects = findQuoteRects(long, [quote]);
    expect(rects.length).toBeGreaterThan(0);
  });

  it('handles multiple quotes in one call', () => {
    const rects = findQuoteRects(pages, ['landlord shall maintain', 'tenant shall pay']);
    expect(new Set(rects.map(r => r.pageNum))).toEqual(new Set([1, 2]));
  });

  it('skips empty and whitespace-only quotes without throwing', () => {
    expect(() => findQuoteRects(pages, ['', '   '])).not.toThrow();
    expect(findQuoteRects(pages, ['', '   '])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/citations.test.ts`
Expected: FAIL — cannot resolve `./citations`.

- [ ] **Step 3: Port the algorithm as a pure module**

```ts
// src/lib/citations.ts
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height?: number;
}

export interface PdfPageText {
  pageNum: number;
  items: PdfTextItem[];
}

export interface QuoteRect {
  pageNum: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_QUOTE_LENGTH = 5;
const FUZZY_MIN_LENGTH = 30;
const FUZZY_AFFIX = 15;

/** Strips everything but letters and digits, lowercased, so a quote survives
 *  differences in punctuation, spacing and line breaking between the model's
 *  output and the PDF text layer. */
export function normalizeForMatch(text: string): string {
  return text.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Flattens one page's text items into a single normalized string plus a
 *  lookup from each character position back to the item that produced it. */
function flattenPage(items: PdfTextItem[]): { pageStr: string; charToItem: number[] } {
  let pageStr = '';
  const charToItem: number[] = [];
  items.forEach((item, itemIdx) => {
    const clean = normalizeForMatch(item.str);
    for (let c = 0; c < clean.length; c++) charToItem.push(itemIdx);
    pageStr += clean;
  });
  return { pageStr, charToItem };
}

/** Locates the next match at or after `from`, falling back to a prefix/suffix
 *  match for long quotes whose interior the model may have paraphrased.
 *  Returns null when no further match exists. */
function nextMatch(
  pageStr: string,
  needle: string,
  from: number,
): { index: number; length: number } | null {
  const exact = pageStr.indexOf(needle, from);
  if (exact !== -1) return { index: exact, length: needle.length };

  if (needle.length <= FUZZY_MIN_LENGTH) return null;

  const prefix = needle.slice(0, FUZZY_AFFIX);
  const suffix = needle.slice(-FUZZY_AFFIX);
  const pIdx = pageStr.indexOf(prefix, from);
  if (pIdx === -1) return null;

  const sIdx = pageStr.indexOf(suffix, pIdx + FUZZY_AFFIX);
  if (sIdx === -1) return null;
  if (sIdx - pIdx >= needle.length * 1.5) return null;

  return { index: pIdx, length: sIdx + FUZZY_AFFIX - pIdx };
}

export function findQuoteRects(pages: PdfPageText[], quotes: string[]): QuoteRect[] {
  const rects: QuoteRect[] = [];

  for (const quote of quotes) {
    if (!quote) continue;
    const needle = normalizeForMatch(quote);
    if (needle.length < MIN_QUOTE_LENGTH) continue;

    for (const { pageNum, items } of pages) {
      const { pageStr, charToItem } = flattenPage(items);
      let cursor = 0;

      while (cursor < pageStr.length) {
        const match = nextMatch(pageStr, needle, cursor);
        if (!match) break;

        const startItem = charToItem[match.index];
        const endItem = charToItem[match.index + match.length - 1];

        if (startItem !== undefined && endItem !== undefined) {
          for (const item of items.slice(startItem, endItem + 1)) {
            if (item.str.trim().length === 0) continue;
            rects.push({
              pageNum,
              x: item.transform[4],
              y: item.transform[5],
              w: item.width,
              h: item.height ?? 12,
            });
          }
        }
        cursor = match.index + 1;
      }
    }
  }

  return rects;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/citations.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/citations.ts src/lib/citations.test.ts
git commit -m "feat: extract citation matcher as a pure, tested module"
```

---

### Task 3: Domain types

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RiskLevel`, `Clause`, `Template`, `DocumentFile`, `Finding`, `ReviewRun`, `Settings`, `TEMPLATE_SCHEMA_VERSION`.

No test — this file is types plus one constant, with no behaviour to assert. It is a separate task because Tasks 4 onward all import from it.

- [ ] **Step 1: Write the types file**

```ts
// src/types.ts
export const TEMPLATE_SCHEMA_VERSION = 2;

export type RiskLevel = 'High' | 'Medium' | 'Low' | 'Info';

export interface Clause {
  id: string;
  title: string;
  prompt: string;
  riskCriteria?: string;
}

export interface Template {
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

export interface DocumentFile {
  id: string;
  name: string;
  text: string;
  file: File;
  kind: 'pdf' | 'docx' | 'txt';
  /** Rendered page images, present only for scans that yielded no text layer. */
  pageImages?: { mime: string; data: string }[];
  /** Set when parsing failed; the file still appears in the list, marked. */
  parseError?: string;
}

export interface Finding {
  clauseId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  summary?: string;
  citations: string[];
  riskLevel?: RiskLevel;
  riskAnalysis?: string;
  error?: string;
  edited?: boolean;
}

export interface ReviewRun {
  id: string;
  /** Frozen copy, so editing the template later does not rewrite what this run claims to have checked. */
  templateSnapshot: Template;
  documentIds: string[];
  /** docId -> clauseId -> Finding */
  findings: Record<string, Record<string, Finding>>;
  startedAt: number;
  completedAt?: number;
}

export interface Settings {
  apiKey: string;
  modelId: string;
  concurrency: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  modelId: '',
  concurrency: 5,
};
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/types.ts
git commit -m "feat: add domain types for the backend-free core"
```

---

### Task 4: Bounded concurrency helper

**Files:**
- Create: `src/lib/concurrency.ts`
- Create: `src/lib/concurrency.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]>`

The current code uses bare `Promise.all` over every clause at once (`services/aiService.ts:192`), which fires 35 simultaneous requests and reliably trips rate limits.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/concurrency.test.ts
import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async ms => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('propagates a rejection from the worker', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async n => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('stops starting new work once aborted', async () => {
    const controller = new AbortController();
    let started = 0;
    const promise = mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async () => {
        started++;
        await tick(5);
        return null;
      },
      controller.signal,
    );
    await tick(12);
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
    const startedAtAbort = started;
    await tick(40);
    expect(started).toBe(startedAtAbort);
  });

  it('handles an empty input list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/concurrency.test.ts`
Expected: FAIL — cannot resolve `./concurrency`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/concurrency.ts
/** Runs `fn` over `items` with at most `limit` promises in flight, preserving
 *  input order in the result. Rejects on the first worker rejection, and stops
 *  starting new work once `signal` aborts. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/concurrency.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/lib/concurrency.ts src/lib/concurrency.test.ts
git commit -m "feat: add bounded concurrency helper with abort support"
```

---

### Task 5: Template storage

**Files:**
- Create: `src/lib/storage.ts`
- Create: `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `Template`, `TEMPLATE_SCHEMA_VERSION` from `src/types.ts`.
- Produces:
  ```ts
  export function listTemplates(): Promise<Template[]>
  export function getTemplate(id: string): Promise<Template | null>
  export function saveTemplate(t: Template): Promise<Template>
  export function deleteTemplate(id: string): Promise<void>
  export function newTemplate(name: string): Template
  export function exportTemplate(t: Template): Blob
  export function importTemplate(json: string): Promise<Template>
  export function loadSettings(): Settings
  export function saveSettings(s: Settings): void
  ```

All functions are Promise-returning even though `localStorage` is synchronous, so a remote implementation can replace this module later without changing a single caller.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/storage.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  newTemplate, exportTemplate, importTemplate,
  loadSettings, saveSettings,
} from './storage';
import { TEMPLATE_SCHEMA_VERSION } from '../types';

beforeEach(() => localStorage.clear());

describe('template CRUD', () => {
  it('starts empty', async () => {
    expect(await listTemplates()).toEqual([]);
  });

  it('saves and reads back a template', async () => {
    const t = newTemplate('NDA Review');
    await saveTemplate(t);
    expect((await listTemplates()).map(x => x.name)).toEqual(['NDA Review']);
    expect((await getTemplate(t.id))?.name).toBe('NDA Review');
  });

  it('updates in place rather than duplicating', async () => {
    const t = newTemplate('Draft');
    await saveTemplate(t);
    await saveTemplate({ ...t, name: 'Renamed' });
    const all = await listTemplates();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Renamed');
  });

  it('advances updatedAt on save', async () => {
    const t = newTemplate('T');
    const saved = await saveTemplate({ ...t, updatedAt: 0 });
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('sorts most-recently-updated first', async () => {
    const a = await saveTemplate({ ...newTemplate('A'), updatedAt: 1 });
    await saveTemplate({ ...newTemplate('B'), updatedAt: 2 });
    await saveTemplate({ ...a, name: 'A2' });
    expect((await listTemplates())[0].name).toBe('A2');
  });

  it('deletes', async () => {
    const t = newTemplate('Gone');
    await saveTemplate(t);
    await deleteTemplate(t.id);
    expect(await listTemplates()).toEqual([]);
    expect(await getTemplate(t.id)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await getTemplate('nope')).toBeNull();
  });
});

describe('import / export', () => {
  it('round-trips through export and import', async () => {
    const t = newTemplate('Round Trip');
    t.clauses = [{ id: 'c1', title: 'Term', prompt: 'What is the term?' }];
    const text = await exportTemplate(t).text();
    const imported = await importTemplate(text);
    expect(imported.name).toBe('Round Trip');
    expect(imported.clauses[0].title).toBe('Term');
  });

  it('assigns a fresh id on import so it cannot clobber the original', async () => {
    const t = newTemplate('Original');
    await saveTemplate(t);
    const imported = await importTemplate(await exportTemplate(t).text());
    expect(imported.id).not.toBe(t.id);
    expect((await listTemplates()).length).toBe(2);
  });

  it('rejects malformed JSON', async () => {
    await expect(importTemplate('{not json')).rejects.toThrow(/not valid/i);
  });

  it('rejects JSON that is not a template', async () => {
    await expect(importTemplate('{"hello":"world"}')).rejects.toThrow(/not a template/i);
  });

  it('migrates a v1 template that used content-era field names', async () => {
    // The shape the old Firestore-backed build wrote: no schemaVersion,
    // timestamps absent, clauses present.
    const legacy = JSON.stringify({
      name: 'Legacy Lease',
      contractType: 'Lease',
      mode: 'risk',
      systemPrompt: 'You are a reviewer.',
      formatPrompt: 'Return JSON.',
      clauses: [{ title: 'Rent', prompt: 'What is the rent?' }],
    });
    const migrated = await importTemplate(legacy);
    expect(migrated.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(migrated.clauses[0].id).toBeTruthy();
    expect(migrated.createdAt).toBeGreaterThan(0);
  });
});

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings().concurrency).toBe(5);
    expect(loadSettings().apiKey).toBe('');
  });

  it('persists and reloads', () => {
    saveSettings({ apiKey: 'k', modelId: 'm', concurrency: 3 });
    expect(loadSettings()).toEqual({ apiKey: 'k', modelId: 'm', concurrency: 3 });
  });

  it('survives corrupt stored JSON by falling back to defaults', () => {
    localStorage.setItem('lexprompt.settings', '{broken');
    expect(loadSettings().concurrency).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — cannot resolve `./storage`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/storage.ts
import {
  type Template, type Clause, type Settings,
  TEMPLATE_SCHEMA_VERSION, DEFAULT_SETTINGS,
} from '../types';

const TEMPLATES_KEY = 'lexprompt.templates.v2';
const SETTINGS_KEY = 'lexprompt.settings';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readAll(): Template[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(migrate) : [];
  } catch {
    return [];
  }
}

function writeAll(templates: Template[]): void {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
}

/** Brings a template of any earlier shape up to the current one. Anything
 *  missing gets a sane default rather than causing the template to be dropped. */
function migrate(input: unknown): Template {
  const t = input as Partial<Template> & Record<string, unknown>;
  const now = Date.now();
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    name: typeof t.name === 'string' ? t.name : 'Untitled template',
    contractType: typeof t.contractType === 'string' ? t.contractType : 'Custom',
    mode: t.mode === 'risk' ? 'risk' : 'extraction',
    systemPrompt: typeof t.systemPrompt === 'string' ? t.systemPrompt : '',
    formatPrompt: typeof t.formatPrompt === 'string' ? t.formatPrompt : '',
    riskTolerance: typeof t.riskTolerance === 'string' ? t.riskTolerance : undefined,
    clauses: Array.isArray(t.clauses) ? t.clauses.map(migrateClause) : [],
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : now,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
}

function migrateClause(input: unknown): Clause {
  const c = input as Partial<Clause>;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    title: typeof c.title === 'string' ? c.title : 'Untitled clause',
    prompt: typeof c.prompt === 'string' ? c.prompt : '',
    riskCriteria: typeof c.riskCriteria === 'string' ? c.riskCriteria : undefined,
  };
}

export function newTemplate(name: string): Template {
  const now = Date.now();
  return {
    id: uid(),
    name,
    contractType: 'Custom',
    mode: 'extraction',
    systemPrompt: 'You are an expert legal contract reviewer.',
    formatPrompt: 'Answer strictly from the document text. Quote verbatim.',
    clauses: [],
    createdAt: now,
    updatedAt: now,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
}

export async function listTemplates(): Promise<Template[]> {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getTemplate(id: string): Promise<Template | null> {
  return readAll().find(t => t.id === id) ?? null;
}

export async function saveTemplate(template: Template): Promise<Template> {
  const saved: Template = { ...template, updatedAt: Date.now(), schemaVersion: TEMPLATE_SCHEMA_VERSION };
  const all = readAll();
  const idx = all.findIndex(t => t.id === saved.id);
  if (idx >= 0) all[idx] = saved;
  else all.push(saved);
  writeAll(all);
  return saved;
}

export async function deleteTemplate(id: string): Promise<void> {
  writeAll(readAll().filter(t => t.id !== id));
}

export function exportTemplate(template: Template): Blob {
  return new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
}

export async function importTemplate(json: string): Promise<Template> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { clauses?: unknown }).clauses)) {
    throw new Error('That file is not a template — it has no clauses.');
  }
  const migrated = migrate(parsed);
  // Fresh id so importing a template you already have does not overwrite it.
  return saveTemplate({ ...migrated, id: uid() });
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: add localStorage template persistence with migration"
```

---

### Task 6: Observe the OpenRouter models endpoint

**Files:**
- Create: `docs/superpowers/notes/openrouter-models-shape.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded, factual response shape that Task 7 writes `ModelInfo` against.

**Why this is its own task:** everything downstream of the model picker depends on this shape. Guessing field names here and discovering them wrong in Task 12 would invalidate three tasks of work. This establishes it by observation, and costs one HTTP call. The endpoint requires no API key.

- [ ] **Step 1: Fetch the endpoint and capture one entry**

```bash
curl -s https://openrouter.ai/api/v1/models > /tmp/or-models.json
node -e "const d=require('/tmp/or-models.json');console.log('count:',d.data.length);console.log(JSON.stringify(d.data.find(m=>/claude|gpt|gemini/.test(m.id)),null,2))"
```

- [ ] **Step 2: Record the observed shape**

Write `docs/superpowers/notes/openrouter-models-shape.md` containing:
- the top-level envelope key (expected `data`, but record what is actually returned),
- the exact field names for: model id, display name, context length, prompt price, completion price,
- how supported capabilities are expressed, and specifically which field indicates structured-output / `response_format` support,
- how image input support is expressed,
- one full example entry, verbatim.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/openrouter-models-shape.md
git commit -m "docs: record observed OpenRouter models response shape"
```

**Note for the implementer:** if any field name in this note differs from what Task 7's code below assumes, the note wins. Adjust Task 7's `ModelInfo` mapping to match observation and say so in the commit message.

---

### Task 7: OpenRouter client — models and non-streaming chat

**Files:**
- Create: `src/lib/openrouter.ts`
- Create: `src/lib/openrouter.test.ts`

**Interfaces:**
- Consumes: the shape recorded in Task 6.
- Produces:
  ```ts
  export interface ModelInfo {
    id: string; name: string; contextLength: number;
    promptPrice: number; completionPrice: number;
    supportsStructuredOutput: boolean; supportsImages: boolean;
  }
  export class OpenRouterError extends Error { status: number; retryable: boolean }
  export function listModels(): Promise<ModelInfo[]>
  export interface ChatRequest {
    apiKey: string; modelId: string; system?: string; user: string;
    images?: { mime: string; data: string }[];
    jsonSchema?: object; temperature?: number;
  }
  export function chat(req: ChatRequest, signal?: AbortSignal): Promise<string>
  export function chatJson<T>(req: ChatRequest, signal?: AbortSignal): Promise<T>
  export function parseJsonLoose<T>(text: string): T
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/openrouter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, chatJson, listModels, parseJsonLoose, OpenRouterError } from './openrouter';

const KEY = 'test-key';
const req = { apiKey: KEY, modelId: 'test/model', user: 'hello' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function completion(content: string) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('parseJsonLoose', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in a prose preamble', () => {
    expect(parseJsonLoose('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('recovers JSON inside a fenced code block', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles nested braces and braces inside strings', () => {
    expect(parseJsonLoose('x {"a":{"b":"}"},"c":2} y')).toEqual({ a: { b: '}' }, c: 2 });
  });

  it('throws a readable error when there is no JSON at all', () => {
    expect(() => parseJsonLoose('no json here')).toThrow(/could not parse/i);
  });
});

describe('chat', () => {
  it('sends the key as a bearer token and returns the message content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('hi there'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await chat(req)).toBe('hi there');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body).model).toBe('test/model');
  });

  it('fails immediately on 401 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat(req)).rejects.toThrow(OpenRouterError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on 402 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'no credit' } }, 402));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat(req)).rejects.toThrow(/credit/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'slow down' } }, 429))
      .mockResolvedValueOnce(completion('recovered'));
    vi.stubGlobal('fetch', fetchMock);

    const p = chat(req);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 and gives up after the retry budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'oops' } }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const p = chat(req);
    const assertion = expect(p).rejects.toThrow(OpenRouterError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('marks the error retryable only for transient statuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await chat(req).catch((e: OpenRouterError) => {
      expect(e.status).toBe(401);
      expect(e.retryable).toBe(false);
    });
  });

  it('includes a json_schema response format when a schema is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    await chatJson({ ...req, jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.type).toBe('object');
  });

  it('attaches images as image_url content parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await chat({ ...req, images: [{ mime: 'image/jpeg', data: 'AAAA' }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const parts = body.messages.at(-1).content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  });

  it('prepends the system message when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await chat({ ...req, system: 'be terse' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
  });

  it('rejects when no API key is set, before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat({ ...req, apiKey: '' })).rejects.toThrow(/api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chatJson parses a schema-shaped response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('{"summary":"s","citations":[]}')));
    expect(await chatJson<{ summary: string }>(req)).toEqual({ summary: 's', citations: [] });
  });
});

describe('listModels', () => {
  it('maps the models envelope into ModelInfo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015' },
        supported_parameters: ['response_format', 'structured_outputs'],
        architecture: { input_modalities: ['text', 'image'] },
      }],
    })));

    const models = await listModels();
    expect(models[0].id).toBe('anthropic/claude-sonnet-4.5');
    expect(models[0].contextLength).toBe(200000);
    expect(models[0].supportsStructuredOutput).toBe(true);
    expect(models[0].supportsImages).toBe(true);
  });

  it('tolerates entries with missing optional fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'x/y' }] })));
    const models = await listModels();
    expect(models[0].supportsStructuredOutput).toBe(false);
    expect(models[0].supportsImages).toBe(false);
    expect(models[0].contextLength).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/openrouter.test.ts`
Expected: FAIL — cannot resolve `./openrouter`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/openrouter.ts
const BASE = 'https://openrouter.ai/api/v1';
const MAX_ATTEMPTS = 3;

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
  supportsStructuredOutput: boolean;
  supportsImages: boolean;
}

export class OpenRouterError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export interface ChatRequest {
  apiKey: string;
  modelId: string;
  system?: string;
  user: string;
  images?: { mime: string; data: string }[];
  jsonSchema?: object;
  temperature?: number;
}

/** Parses a JSON object out of a model response, tolerating a prose preamble
 *  or a markdown code fence. Models vary in schema adherence and a run must not
 *  fail because one added "Sure! Here you go:". */
export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to extraction
  }

  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`Could not parse a JSON object from the model response: ${text.slice(0, 200)}`);
}

async function toError(response: Response): Promise<OpenRouterError> {
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    // keep the status text
  }
  if (response.status === 401) message = `Your OpenRouter API key was rejected: ${message}`;
  if (response.status === 402) message = `Your OpenRouter account is out of credit: ${message}`;
  return new OpenRouterError(message, response.status);
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function buildBody(req: ChatRequest) {
  const messages: unknown[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });

  const content = req.images?.length
    ? [
        { type: 'text', text: req.user },
        ...req.images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.data}` },
        })),
      ]
    : req.user;

  messages.push({ role: 'user', content });

  return {
    model: req.modelId,
    messages,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.jsonSchema
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'result', strict: true, schema: req.jsonSchema },
          },
        }
      : {}),
  };
}

export async function chat(req: ChatRequest, signal?: AbortSignal): Promise<string> {
  if (!req.apiKey) throw new Error('No OpenRouter API key is set. Add one in Settings.');
  if (!req.modelId) throw new Error('No model is selected. Choose one in Settings.');

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://lexprompt.app',
        'X-Title': 'LexPrompt',
      },
      body: JSON.stringify(buildBody(req)),
    });

    if (response.ok) {
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenRouter returned no message content.');
      return content;
    }

    const error = await toError(response);
    // Only 429 and 5xx are transient. Retrying a rejected key or an exhausted
    // balance just wastes the user's time.
    if (!error.retryable) throw error;
    lastError = error;
    if (attempt < MAX_ATTEMPTS - 1) await wait(1000 * 2 ** attempt);
  }
  throw lastError;
}

export async function chatJson<T>(req: ChatRequest, signal?: AbortSignal): Promise<T> {
  return parseJsonLoose<T>(await chat(req, signal));
}

export async function listModels(): Promise<ModelInfo[]> {
  const response = await fetch(`${BASE}/models`);
  if (!response.ok) throw await toError(response);
  const body = await response.json();
  const entries: unknown[] = Array.isArray(body?.data) ? body.data : [];

  return entries.map((entry): ModelInfo => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [];
    const architecture = (m.architecture ?? {}) as Record<string, unknown>;
    const modalities = Array.isArray(architecture.input_modalities)
      ? (architecture.input_modalities as string[])
      : [];
    const pricing = (m.pricing ?? {}) as Record<string, string>;

    return {
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      contextLength: Number(m.context_length ?? 0),
      promptPrice: Number(pricing.prompt ?? 0),
      completionPrice: Number(pricing.completion ?? 0),
      supportsStructuredOutput:
        params.includes('structured_outputs') || params.includes('response_format'),
      supportsImages: modalities.includes('image'),
    };
  }).filter(m => m.id);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/openrouter.test.ts`
Expected: all PASS. If the `listModels` mapping tests fail because Task 6's note records different field names, change the mapping to match the note and update the two `listModels` tests to use the real field names.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/lib/openrouter.ts src/lib/openrouter.test.ts
git commit -m "feat: add OpenRouter client with fail-fast retry policy and loose JSON parsing"
```

---

### Task 8: OpenRouter streaming

**Files:**
- Modify: `src/lib/openrouter.ts` (append)
- Modify: `src/lib/openrouter.test.ts` (append)

**Interfaces:**
- Consumes: `ChatRequest`, `toError` from Task 7.
- Produces: `chatStream(req: ChatRequest, onDelta: (chunk: string) => void, signal?: AbortSignal): Promise<string>`

Used only by the assistant chat panel (Task 18). Split from Task 7 because SSE parsing has its own failure modes and deserves its own gate.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/lib/openrouter.test.ts
import { chatStream } from './openrouter';

function sseResponse(lines: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('chatStream', () => {
  it('emits deltas in order and resolves with the joined text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));

    const chunks: string[] = [];
    const full = await chatStream({ apiKey: 'k', modelId: 'm', user: 'hi' }, c => chunks.push(c));

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(full).toBe('Hello');
  });

  it('handles a delta split across two network chunks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"con',
      'tent":"split"}}]}\n\ndata: [DONE]\n\n',
    ])));

    const full = await chatStream({ apiKey: 'k', modelId: 'm', user: 'hi' }, () => {});
    expect(full).toBe('split');
  });

  it('ignores SSE comment/keepalive lines', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      ': keepalive\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));

    expect(await chatStream({ apiKey: 'k', modelId: 'm', user: 'hi' }, () => {})).toBe('ok');
  });

  it('sets stream:true in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    await chatStream({ apiKey: 'k', modelId: 'm', user: 'hi' }, () => {});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
  });

  it('throws on an error status without attempting to read a stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    ));

    await expect(chatStream({ apiKey: 'k', modelId: 'm', user: 'hi' }, () => {}))
      .rejects.toThrow(/rejected/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/openrouter.test.ts -t chatStream`
Expected: FAIL — `chatStream` is not exported.

- [ ] **Step 3: Implement streaming**

```ts
// append to src/lib/openrouter.ts

/** Streams a completion, invoking `onDelta` for each content fragment.
 *  Not retried: a half-delivered stream cannot be resumed, and the caller
 *  (the chat panel) is interactive and can simply be asked again. */
export async function chatStream(
  req: ChatRequest,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!req.apiKey) throw new Error('No OpenRouter API key is set. Add one in Settings.');
  if (!req.modelId) throw new Error('No model is selected. Choose one in Settings.');

  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://lexprompt.app',
      'X-Title': 'LexPrompt',
    },
    body: JSON.stringify({ ...buildBody(req), stream: true }),
  });

  if (!response.ok) throw await toError(response);
  if (!response.body) throw new Error('OpenRouter returned no response body to stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a partial event stays in the buffer.
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // A malformed event is skipped rather than failing the stream.
        }
      }
    }
  }

  return full;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/openrouter.test.ts`
Expected: all PASS, including the Task 7 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/lib/openrouter.ts src/lib/openrouter.test.ts
git commit -m "feat: add SSE streaming to the OpenRouter client"
```

---

### Task 9: Document parsing on pdfjs-dist v6

**Files:**
- Create: `src/lib/documents.ts`
- Create: `src/lib/documents.test.ts`
- Modify: `package.json` (add `pdfjs-dist`, `mammoth`)
- Source to port: `services/docService.ts`

**Interfaces:**
- Consumes: `DocumentFile` from `src/types.ts`.
- Produces:
  ```ts
  export function parseFile(file: File): Promise<DocumentFile>
  export function parseFiles(files: File[]): Promise<DocumentFile[]>
  export function extractPageText(pdf: unknown): Promise<PdfPageText[]>   // for the viewer
  ```

**Critical difference from the old code:** the installed `pdfjs-dist` is v6, not the CDN's v3. The v3 call style in `services/docService.ts` and `components/PDFViewer.tsx` will not work unchanged, and `window['pdfjs-dist/build/pdf']` does not exist at all.

- [ ] **Step 1: Install and inspect the actual v6 API before writing code**

```bash
npm install pdfjs-dist mammoth
node -e "const p=require('pdfjs-dist/package.json');console.log('version',p.version);console.log('exports',Object.keys(p.exports||{}).join(', '))"
ls node_modules/pdfjs-dist/build/
```

Record which worker file exists (`pdf.worker.mjs` vs `pdf.worker.min.mjs`) and confirm the entry point. Then check the render signature:

```bash
grep -n "canvasContext\|class RenderParameters\|interface RenderParameters" node_modules/pdfjs-dist/types/src/display/api.d.ts | head -20
```

v6 requires `canvas` and/or `canvasContext` plus `viewport` on `page.render()`. Use whatever the installed `.d.ts` declares; the code below assumes `{ canvasContext, viewport }` and must be corrected if the types disagree.

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/documents.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFile, parseFiles } from './documents';

// pdf.js and mammoth are heavy and DOM-bound; the unit tests cover dispatch
// and error isolation. Real PDF parsing is covered by manual verification
// against test_docs/ in Task 19.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'Hello world from the PDF' }] }),
        getViewport: () => ({ width: 100, height: 100 }),
      }),
    }),
  })),
}));

vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn(async () => ({ value: 'docx text' })) },
}));

function makeFile(name: string, type: string, content = 'plain text body'): File {
  return new File([content], name, { type });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('parseFile', () => {
  it('reads a plain text file', async () => {
    const doc = await parseFile(makeFile('a.txt', 'text/plain'));
    expect(doc.kind).toBe('txt');
    expect(doc.text).toBe('plain text body');
    expect(doc.name).toBe('a.txt');
  });

  it('extracts text from a PDF and tags the page number', async () => {
    const doc = await parseFile(makeFile('a.pdf', 'application/pdf'));
    expect(doc.kind).toBe('pdf');
    expect(doc.text).toContain('Hello world from the PDF');
    expect(doc.text).toContain('[Page 1]');
  });

  it('extracts text from a DOCX', async () => {
    const doc = await parseFile(makeFile(
      'a.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ));
    expect(doc.kind).toBe('docx');
    expect(doc.text).toBe('docx text');
  });

  it('falls back to extension when the browser reports no MIME type', async () => {
    const doc = await parseFile(makeFile('contract.pdf', ''));
    expect(doc.kind).toBe('pdf');
  });

  it('assigns a unique id per document', async () => {
    const a = await parseFile(makeFile('a.txt', 'text/plain'));
    const b = await parseFile(makeFile('b.txt', 'text/plain'));
    expect(a.id).not.toBe(b.id);
  });

  it('records a parse failure on the document instead of throwing', async () => {
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementationOnce(() => {
      throw new Error('corrupt file');
    });

    const doc = await parseFile(makeFile('bad.pdf', 'application/pdf'));
    expect(doc.parseError).toMatch(/corrupt file/);
    expect(doc.text).toBe('');
  });
});

describe('parseFiles', () => {
  it('isolates one bad file from the rest of the batch', async () => {
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementationOnce(() => {
      throw new Error('corrupt file');
    });

    const docs = await parseFiles([
      makeFile('bad.pdf', 'application/pdf'),
      makeFile('good.txt', 'text/plain'),
    ]);

    expect(docs.length).toBe(2);
    expect(docs[0].parseError).toBeTruthy();
    expect(docs[1].text).toBe('plain text body');
    expect(docs[1].parseError).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/documents.test.ts`
Expected: FAIL — cannot resolve `./documents`.

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/documents.ts
import * as pdfjs from 'pdfjs-dist';
import type { DocumentFile } from '../types';
import type { PdfPageText } from './citations';
import { debug } from './debug';

// Worker resolved through Vite rather than a CDN global. This is what removes
// the `window['pdfjs-dist/build/pdf']` bug class permanently.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

/** A page with almost no extractable text is a scan; we render it to an image
 *  so a vision-capable model can read it instead. */
const SCAN_TEXT_THRESHOLD = 20;

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function classify(file: File): DocumentFile['kind'] {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) return 'docx';
  return 'txt';
}

async function renderPageToJpeg(page: {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: Record<string, unknown>) => { promise: Promise<void> };
}): Promise<{ mime: string; data: string } | null> {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) return null;
  await page.render({ canvas, canvasContext, viewport }).promise;
  return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1] };
}

async function parsePdf(file: File): Promise<{ text: string; pageImages?: { mime: string; data: string }[] }> {
  const pdf = await pdfjs.getDocument(await file.arrayBuffer()).promise;
  let text = '';
  const pageImages: { mime: string; data: string }[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: unknown) => (item as { str?: string }).str ?? '')
      .join(' ');
    text += `[Page ${i}]\n${pageText}\n\n`;

    if (pageText.trim().length < SCAN_TEXT_THRESHOLD) {
      const image = await renderPageToJpeg(page as never);
      if (image) pageImages.push(image);
    }
  }

  return { text, pageImages: pageImages.length ? pageImages : undefined };
}

export async function parseFile(file: File): Promise<DocumentFile> {
  const kind = classify(file);
  const base: DocumentFile = { id: uid(), name: file.name, text: '', file, kind };

  try {
    if (kind === 'pdf') {
      const { text, pageImages } = await parsePdf(file);
      return { ...base, text, pageImages };
    }
    if (kind === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return { ...base, text: result.value };
    }
    return { ...base, text: await file.text() };
  } catch (error) {
    // A bad file is reported against itself; the rest of a batch still runs.
    const message = error instanceof Error ? error.message : String(error);
    debug('parseFile failed', file.name, message);
    return { ...base, parseError: message };
  }
}

export async function parseFiles(files: File[]): Promise<DocumentFile[]> {
  return Promise.all(files.map(parseFile));
}

/** Builds the per-page text-item index the citation matcher needs. */
export async function extractPageText(pdf: {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
}): Promise<PdfPageText[]> {
  const pages: PdfPageText[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push({ pageNum: i, items: content.items as PdfPageText['items'] });
  }
  return pages;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/documents.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit
git add src/lib/documents.ts src/lib/documents.test.ts package.json package-lock.json
git commit -m "feat: parse documents via bundled pdfjs-dist v6 and mammoth"
```

---

### Task 10: Single-clause extraction

**Files:**
- Create: `src/features/review/extractClause.ts`
- Create: `src/features/review/extractClause.test.ts`
- Source to port: `services/aiService.ts:389` (`extractTabularData`) and `:244` (`analyzeContract` schema construction)

**Interfaces:**
- Consumes: `chatJson`, `ChatRequest` from `src/lib/openrouter.ts`; `Finding`, `Clause`, `Template`, `DocumentFile`, `Settings` from `src/types.ts`.
- Produces:
  ```ts
  export const CLAUSE_SCHEMA: object
  export function buildClausePrompt(doc: DocumentFile, clause: Clause, template: Template): string
  export function extractClause(
    doc: DocumentFile, clause: Clause, template: Template,
    settings: Settings, signal?: AbortSignal,
  ): Promise<Finding>
  ```

This replaces the single 35-property, 500k-character request that fails a whole document when one clause misbehaves.

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/review/extractClause.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractClause, buildClausePrompt, CLAUSE_SCHEMA } from './extractClause';
import type { Clause, Template, DocumentFile, Settings } from '../../types';

vi.mock('../../lib/openrouter', () => ({ chatJson: vi.fn() }));
const { chatJson } = await import('../../lib/openrouter');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };

const clause: Clause = {
  id: 'c1',
  title: 'Governing Law',
  prompt: 'Identify the governing law.',
  riskCriteria: 'Must be England and Wales.',
};

const template: Template = {
  id: 't1', name: 'Lease', contractType: 'Lease', mode: 'risk',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.', clauses: [clause],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

const doc: DocumentFile = {
  id: 'd1', name: 'lease.pdf', kind: 'pdf',
  text: 'This deed is governed by the laws of England and Wales.',
  file: new File([''], 'lease.pdf'),
};

beforeEach(() => vi.clearAllMocks());

describe('buildClausePrompt', () => {
  it('includes the clause instruction and the document text', () => {
    const prompt = buildClausePrompt(doc, clause, template);
    expect(prompt).toContain('Identify the governing law.');
    expect(prompt).toContain('England and Wales');
  });

  it('includes risk criteria in risk mode', () => {
    expect(buildClausePrompt(doc, clause, template)).toContain('Must be England and Wales.');
  });

  it('omits risk criteria in extraction mode', () => {
    const prompt = buildClausePrompt(doc, clause, { ...template, mode: 'extraction' });
    expect(prompt).not.toContain('Must be England and Wales.');
  });
});

describe('extractClause', () => {
  it('returns a done finding on success', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'England and Wales.',
      citations: ['governed by the laws of England and Wales'],
      risk_level: 'Low',
      risk_analysis: 'Matches the preferred jurisdiction.',
    });

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.clauseId).toBe('c1');
    expect(finding.summary).toBe('England and Wales.');
    expect(finding.citations).toEqual(['governed by the laws of England and Wales']);
    expect(finding.riskLevel).toBe('Low');
  });

  it('resolves to an error finding rather than rejecting', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/rate limited/);
    expect(finding.citations).toEqual([]);
  });

  it('passes the JSON schema through to the model', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(CLAUSE_SCHEMA);
  });

  it('coerces a missing citations array to empty', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'no citations given' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
    expect(finding.status).toBe('done');
  });

  it('drops a risk level the model invented outside the allowed set', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 'Catastrophic' });
    expect((await extractClause(doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('attaches page images for a scanned document', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const scan: DocumentFile = { ...doc, text: '', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] };

    await extractClause(scan, clause, template, settings);

    expect(vi.mocked(chatJson).mock.calls[0][0].images).toHaveLength(1);
  });

  it('sends no images for a document that has a text layer', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toBeUndefined();
  });

  it('reports a parse failure without calling the model', async () => {
    const broken: DocumentFile = { ...doc, text: '', parseError: 'corrupt file' };
    const finding = await extractClause(broken, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/corrupt file/);
    expect(chatJson).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/review/extractClause.test.ts`
Expected: FAIL — cannot resolve `./extractClause`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/review/extractClause.ts
import { chatJson } from '../../lib/openrouter';
import type { Clause, DocumentFile, Finding, RiskLevel, Settings, Template } from '../../types';

const RISK_LEVELS: RiskLevel[] = ['High', 'Medium', 'Low', 'Info'];

export const CLAUSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'EXACT VERBATIM SUBSTRINGS copied from the document text. Never clause numbers such as "Clause 14.2" — the literal text, so it can be located and highlighted.',
    },
    risk_level: { type: 'string', enum: RISK_LEVELS },
    risk_analysis: { type: 'string' },
  },
  required: ['summary', 'citations', 'risk_level', 'risk_analysis'],
  additionalProperties: false,
} as const;

interface RawFinding {
  summary?: string;
  citations?: unknown;
  risk_level?: string;
  risk_analysis?: string;
}

export function buildClausePrompt(doc: DocumentFile, clause: Clause, template: Template): string {
  const riskBlock =
    template.mode === 'risk'
      ? `\nRISK CRITERIA: ${clause.riskCriteria || template.riskTolerance || 'General commercial reasonableness.'}`
      : '';

  return `DOCUMENT: ${doc.name}

DOCUMENT TEXT:
${doc.text}

CLAUSE TO REVIEW: ${clause.title}
INSTRUCTION: ${clause.prompt}${riskBlock}

Return:
- summary: what the document says on this point, or that it is silent.
- citations: exact verbatim substrings from the document text supporting the summary.
- risk_level: one of High, Medium, Low, Info.
- risk_analysis: why that level.

If the document text above is empty and images are attached, read the images instead.`;
}

/** Never rejects: a failed clause resolves to an error Finding so a run
 *  completes with partial results and the cell can be retried on its own. */
export async function extractClause(
  doc: DocumentFile,
  clause: Clause,
  template: Template,
  settings: Settings,
  signal?: AbortSignal,
): Promise<Finding> {
  const base: Finding = { clauseId: clause.id, status: 'error', citations: [] };

  if (doc.parseError) {
    return { ...base, error: `Could not read ${doc.name}: ${doc.parseError}` };
  }

  try {
    const raw = await chatJson<RawFinding>(
      {
        apiKey: settings.apiKey,
        modelId: settings.modelId,
        system: `${template.systemPrompt}\n\nOUTPUT RULES: ${template.formatPrompt}`,
        user: buildClausePrompt(doc, clause, template),
        images: doc.pageImages,
        jsonSchema: CLAUSE_SCHEMA,
        temperature: 0.1,
      },
      signal,
    );

    const level = RISK_LEVELS.find(l => l === raw.risk_level);

    return {
      clauseId: clause.id,
      status: 'done',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      citations: Array.isArray(raw.citations) ? raw.citations.filter(c => typeof c === 'string') : [],
      riskLevel: level,
      riskAnalysis: typeof raw.risk_analysis === 'string' ? raw.risk_analysis : undefined,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/extractClause.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/features/review/extractClause.ts src/features/review/extractClause.test.ts
git commit -m "feat: add per-clause extraction that isolates failures"
```

---

### Task 11: Review orchestration

**Files:**
- Create: `src/features/review/runReview.ts`
- Create: `src/features/review/runReview.test.ts`

**Interfaces:**
- Consumes: `extractClause` (Task 10), `mapWithConcurrency` (Task 4), types (Task 3).
- Produces:
  ```ts
  export function emptyRun(template: Template, docs: DocumentFile[]): ReviewRun
  export function runReview(
    run: ReviewRun, docs: DocumentFile[], settings: Settings,
    onUpdate: (run: ReviewRun) => void, signal?: AbortSignal,
  ): Promise<ReviewRun>
  export function retryCell(
    run: ReviewRun, doc: DocumentFile, clauseId: string, settings: Settings,
    onUpdate: (run: ReviewRun) => void,
  ): Promise<ReviewRun>
  export function runProgress(run: ReviewRun): { done: number; total: number; errors: number }
  ```

This is the shared engine. The card view (Task 16) and the tabular grid (Task 17) both render `run.findings`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/review/runReview.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyRun, runReview, retryCell, runProgress } from './runReview';
import type { DocumentFile, Settings, Template, Finding } from '../../types';

vi.mock('./extractClause', () => ({ extractClause: vi.fn() }));
const { extractClause } = await import('./extractClause');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 2 };

const template: Template = {
  id: 't1', name: 'T', contractType: 'NDA', mode: 'risk',
  systemPrompt: 's', formatPrompt: 'f',
  clauses: [
    { id: 'c1', title: 'Term', prompt: 'p1' },
    { id: 'c2', title: 'Law', prompt: 'p2' },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

function doc(id: string): DocumentFile {
  return { id, name: `${id}.pdf`, kind: 'pdf', text: 'body', file: new File([''], `${id}.pdf`) };
}

const ok = (clauseId: string): Finding =>
  ({ clauseId, status: 'done', summary: 'ok', citations: ['q'] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractClause).mockImplementation(async (_d, c) => ok(c.id));
});

describe('emptyRun', () => {
  it('seeds a pending finding for every document/clause pair', () => {
    const run = emptyRun(template, [doc('d1'), doc('d2')]);
    expect(Object.keys(run.findings)).toEqual(['d1', 'd2']);
    expect(run.findings.d1.c1.status).toBe('pending');
    expect(runProgress(run)).toEqual({ done: 0, total: 4, errors: 0 });
  });

  it('snapshots the template so later edits do not rewrite history', () => {
    const run = emptyRun(template, [doc('d1')]);
    template.clauses.push({ id: 'c3', title: 'New', prompt: 'p3' });
    expect(run.templateSnapshot.clauses.length).toBe(2);
    template.clauses.pop();
  });
});

describe('runReview', () => {
  it('fills every cell', async () => {
    const docs = [doc('d1'), doc('d2')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});
    expect(runProgress(run)).toEqual({ done: 4, total: 4, errors: 0 });
    expect(run.completedAt).toBeGreaterThan(0);
  });

  it('reports progress as each cell lands', async () => {
    const docs = [doc('d1')];
    const seen: number[] = [];
    await runReview(emptyRun(template, docs), docs, settings, r => seen.push(runProgress(r).done));
    expect(seen.at(-1)).toBe(2);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('completes the run when one clause fails', async () => {
    vi.mocked(extractClause).mockImplementation(async (_d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'boom' }
        : ok(c.id));

    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});

    expect(run.findings.d1.c1.status).toBe('error');
    expect(run.findings.d1.c2.status).toBe('done');
    expect(runProgress(run)).toEqual({ done: 2, total: 2, errors: 1 });
  });

  it('respects the concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(extractClause).mockImplementation(async (_d, c) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return ok(c.id);
    });

    const docs = [doc('d1'), doc('d2'), doc('d3')];
    await runReview(emptyRun(template, docs), docs, { ...settings, concurrency: 2 }, () => {});
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    vi.mocked(extractClause).mockImplementation(async (_d, c) => {
      await new Promise(r => setTimeout(r, 10));
      return ok(c.id);
    });

    const docs = [doc('d1'), doc('d2'), doc('d3')];
    const promise = runReview(emptyRun(template, docs), docs, settings, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 15);

    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('handles a template with no clauses', async () => {
    const bare = { ...template, clauses: [] };
    const docs = [doc('d1')];
    const run = await runReview(emptyRun(bare, docs), docs, settings, () => {});
    expect(runProgress(run)).toEqual({ done: 0, total: 0, errors: 0 });
  });
});

describe('retryCell', () => {
  it('re-runs one cell and leaves its neighbours untouched', async () => {
    vi.mocked(extractClause).mockImplementation(async (_d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'boom' }
        : ok(c.id));

    const docs = [doc('d1')];
    const failed = await runReview(emptyRun(template, docs), docs, settings, () => {});

    vi.mocked(extractClause).mockImplementation(async (_d, c) => ok(c.id));
    const retried = await retryCell(failed, docs[0], 'c1', settings, () => {});

    expect(retried.findings.d1.c1.status).toBe('done');
    expect(retried.findings.d1.c2.status).toBe('done');
    expect(extractClause).toHaveBeenCalledTimes(3);
  });

  it('is a no-op for an unknown clause id', async () => {
    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});
    const same = await retryCell(run, docs[0], 'nope', settings, () => {});
    expect(same.findings).toEqual(run.findings);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/review/runReview.test.ts`
Expected: FAIL — cannot resolve `./runReview`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/review/runReview.ts
import { mapWithConcurrency } from '../../lib/concurrency';
import type { DocumentFile, Finding, ReviewRun, Settings, Template } from '../../types';
import { extractClause } from './extractClause';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function emptyRun(template: Template, docs: DocumentFile[]): ReviewRun {
  const findings: ReviewRun['findings'] = {};
  for (const doc of docs) {
    findings[doc.id] = {};
    for (const clause of template.clauses) {
      findings[doc.id][clause.id] = { clauseId: clause.id, status: 'pending', citations: [] };
    }
  }
  return {
    id: uid(),
    // Deep copy: editing the template afterwards must not change what this run claims to have checked.
    templateSnapshot: structuredClone(template),
    documentIds: docs.map(d => d.id),
    findings,
    startedAt: Date.now(),
  };
}

export function runProgress(run: ReviewRun): { done: number; total: number; errors: number } {
  let done = 0;
  let total = 0;
  let errors = 0;
  for (const byClause of Object.values(run.findings)) {
    for (const finding of Object.values(byClause)) {
      total++;
      if (finding.status === 'done' || finding.status === 'error') done++;
      if (finding.status === 'error') errors++;
    }
  }
  return { done, total, errors };
}

function withFinding(run: ReviewRun, docId: string, finding: Finding): ReviewRun {
  return {
    ...run,
    findings: {
      ...run.findings,
      [docId]: { ...run.findings[docId], [finding.clauseId]: finding },
    },
  };
}

export async function runReview(
  initial: ReviewRun,
  docs: DocumentFile[],
  settings: Settings,
  onUpdate: (run: ReviewRun) => void,
  signal?: AbortSignal,
): Promise<ReviewRun> {
  const template = initial.templateSnapshot;
  const cells = docs.flatMap(doc => template.clauses.map(clause => ({ doc, clause })));

  let current = initial;

  await mapWithConcurrency(
    cells,
    settings.concurrency,
    async ({ doc, clause }) => {
      current = withFinding(current, doc.id, {
        clauseId: clause.id, status: 'running', citations: [],
      });
      onUpdate(current);

      const finding = await extractClause(doc, clause, template, settings, signal);
      current = withFinding(current, doc.id, finding);
      onUpdate(current);
    },
    signal,
  );

  current = { ...current, completedAt: Date.now() };
  onUpdate(current);
  return current;
}

export async function retryCell(
  run: ReviewRun,
  doc: DocumentFile,
  clauseId: string,
  settings: Settings,
  onUpdate: (run: ReviewRun) => void,
): Promise<ReviewRun> {
  const clause = run.templateSnapshot.clauses.find(c => c.id === clauseId);
  if (!clause) return run;

  let current = withFinding(run, doc.id, { clauseId, status: 'running', citations: [] });
  onUpdate(current);

  const finding = await extractClause(doc, clause, run.templateSnapshot, settings);
  current = withFinding(current, doc.id, finding);
  onUpdate(current);
  return current;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/runReview.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/features/review/runReview.ts src/features/review/runReview.test.ts
git commit -m "feat: add review orchestration shared by card and tabular views"
```

---

### Task 12: Template generation

**Files:**
- Create: `src/features/templates/generateTemplate.ts`
- Create: `src/features/templates/generateTemplate.test.ts`
- Source to port: `services/aiService.ts:116-241`

**Interfaces:**
- Consumes: `chatJson` (Task 7), `mapWithConcurrency` (Task 4), `newTemplate` (Task 5).
- Produces:
  ```ts
  export type Depth = 'Light-Touch' | 'Standard' | 'Detailed';
  export type Verbosity = 'Concise' | 'Standard' | 'Lengthy';
  export interface GenerateOptions {
    contractType: string; depth: Depth; verbosity: Verbosity;
    context?: string; settings: Settings;
    onStatus?: (message: string) => void;
  }
  export function generateTemplate(options: GenerateOptions): Promise<Template>
  ```

The existing two-phase approach is kept because it is sound. What changes: bounded concurrency instead of `Promise.all` over 35 clauses, and a failed clause degrades the template instead of failing generation.

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/templates/generateTemplate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTemplate } from './generateTemplate';
import type { Settings } from '../../types';

vi.mock('../../lib/openrouter', () => ({ chatJson: vi.fn() }));
const { chatJson } = await import('../../lib/openrouter');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 3 };

const plan = {
  systemPrompt: 'You are a reviewer.',
  formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.',
  clausePlans: [
    { title: 'Term', instructionSummary: 'find the term', riskCriteriaSummary: 'over 5y is risky' },
    { title: 'Rent', instructionSummary: 'find the rent', riskCriteriaSummary: 'uncapped is risky' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatJson)
    .mockResolvedValueOnce(plan)
    .mockResolvedValue({ prompt: 'generated prompt', riskCriteria: 'generated criteria' });
});

describe('generateTemplate', () => {
  it('returns a saveable template built from the plan', async () => {
    const t = await generateTemplate({
      contractType: 'Commercial Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.contractType).toBe('Commercial Lease');
    expect(t.name).toBe('Commercial Lease');
    expect(t.systemPrompt).toBe('You are a reviewer.');
    expect(t.clauses.map(c => c.title)).toEqual(['Term', 'Rent']);
    expect(t.clauses[0].prompt).toBe('generated prompt');
    expect(t.clauses[0].id).toBeTruthy();
    expect(t.schemaVersion).toBeGreaterThan(0);
  });

  it('preserves the planned clause order despite parallel generation', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson)
      .mockResolvedValueOnce(plan)
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 20));
        return { prompt: 'slow first', riskCriteria: 'x' };
      })
      .mockResolvedValueOnce({ prompt: 'fast second', riskCriteria: 'y' });

    const t = await generateTemplate({
      contractType: 'Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.clauses[0].prompt).toBe('slow first');
    expect(t.clauses[1].prompt).toBe('fast second');
  });

  it('keeps a clause whose prompt generation failed, using the planned summary', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson)
      .mockResolvedValueOnce(plan)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ prompt: 'ok', riskCriteria: 'ok' });

    const t = await generateTemplate({
      contractType: 'Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.clauses.length).toBe(2);
    expect(t.clauses[0].prompt).toBe('find the term');
    expect(t.clauses[1].prompt).toBe('ok');
  });

  it('reports status as it progresses', async () => {
    const messages: string[] = [];
    await generateTemplate({
      contractType: 'NDA', depth: 'Light-Touch', verbosity: 'Concise', settings,
      onStatus: m => messages.push(m),
    });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.join(' ')).toMatch(/NDA/);
  });

  it('includes the requested depth guidance in the planning prompt', async () => {
    await generateTemplate({
      contractType: 'NDA', depth: 'Detailed', verbosity: 'Standard', settings,
    });
    expect(vi.mocked(chatJson).mock.calls[0][0].user).toContain('Detailed');
  });

  it('passes optional context through to the planner', async () => {
    await generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard',
      context: 'We are the disclosing party.', settings,
    });
    expect(vi.mocked(chatJson).mock.calls[0][0].user).toContain('We are the disclosing party.');
  });

  it('fails loudly when planning itself fails', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson).mockRejectedValue(new Error('bad key'));

    await expect(generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard', settings,
    })).rejects.toThrow(/bad key/);
  });

  it('rejects a plan with no clauses', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson).mockResolvedValueOnce({ ...plan, clausePlans: [] });

    await expect(generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard', settings,
    })).rejects.toThrow(/no clauses/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/templates/generateTemplate.test.ts`
Expected: FAIL — cannot resolve `./generateTemplate`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/templates/generateTemplate.ts
import { chatJson } from '../../lib/openrouter';
import { mapWithConcurrency } from '../../lib/concurrency';
import { newTemplate } from '../../lib/storage';
import type { Clause, Settings, Template } from '../../types';

export type Depth = 'Light-Touch' | 'Standard' | 'Detailed';
export type Verbosity = 'Concise' | 'Standard' | 'Lengthy';

export interface GenerateOptions {
  contractType: string;
  depth: Depth;
  verbosity: Verbosity;
  context?: string;
  settings: Settings;
  onStatus?: (message: string) => void;
}

interface ClausePlan {
  title: string;
  instructionSummary: string;
  riskCriteriaSummary: string;
}

interface Plan {
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance: string;
  clausePlans: ClausePlan[];
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    systemPrompt: { type: 'string' },
    formatPrompt: { type: 'string' },
    riskTolerance: { type: 'string' },
    clausePlans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          instructionSummary: { type: 'string' },
          riskCriteriaSummary: { type: 'string' },
        },
        required: ['title', 'instructionSummary', 'riskCriteriaSummary'],
        additionalProperties: false,
      },
    },
  },
  required: ['systemPrompt', 'formatPrompt', 'riskTolerance', 'clausePlans'],
  additionalProperties: false,
};

const CLAUSE_PROMPT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' }, riskCriteria: { type: 'string' } },
  required: ['prompt', 'riskCriteria'],
  additionalProperties: false,
};

const DEPTH_GUIDANCE: Record<Depth, string> = {
  'Light-Touch': 'Light-Touch: roughly 8-12 high-level commercial risks.',
  Standard: 'Standard: roughly 15-22 balanced legal and commercial points.',
  Detailed: 'Detailed: roughly 25-35 deep-dive points, only where genuinely relevant.',
};

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function generateTemplate(options: GenerateOptions): Promise<Template> {
  const { contractType, depth, verbosity, context, settings, onStatus } = options;

  onStatus?.(`Planning a ${depth} review template for ${contractType}...`);

  const plan = await chatJson<Plan>({
    apiKey: settings.apiKey,
    modelId: settings.modelId,
    system:
      'You are an expert legal contract architect planning a contract review template. ' +
      'Use legal judgement to choose the number of clauses; do not pad to hit a count.',
    user: `Plan a "${depth}" contract review template for a "${contractType}".
${DEPTH_GUIDANCE[depth]}
Verbosity of the eventual prompts: ${verbosity}.
Context: ${context || 'None'}

Return systemPrompt, formatPrompt, riskTolerance, and clausePlans[{title, instructionSummary, riskCriteriaSummary}].`,
    jsonSchema: PLAN_SCHEMA,
    temperature: 0.7,
  });

  if (!Array.isArray(plan.clausePlans) || plan.clausePlans.length === 0) {
    throw new Error('The model returned a plan with no clauses. Try again, or pick a different model.');
  }

  onStatus?.(`Planned ${plan.clausePlans.length} clauses. Writing prompts...`);

  // Bounded, not Promise.all over 35 at once — the old code reliably tripped rate limits.
  const clauses = await mapWithConcurrency<ClausePlan, Clause>(
    plan.clausePlans,
    settings.concurrency,
    async cp => {
      try {
        const generated = await chatJson<{ prompt: string; riskCriteria: string }>({
          apiKey: settings.apiKey,
          modelId: settings.modelId,
          system: 'You are a legal prompt engineer.',
          user: `Write an extraction prompt for the clause "${cp.title}".
Context: ${cp.instructionSummary}
Risk criteria: ${cp.riskCriteriaSummary}
Verbosity: ${verbosity}

Return { prompt, riskCriteria }.`,
          jsonSchema: CLAUSE_PROMPT_SCHEMA,
          temperature: 0.5,
        });
        return {
          id: uid(),
          title: cp.title,
          prompt: generated.prompt,
          riskCriteria: generated.riskCriteria,
        };
      } catch {
        // Degrade rather than fail: keep the clause with its planned summary,
        // which the user can edit, instead of losing the whole template.
        return {
          id: uid(),
          title: cp.title,
          prompt: cp.instructionSummary,
          riskCriteria: cp.riskCriteriaSummary,
        };
      }
    },
  );

  onStatus?.('Finalising template...');

  return {
    ...newTemplate(contractType),
    contractType,
    mode: 'risk',
    systemPrompt: plan.systemPrompt,
    formatPrompt: plan.formatPrompt,
    riskTolerance: plan.riskTolerance,
    clauses,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/templates/generateTemplate.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/features/templates/ && git commit -m "feat: port template generation with bounded concurrency and graceful degradation"
```

---

### Task 13: App shell, Tailwind 4, and Firebase removal

**Files:**
- Create: `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/components/Toast.tsx`, `src/components/Modal.tsx`, `src/components/Button.tsx`, `src/components/RiskBadge.tsx`, `src/components/AutoResizeTextarea.tsx`, `src/features/settings/SettingsPanel.tsx`
- Modify: `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json`
- Delete: `firebase.ts`, `firestore.rules`, `services/` (whole directory), `components/` (whole directory), `App.tsx`, `index.tsx`, `types.ts`

**Interfaces:**
- Consumes: `loadSettings`/`saveSettings` (Task 5), `listModels` (Task 7).
- Produces: a running app shell with a working Settings panel; `useToast()` hook; `<Modal>`, `<Button>`, `<RiskBadge>`, `<AutoResizeTextarea>`.

**This is the demolition task.** Everything before it built the replacement; this deletes the old code in one commit so the tree is never half-migrated. Views wired in Tasks 14-18 are stubbed here as "coming next" placeholders so the shell compiles and runs on its own.

- [ ] **Step 1: Install Tailwind 4 and remove the dead dependencies**

```bash
npm uninstall firebase @google/genai openai @anthropic-ai/sdk
npm install tailwindcss @tailwindcss/vite
npm install docx
```

Tailwind 4 uses the Vite plugin and CSS-first config — there is no `tailwind.config.js` and no PostCSS step.

- [ ] **Step 2: Rewrite `vite.config.ts`**

```ts
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: { port: 3005, host: '127.0.0.1' },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
```

The `define` block that injected `process.env.API_KEY` is gone. Nothing reads it any more, and its presence is what made the surviving `process.*` references look plausible.

- [ ] **Step 3: Rewrite `index.html` with no CDN scripts**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LexPrompt</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `src/index.css`**

```css
@import "tailwindcss";

@theme {
  --color-surface: #09090b;
  --color-panel: #111113;
  --color-card: #1a1a1d;
}

body {
  background-color: var(--color-surface);
  color: #e2e8f0;
  -webkit-font-smoothing: antialiased;
}

.custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: rgb(255 255 255 / 0.1); border-radius: 10px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgb(255 255 255 / 0.2); }
```

- [ ] **Step 5: Create `src/main.tsx` with the error boundary only**

Port the `ErrorBoundary` class from `index.tsx:21-40` verbatim. **Do not** port the `window.onerror` handler at `index.tsx:6-18` — it injects a raw red `div` over the page and duplicates the boundary.

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-10 min-h-screen bg-red-950 text-white">
          <h1 className="text-2xl font-bold mb-4">Something went wrong.</h1>
          <pre className="bg-black/50 p-4 rounded overflow-auto text-sm">
            {String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find #root to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
```

- [ ] **Step 6: Build the shared primitives**

`src/components/Toast.tsx` — a `useToast()` hook returning `{ notify, toast }` plus a `<Toast>` renderer. Port the markup from `App.tsx:259-264`, keeping the 3-second auto-dismiss and the success/error variants.

`src/components/Modal.tsx` — extract the shared overlay chrome repeated in `components/Modals.tsx` (fixed inset, `bg-black/80 backdrop-blur-sm`, centred panel, titled header with a close `X`). Props: `{ isOpen, title, onClose, children, footer? }`.

`src/components/Button.tsx` — variants `primary` (violet), `ghost` (white/5), `danger` (red), with `disabled` and `loading` states. The current code repeats these class strings 30+ times.

`src/components/RiskBadge.tsx` — takes `RiskLevel | undefined`, renders the coloured pill. Port the colours from `ResultsView.tsx:206-208` but **write the class strings fresh** — the originals there are corrupted into `text - [10px] px - 2 py - 0.5`.

`src/components/AutoResizeTextarea.tsx` — port `components/AutoResizeTextarea.tsx` unchanged; it is 36 lines and correct.

- [ ] **Step 7: Build the Settings panel**

`src/features/settings/SettingsPanel.tsx`. Props: `{ settings, onChange }`.

- A password-type input for the OpenRouter key, placeholder `sk-or-v1-...`, with a link to `https://openrouter.ai/keys`.
- Plain-language text stating: the key is stored in this browser's local storage and sent only to OpenRouter; it is never sent anywhere else. Say it in the UI, not just a tooltip.
- A model picker populated from `listModels()`, fetched once on mount and cached in component state. Show each model's id, context length, and prompt price. Sort so models with `supportsStructuredOutput` come first, and label those without it "may not honour output schemas".
- A concurrency slider, 1-10, defaulting to 5, labelled "Parallel requests".
- Persist every change via `saveSettings`.
- If `listModels()` fails, show the error and a Retry button — never a blank picker.

- [ ] **Step 8: Build `src/App.tsx` as the shell**

State: `view` (`'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings'`), `templates`, `activeTemplate`, `documents`, `run`, `settings`, toast. Header with the LexPrompt mark, a Library link, and a Settings gear.

**Removed relative to the old `App.tsx`:** the `credits` state and its top-up button (`App.tsx:18, 74-88, 268-273`), `checkCredits`/`deductCredits` and all their call sites, the `user`/auth gate at `:255`, `handleModifyTemplate`'s fake `setTimeout` at `:190`.

Render placeholders for the views built in Tasks 14-18:

```tsx
{view === 'editor' && <div className="p-8 text-gray-500">Template editor — Task 14.</div>}
{view === 'run' && <div className="p-8 text-gray-500">Run panel — Task 16.</div>}
```

Add a settings gate: if `!settings.apiKey || !settings.modelId`, any attempt to enter `run` or generate a template routes to `settings` with a toast reading "Add your OpenRouter key to get started."

- [ ] **Step 9: Delete the old tree**

```bash
git rm -r --cached services components 2>/dev/null || true
rm -rf services components
rm -f firebase.ts firestore.rules App.tsx index.tsx types.ts
```

`.firebaserc` and `firebase.json` stay — between them they configure static hosting and name the deploy target, which `npm run hosting:on` needs. Neither references Firestore or Auth once `firestore.rules` is gone.

- [ ] **Step 10: Point tsconfig at src and verify**

Update `tsconfig.json` `include` to `["src"]` and the `@/*` path alias to `["./src/*"]`.

Run: `npx tsc --noEmit && npm test && npm run build && npm run dev`
Expected: `tsc` clean — including the `geminiProvider.ts(104,45)` error from Task 1, which disappears with the file. Tests pass. Build emits **no** "has been externalized for browser compatibility" warning. Dev server serves a styled page with a working Settings panel that lists real models.

- [ ] **Step 11: Verify no forbidden references survive**

```bash
grep -rn "process\.\|cdn\.tailwindcss\|cdnjs\.cloudflare\|unpkg\.com\|firebase" src/ index.html || echo "clean"
```

Expected: `clean`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: replace Firebase shell with backend-free app, Tailwind 4, and OpenRouter settings"
```

---

### Task 14: Template library and editor

**Files:**
- Create: `src/features/templates/TemplateLibrary.tsx`, `src/features/templates/TemplateEditor.tsx`, `src/features/templates/CreateTemplateDialog.tsx`
- Modify: `src/App.tsx` (replace the editor/library placeholders)
- Source to port: `components/TemplateEditor.tsx`, `components/Modals.tsx:13-100` (`CreateTemplateModal`), `App.tsx:296-360` (library grid)

**Interfaces:**
- Consumes: `listTemplates`, `saveTemplate`, `deleteTemplate`, `newTemplate`, `exportTemplate`, `importTemplate` (Task 5); `generateTemplate` (Task 12); `Modal`, `Button`, `AutoResizeTextarea` (Task 13).
- Produces: `<TemplateLibrary>`, `<TemplateEditor>`, `<CreateTemplateDialog>`.

- [ ] **Step 1: Port the library grid**

`<TemplateLibrary templates onOpen onRun onDelete onCreate onImport />`. Port the card grid from `App.tsx:302-355`. Drop the ownership check at `:344` (`user.uid === t.createdById || user.email === 'andy@example.com'`) — there are no users; every template is the visitor's and every card gets a delete button. Keep the `ConfirmationModal` flow from `Modals.tsx` for deletion, rebuilt on `<Modal>`.

Empty state: "No templates yet. Create one to get started."

- [ ] **Step 2: Port the create dialog**

`<CreateTemplateDialog isOpen onClose onCreate loading status />`. Port from `Modals.tsx:13-100`: the AI / Blank tabs, contract-type input, Depth (`Light-Touch | Standard | Detailed`) and Verbosity (`Concise | Standard | Lengthy`) selectors, optional context textarea. Remove the credit-cost badge. Show `status` text while generating — `generateTemplate`'s `onStatus` drives it.

- [ ] **Step 3: Port the editor**

`<TemplateEditor template onChange onSave onExport onClose />`. Port `components/TemplateEditor.tsx` almost unchanged: it is 166 lines, correct, and its class strings are intact. Remove the `onModifyWithAI` prop and its button (`TemplateEditor.tsx:71`) — it was wired to the simulated handler. Keep `onShowMegaPrompt` (the DIY prompt view) and the clause reorder/add/delete controls.

- [ ] **Step 4: Wire into App**

Library loads via `listTemplates()` on mount and after every save/delete/import. Creating routes to the editor with the new template active. Save calls `saveTemplate` and shows a toast. Export downloads `exportTemplate(t)` as `<name>.json`. Import reads the chosen file and calls `importTemplate`, catching and toasting the two error messages it can throw.

- [ ] **Step 5: Verify manually**

Run: `npm run dev`

Confirm: creating a blank template opens the editor; adding, reordering and deleting clauses works; Save persists across a full page reload; Export downloads valid JSON; re-importing that file yields a second copy rather than overwriting the first; deleting asks first.

With a real OpenRouter key, generate a template for "Commercial Lease" at Standard depth and confirm the status text advances and the clause list is plausible and editable.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "feat: add template library, create dialog and editor"
```

---

### Task 15: PDF viewer on pdfjs-dist v6

**Files:**
- Create: `src/features/review/PdfCanvas.tsx`, `src/features/review/DocumentViewer.tsx`
- Source to port: `components/PDFViewer.tsx:12-66` (page rendering) and `:162-178` (zoom chrome)

**Interfaces:**
- Consumes: `findQuoteRects`, `PdfPageText` (Task 2); `extractPageText` (Task 9).
- Produces: `<DocumentViewer doc highlights />` — renders a PDF with highlighted citations, or scrollable text for DOCX/TXT.

The v3→v6 port is the substance here. The matching logic is already done and tested in Task 2; this task only renders.

- [ ] **Step 1: Build `PdfCanvas.tsx`**

One `<canvas>` per page. Load the document with `pdfjs.getDocument`, build the page-text index once via `extractPageText`, and pass it plus `highlights` to `findQuoteRects`.

Port the rect-to-viewport conversion from `PDFViewer.tsx:41-63` — including the `top: viewRect[1] - rect.h * scale` offset and the `1.4` height multiplier, which exist because pdf.js reports a text item's origin at its baseline, not its top. Keep `mixBlendMode: 'multiply'` and `pointerEvents: 'none'`.

Scroll the first highlight into view when `highlights` changes (`PDFViewer.tsx:33-37`).

Correct against the v6 types confirmed in Task 9 Step 1: `page.render()` argument shape, and awaiting `.promise`. If `RenderParameters` requires `canvas`, pass it.

- [ ] **Step 2: Build `DocumentViewer.tsx`**

Dispatches on `doc.kind`. PDF → lazy-loaded `<PdfCanvas>` via `React.lazy` + `<Suspense>`, keeping `pdfjs-dist` out of the initial bundle. DOCX/TXT → the pre-formatted text pane from `ResultsView.tsx:296-298`. If `doc.parseError` is set, show the error and the filename instead.

- [ ] **Step 3: Verify manually against the real fixtures**

Add a temporary route or a dev-only button that loads `test_docs/openrent_standard_ast.pdf` into `<DocumentViewer>` with a hardcoded `highlights` array containing a phrase you have copied by eye out of that PDF.

Confirm: every page renders; zoom in and out works; the highlight lands **on the right words**, not merely somewhere on the right page; the view scrolls to it.

Then try `test_docs/gov_uk_model_ast.pdf` and `signed-counterpart-lease-unit-14-meadowview.pdf`. Remove the temporary route before committing.

This step is manual because the value is in whether the rectangle lands on the correct text, which a unit test on mocked geometry cannot tell you.

- [ ] **Step 4: Commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "feat: port PDF viewer with citation highlighting to pdfjs-dist v6"
```

---

### Task 16: Run panel and card results

**Files:**
- Create: `src/features/review/RunPanel.tsx`, `src/features/review/ResultsView.tsx`, `src/features/review/FindingCard.tsx`
- Modify: `src/App.tsx`
- Source to port: `App.tsx:363-428` (upload/run), `components/ResultsView.tsx:180-260` (cards)

**Interfaces:**
- Consumes: `parseFiles` (Task 9); `emptyRun`, `runReview`, `retryCell`, `runProgress` (Task 11); `<DocumentViewer>` (Task 15); `<RiskBadge>` (Task 13).
- Produces: `<RunPanel>`, `<ResultsView run documents onRetryCell />`, `<FindingCard>`.

This is the payoff task — the loop the whole plan exists to restore.

- [ ] **Step 1: Build the run panel**

`<RunPanel template onCancel onComplete />`. A multi-file drop zone (port `App.tsx:377-382`) calling `parseFiles`. List each parsed file with its name; mark any with `parseError` and let the visitor remove it before running.

Replace the old three-button row (`App.tsx:410-421`) with a single **Run review** button plus a note of what will happen: "N documents × M clauses". The Batch/Collection distinction is gone — every run is per-document now, which is what the card view always wanted.

While running: a progress bar from `runProgress(run)` reading "34 of 60 clauses", and a Cancel button that aborts the `AbortController`.

- [ ] **Step 2: Build the finding card**

`<FindingCard clause finding onCiteClick onRetry />`. Port the card from `ResultsView.tsx:196-247` and **rewrite every class string** — the ones at `:184`, `:206` and `:250` are corrupted into `flex - 1 py - 3 text - sm` and must not be copied.

Card contents: clause title, `<RiskBadge>`, summary, risk analysis block when present, and a row of "Ref 1 / Ref 2" citation buttons with the verbatim-quote tooltip from `:239-243`. Clicking a citation calls `onCiteClick([quote])`, which sets the viewer's highlights.

Status handling: `pending` → dimmed placeholder; `running` → skeleton with a spinner; `error` → the message plus a **Retry** button calling `onRetry(clauseId)`; `done` → the full card.

Drop the "Suggest Fix" button here; it returns in Task 18.

- [ ] **Step 3: Build the results view**

`<ResultsView run documents onRetryCell />`. Two panes: findings list left (a `<FindingCard>` per clause, in `templateSnapshot.clauses` order), `<DocumentViewer>` right. A document switcher above the list when the run covers more than one, which swaps both the card column and the viewer together.

`highlights` is local state, set by `onCiteClick`, passed to `<DocumentViewer>`.

Header actions: a document dropdown, and a "Tabular view" toggle (wired in Task 17).

- [ ] **Step 4: Wire into App**

Run flow: `emptyRun` → set `run` → `runReview(..., setRun, signal)` → switch to `results`. `onUpdate` sets state on every cell, so cards fill in progressively. `onRetryCell` calls `retryCell`.

- [ ] **Step 5: Verify manually — this is the spec's core acceptance check**

Run: `npm run dev`

With a real key and a saved template:
1. Run against `test_docs/openrent_standard_ast.pdf` alone. Cards fill in progressively rather than all at once at the end.
2. Click a citation on a card. The viewer scrolls to and highlights **that exact passage**.
3. Run against all three PDFs in `test_docs/`. The document switcher moves between them and the cards change with it.
4. Mid-run, click Cancel. The run stops and completed cards remain readable.
5. Put a deliberately broken key in Settings, run, and confirm the cards show an error with a working Retry — not a silent empty state.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "feat: add run panel and card results with citation highlighting"
```

---

### Task 17: Tabular view over the shared findings map

**Files:**
- Create: `src/features/tabular/TabularReview.tsx`, `src/features/tabular/CellDetail.tsx`
- Modify: `src/App.tsx`
- Source to port: `components/TabularReview.tsx` (grid markup and cell detail only)

**Interfaces:**
- Consumes: `ReviewRun`, `retryCell`, `runProgress` (Task 11); `<RiskBadge>` (Task 13); `<DocumentViewer>` (Task 15).
- Produces: `<TabularReview run documents onRetryCell onOpenCards />`.

**Critical:** this is a *renderer*, not a pipeline. It must not call `extractClause` or hold its own data. It reads the same `run.findings` the card view reads. The old `TabularReview.tsx` had its own `processQueue`, its own `TabularData` state, and its own AI calls (`:44-90`); none of that is ported.

- [ ] **Step 1: Build the grid**

Rows are documents, columns are `run.templateSnapshot.clauses`. Each cell shows the finding's summary truncated, tinted by risk level. Sticky first column (document name) and sticky header row. Port the wrap-text toggle and the grid chrome from `TabularReview.tsx`, but source every value from `run.findings[docId][clauseId]`.

Cell states mirror the card: `pending` dimmed, `running` a pulse, `error` a red cell with a retry affordance, `done` the summary.

- [ ] **Step 2: Build the cell detail panel**

Clicking a cell opens `<CellDetail>` showing the full summary, risk level, risk analysis, and citation buttons — the same content as `<FindingCard>`, in a side panel — with `<DocumentViewer>` beneath scrolled to the clicked citation.

- [ ] **Step 3: Add CSV export**

An "Export CSV" button producing one row per document, one column per clause, cells containing the summary. Quote and escape properly: wrap every field in double quotes and double any internal quote, since legal summaries routinely contain commas, quotes and newlines.

- [ ] **Step 4: Wire the toggle**

`results` and `tabular` become two views of the same `run`. Toggling between them must not re-run anything or lose state — that is the whole point of the shared map, and is the thing to check hardest.

- [ ] **Step 5: Verify manually**

Run one review over all three `test_docs/` PDFs, then:
1. Toggle to tabular. Every cell is already populated — **no new requests fire**. Confirm in the browser's Network tab.
2. Toggle back to cards. State is intact.
3. Click a cell; the detail panel and viewer show the same content the matching card does.
4. Export CSV and open it in a spreadsheet; confirm a summary containing a comma has not split across columns.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "feat: add tabular view rendering the shared findings map"
```

---

### Task 18: DOCX export and the assistant features

**Files:**
- Create: `src/features/review/exportDocx.ts`, `src/features/assistant/ChatPanel.tsx`, `src/features/assistant/draftEmail.ts`, `src/features/assistant/suggestRevision.ts`, `src/features/assistant/RevisionModal.tsx`
- Create: `src/features/review/exportDocx.test.ts`
- Modify: `src/features/review/ResultsView.tsx`
- Source to port: `ResultsView.tsx:92-176` (docx builder), `:56-79` (chat), `services/aiService.ts:358-386` (email, revision)

**Interfaces:**
- Consumes: `chat`, `chatStream` (Tasks 7-8); `ReviewRun`, `Finding` (Task 3).
- Produces:
  ```ts
  export interface ReportRow {
    title: string;
    summary: string;
    riskLevel?: RiskLevel;
    riskAnalysis?: string;
    citations: string[];
  }
  export function buildReportRows(run: ReviewRun, docId: string): ReportRow[]
  export function exportDocx(run: ReviewRun, docId: string, docName: string): Promise<void>
  export function draftEmail(run: ReviewRun, docId: string, settings: Settings): Promise<string>
  export function suggestRevision(clauseTitle: string, original: string, issue: string, settings: Settings): Promise<string>
  ```

- [ ] **Step 1: Write the failing test for the report row builder**

The `docx` document construction is not usefully unit-testable, but the row derivation is — and it is where the logic lives.

```ts
// src/features/review/exportDocx.test.ts
import { describe, it, expect } from 'vitest';
import { buildReportRows } from './exportDocx';
import type { ReviewRun, Template } from '../../types';

const template: Template = {
  id: 't', name: 'T', contractType: 'NDA', mode: 'risk',
  systemPrompt: '', formatPrompt: '',
  clauses: [
    { id: 'c1', title: 'Term', prompt: '' },
    { id: 'c2', title: 'Law', prompt: '' },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

const run: ReviewRun = {
  id: 'r', templateSnapshot: template, documentIds: ['d1'],
  findings: {
    d1: {
      c1: { clauseId: 'c1', status: 'done', summary: 'Three years.', citations: ['a term of three years'], riskLevel: 'Low', riskAnalysis: 'Standard.' },
      c2: { clauseId: 'c2', status: 'error', citations: [], error: 'timed out' },
    },
  },
  startedAt: 0,
};

describe('buildReportRows', () => {
  it('emits one row per clause in template order', () => {
    expect(buildReportRows(run, 'd1').map(r => r.title)).toEqual(['Term', 'Law']);
  });

  it('carries summary, risk and citations through', () => {
    const row = buildReportRows(run, 'd1')[0];
    expect(row.summary).toBe('Three years.');
    expect(row.riskLevel).toBe('Low');
    expect(row.citations).toEqual(['a term of three years']);
  });

  it('renders a failed clause honestly rather than as an empty finding', () => {
    const row = buildReportRows(run, 'd1')[1];
    expect(row.summary).toMatch(/not (be )?review/i);
    expect(row.summary).toMatch(/timed out/);
  });

  it('marks a clause with no citations', () => {
    const noCite: ReviewRun = {
      ...run,
      findings: { d1: { c1: { clauseId: 'c1', status: 'done', summary: 's', citations: [] }, c2: run.findings.d1.c2 } },
    };
    expect(buildReportRows(noCite, 'd1')[0].citations).toEqual([]);
  });

  it('returns an empty list for an unknown document', () => {
    expect(buildReportRows(run, 'nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `npx vitest run src/features/review/exportDocx.test.ts` → FAIL.

Implement `buildReportRows` returning `{ title, summary, riskLevel, riskAnalysis, citations }[]`, and `exportDocx` which dynamically imports `docx`, builds one bordered table per row exactly as `ResultsView.tsx:104-170` does, and saves the blob. An `error` finding renders as "This clause could not be reviewed: &lt;error&gt;" — a report that silently omits a failed clause is worse than one that says so.

Run again → PASS.

- [ ] **Step 3: Implement draftEmail and suggestRevision**

`draftEmail(run, docId, settings)` — port the prompt from `aiService.ts:361-368`, feeding it `buildReportRows` output rather than raw JSON, high-risk items first. Returns markdown.

`suggestRevision(clauseTitle, original, issue, settings)` — port from `aiService.ts:375-385`. Returns replacement clause text.

**Neither may use `alert()`.** The old `draftEmail` result went to `alert(emailBody)` (`App.tsx:445`). Render both in a `<Modal>`: email as rendered markdown with a Copy button; revision as an original/revised side-by-side (port `RevisionModal` from `Modals.tsx`) with Copy.

- [ ] **Step 4: Build the chat panel**

`<ChatPanel documents settings />` as a tab beside Findings in `ResultsView`, port from `ResultsView.tsx:249-283`. Uses `chatStream` so tokens appear as they arrive. Keep the `ReactMarkdown` + `remarkGfm` rendering and its component overrides (`:256-266`).

Fix the streaming bug at `ResultsView.tsx:64-70`: it mutates `next[next.length - 1].content` in place, which mutates React state directly. Replace the last message immutably:

```tsx
setHistory(prev => [
  ...prev.slice(0, -1),
  { ...prev[prev.length - 1], content: prev[prev.length - 1].content + chunk },
]);
```

Also delete the unused `assistantIdx` variable at `:62` and the unused `resp` binding at `:65`.

Send the active document's text as context, truncated to a budget derived from the selected model's `contextLength`, rather than the hardcoded 50,000 characters.

- [ ] **Step 5: Re-add "Suggest Fix" to the finding card**

On High and Medium risk findings only, matching `ResultsView.tsx:216`. Calls `suggestRevision(clause.title, finding.citations[0] ?? finding.summary, finding.riskAnalysis)` and opens the revision modal. No credit check.

- [ ] **Step 6: Verify manually**

Export a DOCX and open it: check a High-risk clause is shaded, evidence quotes are numbered, and a failed clause says so. Draft an email and confirm it renders in a modal with a working Copy. Suggest a fix on a High-risk finding. Ask the chat panel a question about the loaded lease and confirm text streams in and the answer is grounded in the document.

- [ ] **Step 7: Commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "feat: add DOCX export, chat, draft email and suggest revision"
```

---

### Task 19: Final verification, documentation and deploy check

**Files:**
- Modify: `README.md`, `package.json`

No `.env` or `.env.example`: this architecture has no build-time environment variables. The only secret is the OpenRouter key, and it is entered at runtime in Settings.

**Interfaces:**
- Consumes: everything.
- Produces: a verified, hostable build.

- [ ] **Step 1: Run the full gate**

```bash
npx tsc --noEmit
npm test
npm run build
```

All three clean. The build must emit no "externalized for browser compatibility" warning. Note the bundle size and compare against the 1,407.88 kB baseline recorded before this work; it should be substantially smaller with `pdfjs-dist` and `docx` split out.

- [ ] **Step 2: Confirm the forbidden patterns are absent from the shipped bundle**

```bash
grep -rn "process\." src/ || echo "no process refs"
grep -c "firebase" dist/assets/*.js || echo "no firebase in bundle"
grep -rn "cdn\.\|cdnjs\.\|unpkg\." index.html || echo "no CDN refs"
```

- [ ] **Step 3: Serve the built output and walk the acceptance list**

```bash
npx vite preview
```

In a **fresh browser profile** (no existing localStorage), work through the nine checks in section 11 of the spec, in order. Every one must pass against the real `test_docs/` PDFs. Record any that do not and fix before proceeding — this is the definition of done, not a formality.

- [ ] **Step 4: Rewrite the README**

Replace it entirely. The current one advertises "Gemini 3.0 Pro", "GPT-5", "Claude 3.5 Sonnet", Firestore-backed team templates and a credits system, none of which will exist.

Cover: what the app does (the four-step loop); that it is a static site with no backend and no accounts; that it needs an OpenRouter key, where to get one, and that the key is stored in the browser and sent only to OpenRouter; local development (`npm install`, `npm run dev`); testing (`npm test`); and deployment (`npm run build`, then any static host — with the Firebase Hosting command as one example).

State plainly that templates live in browser local storage and are therefore per-browser, and that documents are never persisted or uploaded anywhere except to the chosen model via OpenRouter. Someone evaluating this for contract work will ask; answer it in the README.

- [ ] **Step 5: Clean up package.json**

Remove any script whose target no longer exists. Confirm `dependencies` contains only: `react`, `react-dom`, `react-markdown`, `remark-gfm`, `lucide-react`, `pdfjs-dist`, `mammoth`, `docx`. Confirm `firebase`, `openai`, `@google/genai` and `@anthropic-ai/sdk` are gone from both the manifest and the lockfile.

```bash
grep -E '"(firebase|openai|@google/genai|@anthropic-ai/sdk)"' package.json || echo "clean"
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "docs: rewrite README for the backend-free OpenRouter build"
```

---

## Post-Plan Notes

**Rotate the OpenAI key.** `bench.ts`, `tests/performance.test.ts` and `test_responses.ts` each contained a live `sk-proj-` key. They were untracked and the key never entered git history, but it sat unencrypted on disk and was compiled into `dist/` at least once. Task 1 deletes the files; rotating the key at platform.openai.com is a separate action only you can take, and nothing in this plan depends on it.

**Deferred deliberately.** Multi-user accounts, sharing, server-side persistence, and migration of any templates still in the Firebase project. The last of these is a small standalone task if it turns out those templates matter.
