import type { Finding, Review } from '../types';
import { positionText } from './netPosition';

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
  const trail = finding?.netPosition?.trail ?? [];
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
    const base = `${i + 1}. ${kind} (${label}): ${step.effect}`;
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
