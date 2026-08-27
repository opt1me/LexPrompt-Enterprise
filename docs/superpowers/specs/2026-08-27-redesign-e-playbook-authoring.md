# Redesign sub-project E — Playbook authoring

**Date:** 2026-08-27
**Status:** Approved for planning (owner authorised proceeding through the whole redesign without check-ins)
**Builds on:** A, B, C, and D (standard positions and versioning — this sub-project authors what D evaluates)
**Source handoff:** `design_handoff_lexprompt_redesign/`, digested to `docs/superpowers/redesign/`

## 0. A note on the sub-project letters

The original decomposition named E "learning from redlines." On writing it out, that turned out to be two sub-projects wearing one letter: *authoring a playbook* (three routes, no research required, sitting directly on D's data model) and *learning positions from tracked changes* (a document-parsing research problem the digest itself flags three times as research-needed).

They are split here rather than left conflated:

- **E — Playbook authoring.** The AI-draft route, the by-hand route, and the review gate between a draft and a saved playbook.
- **F — Learning from redlines, and changesets.** Tracked-changes parsing, chain detection, inferred positions with strength, and the changeset that re-teaches a live playbook.

E does not depend on F. F depends on E's draft-review surface, which it reuses rather than rebuilds.

## 1. What this sub-project is for

D made a standard position a first-class thing. Nothing yet puts one there except typing it.

This sub-project is how a playbook comes to exist: drafted by a model from a description and the firm's own prior work, or built by hand with a model suggesting individual fields, and — in both cases — passing through a gate where a human reads every clause before anything is saved.

That gate is the point. The handoff is unusually firm about it, and it is right: *an AI first pass is a draft, never a saved playbook, until the lawyer has been through every clause.* A playbook is the instrument every future review runs on. A model-generated one that nobody read would propagate its errors into every finding in every matter, wearing the authority of a firm document.

## 2. The rule this sub-project inherits

The same rule, at its sharpest yet: **nothing the model produced is treated as the firm's until a human has said so, clause by clause.**

- A draft is **not persisted as a playbook**. It lives as an unsaved draft and says "UNSAVED DRAFT" in the header the whole time.
- **Save is gated on review, not on time.** Every clause must be kept, edited-and-kept, or cut. A clause nobody looked at cannot be saved, and the save action says how many remain.
- **Provenance is recorded and shown.** `origin: 'ai-drafted'` with `reviewedByHuman: false` renders differently from one a human accepted. D put those two fields on `StandardPosition` for this.
- **Per-field suggestions are suggestions.** In the by-hand route a suggested field renders visibly unaccepted — dashed, badged, with accept / regenerate / dismiss — and is never silently adopted by saving the form.

## 3. Scope

**In:**

1. **The route chooser** — draft with AI, build by hand, and a link out to F's learn-from-redlines flow once it exists. Presented as three parallel routes, not a fork.
2. **The AI draft form** — contract type, acting-for, free-text context, a "learn from" picker over existing playbooks and completed matters, clause-count and answer-length controls.
3. **`PlaybookDraft`** — a non-persisted working object holding proposed clauses and each one's review disposition.
4. **The draft review screen** — per clause: the extract prompt, the risk criteria, the proposed standard position with its provenance, optional extra sub-questions to add or dismiss, and keep / edit-then-keep / cut. A clause rail with kept/cut/unreviewed counts and progress, and keyboard next.
5. **Save as v1** — turns a fully-reviewed draft into a published `PlaybookVersion` through D's existing publish path, with the cut clauses genuinely absent and the kept ones carrying honest provenance.
6. **By-hand authoring** — add clauses one at a time; per field, a "draft this for me" that calls a small independent completion and renders the result as an unaccepted suggestion.
7. **"Suggest what I'm missing"** — proposes additional clauses against what the playbook already covers, as suggestions to add or dismiss.

**Out:** learning from redlines and changesets (F); mobile layouts; the visual reskin.

**Unchanged and not to be touched:** everything D left alone, plus D's publish path itself — this sub-project *uses* `publishVersion`, it does not reimplement it.

## 4. Data model

Only one new type, and it is deliberately not persisted:

```ts
type ClauseDisposition = 'unreviewed' | 'kept' | 'cut';

interface DraftClause extends PlaybookClause {
  disposition: ClauseDisposition;
  /** True when the human changed any field before keeping it. Recorded
   *  because "kept as drafted" and "rewritten then kept" are different
   *  claims about how much a human actually engaged. */
  edited: boolean;
  /** Extra sub-questions the model offered for this clause, neither added
   *  nor dismissed yet. */
  suggestions: string[];
}

interface PlaybookDraft {
  /** Session-only. Never written to IndexedDB — a draft that survives a
   *  reload is a playbook nobody agreed to. */
  contractType: string;
  actingFor?: string;
  context?: string;
  /** Names of the playbooks and matters used as style sources, for the
   *  provenance line. */
  learnedFrom: string[];
  modelId: string;
  clauses: DraftClause[];
}
```

`PlaybookDraft` is held in React state and lost on reload, on purpose. The handoff's own footer copy says it: *nothing is saved until you have been through the draft.* Persisting a draft would make that false, and would leave half-reviewed model output sitting in the store looking like work.

This is the one place in the redesign where **not** persisting is the correct answer, and it is worth being explicit that it is a decision rather than an omission.

## 5. Generation

**One call produces the draft.** The form's fields become a single structured request returning a clause list. The "learn from" sources contribute as few-shot material: the selected playbooks' clause titles and standard positions, and the selected matters' *verified* findings only — an unverified finding is the model's own output, and feeding it back as house style would launder a guess into a rule.

**Clause count and answer length are honoured as guidance, not enforced.** A model asked for ~18 clauses that returns 15 good ones has not failed. The draft header says how many were proposed; nothing pads to a target.

**A malformed clause is repaired, not dropped** — the standing rule. A clause with a title and no extract prompt arrives as unreviewed with an empty prompt and a visible marker, so the human sees the gap rather than the clause silently vanishing.

**Per-field suggestions are separate small calls**, one field at a time, so a "draft this for me" on a risk criterion does not regenerate the clause around it.

## 6. Screens

**Route chooser** — three cards. The learn-from-redlines card is present and disabled with an honest "not built yet" until F lands, rather than hidden: the handoff frames the three as parallel and hiding one misrepresents the product.

**Draft form** — the fields in §3.2, a footer stating plainly that nothing is saved yet, and `Draft the playbook`.

**Draft review** — the "UNSAVED DRAFT" badge, the provenance meta line, a progress fraction, `Discard` and `Save as v1`. `Save as v1` is disabled while any clause is unreviewed and says how many remain rather than being inertly grey. Left rail: kept / cut / unreviewed counts and the clause list with per-row state. Main pane: the clause, its fields, its proposed position with provenance, its suggestions, and keep / edit-then-keep / cut. `J` moves to the next unreviewed clause.

**By-hand editor** — D's playbook editor with per-field `Draft this for me`, suggestions rendered dashed-and-badged with `Use this` / `Try again` / `I'll write it`, and `Suggest what I'm missing` at the foot.

## 7. Error handling

- A generation failure surfaces with the form intact and everything the user typed still there. Losing a filled-in form to a 500 is the kind of small betrayal that stops people using a feature.
- A 401/403 routes to Settings, as everywhere else in this app.
- A model that returns no usable clauses says so, and does not open an empty review screen that looks like a draft of nothing.
- `Discard` confirms first — it destroys work the user has partly reviewed.
- Navigating away from a draft warns, because the draft is session-only and the warning is the only thing standing between a half-reviewed draft and silence.

## 8. Testing

| Suite | Covers |
|---|---|
| `playbookDraft` | disposition transitions; `edited` set only when a field actually changed; cut clauses absent from the published version |
| `saveGate` | save refused while any clause is unreviewed; the count of remaining clauses is accurate; save produces a v1 through D's publish path |
| `generation` | few-shot sources include verified findings only; malformed clauses repaired not dropped; a clause count under target is not padded |
| `provenance` | an accepted AI position is `ai-drafted` + `reviewedByHuman: true`; an edited one is still `ai-drafted` but marked edited; a hand-written one is `authored` |
| `fieldSuggestions` | a suggestion is not adopted by saving; accept / regenerate / dismiss each behave; one field's regeneration does not disturb its neighbours |
| `errors` | a failed generation preserves the form; an auth error routes to Settings; discard confirms |

Mutation-test: the save gate, the verified-findings-only rule in few-shot selection, and the "suggestion is not adopted by saving" rule.

## 9. Definition of done

1. `tsc --noEmit` clean; tests pass; build clean.
2. A playbook can be drafted from the form and every proposed clause reviewed, kept, edited or cut.
3. `Save as v1` is refused while any clause is unreviewed, and says how many remain.
4. A saved draft becomes a published v1 through D's existing publish path, with cut clauses genuinely absent.
5. Provenance on each saved standard position honestly reflects how it got there.
6. A draft does not survive a reload, and navigating away warns before losing it.
7. A clause can be authored by hand with per-field AI suggestions that require explicit acceptance.
8. Verified in a browser with a real key: draft a playbook from a description plus one existing playbook, review all clauses, cut two, edit one, save as v1, and run a review with it.

## 10. Risks

**The save gate is the whole feature.** If it can be bypassed — by a clause count that miscounts, by a "keep all" that skips the reading, by a reload that resurrects a half-reviewed draft as saved — then the feature has produced exactly the unread firm document it exists to prevent. It is mutation-tested for that reason.

**Few-shot from the firm's own matters is a quiet privacy question.** The text of prior deals becomes prompt material sent to the chosen model. Everything else in this app sends only the document under review. This sends *other* matters' content, so the picker must say so plainly at the point of selection — not in a settings note.

**"Suggest what I'm missing" invites scope creep** toward a general playbook assistant. It proposes clause titles against existing coverage. Nothing more.
