# Redesign sub-project E — Playbook authoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a playbook come into existence — drafted by a model from a description and the firm's own prior work, or built by hand with per-field suggestions — and make it impossible to save one until a human has been through every clause.

**Architecture:** A session-only `AuthoringDraft` held in React state, never persisted. One generation call produces the clause list; a review screen forces a keep / edit-then-keep / cut decision on each clause; `Save as v1` converts the reviewed draft into a published `PlaybookVersion` through sub-project D's existing `publishVersion`, with cut clauses genuinely absent and provenance honestly recorded.

**Tech Stack:** React 19, TypeScript 5.8 (strict), Vite 6, Tailwind 4, Vitest 3 + jsdom.

**Spec:** `docs/superpowers/specs/2026-08-27-redesign-e-playbook-authoring.md`

**Depends on:** sub-project D, which must be complete. E consumes D's `PlaybookClause`, `StandardPosition`, `PlaybookDraft`, `PlaybookVersion` and `publishVersion` and **does not reimplement any of them**.

---

## Global Constraints

- **Nothing the model produced is treated as the firm's until a human has said so, clause by clause.** This is the sub-project.
- **A draft is never persisted.** Not to IndexedDB, not to `localStorage`, not to a URL. A draft that survives a reload is a playbook nobody agreed to. This is the one place in the redesign where *not* persisting is the correct answer, and it is a decision rather than an omission.
- **Save is gated on review, not on time.** Every clause must be kept, edited-and-kept, or cut. `Save as v1` says how many remain rather than being inertly grey.
- **Provenance is recorded and shown.** `origin: 'ai-drafted'` with `reviewedByHuman: false` renders differently from one a human accepted.
- **Per-field suggestions are suggestions** — rendered visibly unaccepted, never adopted by saving the form.
- **A malformed clause is repaired, not dropped.** A clause with a title and no extract prompt arrives unreviewed with an empty prompt and a visible marker.
- **Never pad to a target.** A model asked for ~18 clauses that returns 15 good ones has not failed.
- **Few-shot uses `verified` findings only.** An unverified finding is the model's own output; feeding it back as house style would launder a guess into a rule.
- `SCHEMA_VERSION` does **not** change. E persists nothing new.
- **Gates for every task:** `npx tsc --noEmit` clean, `npm test` green, `npm run build` clean with no externalization warning.
- **Mutation-test anything load-bearing.** Break it, confirm the test fails, restore, report the observed failure. A mutation that does not bite means the test proves nothing — say so.
- **`toEqual` does not distinguish an absent key from an `undefined` one.** Use `expect('k' in obj).toBe(false)` when absence is the assertion.
- **No `@testing-library/react`.** Use `src/test/mount.tsx` (`mount`, `mountOnce`, `click`, `type`, `keyDown`).
- **Do not touch:** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/verification.ts`, `src/lib/netPosition.ts`, `src/lib/citationPage.ts`, `PdfCanvas`, `src/features/assistant/`, and **D's publish path** (`db/playbookVersions.ts`) — E uses `publishVersion`, it does not reimplement or modify it.
- **Stage commits by name.** Never `git add -A` / `.` / `src` / `-u`; run `git show --stat HEAD` afterwards.

---

## Rulings made while writing this plan

To be copied into `docs/superpowers/redesign/rulings.md` by the docs task.

**R-E1 (already recorded).** E's session object is `AuthoringDraft`, not `PlaybookDraft` — D owns that name for the persisted working copy, and the two have opposite persistence rules.

**R-E2 — The few-shot privacy disclosure sits on the picker, not in Settings.** Spec §10 requires it at the point of selection. Everything else in this app sends only the document under review; this sends *other matters'* content to the chosen model. The disclosure names that plainly, next to the checkboxes, and is not dismissible. Cost if wrong: one line of copy someone finds redundant.

**R-E3 — `Save as v1` creates the `Playbook` identity record first, then publishes, and on a publish failure deletes the orphan.** Two writes cannot be one transaction across two stores here, so the order is chosen so the failure mode is recoverable: an identity with no version renders as a playbook with nothing in it, which is worse than nothing at all. Cost if wrong: a rare orphan record on a storage failure mid-save.

**R-E4 — Navigating away warns via an in-app guard, not `beforeunload` alone.** `beforeunload` covers a tab close and a reload; it does not fire on an in-app route change, which is the far likelier way to lose a draft. Both are wired. Cost if wrong: one confirm the user finds mildly annoying.

**R-E5 — `edited` is computed by comparing fields, never set by an onChange firing.** A focus-and-blur, or an edit typed and undone, must not count as "a human engaged with this". `edited: true` is a claim about how much a person actually did, and it feeds provenance. Cost if wrong: a clause reads as edited when it was only touched.

**R-E6 — The disabled learn-from-redlines card is rendered, not hidden.** Spec §6. The handoff frames three parallel routes; hiding one misrepresents what the product is going to be. It says "not built yet" rather than being mysteriously inert. Cost if wrong: a visible affordance that does nothing yet, which is the honest state of affairs.

---

## File Structure

**Create:**
- `src/lib/authoringDraft.ts` — the session draft model, disposition transitions, the save gate, and the conversion to D's `PlaybookDraft`. Pure, no React, no store.
- `src/lib/authoringDraft.test.ts`
- `src/features/authoring/generateDraft.ts` — the one generation call, its schema, and its repair rules.
- `src/features/authoring/generateDraft.test.ts`
- `src/features/authoring/fewShot.ts` — builds few-shot material from selected playbooks and matters, **verified findings only**.
- `src/features/authoring/fewShot.test.ts`
- `src/features/authoring/RouteChooser.tsx` + test
- `src/features/authoring/DraftForm.tsx` + test
- `src/features/authoring/SourcePicker.tsx` + test — with R-E2's disclosure
- `src/features/authoring/DraftReview.tsx` + test — the gate's screen
- `src/features/authoring/ClauseRail.tsx` + test
- `src/features/authoring/suggestField.ts` + test — one small call per field
- `src/features/authoring/FieldSuggestion.tsx` + test — dashed, badged, unaccepted
- `src/features/authoring/suggestMissingClauses.ts` + test
- `src/features/authoring/useUnsavedDraftGuard.ts` + test — R-E4

**Modify:**
- `src/App.tsx` — the authoring route, and `Save as v1` through D's publish path.
- `src/features/templates/TemplateLibrary.tsx` — entry to the route chooser.
- `src/features/templates/TemplateEditor.tsx` — per-field `Draft this for me` and `Suggest what I'm missing` (D reshaped this file; build on that shape).
- `README.md`, `CLAUDE.md`, `docs/superpowers/redesign/rulings.md`.

---

## Task 1: `authoringDraft.ts` — the model and the save gate

The spec's Risk §10 says the save gate is the whole feature. This task is that gate, plus the model it gates.

**Files:**
- Create: `src/lib/authoringDraft.ts`, `src/lib/authoringDraft.test.ts`

**Interfaces:**
- Consumes: D's `PlaybookClause`, `StandardPosition`, `PlaybookDraft`.
- Produces:

```ts
export type ClauseDisposition = 'unreviewed' | 'kept' | 'cut';

export interface DraftClause extends PlaybookClause {
  disposition: ClauseDisposition;
  /** True when the human changed a field before keeping it. R-E5: computed
   *  by comparing values, never set by an onChange firing — "kept as
   *  drafted" and "rewritten then kept" are different claims about how much
   *  a person actually engaged, and this one feeds provenance. */
  edited: boolean;
  /** Extra sub-questions the model offered, neither added nor dismissed. */
  suggestions: string[];
}

export interface AuthoringDraft {
  contractType: string;
  actingFor?: string;
  context?: string;
  /** Names of the playbooks and matters used as style sources. */
  learnedFrom: string[];
  modelId: string;
  clauses: DraftClause[];
}

export function keepClause(draft: AuthoringDraft, clauseId: string, edits?: Partial<PlaybookClause>): AuthoringDraft;
export function cutClause(draft: AuthoringDraft, clauseId: string): AuthoringDraft;
export function unreviewedCount(draft: AuthoringDraft): number;
export function canSaveDraft(draft: AuthoringDraft): boolean;
export function saveGateLabel(draft: AuthoringDraft): string;
export function toPlaybookDraft(draft: AuthoringDraft, name: string): PlaybookDraft;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  keepClause, cutClause, unreviewedCount, canSaveDraft, saveGateLabel, toPlaybookDraft,
  type AuthoringDraft, type DraftClause,
} from './authoringDraft';

const clause = (id: string, over: Partial<DraftClause> = {}): DraftClause => ({
  id, title: `Clause ${id}`, extractPrompt: `Extract ${id}.`,
  disposition: 'unreviewed', edited: false, suggestions: [], ...over,
});

const draft = (clauses: DraftClause[]): AuthoringDraft => ({
  contractType: 'Lease', learnedFrom: [], modelId: 'test/model', clauses,
});

describe('the save gate', () => {
  it('refuses to save while any clause is unreviewed', () => {
    expect(canSaveDraft(draft([clause('a', { disposition: 'kept' }), clause('b')]))).toBe(false);
  });

  it('allows save once every clause is kept or cut', () => {
    expect(canSaveDraft(draft([
      clause('a', { disposition: 'kept' }), clause('b', { disposition: 'cut' }),
    ]))).toBe(true);
  });

  it('says how many remain, rather than being inertly grey', () => {
    expect(saveGateLabel(draft([clause('a'), clause('b'), clause('c', { disposition: 'kept' })])))
      .toBe('2 clauses left to review');
  });

  it('uses the singular for one remaining clause', () => {
    expect(saveGateLabel(draft([clause('a'), clause('b', { disposition: 'kept' })])))
      .toBe('1 clause left to review');
  });

  it('says Save as v1 when nothing remains', () => {
    expect(saveGateLabel(draft([clause('a', { disposition: 'cut' })]))).toBe('Save as v1');
  });

  it('refuses to save a draft with no clauses at all', () => {
    // Vacuously "all reviewed" is not the same as reviewed. An empty playbook
    // is not a thing anyone meant to create, and letting it through would
    // make the gate's own rule read as satisfied when nothing was read.
    expect(canSaveDraft(draft([]))).toBe(false);
  });

  it('refuses to save when every clause was cut', () => {
    // Same reasoning: a version with no clauses reviews nothing.
    expect(canSaveDraft(draft([clause('a', { disposition: 'cut' })]))).toBe(false);
  });
});

describe('dispositions and `edited`', () => {
  it('keeping without edits leaves edited false', () => {
    const out = keepClause(draft([clause('a')]), 'a');
    expect(out.clauses[0].disposition).toBe('kept');
    expect(out.clauses[0].edited).toBe(false);
  });

  it('keeping with a changed field sets edited', () => {
    const out = keepClause(draft([clause('a')]), 'a', { extractPrompt: 'Something else.' });
    expect(out.clauses[0].edited).toBe(true);
    expect(out.clauses[0].extractPrompt).toBe('Something else.');
  });

  it('keeping with an IDENTICAL value does not set edited (R-E5)', () => {
    // A focus-and-blur, or an edit typed and undone, is not engagement. This
    // is the assertion that stops `edited` becoming "was touched".
    const out = keepClause(draft([clause('a')]), 'a', { extractPrompt: 'Extract a.' });
    expect(out.clauses[0].edited).toBe(false);
  });

  it('cutting a clause marks it cut and does not mark it edited', () => {
    const out = cutClause(draft([clause('a')]), 'a');
    expect(out.clauses[0].disposition).toBe('cut');
    expect(out.clauses[0].edited).toBe(false);
  });

  it('leaves other clauses untouched', () => {
    const out = keepClause(draft([clause('a'), clause('b')]), 'a');
    expect(out.clauses[1].disposition).toBe('unreviewed');
  });

  it('never mutates the draft it was given', () => {
    const before = draft([clause('a')]);
    keepClause(before, 'a', { title: 'New' });
    expect(before.clauses[0].disposition).toBe('unreviewed');
    expect(before.clauses[0].title).toBe('Clause a');
  });
});

describe('toPlaybookDraft', () => {
  it('omits cut clauses entirely', () => {
    const out = toPlaybookDraft(draft([
      clause('a', { disposition: 'kept' }), clause('b', { disposition: 'cut' }),
    ]), 'My playbook');
    expect(out.clauses.map(c => c.id)).toEqual(['a']);
  });

  it('strips the authoring-only fields from every clause', () => {
    const out = toPlaybookDraft(draft([clause('a', { disposition: 'kept' })]), 'p');
    expect('disposition' in out.clauses[0]).toBe(false);
    expect('edited' in out.clauses[0]).toBe(false);
    expect('suggestions' in out.clauses[0]).toBe(false);
  });

  it('marks an AI position a human kept as reviewed', () => {
    const withPos = clause('a', {
      disposition: 'kept',
      standardPosition: { text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    const out = toPlaybookDraft(draft([withPos]), 'p');
    expect(out.clauses[0].standardPosition).toEqual({
      text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: true,
    });
  });

  it('keeps an edited AI position as ai-drafted, not authored', () => {
    // The model proposed it; a person changed it. Calling that `authored`
    // would erase where it came from, and the provenance line is the whole
    // reason `origin` exists.
    const withPos = clause('a', {
      disposition: 'kept', edited: true,
      standardPosition: { text: 'We ask for nine months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    expect(toPlaybookDraft(draft([withPos]), 'p').clauses[0].standardPosition!.origin).toBe('ai-drafted');
  });

  it('leaves a clause with no position without one', () => {
    const out = toPlaybookDraft(draft([clause('a', { disposition: 'kept' })]), 'p');
    expect('standardPosition' in out.clauses[0]).toBe(false);
  });

  it('carries the name and a first-version change summary', () => {
    const out = toPlaybookDraft(draft([clause('a', { disposition: 'kept' })]), 'Commercial Lease');
    expect(out.name).toBe('Commercial Lease');
    // v1 is exempt from D's required-change-summary rule, so an empty string
    // is correct here and `publishVersion` accepts it.
    expect(out.changeSummary).toBe('');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/authoringDraft.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

Key points the tests pin, so implement to them rather than around them:

- `canSaveDraft` is `unreviewedCount === 0 && clauses.some(c => c.disposition === 'kept')`. The second half is what makes "no clauses" and "all cut" refuse.
- `keepClause` computes `edited` by comparing each supplied edit against the current value, and ORs it with the existing `edited` (a clause edited, kept, reopened and kept again is still edited).
- `toPlaybookDraft` destructures the authoring-only fields off rather than deleting them, so the returned object never carries an `undefined`-valued key.
- A kept clause's `standardPosition`, if present, gets `reviewedByHuman: true` — a human just read it. `origin` is never rewritten.

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Mutation-test — this is the sub-project's load-bearing module**

| Mutation | Expect to fail |
|---|---|
| `canSaveDraft` returns `true` unconditionally | "refuses to save while any clause is unreviewed" |
| drop the `some(kept)` half of `canSaveDraft` | "refuses to save a draft with no clauses" AND "refuses when every clause was cut" |
| `saveGateLabel` always returns `'Save as v1'` | the two count tests |
| `keepClause` sets `edited: true` whenever `edits` is supplied | "keeping with an IDENTICAL value does not set edited" |
| `toPlaybookDraft` includes cut clauses | "omits cut clauses entirely" |
| `toPlaybookDraft` sets `origin: 'authored'` on a kept AI position | "keeps an edited AI position as ai-drafted" |
| `toPlaybookDraft` leaves `reviewedByHuman: false` | "marks an AI position a human kept as reviewed" |

Report each observed failure. **Any mutation that does not bite is a finding about the test, not a pass.**

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/lib/authoringDraft.ts src/lib/authoringDraft.test.ts
git commit -m "feat: the authoring draft model and the save gate"
git show --stat HEAD
```

---

## Task 2: Generation, few-shot, and repair

**Files:**
- Create: `src/features/authoring/generateDraft.ts` + test, `src/features/authoring/fewShot.ts` + test

**Interfaces:**
- Consumes: `chatJson` from `src/lib/openrouter.ts` (call it; do not modify it), `Review`, `Playbook`, `Finding`, `AuthoringDraft`.
- Produces:

```ts
export interface DraftFormValues {
  contractType: string;
  actingFor?: string;
  context?: string;
  /** ~N clauses. Guidance, never enforced. */
  targetClauseCount?: number;
  answerLength?: 'brief' | 'standard' | 'detailed';
}

export interface FewShotSource {
  kind: 'playbook' | 'matter';
  id: string;
  name: string;
}

/** Style material for the prompt. Verified findings ONLY. */
export function buildFewShot(
  playbooks: Playbook[],
  versions: PlaybookVersion[],
  reviews: Review[],
  selected: FewShotSource[],
): string;

export async function generateDraft(
  form: DraftFormValues,
  fewShot: string,
  sources: FewShotSource[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<AuthoringDraft>;
```

- [ ] **Step 0: Build your own fixtures — none of these helpers exist**

Both test files in this task are new, so every fixture below is yours to define. The snippets name `mockChatJson`, `mockChatJsonRejection`, `reviewWith`, `verifiedFinding`, `uncheckedFinding`, `findingInState`, `playbook()`, `versionWith`, `authRejection` and `diffEdit` — **none of them exist anywhere in the repo**, and there is no shared `chatJson` mocking helper.

The real idiom, used by `src/features/review/extractClause.test.ts` and its siblings, is a module mock:

```ts
vi.mock('../../lib/openrouter', async () => {
  const actual = await vi.importActual<typeof import('../../lib/openrouter')>('../../lib/openrouter');
  return { ...actual, chatJson: vi.fn() };
});
const { chatJson } = await import('../../lib/openrouter');
// then per test:
vi.mocked(chatJson).mockResolvedValue({ clauses: [ … ] });
vi.mocked(chatJson).mockRejectedValue(someError);
```

Note the `importActual` spread: `isAuthError` is a **real** export of that module and the auth tests below depend on its genuine behaviour, so it must not be replaced by a stub. `isAuthError` exists at `src/lib/openrouter.ts:42` — call it, do not re-derive "was this a 401" from a message string.

For the finding fixtures, build them from the real `Verification` shape (`{ state, byUserId?, at?, reason?, assigneeId? }`) and name them `verifiedFinding` / `uncheckedFinding` — **not** `verified` / `unchecked`, because `src/lib/verification.ts` already exports `unchecked()` and shadowing it is this codebase's most repeated defect shape.

- [ ] **Step 1: Write the failing tests for `fewShot`**

```ts
it('includes a verified finding as style material', () => {
  const out = buildFewShot([], [], [reviewWith(verifiedFinding('The cap is 125% of the Charges.'))],
    [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
  expect(out).toContain('The cap is 125% of the Charges.');
});

it('EXCLUDES an unverified finding', () => {
  // An unverified finding is the model's own output. Feeding it back as
  // house style launders a guess into a rule — the single rule this
  // function exists to enforce.
  const out = buildFewShot([], [], [reviewWith(uncheckedFinding('The cap is 125%.'))],
    [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
  expect(out).not.toContain('The cap is 125%.');
});

it('excludes a flagged or rejected finding too', () => {
  for (const state of ['flagged', 'rejected'] as const) {
    const out = buildFewShot([], [], [reviewWith(findingInState(state, 'Suspect text.'))],
      [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
    expect(out).not.toContain('Suspect text.');
  }
});

it('includes a selected playbook\'s clause titles and standard positions', () => {
  const out = buildFewShot([playbook('pb1')], [versionWith('pb1', 'Break', 'We ask for six months.')], [],
    [{ kind: 'playbook', id: 'pb1', name: 'Lease' }]);
  expect(out).toContain('Break');
  expect(out).toContain('We ask for six months.');
});

it('ignores sources that were not selected', () => {
  const out = buildFewShot([playbook('pb1')], [versionWith('pb1', 'Break', 'x')], [], []);
  expect(out).toBe('');
});
```

- [ ] **Step 2: Failing tests for `generateDraft`**

Mock `chatJson` the way `src/features/review/extractClause.test.ts` does — read that file and copy its mocking idiom rather than inventing one.

```ts
it('repairs a clause with a title and no extract prompt, rather than dropping it', () => {
  mockChatJson({ clauses: [{ title: 'Break' }, { title: 'Rent', extract_prompt: 'Find the rent.' }] });
  const draft = await generateDraft(form, '', [], settings);
  expect(draft.clauses.map(c => c.title)).toEqual(['Break', 'Rent']);
  expect(draft.clauses[0].extractPrompt).toBe('');
  expect(draft.clauses[0].disposition).toBe('unreviewed');
});

it('drops a clause with no title at all — there is nothing to review', () => {
  mockChatJson({ clauses: [{ extract_prompt: 'Find something.' }, { title: 'Rent', extract_prompt: 'x' }] });
  const draft = await generateDraft(form, '', [], settings);
  expect(draft.clauses.map(c => c.title)).toEqual(['Rent']);
});

it('does not pad to the requested clause count', () => {
  mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }, { title: 'B', extract_prompt: 'b' }] });
  const draft = await generateDraft({ ...form, targetClauseCount: 18 }, '', [], settings);
  expect(draft.clauses).toHaveLength(2);
});

it('marks every proposed standard position ai-drafted and unreviewed', () => {
  mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a', standard_position: 'We ask for six months.' }] });
  const draft = await generateDraft(form, '', [], settings);
  expect(draft.clauses[0].standardPosition).toEqual({
    text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false,
  });
});

it('every clause arrives unreviewed and unedited', () => {
  mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }] });
  const draft = await generateDraft(form, '', [], settings);
  expect(draft.clauses[0].disposition).toBe('unreviewed');
  expect(draft.clauses[0].edited).toBe(false);
});

it('throws a specific error when the model returns no usable clauses', () => {
  // Spec S7: this must NOT open an empty review screen that looks like a
  // draft of nothing.
  mockChatJson({ clauses: [] });
  await expect(generateDraft(form, '', [], settings)).rejects.toThrow(/no clauses/i);
});

it('records the sources it learned from, for the provenance line', () => {
  mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }] });
  const draft = await generateDraft(form, 'material', [{ kind: 'playbook', id: 'p', name: 'Lease v4' }], settings);
  expect(draft.learnedFrom).toEqual(['Lease v4']);
});

it('marks a rejected key as an auth error, so the caller can route to Settings', async () => {
  // Spec §7: "A 401/403 routes to Settings, as everywhere else in this app."
  // `generateDraft` does not navigate — it reports, and the route decides.
  // `isAuthError` from `openrouter.ts` is the shared predicate; do not
  // re-derive "was this a 401" from a message string.
  mockChatJsonRejection(authRejection(401));
  await expect(generateDraft(form, '', [], settings)).rejects.toSatisfy(isAuthError);
});

it('a non-auth failure is NOT reported as an auth error', () => {
  // Otherwise every 500 sends the user to Settings to fix a key that is fine,
  // which is the same class of wrong advice as telling them to reload when
  // reloading cannot help.
  mockChatJsonRejection(new Error('502 Bad Gateway'));
  await expect(generateDraft(form, '', [], settings)).rejects.not.toSatisfy(isAuthError);
});
```

**Wiring, in Task 3's screen:** an auth error from `generateDraft` calls `onAuthError` (the same prop `ResultsView` already takes and `App.tsx` already routes to Settings) rather than rendering the message in the form's error slot. Every other failure keeps the form intact with its values (the test above it). Read how `ResultsView` distinguishes the two before writing this — the pattern exists and must not be re-invented.

Add to Task 3's tests:

```ts
it('routes an auth failure to Settings instead of showing it in the form', () => {
  const onAuthError = vi.fn();
  const el = mount(<DraftForm error="Your API key was rejected." authFailed onAuthError={onAuthError} … />);
  expect(onAuthError).toHaveBeenCalled();
});
```

- [ ] **Steps 3–5: Run / implement / run.**

- [ ] **Step 6: Mutation-test**

- Drop the verified-only filter in `buildFewShot` → the unverified/flagged/rejected exclusion tests fail. (Named in the spec's mutation list.)
- Make a missing `extract_prompt` drop the clause → the repair test fails.
- Pad to `targetClauseCount` → the no-padding test fails.
- Return an empty draft instead of throwing on zero clauses → the "no usable clauses" test fails.

- [ ] **Step 7: Gates and commit.**

---

## Task 3: The route chooser, the draft form, and the source picker

**Files:**
- Create: `RouteChooser.tsx`, `DraftForm.tsx`, `SourcePicker.tsx`, each + test
- Modify: `src/features/templates/TemplateLibrary.tsx`, `src/App.tsx`

**Interfaces:**

```ts
export interface RouteChooserProps {
  onDraftWithAI: () => void;
  onBuildByHand: () => void;
  /** R-E6: rendered, disabled, saying "not built yet" — never hidden. */
  learnFromRedlinesAvailable: boolean;
  onLearnFromRedlines?: () => void;
  onClose: () => void;
}

export interface SourcePickerProps {
  playbooks: { id: string; name: string }[];
  matters: { id: string; name: string }[];
  selected: FewShotSource[];
  onChange: (selected: FewShotSource[]) => void;
}

export interface DraftFormProps {
  playbooks: { id: string; name: string }[];
  matters: { id: string; name: string }[];
  busy?: boolean;
  error?: string;
  /** Retains everything typed when generation fails (spec S7). */
  initialValues?: DraftFormValues;
  onSubmit: (form: DraftFormValues, sources: FewShotSource[]) => void;
  onCancel: () => void;
}
```

- [ ] **Step 1: Failing tests**

**Harness, checked at plan time.** `src/test/mount.tsx` exports `mount`, `mountOnce`, `buttons`, `buttonNamed`, `textbox`, `click`, `type`, `keyDown`, `keyDownOn`. There is **no** `text()` and no `inputValue()` — read `container.textContent`, and read an input's value by querying for it. These are all new test files, so they use the shared harness.

```ts
import { mount, buttonNamed, click } from '../../test/mount';

const valueOf = (c: HTMLElement, placeholderOrLabel: RegExp) =>
  [...c.querySelectorAll('input, textarea')]
    .find(el => placeholderOrLabel.test((el as HTMLInputElement).placeholder ?? ''))
    ?.getAttribute('value') ?? (
    [...c.querySelectorAll('textarea')]
      .find(el => placeholderOrLabel.test(el.placeholder ?? ''))?.value ?? '');

it('shows the learn-from-redlines route as present but not yet built (R-E6)', () => {
  const c = mount(<RouteChooser learnFromRedlinesAvailable={false}
    onDraftWithAI={() => {}} onBuildByHand={() => {}} onClose={() => {}} />);
  expect(c.textContent).toMatch(/redline/i);
  expect(c.textContent).toMatch(/not built yet/i);
});

it('does not offer the redlines route as clickable while it is unavailable', () => {
  // R-E6 keeps the card VISIBLE so the product is not misrepresented — but a
  // visible card that silently does nothing is worse than one that says why.
  const onLearn = vi.fn();
  const c = mount(<RouteChooser learnFromRedlinesAvailable={false} onLearnFromRedlines={onLearn}
    onDraftWithAI={() => {}} onBuildByHand={() => {}} onClose={() => {}} />);
  const card = buttonNamed(c, /redline/i);
  if (card) { click(card); }
  expect(onLearn).not.toHaveBeenCalled();
});

it('discloses that selecting a matter sends its content to the model (R-E2)', () => {
  // Everything else in this app sends only the document under review. This
  // sends OTHER matters' text. Spec §10 requires saying so at the point of
  // selection, not in a settings note.
  const c = mount(<SourcePicker playbooks={[]} matters={[{ id: 'm1', name: 'Acme' }]}
    selected={[]} onChange={() => {}} />);
  expect(c.textContent).toMatch(/sent to the model|leaves your browser|other matters/i);
});

it('says plainly in the form footer that nothing is saved yet', () => {
  const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}} />);
  expect(c.textContent).toMatch(/nothing is saved/i);
});

it('keeps everything typed when generation fails', () => {
  const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
    error="The model could not be reached."
    initialValues={{ contractType: 'Lease', context: 'Acting for the tenant.' }} />);
  expect(c.textContent).toContain('The model could not be reached.');
  // Losing a filled-in form to a 500 is the small betrayal that stops people
  // using a feature (spec §7).
  expect(c.innerHTML).toContain('Acting for the tenant.');
});

it('routes an auth failure to Settings instead of showing it in the form', () => {
  const onAuthError = vi.fn();
  mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
    error="Your API key was rejected." authFailed onAuthError={onAuthError} />);
  expect(onAuthError).toHaveBeenCalled();
});

it('does NOT route an ordinary failure to Settings', () => {
  // Without this, every 502 sends the user to fix a key that is fine — the
  // same class of wrong advice as telling someone to reload when reloading
  // cannot help.
  const onAuthError = vi.fn();
  mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
    error="502 Bad Gateway" onAuthError={onAuthError} />);
  expect(onAuthError).not.toHaveBeenCalled();
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: Gates and commit.**

---

## Task 4: The draft review screen — where the gate is enforced

**Files:**
- Create: `DraftReview.tsx` + test, `ClauseRail.tsx` + test

**Interfaces:**

```ts
export interface DraftReviewProps {
  draft: AuthoringDraft;
  onChange: (draft: AuthoringDraft) => void;
  /** Enabled only when `canSaveDraft(draft)`; labelled by `saveGateLabel`. */
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean;
}

export interface ClauseRailProps {
  clauses: DraftClause[];
  activeId: string;
  onSelect: (clauseId: string) => void;
}
```

- [ ] **Step 1: Failing tests**

```ts
it('says UNSAVED DRAFT the whole time', () => {
  expect(text(mount(<DraftReview draft={twoUnreviewed} … />))).toMatch(/unsaved draft/i);
});

it('disables save while a clause is unreviewed, and says how many remain', () => {
  const el = mount(<DraftReview draft={twoUnreviewed} … />);
  const save = buttonMatching(el, /left to review|save as v1/i);
  expect(save.hasAttribute('disabled')).toBe(true);
  expect(save.textContent).toMatch(/2 clauses left to review/);
});

it('enables save once every clause is decided', () => {
  const el = mount(<DraftReview draft={allKept} … />);
  const save = buttonMatching(el, /save as v1/i);
  expect(save.hasAttribute('disabled')).toBe(false);
});

it('shows kept / cut / unreviewed counts in the rail', () => {
  const out = text(mount(<ClauseRail clauses={mixed} activeId="a" onSelect={() => {}} />));
  expect(out).toMatch(/1[^0-9]*kept/i);
  expect(out).toMatch(/1[^0-9]*cut/i);
  expect(out).toMatch(/1[^0-9]*unreviewed/i);
});

it('J moves to the next UNREVIEWED clause, skipping decided ones', () => {
  const el = mount(<DraftReview draft={firstKeptSecondCutThirdUnreviewed} … />);
  keyDown({ key: 'j' });
  expect(activeClauseTitle(el)).toBe('Clause c');
});

it('J at the last unreviewed clause stays put rather than wrapping', () => {
  // Wrapping would make a reviewer think they had already seen a clause
  // they had not. Read CLAUDE.md's note about two live mount()s before
  // writing a before/after comparison here — use mountOnce.
  const el = mountOnce(<DraftReview draft={onlyLastUnreviewed} … />);
  keyDown({ key: 'j' });
  keyDown({ key: 'j' });
  expect(activeClauseTitle(el)).toBe('Clause c');
});

it('shows an AI-proposed position as not yet reviewed', () => {
  const el = mount(<DraftReview draft={withAiPosition} … />);
  expect(text(el)).toMatch(/drafted by AI/i);
  expect(text(el)).not.toMatch(/reviewed by you/i);
});

it('marks a clause edited when a field was changed before keeping', () => {
  const onChange = vi.fn();
  const el = mount(<DraftReview draft={oneUnreviewed} onChange={onChange} … />);
  type(fieldMatching(el, /extraction/i), 'A different instruction.');
  click(buttonMatching(el, /keep/i));
  expect(onChange.mock.calls.at(-1)![0].clauses[0].edited).toBe(true);
});
```

- [ ] **Steps 2–4: Run / implement / run.**

- [ ] **Step 5: Mutation-test the gate at the seam**

Make the save button ignore `canSaveDraft` and stay enabled. Expect "disables save while a clause is unreviewed" to FAIL. Restore. This is the one that matters: Task 1 proves the rule, this proves the screen obeys it. A gate that is correct in a pure function and ignored by its only caller is this project's most repeated defect shape.

- [ ] **Step 6: Gates and commit.**

---

## Task 5: Save as v1 through D's publish path

**Files:**
- Modify: `src/App.tsx`
- Test: wherever App-level playbook tests live — `grep -rn "publishVersion\|savePlaybook" src/*.test.tsx` and follow that file's idiom.

**Interfaces:**
- Consumes: D's `publishVersion(playbookId, draft, byUserId)`, `savePlaybook`, `deletePlaybook`, `toPlaybookDraft`.

- [ ] **Step 1: Failing tests**

```ts
it('publishes a v1 whose clauses are the kept ones only', async () => {
  await saveDraftAsV1(draftWithOneKeptOneCut, 'Commercial Lease');
  const versions = await listVersions(newPlaybookId);
  expect(versions).toHaveLength(1);
  expect(versions[0].version).toBe(1);
  expect(versions[0].clauses.map(c => c.id)).toEqual(['a']);
});

it('points the playbook at the version it just published', async () => {
  await saveDraftAsV1(draftAllKept, 'p');
  expect((await getPlaybook(newPlaybookId))!.currentVersionId).toBe((await listVersions(newPlaybookId))[0].id);
});

it('leaves no orphan playbook when publishing fails (R-E3)', async () => {
  // An identity record with no version renders as a playbook with nothing in
  // it — worse than no playbook at all, because it looks like work.
  publishVersionMock.mockRejectedValueOnce(new Error('storage full'));
  await expect(saveDraftAsV1(draftAllKept, 'p')).rejects.toThrow();
  expect(await listPlaybooks()).toHaveLength(0);
});

it('refuses to save a draft the gate has not cleared', async () => {
  // Defence in depth: the button is disabled, but the handler must not
  // depend on the button being the only way in.
  await expect(saveDraftAsV1(draftWithUnreviewed, 'p')).rejects.toThrow(/review/i);
});
```

- [ ] **Steps 2–4: Run / implement / run.**

Order per R-E3: `savePlaybook(identity)` → `publishVersion(...)` → `savePlaybook({ ...identity, currentVersionId })`. On a publish rejection, `deletePlaybook(identity.id)` before rethrowing.

- [ ] **Step 5: Mutation-test** — remove the orphan cleanup (expect the orphan test to fail); remove the handler's own gate check (expect the last test to fail).

- [ ] **Step 6: Gates and commit.**

---

## Task 6: The draft is session-only, and says so before you lose it

**Files:**
- Create: `useUnsavedDraftGuard.ts` + test
- Modify: `src/App.tsx`

- [ ] **Step 1: Failing tests**

```ts
it('writes nothing to IndexedDB or localStorage while a draft exists', async () => {
  // The strongest form of this assertion: spy on the stores, not on intent.
  const el = mount(<AuthoringRoute … />);
  await generateAndReview(el);
  expect(savePlaybookMock).not.toHaveBeenCalled();
  expect(localStorage.getItem('lexprompt:draft')).toBeNull();
});

it('warns before an in-app navigation away from a live draft (R-E4)', () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const el = mount(<AuthoringRoute … />);
  click(buttonMatching(el, /matters/i));
  expect(confirmSpy).toHaveBeenCalled();
});

it('does not warn once the draft has been saved or discarded', () => {
  const confirmSpy = vi.spyOn(window, 'confirm');
  // ... save, then navigate
  expect(confirmSpy).not.toHaveBeenCalled();
});

it('confirms before discarding', () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const onDiscard = vi.fn();
  click(buttonMatching(mount(<DraftReview draft={partly} onDiscard={onDiscard} … />), /discard/i));
  expect(confirmSpy).toHaveBeenCalled();
  expect(onDiscard).not.toHaveBeenCalled();
});
```

CLAUDE.md notes that `window.confirm` cannot be clicked by browser automation but mocks fine in jsdom — that is why these are jsdom tests and why the browser-verification task checks the same behaviour by hand.

- [ ] **Steps 2–4: Run / implement / run.** Wire both `beforeunload` and the in-app guard (R-E4).

- [ ] **Step 5: Mutation-test** — remove the in-app guard, leaving only `beforeunload`; expect the in-app navigation test to fail. This is the mutation that matters, because `beforeunload` alone looks like a working guard right up until someone clicks a link.

- [ ] **Step 6: Gates and commit.**

---

## Task 7: Per-field suggestions in the by-hand editor

**Files:**
- Create: `suggestField.ts` + test, `FieldSuggestion.tsx` + test
- Modify: `src/features/templates/TemplateEditor.tsx` (as D reshaped it)

**Interfaces:**

```ts
export type SuggestableField = 'extractPrompt' | 'riskCriteria' | 'standardPosition';

/** One small independent call, so drafting a risk criterion does not
 *  regenerate the clause around it (spec S5). */
export async function suggestField(
  field: SuggestableField,
  clause: Pick<PlaybookClause, 'title' | 'extractPrompt'>,
  contractType: string,
  settings: Settings,
): Promise<string>;

export interface FieldSuggestionProps {
  text: string;
  onAccept: () => void;
  onRegenerate: () => void;
  onDismiss: () => void;
  busy?: boolean;
}
```

- [ ] **Step 1: Failing tests**

```ts
it('renders a suggestion as visibly unaccepted', () => {
  const el = mount(<FieldSuggestion text="We ask for six months." … />);
  expect(text(el)).toMatch(/suggestion|not accepted/i);
  expect(el.querySelector('[class*="dashed"]')).toBeTruthy();
});

it('offers accept, regenerate and dismiss', () => {
  const el = mount(<FieldSuggestion text="x" … />);
  for (const re of [/use this/i, /try again/i, /i'll write it/i]) {
    expect(buttonMatching(el, re)).toBeTruthy();
  }
});

it('a suggestion is NOT adopted by saving the form', () => {
  // The rule this component exists for. Saving with a suggestion on screen
  // and unaccepted must leave the field as it was.
  const onSaveDraft = vi.fn();
  const el = mount(<TemplateEditor … />);
  triggerSuggestion(el, /risk/i);
  click(buttonMatching(el, /publish|save/i));
  expect(onSaveDraft.mock.calls.at(-1)![0].clauses[0].riskCriteria).toBe('');
});

it('accepting one field does not disturb its neighbour', () => {
  // Each suggestion is its own small call and its own state.
  const el = mount(<TemplateEditor … />);
  triggerSuggestion(el, /extraction/i);
  triggerSuggestion(el, /risk/i);
  click(acceptFor(el, /extraction/i));
  expect(suggestionVisibleFor(el, /risk/i)).toBe(true);
});

it('suggestField asks for one field only', async () => {
  await suggestField('riskCriteria', { title: 'Break', extractPrompt: 'Find it.' }, 'Lease', settings);
  const prompt = chatJsonMock.mock.calls[0][0].user as string;
  expect(prompt).toMatch(/risk/i);
  expect(prompt).not.toMatch(/return the whole clause|all fields/i);
});
```

- [ ] **Steps 2–4: Run / implement / run.**

- [ ] **Step 5: Mutation-test** — make saving adopt any visible suggestion; expect "a suggestion is NOT adopted by saving the form" to fail. (Named in the spec's mutation list.)

- [ ] **Step 6: Gates and commit.**

---

## Task 8: "Suggest what I'm missing"

**Files:**
- Create: `suggestMissingClauses.ts` + test
- Modify: `src/features/templates/TemplateEditor.tsx`

```ts
/** Proposes additional clause TITLES against what the playbook already
 *  covers. Titles only — spec S10 names the scope creep this invites, and
 *  the answer is that it proposes titles and nothing more. */
export async function suggestMissingClauses(
  existingTitles: string[],
  contractType: string,
  settings: Settings,
): Promise<string[]>;
```

- [ ] **Step 1: Failing tests**

```ts
it('does not propose a clause the playbook already has', () => {
  mockChatJson({ titles: ['Break', 'Rent Review', 'Assignment'] });
  const out = await suggestMissingClauses(['Break', 'break '], 'Lease', settings);
  // Case- and whitespace-insensitive: a model proposing "break" against an
  // existing "Break" is proposing nothing.
  expect(out).toEqual(['Rent Review', 'Assignment']);
});

it('returns an empty list rather than throwing when nothing is missing', () => {
  mockChatJson({ titles: ['Break'] });
  expect(await suggestMissingClauses(['Break'], 'Lease', settings)).toEqual([]);
});

it('each proposal is added or dismissed individually, never in bulk', () => {
  const el = mount(<TemplateEditor … />);
  // no "add all" affordance — every clause entering a playbook is a decision
  expect(buttonMatching(el, /add all/i)).toBeUndefined();
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: Gates and commit.**

---

## Task 9: Documentation, rulings, and browser verification

**Files:** `README.md`, `CLAUDE.md`, `docs/superpowers/redesign/rulings.md`

- [ ] **Step 1: `rulings.md`** — copy R-E2 … R-E6 verbatim with their costs-if-wrong. R-E1 is already recorded.

- [ ] **Step 2: `README.md`** — a `## Creating a playbook` section: the three routes, that a draft is never saved until every clause has been reviewed, and that selecting a matter as a style source sends that matter's verified findings to the model.

- [ ] **Step 3: `CLAUDE.md`** — add:

- **`authoringDraft.ts` holds the save gate, and the gate is the feature.** A draft cannot be saved while any clause is unreviewed, and a draft with no kept clauses cannot be saved at all — "vacuously all reviewed" is not reviewed.
- **An authoring draft is never persisted, anywhere.** Not IndexedDB, not localStorage, not the URL. A draft that survives a reload is a playbook nobody agreed to. This is the one place in the app where not persisting is the correct answer.
- **`edited` is computed by comparing values, never set by an onChange.** It is a claim about how much a person engaged, and it feeds provenance.
- **Few-shot material uses `verified` findings only.** An unverified finding is the model's own output; feeding it back as house style launders a guess into a rule.
- Add `authoringDraft.ts`, `generateDraft.ts`, `fewShot.ts`, `suggestField.ts` to the extraction-points list.

- [ ] **Step 4: Commit.**

- [ ] **Step 5: Browser verification — the controller's own**

Spec §9.8 and CLAUDE.md's "Verify UI work in a browser".

1. Open the route chooser; confirm the learn-from-redlines card is visible and says it is not built yet.
2. Draft a playbook from a description plus one existing playbook as a source; confirm the picker discloses what selecting a matter sends.
3. Confirm the form footer says nothing is saved yet.
4. On the review screen: confirm "UNSAVED DRAFT", the rail counts, and that `Save as v1` is disabled and names the number remaining.
5. Press `J` repeatedly; confirm it visits only unreviewed clauses and stops at the last one.
6. Cut two clauses, edit one, keep the rest.
7. **Reload the page mid-review. Confirm the draft is gone** — and that this is presented as expected rather than as a crash.
8. Redo, then try navigating away; confirm the warning.
9. Save as v1. Confirm the published version contains the kept clauses only, that the cut ones are absent, and that an accepted AI position reads "Drafted by AI, reviewed by you" while an edited one still says drafted by AI.
10. Run a review with the new playbook and confirm it produces findings.

If any step cannot be driven, say so plainly rather than implying it was.
