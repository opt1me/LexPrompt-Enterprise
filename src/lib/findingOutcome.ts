import type { Finding, Review } from '../types';
import { positionText, stepEffectText } from '@lexprompt/core';

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
