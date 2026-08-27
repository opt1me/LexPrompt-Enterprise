# Redesign sub-project F — Learning from redlines, and changesets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a firm's own negotiated documents, propose standard positions from what they actually did — with the evidence attached and the strength of that evidence computed rather than claimed — and then keep doing it: read a new deal against a live playbook version and produce a reviewable changeset that publishes only what a human accepted.

**Architecture:** Tracked changes are read directly from the `.docx` zip (`<w:ins>`/`<w:del>`/`comments.xml`); where a document has none, a sentence-level normalised diff of two PDFs points at what changed, labelled as weaker evidence. Evidence is assembled and counted **deterministically in code**; the model's only job is to state the position a group of edits implies. Strength is computed from those counts. Everything is a proposal accepted one at a time, and the changeset is the only thing that persists.

**Tech Stack:** React 19, TypeScript 5.8 (strict), Vite 6, Tailwind 4, Vitest 3 + jsdom, `jszip`.

**Spec:** `docs/superpowers/specs/2026-08-27-redesign-f-learning-from-redlines.md` — read §3a, the spike outcomes, before anything else.

**Depends on:**
- **D** — `publishVersion`, `PlaybookVersion`, `StandardPosition`, `PlaybookClause`. F uses D's publish path and does not reimplement it.
- **E** — the draft-review surface, which F **reuses rather than rebuilds** (spec §0).
- **The tracked-changes prerequisite fix** (`.superpowers/sdd/tracked-changes-detection-brief.md`), which declares `jszip` and adds ingest-time detection. F builds on a `.docx` reader that already knows markup is present.

---

## Global Constraints

- **Nothing is adopted because a model inferred it.** Everything is a proposal with a basis, accepted one at a time.
- **Frequency is evidence, not proof, and the app must say which it has.** The handoff's banner, close to verbatim: *these are observations about what you did, not advice.*
- **Never guess a position from silence.** An un-amended universal clause is an open **question**, never a position. Spec §11 calls this "the one that would be easiest to get wrong and hardest to notice".
- **Strength is computed in code, never returned by the model.** `supporting === total` → `consistent`; `total === 1` → `weak`; otherwise `mixed`. Letting the model count would let it be confidently wrong about "4 of 4", the single number the feature's credibility rests on.
- **Contradiction is detected, not judged.** The app says the redlines disagree; it does not pick a side.
- **`source: 'diff'` is labelled everywhere it appears** and never wears the same confidence as `source: 'tracked'`.
- **Precedent documents are read, never stored.** The UI promises this; it must be true in the implementation, not only in the copy.
- **`Accept all consistent` exists only for `consistent` positions.** Never for `mixed` or `weak`.
- `SCHEMA_VERSION` bumps for `Changeset` alone — nothing else here persists.
- **Gates for every task:** `npx tsc --noEmit` clean, `npm test` green, `npm run build` clean with no externalization warning.
- **Mutation-test anything load-bearing**; report the observed failure. A mutation that does not bite is a finding about the test.
- **`toEqual` does not distinguish an absent key from an `undefined` one.**
- **No `@testing-library/react`** — use `src/test/mount.tsx`.
- **Do not touch:** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/verification.ts`, `src/lib/netPosition.ts`, `src/lib/citationPage.ts`, `PdfCanvas`, and **D's publish path**.
- **Stage commits by name.** Never `git add -A` / `.` / `src` / `-u`.

---

## Rulings made while writing this plan

**R-F1, R-F2 (already recorded).** The tracked-changes detection fix is split out ahead of F; `jszip` is declared as a real dependency.

**R-F3 — `w:moveFrom`/`w:moveTo` are read as a move and labelled, not silently rendered as an unrelated deletion plus insertion.** Spike 1 flagged this as untested. A moved clause presented as "deleted here, inserted there" invites a reader to infer a negotiation that never happened. If reading the pairing proves awkward, the fallback is to label both halves `moved` and say the app does not yet pair them — never to present them as ordinary edits. Cost if wrong: one extra edit kind to render.

**R-F4 — A chain is never auto-confirmed, however confident the heuristic.** Spec §4.2 says roles are proposed and user-confirmable and "an ambiguous document asks rather than guesses". A filename containing "executed" is a strong hint and still only a proposal. Cost if wrong: one confirmation click on an obvious chain.

**R-F5 — Evidence grouping is the model's job; evidence counting is not.** The model receives the parsed edits and returns groups plus a statement per group. The app then counts which documents support and oppose each group **from the edits themselves**, and computes strength. If the model returns a group referencing an edit id that does not exist, that reference is dropped rather than the group being trusted. Cost if wrong: a group loses an edit the model meant to include, which understates strength — the safe direction.

**R-F6 — A learning session is session-only, exactly as E's `AuthoringDraft` is.** Precedent documents, parsed edits and inferred positions live in React state and die with the tab. Only the `Changeset` persists. This mirrors E's rule and for the same reason; reuse E's `useUnsavedDraftGuard` rather than writing a second one. Cost if wrong: a long session lost to an accidental reload — which is why the guard is reused, not skipped.

---

## File Structure

**Create:**
- `src/lib/redlines/docxRedlines.ts` + test — read `<w:ins>`/`<w:del>`/`comments.xml` from the zip.
- `src/lib/redlines/pdfRedlineDiff.ts` + test — Spike 2's normalised sentence diff.
- `src/lib/redlines/chains.ts` + test — chain and role proposal.
- `src/lib/redlines/strength.ts` + test — the computed strength and contradiction rules. Deliberately its own tiny module: it is the feature's credibility.
- `src/features/redlines/inferPositions.ts` + test — deterministic assembly, one model call for the claim.
- `src/features/redlines/PrecedentIntake.tsx` + test
- `src/features/redlines/WhatWeLearned.tsx` + test
- `src/features/redlines/TheWorkings.tsx` + test
- `src/features/redlines/buildChangeset.ts` + test
- `src/features/redlines/ChangesetReview.tsx` + test
- `src/lib/db/changesets.ts` + test

**Modify:** `src/types.ts`, `src/lib/db/schema.ts`, `src/lib/db/open.ts`, `src/App.tsx`, `src/features/authoring/RouteChooser.tsx` (enable the third card), `README.md`, `CLAUDE.md`, `rulings.md`.

---

## Task 1: `docxRedlines.ts` — read the markup mammoth throws away

Spike 1 established this is one function over one XML part plus a flat comment list, not a general OOXML parser. Read `docs/superpowers/redesign/spike-1-docx-tracked-changes.md` before starting; its worked example is the fixture shape.

**Interfaces:**

```ts
export type RedlineEditKind = 'insertion' | 'deletion' | 'comment' | 'moved';

export interface ParsedEdit {
  kind: RedlineEditKind;
  /** The inserted, deleted, or comment text. */
  text: string;
  /** The surrounding paragraph, so an edit can be read in context. */
  context: string;
  author?: string;
  at?: number;
}

export interface ParsedRedlines {
  edits: ParsedEdit[];
  /** False when the document simply has no markup — distinct from a failure
   *  to read it, which throws. "No tracked changes" and "could not look" are
   *  different facts and the caller must be able to tell them apart. */
  hasMarkup: boolean;
}

export async function parseDocxRedlines(file: Blob): Promise<ParsedRedlines>;
```

- [ ] **Step 1: Write the failing tests**

Build the fixture with JSZip **in the test** — no checked-in binary. Spike 1's script (session scratchpad, `spike1-mammoth-tracked-changes.mjs`) has a working minimal `.docx`: its `CT`, `RELS`, `DOC_RELS`, `DOCUMENT` and `COMMENTS` constants are correct and are yours to adapt. Note CLAUDE.md's warning that Blobs do not round-trip through `fake-indexeddb` with jsdom's `Blob` — use `node:buffer`'s `Blob`.

```ts
it('reads an insertion with its author and date', async () => {
  const out = await parseDocxRedlines(await trackedChangesDocx());
  const ins = out.edits.find(e => e.kind === 'insertion')!;
  expect(ins.text).toBe('withheld only where it is reasonable to do so');
  expect(ins.author).toBe('A Lawyer');
  expect(new Date(ins.at!).getUTCFullYear()).toBe(2026);
});

it('reads a deletion from w:delText, which mammoth discards entirely', async () => {
  const out = await parseDocxRedlines(await trackedChangesDocx());
  expect(out.edits.find(e => e.kind === 'deletion')!.text)
    .toBe("withheld at the Landlord's absolute discretion");
});

it('gives every edit the surrounding paragraph as context', async () => {
  const out = await parseDocxRedlines(await trackedChangesDocx());
  // Context must contain BOTH sides — the original wording and the new one —
  // or a reader cannot see what the change actually did.
  const ins = out.edits.find(e => e.kind === 'insertion')!;
  expect(ins.context).toContain('Consent may be');
  expect(ins.context).toContain("withheld at the Landlord's absolute discretion");
  expect(ins.context).toContain('withheld only where it is reasonable to do so');
});

it('reads a margin comment with its author', async () => {
  const out = await parseDocxRedlines(await trackedChangesDocx());
  const c = out.edits.find(e => e.kind === 'comment')!;
  expect(c.text).toBe('We never accept an uncapped costs indemnity.');
  expect(c.context).toContain('The Tenant shall pay all costs.');
});

it('reports a clean document as having no markup, without throwing', async () => {
  const out = await parseDocxRedlines(await cleanDocx());
  expect(out.hasMarkup).toBe(false);
  expect(out.edits).toEqual([]);
});

it('THROWS on a file it cannot read, rather than reporting no markup', async () => {
  // "No tracked changes" and "could not look" must never collapse. A
  // detector that reports clean when it could not look is the founding
  // defect one level up.
  await expect(parseDocxRedlines(new Blob(['not a zip']))).rejects.toThrow();
});

it('does not mistake w:insideH for an insertion', async () => {
  // A real OOXML table-border element. Matching the letters rather than the
  // element name is the false positive waiting to happen here.
  const out = await parseDocxRedlines(await docxWithTableBorders());
  expect(out.hasMarkup).toBe(false);
});

it('labels a move rather than reporting an unrelated deletion and insertion (R-F3)', async () => {
  const out = await parseDocxRedlines(await docxWithMove());
  expect(out.edits.filter(e => e.kind === 'moved')).toHaveLength(2);
  expect(out.edits.some(e => e.kind === 'deletion')).toBe(false);
});
```

- [ ] **Steps 2–4: Run / implement / run.**

- [ ] **Step 5: Mutation-test** — make an unreadable file return `{ hasMarkup: false, edits: [] }` (expect the throw test to fail); match `<w:ins` without the name boundary (expect the `w:insideH` test to fail); drop the `moved` handling (expect R-F3's test to fail).

- [ ] **Step 6: Gates and commit.**

---

## Task 2: `pdfRedlineDiff.ts` — the fallback, with Spike 2's two mandatory steps

Read `docs/superpowers/redesign/spike-2-pdf-pair-diffing.md`. Its measurements are the requirements.

**Interfaces:**

```ts
export interface DiffUnit {
  text: string;
  /** 'amended' where the unit has a counterpart that changed; 'structural'
   *  where it has none at all (an inserted heading, a removed clause).
   *  Spike 2: the model must never be asked to explain a re-typesetting as
   *  if it were a negotiation. */
  kind: 'amended' | 'structural';
}

/** Compares two extracted texts and returns the units that differ.
 *  Takes `DocumentRecord.text` — NEVER `usableText` output, which strips
 *  `[Page N]` markers and drops sparse pages. */
export function diffExtractedText(earlier: string, later: string): DiffUnit[];
```

- [ ] **Step 1: Write the failing tests**

```ts
const REFLOWED = (s: string) => s.replace(/ {2,}/g, '   ');
const HYPHENATED = (s: string) => s.replace(/(\w{3})(\w{3})/, '$1-\n$2');

it('finds a genuine amendment through whitespace reflow', () => {
  const out = diffExtractedText(base, REFLOWED(base).replace('three months', 'six months'));
  expect(out).toHaveLength(1);
  expect(out[0].text).toContain('six months');
});

it('finds it through hyphenation across line breaks too', () => {
  // Spike 2's non-obvious result: hyphenation ALONE, with whitespace already
  // collapsed, drops precision from 1.00 to 0.038. De-hyphenation is not
  // optional polish — without it this function is useless.
  const later = HYPHENATED(REFLOWED(base)).replace('three months', 'six months');
  expect(diffExtractedText(base, later)).toHaveLength(1);
});

it('reports an inserted heading as structural, not as an amendment', () => {
  const out = diffExtractedText(base, base.replace('The Tenant', 'SCHEDULE 2 — CONTINUED. The Tenant'));
  expect(out.every(u => u.kind === 'structural')).toBe(true);
});

it('never misses a changed clause — recall is the property that matters', () => {
  // Spike 2 measured recall 1.00 across every scenario. Over-flagging is
  // triaged; a missed amendment is silently omitted from the evidence.
  const later = REFLOWED(base).replace('three months', 'six months').replace('Landlord', 'Lessor');
  const flagged = diffExtractedText(base, later).map(u => u.text).join(' ');
  expect(flagged).toContain('six months');
  expect(flagged).toContain('Lessor');
});

it('returns nothing at all for two renderings of the same text', () => {
  expect(diffExtractedText(base, HYPHENATED(REFLOWED(base)))).toEqual([]);
});

it('refuses an empty later text rather than reporting every clause deleted', () => {
  // A scanned second version has no text layer. Diffing it against a real
  // one would flag the entire document as removed — the loudest possible
  // wrong answer. Spec §3a: a scan yields NO positions, not an empty set
  // of changes.
  expect(() => diffExtractedText(base, '')).toThrow(/no extractable text/i);
});
```

- [ ] **Steps 2–4: Run / implement / run.** Normalise with whitespace-collapse **and** de-hyphenation; split into sentences after stripping `[Page N]`; LCS over the normalised units.

- [ ] **Step 5: Mutation-test** — remove de-hyphenation (expect the hyphenation test to fail); remove whitespace collapse (expect the reflow test to fail); return `[]` instead of throwing on empty text (expect the scan test to fail).

- [ ] **Step 6: Gates and commit.**

---

## Task 3: `strength.ts` — the number the feature's credibility rests on

Its own module because it is the structural defence named in spec §11: strength computed in code, never asked of the model.

**Interfaces:**

```ts
export type PositionStrength = 'consistent' | 'mixed' | 'weak';

export interface BasisEntry { documentId: string; supports: boolean; }

export function computeStrength(basis: BasisEntry[]): PositionStrength;
export function isContradicted(basis: BasisEntry[]): boolean;
export function strengthLabel(strength: PositionStrength, supporting: number, total: number): string;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('is consistent when every document supports it', () => {
  expect(computeStrength([s('a'), s('b'), s('c'), s('d')])).toBe('consistent');
});

it('is weak on a single instance, even a supporting one', () => {
  // One strike may have been a trade on that deal, not a policy. This is the
  // distinction the whole feature turns on.
  expect(computeStrength([s('a')])).toBe('weak');
});

it('is mixed when documents disagree', () => {
  expect(computeStrength([s('a'), s('b'), o('c')])).toBe('mixed');
});

it('is mixed, not consistent, when one of many opposes', () => {
  expect(computeStrength([s('a'), s('b'), s('c'), o('d')])).toBe('mixed');
});

it('a single OPPOSING instance is weak, not consistent', () => {
  // `supporting === total` must not be satisfied by 0 === 0.
  expect(computeStrength([o('a')])).toBe('weak');
});

it('an empty basis is weak and never consistent', () => {
  // Vacuous unanimity is the exact shape of "guessed from silence".
  expect(computeStrength([])).toBe('weak');
});

it('sets contradicted only when the basis actually disagrees', () => {
  expect(isContradicted([s('a'), o('b')])).toBe(true);
  expect(isContradicted([s('a'), s('b')])).toBe(false);
  expect(isContradicted([])).toBe(false);
});

it('labels n of m honestly', () => {
  expect(strengthLabel('consistent', 4, 4)).toBe('Consistent — 4 of 4');
  expect(strengthLabel('mixed', 3, 4)).toBe('Mixed — 3 of 4');
  expect(strengthLabel('weak', 1, 1)).toBe('Weak — a single instance');
});
```

- [ ] **Steps 2–4: Run / implement / run.**

- [ ] **Step 5: Mutation-test** (named in the spec's mutation list) — make `computeStrength` return `'consistent'` for `supporting === total` without the `total === 1` check first (expect the weak tests to fail); make an empty basis `consistent` (expect the vacuous-unanimity test to fail).

- [ ] **Step 6: Gates and commit.**

---

## Task 4: `chains.ts` — proposed, never assumed

**Interfaces:**

```ts
export type PrecedentRole = 'their-draft' | 'our-markup' | 'executed' | 'unknown';

export interface PrecedentDocument {
  id: string; name: string; role: PrecedentRole;
  documentDate?: number;
  /** True when the role was inferred rather than stated, so the UI asks
   *  instead of asserting (R-F4). */
  roleInferred: boolean;
  chainId?: string;
}

export function proposeChains(docs: PrecedentDocument[]): PrecedentDocument[];
export function proposeRole(name: string, hasMarkup: boolean): { role: PrecedentRole; inferred: boolean };
```

- [ ] **Step 1: Failing tests**

```ts
it('proposes a role from a clear filename, and marks it inferred (R-F4)', () => {
  expect(proposeRole('Lease - executed.docx', false)).toEqual({ role: 'executed', inferred: true });
});

it('uses the presence of markup as evidence of our markup', () => {
  expect(proposeRole('Lease v3.docx', true)).toEqual({ role: 'our-markup', inferred: true });
});

it('leaves an ambiguous document unknown rather than guessing', () => {
  expect(proposeRole('document1.docx', false)).toEqual({ role: 'unknown', inferred: true });
});

it('NEVER returns inferred: false — nothing here is confirmed by the app', () => {
  for (const n of ['Lease - executed.docx', 'their draft.docx', 'x.docx']) {
    expect(proposeRole(n, false).inferred).toBe(true);
  }
});

it('groups documents sharing a stem into one proposed chain', () => {
  const out = proposeChains([doc('Brookvale - their draft.docx'), doc('Brookvale - our markup.docx')]);
  expect(new Set(out.map(d => d.chainId)).size).toBe(1);
});

it('does not chain two unrelated documents', () => {
  const out = proposeChains([doc('Brookvale lease.docx'), doc('Camden licence.docx')]);
  expect(out[0].chainId).not.toBe(out[1].chainId);
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: mutation-test the `inferred: true` invariant. Step 6: gates and commit.**

---

## Task 5: `inferPositions.ts` — deterministic evidence, one model call for the claim

The rule from spec §6 and R-F5: **the model groups and states; the app counts.**

**Interfaces:**

```ts
export interface InferredPosition {
  id: string; clauseTitle: string; statement: string;
  strength: PositionStrength;
  supporting: number; total: number;
  basis: { documentId: string; supports: boolean; edits: ParsedEdit[] }[];
  contradicted: boolean;
  disposition: 'undecided' | 'adopted' | 'reworded' | 'rejected';
  rewordedText?: string;
  /** True when every supporting edit is `source: 'diff'`. Rendered with
   *  lower confidence everywhere. */
  diffDerivedOnly: boolean;
}

export interface OpenQuestion { id: string; clauseTitle: string; question: string; answer?: string; }

export async function inferPositions(
  edits: { documentId: string; edit: ParsedEdit; source: 'tracked' | 'diff' }[],
  unamendedClauses: { title: string; documentIds: string[] }[],
  settings: Settings,
): Promise<{ positions: InferredPosition[]; questions: OpenQuestion[] }>;
```

- [ ] **Step 1: Failing tests — the two that matter most first**

```ts
it('NEVER produces a position from silence — an un-amended clause becomes a question', async () => {
  // Spec §11: "the one that would be easiest to get wrong and hardest to
  // notice". Every lease had a break clause; none was ever amended. That is
  // not "the firm accepts standard break clauses" — it is a question.
  mockChatJson({ groups: [] });
  const out = await inferPositions([], [{ title: 'Break', documentIds: ['a', 'b', 'c', 'd'] }], settings);
  expect(out.positions).toEqual([]);
  expect(out.questions).toHaveLength(1);
  expect(out.questions[0].clauseTitle).toBe('Break');
  expect(out.questions[0].question).toMatch(/never amended|do you have a position/i);
});

it('ignores a strength the model volunteers and computes its own', async () => {
  // Letting the model count would let it be confidently wrong about "4 of 4",
  // the single number this feature's credibility rests on.
  mockChatJson({ groups: [{ clause_title: 'Consent', statement: 'We strike absolute discretion.',
    edit_ids: ['e1'], strength: 'consistent' }] });
  const out = await inferPositions([edit('e1', 'doc-a')], [], settings);
  expect(out.positions[0].strength).toBe('weak');   // one document, not consistent
  expect(out.positions[0].total).toBe(1);
});

it('counts supporting and total from the edits, not from the model', async () => {
  mockChatJson({ groups: [{ clause_title: 'Consent', statement: 'x',
    edit_ids: ['e1', 'e2', 'e3'], supporting: 99, total: 99 }] });
  const out = await inferPositions(
    [edit('e1', 'doc-a'), edit('e2', 'doc-b'), edit('e3', 'doc-c')], [], settings);
  expect(out.positions[0].total).toBe(3);
  expect(out.positions[0].supporting).toBe(3);
});

it('drops an edit id the model invented rather than trusting the group (R-F5)', async () => {
  mockChatJson({ groups: [{ clause_title: 'C', statement: 'x', edit_ids: ['e1', 'does-not-exist'] }] });
  const out = await inferPositions([edit('e1', 'doc-a')], [], settings);
  expect(out.positions[0].total).toBe(1);
});

it('marks a position contradicted when its basis disagrees', async () => {
  mockChatJson({ groups: [{ clause_title: 'C', statement: 'x', edit_ids: ['e1', 'e2'] }] });
  const out = await inferPositions([supporting('e1', 'a'), opposing('e2', 'b')], [], settings);
  expect(out.positions[0].contradicted).toBe(true);
});

it('flags a position resting only on diff-derived edits', async () => {
  mockChatJson({ groups: [{ clause_title: 'C', statement: 'x', edit_ids: ['e1'] }] });
  const out = await inferPositions([diffEdit('e1', 'a')], [], settings);
  expect(out.positions[0].diffDerivedOnly).toBe(true);
});

it('says so plainly when nothing could be inferred', async () => {
  mockChatJson({ groups: [] });
  const out = await inferPositions([edit('e1', 'a')], [], settings);
  expect(out.positions).toEqual([]);
  // The SCREEN says "the redlines did not settle anything we could state as
  // a position" (Task 6) — this function returning empty is the honest input
  // to that, not an error.
});
```

- [ ] **Steps 2–4: Run / implement / run.** The prompt sends edits with stable ids and asks only for groups (`clause_title`, `statement`, `edit_ids`). Any `strength`/`supporting`/`total` the model returns is **discarded**, not read.

- [ ] **Step 5: Mutation-test** (two are in the spec's list) — read strength from the model (expect the two counting tests to fail); turn an un-amended clause into a position (expect the silence test to fail); trust unknown edit ids (expect R-F5's test to fail).

- [ ] **Step 6: Gates and commit.**

---

## Task 6: Precedent intake, and "What we learned"

**Files:** `PrecedentIntake.tsx`, `WhatWeLearned.tsx`, each + test.

- [ ] **Step 1: Failing tests**

```ts
it('shows the observations banner close to the handoff wording', () => {
  expect(text(mount(<WhatWeLearned … />)))
    .toMatch(/observations about what you did, not advice/i);
});

it('offers Accept all consistent, and ONLY for consistent positions', () => {
  const el = mount(<WhatWeLearned positions={[consistentPos, mixedPos, weakPos]} … />);
  click(buttonMatching(el, /accept all consistent/i));
  expect(onBulkAccept.mock.calls[0][0].map((p: InferredPosition) => p.id)).toEqual([consistentPos.id]);
});

it('says plainly when nothing could be inferred, rather than showing an empty screen', () => {
  expect(text(mount(<WhatWeLearned positions={[]} questions={[]} … />)))
    .toMatch(/did not settle anything/i);
});

it('renders an open question as a question, never as an adoptable position', () => {
  const el = mount(<WhatWeLearned positions={[]} questions={[breakQuestion]} … />);
  expect(text(el)).toContain(breakQuestion.question);
  expect(buttonMatching(el, /adopt/i)).toBeUndefined();
});

it('shows a contradiction callout and does not resolve it', () => {
  const el = mount(<WhatWeLearned positions={[contradictedPos]} … />);
  expect(text(el)).toMatch(/redlines disagree/i);
});

it('a weak position never wears a consistent one\'s clothes', () => {
  const el = mount(<WhatWeLearned positions={[weakPos]} … />);
  expect(text(el)).toMatch(/weak|single instance/i);
});

it('asks about an ambiguous document instead of asserting a role (R-F4)', () => {
  const el = mount(<PrecedentIntake documents={[unknownRoleDoc]} … />);
  expect(text(el)).toMatch(/what is this/i);
});

it('reports a document whose tracked changes could not be read, by name', () => {
  const el = mount(<PrecedentIntake documents={[doc]} unreadable={[{ name: 'Deed.docx' }]} … />);
  expect(text(el)).toContain('Deed.docx');
  // Spec §8: the diff fallback is OFFERED explicitly, never substituted
  // silently.
  expect(buttonMatching(el, /compare|diff/i)).toBeTruthy();
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: mutation-test the bulk-accept filter. Step 6: gates and commit.**

---

## Task 7: "The workings"

*A lawyer will not adopt a position they cannot see the workings for.* Keep that sentence in the code.

- [ ] **Step 1: Failing tests**

```ts
it('renders deletions struck and insertions underlined in the same sentence', () => {
  const el = mount(<TheWorkings position={pos} … />);
  expect(el.querySelector('del,[class*="line-through"]')!.textContent)
    .toContain("withheld at the Landlord's absolute discretion");
  expect(el.querySelector('ins,[class*="underline"]')!.textContent)
    .toContain('withheld only where it is reasonable to do so');
});

it('shows a margin comment with its author and date', () => {
  const out = text(mount(<TheWorkings position={posWithComment} … />));
  expect(out).toContain('We never accept an uncapped costs indemnity.');
  expect(out).toContain('A Lawyer');
});

it('names each document the workings came from', () => {
  expect(text(mount(<TheWorkings position={pos} documentNames={{ 'd1': 'Brookvale markup.docx' }} … />)))
    .toContain('Brookvale markup.docx');
});

it('labels diff-derived workings as weaker evidence', () => {
  expect(text(mount(<TheWorkings position={diffOnlyPos} … />)))
    .toMatch(/compared|inferred from|not from tracked changes/i);
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: gates and commit.**

---

## Task 8: `buildChangeset.ts` and the changeset store

**Interfaces:**

```ts
export type ChangeKind = 'confirm' | 'drift' | 'new_clause';
// `ChangesetItem` and `Changeset` exactly as spec §5 declares them.

export async function buildChangeset(
  version: PlaybookVersion,
  edits: { documentId: string; edit: ParsedEdit; source: 'tracked' | 'diff' }[],
  sourceSummary: string,
  settings: Settings,
): Promise<Changeset>;
```

`SCHEMA_VERSION` bumps; `DB_VERSION` bumps for a `changesets` store with a `byPlaybook` index. Follow `db/playbookVersions.ts`'s shape — including its transaction discipline — rather than inventing a second idiom.

- [ ] **Step 1: Failing tests**

```ts
it('classifies an unchanged clause as confirm', async () => { … expect(item.kind).toBe('confirm'); });
it('classifies a changed clause as drift, with the current text alongside', async () => {
  expect(item.kind).toBe('drift');
  expect(item.currentText).toBe(version.clauses[0].standardPosition!.text);
  expect(item.proposedText).not.toBe(item.currentText);
});
it('classifies something the version never covered as new_clause, with no clauseId', async () => {
  expect(item.kind).toBe('new_clause');
  expect('clauseId' in item).toBe(false);
});
it('every item carries a rationale — a proposal without a reason is not reviewable', async () => {
  for (const item of changeset.items) expect(item.rationale.trim()).not.toBe('');
});
it('every item starts open', async () => {
  for (const item of changeset.items) expect(item.decision).toBe('open');
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: gates and commit.**

---

## Task 9: The changeset screen, and publishing only what was accepted

- [ ] **Step 1: Failing tests**

```ts
it('says nothing changes in the live version until publish', () => {
  expect(text(mount(<ChangesetReview changeset={cs} … />))).toMatch(/nothing changes .* until you publish/i);
});

it('publishes ONLY accepted and reworded items', async () => {
  // Mutation-tested; named in the spec's list. A declined item reaching the
  // version would put a position into the instrument every future review
  // runs on, which a human explicitly refused.
  await publishChangeset(csWithOneAcceptedOneRewordedOneDeclined, 'u1');
  const v = (await listVersions('pb1'))[0];
  expect(v.clauses.map(c => c.title)).toEqual(['Accepted clause', 'Reworded clause']);
});

it('a reworded item publishes the human text, not the proposal', async () => {
  const v = (await listVersions('pb1'))[0];
  expect(v.clauses[0].standardPosition!.text).toBe('The words a person wrote.');
});

it('publishes through D\'s path, producing an immutable version with a change summary', async () => {
  const v = (await listVersions('pb1'))[0];
  expect(v.version).toBe(2);
  expect(v.changeSummary.trim()).not.toBe('');
});

it('a failed publish preserves every decision', async () => {
  // Spec §8: the review work is the expensive part and must not be lost to
  // a write failure.
  publishVersionMock.mockRejectedValueOnce(new Error('storage full'));
  await expect(publishChangeset(cs, 'u1')).rejects.toThrow();
  const reloaded = await getChangeset(cs.id);
  expect(reloaded!.items.map(i => i.decision)).toEqual(['accepted', 'declined']);
});

it('refuses to publish a changeset with open items', () => { … });
```

- [ ] **Steps 2–4: Run / implement / run.**

- [ ] **Step 5: Mutation-test** — publish every item regardless of decision (expect the accepted-subset test to fail); clear decisions on a failed publish (expect the preservation test to fail).

- [ ] **Step 6: Gates and commit.**

---

## Task 10: Session-only guarantees, and errors

- [ ] **Step 1: Failing tests**

```ts
it('stores no precedent document, anywhere (spec §4 and §11)', async () => {
  // A deliberate promise the UI makes. It has to be true in the
  // implementation, not just in the copy.
  await runALearningSession();
  expect(addDocumentMock).not.toHaveBeenCalled();
  expect(saveBlobMock).not.toHaveBeenCalled();
});

it('warns before navigating away from a live learning session (R-F6)', () => {
  // Reuses E's `useUnsavedDraftGuard` — do not write a second one.
});

it('confirms before discarding a session or a changeset', () => { … });

it('a rejected chain stays ungrouped and is not re-proposed', () => { … });
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: mutation-test the no-storage assertion. Step 6: gates and commit.**

---

## Task 11: Documentation, rulings, and browser verification

- [ ] **Step 1: `rulings.md`** — R-F3 … R-F6 with costs-if-wrong. R-F1/R-F2 already recorded.
- [ ] **Step 2: `README.md`** — how learning from redlines works; that precedent documents are read and never stored; that a position's strength is counted, not claimed; that a diff-derived position is weaker evidence and says so.
- [ ] **Step 3: `CLAUDE.md`:**

- **Strength is computed in `strength.ts`, never returned by the model.** Letting the model count would let it be confidently wrong about "4 of 4", the number this feature's credibility rests on. Any `strength`/`supporting`/`total` a model returns is discarded, not read.
- **Silence never produces a position.** An un-amended universal clause is an open question. This is the failure that would be easiest to get wrong and hardest to notice.
- **`source: 'diff'` never wears `source: 'tracked'`'s confidence.** A diff knows two documents differ at a point; a tracked change knows someone made an edit, and who.
- **Precedent documents are read and never stored** — a promise the UI makes that must be true in the implementation.
- Add `docxRedlines.ts`, `pdfRedlineDiff.ts`, `strength.ts`, `chains.ts`, `inferPositions.ts` to the extraction-points list.

- [ ] **Step 4: Commit.**

- [ ] **Step 5: Browser verification — the controller's own, on genuine tracked-changes documents**

1. Bring in a real marked-up `.docx`; confirm the edit count is plausible and the roles are proposed, not asserted.
2. Confirm an ambiguous document asks "what is this?" rather than guessing.
3. Confirm a document with no tracked changes offers the diff fallback explicitly rather than being silently substituted.
4. Infer positions. Confirm the observations banner, and that a single-instance position reads `weak` while a unanimous one reads `consistent — n of n`.
5. Confirm an un-amended clause appears under open questions and **cannot be adopted as a position**.
6. Open the workings on one position; confirm deletions are struck and insertions underlined in the same sentence, with the comment and its author.
7. Adopt one, reword one, reject one. Confirm `Accept all consistent` touches only consistent positions.
8. Build a changeset against a live version; confirm the screen says nothing changes until publish.
9. Publish; confirm the new version contains only the accepted and reworded items and that the declined one is absent.
10. Reload and confirm no precedent document was stored anywhere.

If any step cannot be driven, say so plainly rather than implying it was.
