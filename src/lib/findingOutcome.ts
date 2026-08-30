import type { Finding, Review } from '../types';
import {
  positionText, stepEffectText,
  type DispositionCause, type DispositionEventView, type DispositionWithHistory,
  type VerificationChange, type VerificationState,
} from '@lexprompt/core';

/**
 * The one place that decides what text represents a clause's outcome when
 * it has to be rendered as plain prose — a CSV cell, a DOCX summary row —
 * rather than a status-aware UI component with its own pending/running/
 * error styling (`FindingCard`, the tabular `Cell`).
 *
 * A clause that is still pending, still running, was cancelled, or failed
 * must never render as an empty string: in a spreadsheet or a report, an
 * empty cell reads as "checked, nothing found," which is a worse failure
 * than an honest "could not be reviewed" notice — the whole reason this
 * app exists is to tell a lawyer what is (and isn't) in a contract.
 *
 * Shared by `csv.ts` and `exportDocx.ts` so the two exporters can't
 * silently disagree about what "not reviewed" reads as; before this was
 * extracted, the DOCX export got this right and the CSV export did not
 * (Critical 3), and the CSV is the one that opens directly in Excel.
 */
/**
 * Whether a finding is in a state a human can attach a verification to.
 * Today that's exactly `status === 'done'`: a `Verification` is a judgement
 * about specific model output, and `pending`/`running`/`error`/`cancelled`
 * findings have no settled output yet for a judgement to be about.
 *
 * Extracted because this rule used to be hardcoded twice — `FindingCard`'s
 * render decided whether to show `VerificationControls` from its own
 * `status === 'done'` fallthrough, and `ResultsView`'s keyboard-shortcut
 * handler repeated the same comparison inline to decide whether `v`/`f`/`r`
 * were allowed to act. Two copies of one rule is this project's most
 * frequently repeated defect (CLAUDE.md's "sibling drift"), and it is
 * exactly what let the keyboard path's own gate go missing in the first
 * place (Critical 2): the mouse path's rule changed shape, in one file,
 * without the keyboard path's copy of it changing to match. Both now call
 * this.
 *
 * A type guard (not a plain `boolean`) so a caller that only needs the
 * narrowing — `FindingCard` already has `finding` in scope and wants
 * TypeScript to know it's defined past this check — gets it for free.
 */
export function isVerifiable(finding: Finding | undefined): finding is Finding {
  return finding?.status === 'done';
}

export function describeFindingOutcome(finding: Finding | undefined): string {
  if (finding?.status === 'done') {
    // A collection finding (`extractCollectionClause`) never sets `summary`
    // — only `netPosition` — so this is the only place its exported text
    // comes from. Without this, a done collection finding's outcome was
    // `finding.summary ?? ''`, i.e. always the empty string: exactly the
    // founding defect (an empty cell reading as "checked, nothing found"),
    // independent of the Step 0 key bug. `positionText` already prefers a
    // human's amendment over the model's proposal.
    if (finding.summary) return finding.summary;
    if (finding.netPosition) return positionText(finding.netPosition);
    return finding.summary ?? '';
  }

  const reason =
    finding?.status === 'error' ? (finding.error ?? 'unknown error') :
    finding?.status === 'cancelled' ? 'the run was cancelled before this clause was reviewed' :
    finding?.status === 'running' ? 'review was still in progress when this was exported' :
    'not yet reviewed';

  return `This clause could not be reviewed: ${reason}`;
}

/**
 * How an export names what a human concluded about a finding — the only
 * place that wording exists, so the DOCX report and the CSV can never
 * disagree about it. They disagreed once before, over exactly this kind of
 * thing (a CSV wrote unreviewed clauses as blank cells while the DOCX said
 * "could not be reviewed"), and the CSV is the one that opens straight into
 * Excel.
 *
 * `null` means "no label" and is returned for exactly one case: a verified
 * finding. Everything else — including a finding that is simply missing —
 * is labelled, because an unlabelled export row reads as checked, and the
 * spec's rule is that nothing leaves the app claiming to be checked when it
 * isn't.
 *
 * Export is never blocked by any of these. A rejected finding is exported
 * WITH its reason: silently dropping it would hide a human judgement from
 * whoever reads the report.
 */
export function verificationLabel(finding: Finding | undefined): string | null {
  const state = finding?.verification?.state ?? 'unchecked';

  if (state === 'verified') return null;
  if (state === 'flagged') return 'FLAGGED';
  if (state === 'rejected') {
    const reason = finding?.verification?.reason?.trim();
    // A rejection whose reason went missing (a record written before the
    // requirement existed, or repaired by the migration) still says it was
    // rejected. Silence here would be the worst of both: a rejected finding
    // exported as though nobody had objected.
    return `REJECTED: ${reason && reason !== '' ? reason : 'no reason recorded'}`;
  }
  return 'UNVERIFIED AI OUTPUT';
}

/**
 * Whether a finding's net position and derivation still stand — i.e. still
 * describe the output the finding actually holds.
 *
 * They do not when the finding is not `done`. `failRetryCell` carries the
 * previous attempt's position onto an `error` finding when a retry cannot
 * even reach the extractor, and `FindingCard`'s error branch returns early:
 * it renders the message and nothing else, no position panel and no trail.
 * Without this guard the exporters did the opposite — a DOCX row read "this
 * clause could not be reviewed", then "UNCONFIRMED NET POSITION", then a
 * Derivation table of quotes from an attempt that no longer stands. Two
 * surfaces disagreeing about whether a piece of evidence still stands is
 * exactly the drift this module exists to prevent, and the screen has the
 * better of the argument: a derivation is the argument FOR a conclusion, and
 * a failed clause has no conclusion.
 *
 * `isVerifiable` is the same rule — "this finding has settled output a human
 * judgement can be about" — already stated once in this file, so it is
 * reused rather than copied. The stale position stays on the record (nothing
 * is deleted that a later read might want); it simply reaches no reader.
 */
function hasStandingPosition(finding: Finding | undefined): boolean {
  return isVerifiable(finding);
}

/**
 * How an export names an unconfirmed net position — a synthesised "what the
 * documents say now" that no human has yet read, the most dangerous output
 * this app produces (see `netPosition.ts`). Mirrors `verificationLabel`'s
 * shape and reasoning exactly, on a second, independent axis: a collection
 * finding carries BOTH a `verification` (has a human checked this AI output
 * at all) and a `netPosition.state` (has a human accepted THIS SPECIFIC
 * synthesis), and either can be labelled without the other.
 *
 * The three return cases matter individually and must not collapse into each
 * other:
 *  - `'UNCONFIRMED NET POSITION'` — a human has not yet looked at this
 *    synthesis. Exporting it unlabelled would let a reader mistake a
 *    document nobody wrote for one a human stood behind.
 *  - `null` for a CONFIRMED position (whether via `confirmPosition` or
 *    `amendPosition` — both set `state: 'confirmed'`) — a label here would
 *    contradict the human sign-off it just received, the same reason
 *    `verificationLabel` returns `null` for `verified`.
 *  - `null` when there is no net position AT ALL (a standalone-document
 *    finding, or a collection clause the run never reached) — this is a
 *    DIFFERENT case from "confirmed": no question of confirmation ever
 *    arose. Both return `null`, but for a caller checking "is this raising a
 *    caveat," which is all a label is for, that's the right answer either
 *    way — see `netPositionAmendmentLabel` for the positive claim ("a person
 *    wrote this") that a plain `null` here cannot carry.
 */
export function netPositionLabel(finding: Finding | undefined): string | null {
  // A position that no longer describes settled output raises no caveat,
  // because it must not be exported at all — see `hasStandingPosition`.
  if (!hasStandingPosition(finding)) return null;
  const state = finding?.netPosition?.state;
  if (state === 'unconfirmed') return 'UNCONFIRMED NET POSITION';
  return null;
}

/**
 * The positive counterpart to `netPositionLabel`: says a PERSON rewrote this
 * text, for exactly the one case that's true — `netPosition.amended` is set.
 * An amended position is a STRONGER claim than a merely confirmed one (a
 * person wrote every word a reader now sees, not just accepted the model's),
 * and `netPositionLabel` alone cannot say that: it returns `null` for every
 * confirmed position, amended or not, because neither needs a CAVEAT. This
 * is not a caveat — it is provenance a reader is entitled to know, the
 * export-side equivalent of `NetPositionPanel`'s "Amended by … on …" line.
 *
 * Not attributed to a specific person, for the same reason `noteLines`
 * isn't: R1 means there is exactly one local user, and an opaque id would
 * communicate nothing while implying multi-user collaboration this app does
 * not deliver.
 */
export function netPositionAmendmentLabel(finding: Finding | undefined): string | null {
  if (!hasStandingPosition(finding)) return null;
  if (!finding?.netPosition?.amended) return null;
  return 'AMENDED NET POSITION: this text was rewritten by a person, not the model';
}

/**
 * The derivation behind a net position, one line per contributing document —
 * mirrors `noteLines`'s shape exactly, and for the same reason it exists:
 * the DOCX and CSV exports must not be able to disagree about what a trail
 * step says once it leaves the app. A conclusion exported without this is an
 * assertion, not the derivation `VariationTrailModal` shows on screen (spec:
 * "a net position without its trail is an assertion").
 */
export function trailLines(
  finding: Finding | undefined,
  documentNames: Record<string, string> = {},
): string[] {
  const trail = hasStandingPosition(finding) ? (finding?.netPosition?.trail ?? []) : [];
  return trail.map((step, i) => {
    const kind = step.kind === 'original' ? 'Original' : 'Varies';
    const quotes = step.citations.map(c => `"${c.quote}"`).join('; ');
    // Name the document, not its id. Which document varied a clause IS the
    // information a derivation carries — "varied by the deed of variation"
    // is the whole point, and `(a3f9x2mtaoyw)` says nothing to a reader
    // while looking like it should. Sub-project B shipped exactly this in
    // note attribution (`Note (vzcsj71fs7mtalycwr):`) and it had to be
    // fixed after a browser check, not a test, caught it.
    //
    // Falls back to the id when a name is genuinely unavailable — a
    // document deleted from the matter since the run. That is an honest
    // "this document is gone" rather than a wrong name, and the id at
    // least distinguishes one missing document from another.
    const label = documentNames[step.documentId] ?? step.documentId;
    // `stepEffectText`, never `step.effect` raw: a blank effect used to
    // export as "2. Varies (Deed of Variation.pdf): " with nothing after the
    // colon, which reads as "considered, does nothing". Shared with the
    // trail modal so the screen and the exports say the same thing.
    const base = `${i + 1}. ${kind} (${label}): ${stepEffectText(step)}`;
    return quotes ? `${base} — ${quotes}` : base;
  });
}

/**
 * Formats a finding's notes for export — one line per note, attributed to
 * whoever wrote it. Spec section 6: "A `flagged` finding carries its flag
 * **and any note**." Extracted here, next to `verificationLabel`, so the
 * DOCX report and the CSV export cannot disagree about what a note looks
 * like once it leaves the app — the exact reason this module exists. Not
 * limited to `flagged` findings: a note can be added to any finding
 * regardless of its verification state, and the spec's honesty rule ("say
 * what a human has and has not confirmed") applies just as much there.
 *
 * Deliberately NOT attributed in the exported line. An earlier version
 * printed the raw `byUserId`, reasoning that this module cannot see the
 * profile store and that R1 means there is one local user anyway. Driving
 * the real app showed where that lands: a client-facing report containing
 * `Note (vzcsj71fs7mtalycwr): …`. That is worse than both alternatives —
 * it communicates nothing to the reader, and an opaque per-person id
 * *implies* the multi-user product R1 says this app must not pretend to
 * be. With exactly one local author, the author is not the information;
 * the note is. `Note.byUserId` is still recorded on the finding, so
 * attribution can be rendered the day there is more than one person to
 * attribute to.
 */
export function noteLines(finding: Finding | undefined): string[] {
  const notes = finding?.notes ?? [];
  return notes.map(note => `Note: ${note.text}`);
}

export interface VerificationCounts {
  total: number;
  verified: number;
  unchecked: number;
  flagged: number;
  rejected: number;
}

/** Counts findings by verification state across every document in a review.
 *  Shared by both exporters' header summary so a DOCX report and a CSV
 *  export of the same run can never quote different numbers. */
export function verificationCounts(findings: Review['findings']): VerificationCounts {
  const counts: VerificationCounts = { total: 0, verified: 0, unchecked: 0, flagged: 0, rejected: 0 };
  for (const byClause of Object.values(findings ?? {})) {
    for (const finding of Object.values(byClause ?? {})) {
      counts.total++;
      counts[finding?.verification?.state ?? 'unchecked']++;
    }
  }
  return counts;
}

/** The one-line header every export carries. Reading it should be enough to
 *  know how much of the report a human has actually stood behind.
 *
 *  Deliberately ASCII-only. This same string goes into the CSV, which is
 *  written with no byte-order mark, and Excel's default import on Windows
 *  reads a BOM-less file as ANSI — so an em-dash here would arrive as
 *  mojibake in the first thing a reader sees. The line has to survive its
 *  most fragile consumer, and typography is not worth a garbled export. */
export function exportSummaryLine(findings: Review['findings']): string {
  const c = verificationCounts(findings);
  return `${c.total} findings: ${c.verified} verified, ${c.unchecked} unverified, ${c.flagged} flagged, ${c.rejected} rejected.`;
}

/**
 * How an export names a COLLECTION — the identity of what was reviewed,
 * spelled out as the member documents read together.
 *
 * The only place that wording lives, for exactly the reason
 * `verificationLabel` is: the DOCX report and the CSV export must not be
 * able to name the same object two different ways. They did. The CSV said
 * "Collection: Lease.pdf + Deed of Variation.pdf" and the DOCX said
 * "<template name> - collection of 2 linked documents", which identifies the
 * TEMPLATE rather than the collection: two collections in one matter under
 * one playbook produced the same report title and the same filename. It also
 * counted the member ids blind, announcing "3 linked documents" when one of
 * them no longer existed. That divergence was written in the same round that
 * fixed M1 — itself a divergence between these two exporters — which is why
 * it now lives here rather than once in each caller.
 *
 * Named, never keyed by `collectionId`. A raw internal id in a cell or a
 * heading a reader meets says nothing to them while looking like it should —
 * the same defect `trailLines` carries a long comment about, and the one
 * `cd89c27` fixed for a user id. A member whose name isn't in hand is
 * described in words for the same reason, rather than falling back to its
 * id: "an unavailable document" is at least true and readable, and it keeps
 * the count honest about what actually resolved.
 */
export function collectionExportLabel(
  documentIds: string[],
  documentNames: Record<string, string>,
): string {
  const names = documentIds.map(id => documentNames[id] ?? 'an unavailable document');
  return names.length > 0 ? `Collection: ${names.join(' + ')}` : 'Collection';
}

/** Characters no common filesystem accepts in a name, plus the control
 *  range. Replaced with a space rather than removed, so `Lease:Deed` reads
 *  as `Lease Deed` instead of running two words together. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\/:*?"<>|\u0000-\u001f]/g;

/**
 * A download name that a filesystem will actually accept, from text a person
 * typed.
 *
 * Lives here, beside the other export wording, because it is the second half
 * of the same rule: `collectionExportLabel` decides what an export is called
 * and this decides what that name looks like once it becomes a file. Both
 * exporters call both, and a second home for either is how the two drift
 * apart again.
 *
 * `exportDocx`'s filename used to come from `docName`, which was always a
 * real filename and needed nothing. It now comes from a collection label
 * assembled from user-authored text, and the CSV's has always come from a
 * template name someone typed — either can contain `/`, `\` or `:`. Browsers
 * sanitise `a.download` themselves, so this is about a legible name rather
 * than a security boundary; the point is that the input class changed and
 * nothing had noticed.
 *
 * Falls back rather than returning a name that is empty, whitespace-only or
 * all dots — each of which is either rejected or silently turned into
 * something else by the browser, which would leave a reader with a file they
 * cannot identify.
 */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows rejects a trailing dot or space outright, and a leading dot
    // makes the file hidden on Unix — neither is what anyone meant.
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/**
 * How an export says the model did not read all of the text this finding is
 * drawn from.
 *
 * mn6 (residual). M3 made truncation legible on the card and in
 * `CellDetail`, and it reached neither exporter: `ReportRow` had no field
 * for it and no CSV cell mentioned it, so the DOCX a client receives said
 * nothing about a deed of variation the model had only read half of. Spec
 * §11 names that precise case — "a silently truncated deed of variation
 * produces a net position that is confidently wrong about exactly the thing
 * the user grouped the documents to find out" — and §6 requires the cut
 * documents to be named. Every other honesty signal in this app is
 * single-sourced into both exporters through this module; this one now is
 * too.
 *
 * By NAME wherever names were recorded. A collection finding derived from
 * four documents cannot tell a reviewer anything with "the text was
 * truncated"; which document was cut is the whole question. A single-
 * document finding records `truncated` with no names because the document it
 * reports on is the only one there is, and gets the singular wording.
 *
 * Gated on `isVerifiable`, exactly as `hasStandingPosition` gates the net
 * position: this caveat qualifies an ANSWER, and a finding that is not
 * `done` has no answer to qualify — its own "could not be reviewed" text is
 * already the loud failure. It is also what the card does, and screen and
 * export disagreeing about a caveat is the drift this module exists to stop.
 */
/**
 * How an export names a clause's comparison against the firm's standard
 * position — the export-side counterpart to `PositionChip`/`PositionComparison`
 * on the card. Sub-project D's whole distinction turns on getting this
 * `switch` right:
 *
 *  - `meets` returns `null`, deliberately. A clause that satisfies the
 *    house position raises no caveat; a label there would manufacture a
 *    caveat the document does not actually carry.
 *  - `unclear` is its OWN label, never folded into `deviates`. `unclear`
 *    means the model could not tell whether the document conflicts with the
 *    position — reporting it as a deviation would tell a reader the two
 *    disagree when nobody has established that they do.
 *  - A clause that never carried a standard position at all also returns
 *    `null`: `normalisePositionOutcome` never writes the `positionOutcome`
 *    key when there is no position to compare against, so `finding
 *    ?.positionOutcome` is `undefined` and the `switch` falls to its
 *    default — the same `null` as `meets`, but for a different reason
 *    (there was no comparison to raise a caveat about, rather than a
 *    comparison that came back clean). Both are "no caveat" to a caller
 *    checking whether to show one, which is all this function is for.
 *
 * Gated on `hasStandingPosition`, the same guard `netPositionLabel` uses and
 * for the same reason: a finding that is not `done` has no settled
 * comparison to report, and the card itself (`FindingCard`'s error branch)
 * shows nothing past the failure message once a retry fails to even reach
 * the extractor.
 */
export function positionOutcomeLabel(finding: Finding | undefined): string | null {
  if (!hasStandingPosition(finding)) return null;
  switch (finding?.positionOutcome) {
    case 'deviates': return 'DEVIATES FROM OUR STANDARD POSITION';
    case 'unclear': return 'UNCLEAR AGAINST OUR STANDARD POSITION';
    default: return null;
  }
}

/**
 * The model's stated reason for a `positionOutcome`, formatted for export —
 * the export-side counterpart of the italic line `PositionComparison` shows
 * beneath the comparison on the card. Returned whenever a rationale is
 * actually present, independent of which outcome it explains: a `meets`
 * outcome can carry a rationale too (`normalisePositionOutcome` does not
 * strip one), and a reader is entitled to the model's reasoning either way
 * — this is supplementary detail, like `noteLines`, not a caveat gated on
 * `positionOutcomeLabel` returning non-null.
 *
 * Gated on `hasStandingPosition` for the same reason `positionOutcomeLabel`
 * is: a rationale explaining an attempt that no longer stands (a failed
 * retry) must not outlive the comparison it was reasoning about.
 */
export function positionRationaleLines(finding: Finding | undefined): string[] {
  if (!hasStandingPosition(finding)) return [];
  const rationale = finding?.positionRationale;
  return rationale ? [`Standard position rationale: ${rationale}`] : [];
}

export interface PositionOutcomeCounts {
  deviating: number;
  hasPosition: boolean;
}

/**
 * How many FINDINGS across a set count as deviating from a standard
 * position, and whether any clause carries one at all. Derived the same
 * flat walk `verificationCounts` uses — every document's every clause's
 * finding — because "absent is not zero": a run (or a matter) where nothing
 * was ever compared to a house position must show no count at all, not a
 * "0 deviating" chip implying a comparison that never happened.
 *
 * Originally lived only in `TabularReview.tsx`; `matterStats.ts`'s
 * `summariseMatter` grew a second copy that counted `positionOutcome ===
 * 'deviates'` directly, with neither the `isVerifiable` gate nor the
 * `hasPosition` distinction — so a matter where no clause anywhere carried a
 * standard position rendered "0 Deviating from a standard position" on the
 * status board, the exact false-reassurance shape this project keeps
 * shipping (a zero that reads as a comparison that never happened). Moved
 * here, next to `positionOutcomeLabel` and `verificationCounts`, so the grid
 * and the matter board can't drift apart on this again.
 *
 * m7 (final honesty review): this counts finding-INSTANCES, not distinct
 * clauses — a single clause deviating in all three documents of a 3-doc run
 * contributes 3, not 1. Callers that show this beside a "N docs · M clauses"
 * summary should say "deviating findings", not "deviating clauses", because
 * this can exceed the clause count.
 *
 * `unclear` is deliberately excluded from the tally. It means the model
 * could not tell, not that it found a conflict — counting it here would
 * report a deviation nobody actually found, the same distinction
 * `positionOutcomeLabel` draws for the exports.
 *
 * Gated on `isVerifiable`, the same guard `positionOutcomeLabel` applies via
 * `hasStandingPosition`. `extractClause`'s `noContent` branch attaches a
 * `positionOutcome` to an `error` finding directly, and without this guard
 * callers could disagree about whether that still counts — exactly the
 * sibling-drift shape this project keeps paying for.
 */
export function positionOutcomeCounts(findings: Review['findings']): PositionOutcomeCounts {
  let deviating = 0;
  let hasPosition = false;
  for (const byClause of Object.values(findings ?? {})) {
    for (const finding of Object.values(byClause ?? {})) {
      if (!isVerifiable(finding) || finding.positionOutcome === undefined) continue;
      hasPosition = true;
      if (finding.positionOutcome === 'deviates') deviating++;
    }
  }
  return { deviating, hasPosition };
}

/**
 * The one wording for "a risk total of zero means nothing was rated, not
 * that nothing is risky." `TabularReview.tsx`'s `ColumnRiskBar` had this
 * branch; `MatterStats.tsx`'s risk-profile card did not, and rendered
 * `HIGH 0 · MEDIUM 0 · LOW 0` on a completed run where every clause errored
 * — three zeroes reading as "assessed, found nothing," the exact shape
 * R-G10 exists to forbid. Both now import this string rather than each
 * carrying its own copy that could drift (CLAUDE.md's sibling-drift rule).
 */
export const NO_RISK_DATA_LABEL = 'No risk data yet';

export function truncationLabel(finding: Finding | undefined): string | null {
  if (!isVerifiable(finding) || !finding.truncated) return null;

  const names = finding.truncatedDocuments ?? [];
  if (names.length === 0) {
    return 'INCOMPLETE SOURCE TEXT: this document exceeded the model\'s context budget, so only ' +
      'part of it was read for this clause';
  }

  const subject = names.length === 1 ? 'this document exceeded' : 'these documents exceeded';
  const each = names.length === 1 ? 'it' : 'each';
  return `INCOMPLETE SOURCE TEXT: ${subject} the model's context budget, so only part of ${each} ` +
    `was read for this clause: ${names.join(', ')}`;
}

/* ------------------------------------------------------------------ *
 *  STAGE 4 §6.3: WHO SET THE STATE THIS CARD IS SHOWING, AND WHEN.     *
 * ------------------------------------------------------------------ */

/**
 * What a caller lends these functions so they can stay pure.
 *
 * Both fields are INJECTED rather than imported, and for two different
 * reasons that both matter:
 *
 *  - `nameOf` would otherwise pull a network cache (`src/lib/api/users.ts`)
 *    into a module the DOCX and CSV exporters import. This file is the one
 *    home of export wording; it must not acquire a transport.
 *  - `timeOf` would otherwise bake a locale and a timezone into an
 *    assertion, so a test that passed in London would fail in Sydney and
 *    the failure would name the string rather than the clock.
 */
export interface DispositionAudience {
  /**
   * Resolves a user id to a name, or `undefined` for one it cannot.
   *
   * `undefined` covers two facts — the directory does not hold this id, and
   * the directory is not loaded — because a caller cannot act on the
   * difference: either way it does not know the name and must say so rather
   * than print a uuid, which says nothing to a reader while looking like it
   * should. The WORDING below is chosen to be true under both, which is why
   * it does not say the person has left the firm.
   */
  nameOf: (id: string | undefined) => string | undefined;
  /** Epoch milliseconds to a human instant. */
  timeOf: (at: number) => string;
}

/**
 * The word for a state, and it is `StateChip`'s word rather than the
 * database's.
 *
 * `unchecked` reads as **Unverified**, because that is what the chip beside
 * this line says and what `verificationLabel` puts in an export — *"the chip
 * is read by someone deciding whether to rely on the finding … the two must
 * say the same thing"*. Three surfaces, one vocabulary.
 */
const STATE_WORD: Record<VerificationState, string> = {
  unchecked: 'Unverified',
  verified: 'Verified',
  flagged: 'Flagged',
  rejected: 'Rejected',
};

/**
 * How this line names a person, and it NEVER prints an id.
 *
 * Three cases, and collapsing any two of them would make a false claim:
 *
 *  - a name the audience resolved;
 *  - an id the audience could not resolve — *"someone this workspace does
 *    not name"*, which is true whether the person has left the firm or the
 *    directory simply has not loaded. Saying "no longer in this workspace"
 *    would be a claim about a person, made on the strength of a failed
 *    fetch;
 *  - NO id at all, which the store does not produce for a moved disposition
 *    (`setDisposition` always writes one) but which a record repaired by a
 *    migration could carry — *"someone this record does not name"*, a
 *    statement about the record rather than about the directory.
 *
 * `matterActivity`'s R-GP5 ruled the same thing one layer down for the local
 * profile: *"an entry whose author matches nothing known is rendered with NO
 * actor rather than an invented one"*.
 */
function actorPhrase(id: string | undefined, audience: DispositionAudience): string {
  if (!id) return 'someone this record does not name';
  return audience.nameOf(id) ?? 'someone this workspace does not name';
}

/**
 * One movement of a disposition, in words — shared by the card's line and by
 * every row of the history panel, so the two cannot describe the same event
 * differently.
 *
 * DELIBERATELY ASCII-ONLY. `exportSummaryLine`'s own docstring gives the
 * reason and it applies unchanged here: these strings go into the CSV, which
 * is written with no byte-order mark, and Excel's default import on Windows
 * reads a BOM-less file as ANSI — so an em-dash would arrive as mojibake in
 * a line about who checked a contract. `-` and not an em-dash, `'` and not a
 * typographic apostrophe. There is no version of this worth a garbled
 * export.
 */
function describeChange(
  change: {
    toState: VerificationState;
    fromState?: VerificationState;
    cause: DispositionCause;
    byUserId: string | undefined;
    at: number | undefined;
  },
  audience: DispositionAudience,
): string {
  const who = actorPhrase(change.byUserId, audience);
  const when = change.at === undefined ? undefined : audience.timeOf(change.at);
  // "WAS UNVERIFIED" IS NOT SAID, AND THE OMISSION IS THE RULE.
  //
  // The "was X" clause exists to say that a judgement REPLACED another
  // judgement — which is the difference between a settled clause and a
  // contested one, and the whole reason the previous state travels with the
  // read. `unchecked` is not a judgement: every finding starts there, so
  // "Verified by A. Trainee, 16:04 - was Unverified" adds a clause that is
  // true of every first verification ever made and distinguishes nothing.
  //
  // Applied to the HISTORY panel as well as to the card, deliberately. The
  // two render one event through this one function precisely so they cannot
  // describe it differently, and a rule that held in one of them would be
  // the beginning of a second wording site.
  const previous = change.fromState === 'unchecked' ? undefined : change.fromState;
  const was = previous === undefined ? '' : `, was ${STATE_WORD[previous]}`;

  // A RE-RUN IS NOT A PERSON UN-VERIFYING (§6.3: the card must not flatten
  // them). It says what actually happened — the clause was run again, so the
  // answer the judgement described no longer exists — and it names whoever
  // asked for the re-run rather than implying they withdrew a judgement.
  if (change.cause === 'rerun_reset') {
    return `${STATE_WORD.unchecked} - this clause was re-run by ${who}`
      + `${when ? ` at ${when}` : ''}${was}`;
  }
  // A PERSON CLEARING a judgement is its own sentence, because "Unverified"
  // alone is what a finding nobody has touched says, and these two must
  // never read the same.
  if (change.toState === 'unchecked') {
    return `${STATE_WORD.unchecked} - cleared by ${who}${when ? `, ${when}` : ''}${was}`;
  }
  const head = `${STATE_WORD[change.toState]} by ${who}${when ? `, ${when}` : ''}`;
  return previous === undefined ? head : `${head} - was ${STATE_WORD[previous]}`;
}

/**
 * How a card, a history header and an export name the state a finding is in
 * — WHO put it there, WHEN, and what it was before.
 *
 * §6.3, and the one place that wording lives. `verificationLabel` above is
 * this module's precedent and its warning: the DOCX report and the CSV
 * export drifted apart on exactly this kind of string once before (a CSV
 * wrote unreviewed clauses as blank cells while the DOCX said "could not be
 * reviewed"), and the CSV is the one that opens straight into Excel. Five
 * surfaces render a disposition in Stage 4 — the card, the history panel,
 * the refusal notice, the DOCX and the CSV. Five callers is four more than
 * it takes for a second copy to appear.
 *
 * NEVER returns an empty string, for any input. An empty label in a cell
 * reads as "checked, nothing found", which is the founding defect of this
 * project and precisely what `verificationLabel` exists to prevent;
 * reintroducing it beside that function would be a joke at its expense.
 *
 * ## The three inputs that are NOT the same
 *
 *  - `undefined` — this caller has not READ a disposition for the clause.
 *    Not "nobody has checked it": nobody has told this browser either way,
 *    and the label says so and says what to do about it.
 *  - `changedCount === 0` — a disposition the store DID state, which nobody
 *    has ever moved. "Not checked", naming nobody, which is §6.3's own
 *    sentence.
 *  - `changedCount > 0` — somebody, or a re-run, moved it. It is named.
 */
export function dispositionLabel(
  d: DispositionWithHistory | undefined,
  audience: DispositionAudience,
): string {
  if (!d) {
    // A fact about this browser, stated as one. "Not checked" here would be
    // a claim about a lawyer's work made on the strength of a missing
    // fetch.
    return 'Checked state not read - reload the review';
  }
  const { disposition, last } = d;
  if (disposition.changedCount === 0) {
    // §6.3: a finding nobody has touched renders as "Not checked" and names
    // nobody. Deliberately NOT `StateChip`'s "Unverified": the chip states
    // the state, and this line states who put it there — and here the
    // honest answer is that nobody did.
    return 'Not checked';
  }

  const line = describeChange({
    toState: disposition.state,
    // `last` is what carries the previous state. Absent only if the store
    // moved a disposition without recording that it moved, which
    // `setDisposition` writes in one transaction to make impossible — so
    // the "was X" clause is simply omitted rather than guessed at.
    ...(last ? { fromState: last.fromState } : {}),
    cause: last?.cause ?? 'human',
    byUserId: disposition.byUserId,
    at: disposition.at ?? last?.at,
  }, audience);

  // "was Rejected" already tells a reader there was one previous state, so
  // the count adds nothing at two and understates at three. Above two, the
  // number is the information: a clause that has moved four times is
  // contested, and a line that only named the last move would hide that.
  return disposition.changedCount > 2
    ? `${line} - changed ${disposition.changedCount} times`
    : line;
}

/**
 * One row of the history panel: what changed, who changed it, when, from
 * what — and, on a rejection, why.
 *
 * The same `describeChange` the card's label uses, so the panel and the card
 * cannot describe one event two ways. What it adds is the REASON, in quotes,
 * because a rejection's reason is the only part of a judgement that is not
 * recoverable from the states either side of it — and `verificationLabel`
 * already establishes that a rejection is exported WITH its reason, since
 * dropping it would hide a human judgement from whoever reads the report.
 */
export function dispositionHistoryLine(
  event: DispositionEventView,
  audience: DispositionAudience,
): string {
  const line = describeChange({
    toState: event.toState,
    fromState: event.fromState,
    cause: event.cause,
    byUserId: event.byUserId,
    at: event.at,
  }, audience);
  const reason = event.reason?.trim();
  // Straight quotes, for the ASCII reason `describeChange` gives above.
  return reason ? `${line}. "${reason}"` : line;
}

/**
 * THE SENTENCE A PERSON SEES WHEN SOMEBODY ELSE MOVED A JUDGEMENT OUT FROM
 * UNDER THEM (§6.3, Stage 4).
 *
 * *"R. Okafor changed this to Rejected at 14:22, after you loaded it. Your
 * change was not applied."* — the spec writes that sentence out, and this is
 * the only place it exists.
 *
 * Three things it must do, and each of them is a defect if it is missing:
 *
 *  - **NAME THE PERSON.** The shipped Stage 3 refusal said *"This finding
 *    changed while you were looking at it. Reload the review and try
 *    again."* — true, and it tells a reviewer nothing they can act on.
 *    "R. Okafor changed it" tells them who to ask. `actorPhrase` is the same
 *    one the card's line uses, so an unresolvable actor reads the same way
 *    in both places rather than disappearing here.
 *  - **SAY WHAT IT IS NOW, in the card's own vocabulary** — `STATE_WORD`,
 *    which is `StateChip`'s word — so the notice and the card beside it
 *    cannot disagree about what happened. That is the drift this module
 *    exists to stop, and a refusal that disagreed with the card two
 *    centimetres above it would be the worst possible place for it.
 *  - **SAY THAT NOTHING WAS SAVED**, in those words. A reviewer who reads
 *    only the first half must not be left thinking their change landed
 *    second.
 *
 * It never says "reload". The change is offered again against the row that
 * won, by a person's click (`conflictReapplyLabel`), which writes a second
 * history row so both intentions are on the record — §6.3's own resolution.
 *
 * ASCII only, like every other string here: it is not exported today, but
 * `verificationLabel`'s history is that a string written for one surface is
 * read by an exporter eighteen months later.
 */
export function dispositionConflictLine(
  current: DispositionWithHistory,
  audience: DispositionAudience,
): string {
  const { disposition } = current;
  const who = actorPhrase(disposition.byUserId, audience);
  const at = disposition.at ?? current.last?.at;
  const when = at === undefined ? '' : ` at ${audience.timeOf(at)}`;
  return `${who} changed this to ${STATE_WORD[disposition.state]}${when}, after you loaded it. `
    + 'Your change was not applied.';
}

/**
 * What the control that offers the change again is called.
 *
 * Here rather than in `ConflictNotice.tsx` because it names a STATE, and a
 * component that spelled "Verified" itself would be the second wording site
 * `dispositionLabel` exists to prevent — the same reason `STATE_WORD` is not
 * exported.
 *
 * It says "anyway", and that is deliberate: the person has just been told
 * somebody else decided otherwise, and the button has to read as a
 * considered second judgement rather than as a retry of a failed request.
 * Nothing clicks it for them (P25).
 */
export function conflictReapplyLabel(attempted: VerificationChange): string {
  return attempted.state === 'unchecked'
    ? 'Clear it anyway'
    : `Set it to ${STATE_WORD[attempted.state]} anyway`;
}

/**
 * WHAT A HELD CHANGE SAYS WHILE IT IS BEING HELD (P36).
 *
 * *"R. Okafor changed this while you were writing. Your view will update
 * when you are done."*
 *
 * A change that lands while somebody has a reject-reason dialog open is not
 * applied under the open control — but it is not hidden either, and the
 * difference between those two is the whole rule. Concealing it would leave
 * a person writing a rejection about a state that no longer exists, which is
 * exactly the outcome holding it exists to prevent; the hold buys them the
 * moment to finish the sentence, and this tells them why finishing it may
 * not land.
 *
 * Here rather than in the card, for `dispositionLabel`'s reason: it names a
 * PERSON, through the same `actorPhrase`, so an actor the directory cannot
 * resolve reads the same way in the announcement as on the line above it.
 * It deliberately does NOT name the new state — the reader is mid-judgement
 * about the old one, and a second state word on screen at that moment is a
 * card that appears to say two things at once. The state arrives when the
 * change does.
 */
export function heldUpdateLine(
  incoming: DispositionWithHistory,
  audience: DispositionAudience,
): string {
  const who = actorPhrase(incoming.disposition.byUserId, audience);
  return `${who} changed this while you were writing. `
    + 'Your view will update when you are done.';
}

/**
 * WHEN THE DISPOSITIONS THIS EXPORT REPORTS WERE TRUE (§6.3.1).
 *
 * *"Dispositions as at 2026-08-28 16:41 (Europe/London)"*.
 *
 * ## Why an export needs this and a card does not
 *
 * §19: *"A card is read next to its history; a DOCX is read on a train, six
 * weeks later, by a partner who was not in the review. Under the superseded
 * insert-once model an export was a claim about a row that could not change
 * … It no longer does, and the failure is completely silent: the document
 * looks exactly the same whether or not the disposition it reports still
 * holds."*
 *
 * A disposition is now mutable by anyone in the workspace at any time, so
 * every export is a POINT-IN-TIME claim and has to say so. Without this
 * line the document asserts, eternally, that a named person verified a
 * clause — and the reader has no way to know it was withdrawn the following
 * morning.
 *
 * ## `at` is when the dispositions were READ, not when the file was written
 *
 * Those differ on a slow export, and the second is a claim the document
 * cannot support: the bytes are assembled from a findings map that was
 * fetched earlier. It is also what makes this testable without mocking a
 * clock.
 *
 * `undefined` is answered honestly rather than filled in with `Date.now()`.
 * An export that cannot say when it was true must say THAT, not pick an
 * instant — a stamp naming the moment the file was written would be the
 * confidently-wrong answer this whole line exists to prevent.
 *
 * ## ASCII, and assembled from parts
 *
 * `exportSummaryLine`'s docstring gives the reason and it applies unchanged:
 * the CSV carries no byte-order mark and Excel on Windows reads a BOM-less
 * file as ANSI. `toLocaleString` is not used because several ICU versions
 * emit a NARROW NO-BREAK SPACE between the time and the meridiem, which is
 * U+202F and arrives as mojibake in the first thing a reader sees. The parts
 * are read individually and joined with plain spaces.
 */
export function dispositionsAsAtLine(at: number | undefined, timeZone: string): string {
  if (at === undefined) {
    return 'Dispositions as at: not recorded. This export cannot say when these were last '
      + 'read from LexPrompt.';
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(at));
  const of = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  // `hour12: false` still answers "24" for midnight in some ICU versions.
  const hour = of('hour') === '24' ? '00' : of('hour');
  return `Dispositions as at ${of('year')}-${of('month')}-${of('day')} `
    + `${hour}:${of('minute')} (${timeZone})`;
}

/**
 * THAT IT CAN CHANGE AGAIN, AND WHAT IS AUTHORITATIVE (§6.3.1).
 *
 * The other half of the stamp above, and the half most likely to be trimmed
 * for looking like boilerplate. It is not boilerplate: it is the sentence
 * that stops a printed copy being read as the record. A partner holding a
 * six-week-old DOCX has to know that the answer to "does this still hold"
 * exists somewhere else and is not in their hands.
 *
 * A function rather than a constant so both exporters call the same thing by
 * the same name as everything else here, and so a future workspace-specific
 * wording has one place to arrive.
 */
export function dispositionsMayChangeLine(): string {
  return 'A disposition can be changed by any reviewer at any time, including after this file '
    + "was made. LexPrompt's history is authoritative over any printed copy.";
}

/**
 * What an exporter needs in order to say when its dispositions were true and
 * who set them.
 *
 * Passed as one object rather than four parameters because the four are one
 * fact — *"what the server said about this review's judgements, and when"* —
 * and a caller that could supply three of them would be a caller that could
 * stamp an instant onto dispositions it did not read.
 *
 * It carries `dispositionOf` and `audience` rather than a ready-made label,
 * deliberately: the exporters call `dispositionLabel` themselves, so the
 * DOCX, the CSV, the card, the history panel and the refusal notice are five
 * callers of ONE function rather than four callers and one caller-shaped
 * hole where a second wording could be handed in.
 */
export interface ExportContext {
  /** When this browser last READ these dispositions from the server —
   *  `dispositionsReadAt` in `src/lib/api/findings.ts`. */
  readAt: number | undefined;
  /** An IANA zone name, stated rather than assumed: a report read in another
   *  office has to know which clock the instant is on. */
  timeZone: string;
  dispositionOf: (findingsKey: string, clauseId: string) => DispositionWithHistory | undefined;
  audience: DispositionAudience;
}

/**
 * The context an exporter falls back to when its caller has none, and it is
 * deliberately the LOUD one.
 *
 * It dates nothing and names nobody, so an export built without a real
 * context says *"Dispositions as at: not recorded"* on its first page and
 * *"Checked state not read - reload the review"* on every clause. That is
 * unmistakable, which is the whole point: the alternative to a loud fallback
 * here is a document that looks finished and asserts a verification
 * eternally, which is section 19's worst-consequence failure and is
 * completely silent.
 *
 * It exists so `ExportContext` can be required at the two functions that
 * produce a file a lawyer sends, while a preview or a test that has no
 * directory in hand can still build one.
 */
export const NO_EXPORT_CONTEXT: ExportContext = {
  readAt: undefined,
  timeZone: 'UTC',
  dispositionOf: () => undefined,
  audience: { nameOf: () => undefined, timeOf: (at: number) => new Date(at).toISOString() },
};

/**
 * The attribution line one clause carries in an export, or `undefined` for a
 * clause that should carry none.
 *
 * ONE decision, in one place, because the DOCX and the CSV both make it and
 * they have disagreed once before over a string of exactly this kind.
 *
 * ## The one case that is deliberately silent, and why it is not the
 * blank-cell defect
 *
 * When a disposition WAS read, the line is rendered, whatever it says —
 * including `dispositionLabel`'s "Checked state not read" for a cell the
 * read did not cover, which is genuinely anomalous and worth sixty
 * repetitions if that is what it takes to be noticed.
 *
 * When NOTHING was read (`readAt === undefined`), the export already says so
 * once, at the top, in `dispositionsAsAtLine`'s own words: *"Dispositions as
 * at: not recorded. This export cannot say when these were last read from
 * LexPrompt."* Repeating "Checked state not read" into every cell of a
 * sixty-cell sheet adds no fact and buries the one that matters. The
 * distinction that keeps this honest is that the caveat is still THERE —
 * stated once at the head of the document a reader meets first — rather than
 * being dropped, which is what made a blank CSV cell read as "checked,
 * nothing found".
 */
export function exportDispositionLine(
  context: ExportContext, findingsKey: string, clauseId: string,
): string | undefined {
  const d = context.dispositionOf(findingsKey, clauseId);
  if (d) return dispositionLabel(d, context.audience);
  return context.readAt === undefined ? undefined : dispositionLabel(d, context.audience);
}
