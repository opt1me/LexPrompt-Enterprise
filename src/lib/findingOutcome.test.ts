import { describe, it, expect } from 'vitest';
import {
  describeFindingOutcome, verificationLabel, verificationCounts, exportSummaryLine, noteLines, isVerifiable,
  netPositionLabel, netPositionAmendmentLabel, trailLines,
  collectionExportLabel, safeFileName, truncationLabel,
  positionOutcomeLabel, positionOutcomeCounts,
} from './findingOutcome';
import { unconfirmedPosition, confirmPosition, amendPosition } from '@lexprompt/core';
import type { Finding, TrailStep, Verification } from '../types';

// Minor 3 (final fix round): `isVerifiable` replaces what used to be two
// independent `status === 'done'` checks — `FindingCard`'s render and
// `ResultsView`'s keyboard-shortcut gate. This file tests the rule directly;
// `FindingCard.test.tsx` and `ResultsView.test.tsx` cover each consumer.
describe('isVerifiable', () => {
  it('is true for a done finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(isVerifiable(finding)).toBe(true);
  });

  it.each(['pending', 'running', 'error', 'cancelled'] as const)('is false for a %s finding', (status) => {
    const finding: Finding = { clauseId: 'c1', status, citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(isVerifiable(finding)).toBe(false);
  });

  it('is false for a missing finding', () => {
    expect(isVerifiable(undefined)).toBe(false);
  });
});

describe('describeFindingOutcome', () => {
  it('returns the summary for a done finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', summary: 'Auto-renews annually.', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('Auto-renews annually.');
  });

  it('returns an empty string for a done finding with no summary, not "undefined"', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('');
  });

  it('reports a missing finding as "not yet reviewed"', () => {
    expect(describeFindingOutcome(undefined)).toBe('This clause could not be reviewed: not yet reviewed');
  });

  it('reports a pending finding as "not yet reviewed"', () => {
    const finding: Finding = { clauseId: 'c1', status: 'pending', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: not yet reviewed');
  });

  it('reports a running finding honestly rather than as empty', () => {
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toMatch(/could not be reviewed/);
  });

  it('includes the error message for an errored finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'error', citations: [], error: 'timed out', verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: timed out');
  });

  it('falls back to "unknown error" for an errored finding with no message', () => {
    const finding: Finding = { clauseId: 'c1', status: 'error', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: unknown error');
  });

  it('reports a cancelled finding distinctly from an error', () => {
    const finding: Finding = { clauseId: 'c1', status: 'cancelled', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe(
      'This clause could not be reviewed: the run was cancelled before this clause was reviewed',
    );
  });
});

function finding(state: Verification['state'], reason?: string, positionOutcome?: Finding['positionOutcome']): Finding {
  return {
    clauseId: 'c', status: 'done', summary: 's', citations: [], notes: [],
    verification: reason ? { state, reason } : { state },
    ...(positionOutcome ? { positionOutcome } : {}),
  } as Finding;
}

describe('verificationLabel', () => {
  it('labels an unchecked finding as unverified AI output', () => {
    expect(verificationLabel(finding('unchecked'))).toBe('UNVERIFIED AI OUTPUT');
  });

  it('labels a flagged finding', () => {
    expect(verificationLabel(finding('flagged'))).toBe('FLAGGED');
  });

  it('carries the reason on a rejected finding', () => {
    expect(verificationLabel(finding('rejected', 'Wrong clause'))).toBe('REJECTED: Wrong clause');
  });

  it('returns null for a verified finding — a label there would be noise', () => {
    expect(verificationLabel(finding('verified'))).toBeNull();
  });

  it('labels a missing finding as unverified rather than saying nothing', () => {
    expect(verificationLabel(undefined)).toBe('UNVERIFIED AI OUTPUT');
  });

  it('never returns an empty string for a rejection with no readable reason', () => {
    const f = { ...finding('rejected'), verification: { state: 'rejected' as const } };
    expect(verificationLabel(f)).toBe('REJECTED: no reason recorded');
  });
});

describe('noteLines (Important 3 — spec section 6: "a flagged finding carries its flag and any note")', () => {
  it('returns nothing for a finding with no notes', () => {
    expect(noteLines(finding('flagged'))).toEqual([]);
  });

  it('returns nothing for a missing finding', () => {
    expect(noteLines(undefined)).toEqual([]);
  });

  it('formats one note, attributed to who wrote it', () => {
    const f: Finding = {
      ...finding('flagged'),
      notes: [{ id: 'n1', findingId: 'x', text: 'Check this against the side letter.', byUserId: 'u1', at: 1 }],
    };
    expect(noteLines(f)).toEqual(['Note: Check this against the side letter.']);
  });

  it('formats every note on a finding, not just the first', () => {
    const f: Finding = {
      ...finding('flagged'),
      notes: [
        { id: 'n1', findingId: 'x', text: 'First note.', byUserId: 'u1', at: 1 },
        { id: 'n2', findingId: 'x', text: 'Second note.', byUserId: 'u1', at: 2 },
      ],
    };
    expect(noteLines(f)).toEqual([
      'Note: First note.',
      'Note: Second note.',
    ]);
  });

  it('is not limited to flagged findings — a note on a verified finding still carries', () => {
    const f: Finding = {
      ...finding('verified'),
      notes: [{ id: 'n1', findingId: 'x', text: 'Confirmed against the executed copy.', byUserId: 'u1', at: 1 }],
    };
    expect(noteLines(f)).toEqual(['Note: Confirmed against the executed copy.']);
  });
});

describe('verificationCounts and exportSummaryLine', () => {
  const findings = {
    'doc-1': {
      a: finding('verified'), b: finding('unchecked'),
      c: finding('flagged'), d: finding('rejected', 'no'),
    },
    'doc-2': { a: finding('verified'), b: finding('unchecked') },
  };

  it('counts every finding across every document', () => {
    expect(verificationCounts(findings)).toEqual({
      total: 6, verified: 2, unchecked: 2, flagged: 1, rejected: 1,
    });
  });

  it('summarises in one line naming how many were verified', () => {
    expect(exportSummaryLine(findings)).toBe(
      '6 findings: 2 verified, 2 unverified, 1 flagged, 1 rejected.',
    );
  });

  it('handles an empty review without dividing by zero or saying nothing', () => {
    expect(exportSummaryLine({})).toBe('0 findings: 0 verified, 0 unverified, 0 flagged, 0 rejected.');
  });
});

// Moved here from `TabularReview.tsx`, which had the only copy, when
// `matterStats.ts`'s `summariseMatter` grew a second one with neither the
// `isVerifiable` gate nor the `hasPosition` distinction — the matter status
// board then rendered "0 Deviating from a standard position" on a matter
// where no clause anywhere carried a standard position.
describe('positionOutcomeCounts', () => {
  it('counts deviating findings and reports that a position existed', () => {
    const findings = {
      'doc-1': {
        c1: finding('unchecked', undefined, 'deviates'),
        c2: finding('unchecked', undefined, 'meets'),
      },
    };
    expect(positionOutcomeCounts(findings)).toEqual({ deviating: 1, hasPosition: true });
  });

  it('reports no position at all when no finding carries a positionOutcome, not a zero', () => {
    const findings = { 'doc-1': { c1: finding('unchecked') } };
    expect(positionOutcomeCounts(findings)).toEqual({ deviating: 0, hasPosition: false });
  });

  it('does not count an unclear outcome as a deviation', () => {
    const findings = { 'doc-1': { c1: finding('unchecked', undefined, 'unclear') } };
    expect(positionOutcomeCounts(findings)).toEqual({ deviating: 0, hasPosition: true });
  });

  it('ignores a positionOutcome carried onto a finding with no standing output', () => {
    const findings = {
      'doc-1': {
        c1: { ...finding('unchecked', undefined, 'deviates'), status: 'error' as const, error: 'boom' },
      },
    };
    expect(positionOutcomeCounts(findings)).toEqual({ deviating: 0, hasPosition: false });
  });
});

const trail: TrailStep[] = [
  { documentId: 'lease', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
  { documentId: 'deed', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [{ quote: 'reduced to six months', documentId: 'deed' }] },
];

function collectionFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId: 'break', status: 'done', citations: [],
    verification: { state: 'unchecked' }, notes: [],
    netPosition: unconfirmedPosition('Break on 6 months notice.', trail),
    ...overrides,
  };
}

// The three cases below are deliberately distinct, and each is asserted
// against a genuinely different input — an unconfirmed net position, a
// CONFIRMED one, and a finding with no net position at all — so a broken
// implementation that collapsed "confirmed" and "no position" into the same
// `null` (technically satisfying two of the three assertions) would still be
// caught: this app must never let a synthesis nobody has read export as
// though a human had already stood behind it, and must never claim a
// question arose that never did.
describe('netPositionLabel', () => {
  it('labels an unconfirmed net position, distinctly from a settled one', () => {
    const f = collectionFinding();
    expect(netPositionLabel(f)).toBe('UNCONFIRMED NET POSITION');
  });

  it('returns null for a confirmed net position — a label there would contradict the human sign-off', () => {
    const pos = confirmPosition(unconfirmedPosition('Break on 6 months notice.', trail), 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(netPositionLabel(f)).toBeNull();
  });

  it('returns null when there is no net position at all — "no position" is not "confirmed"', () => {
    const f: Finding = { clauseId: 'c', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(netPositionLabel(f)).toBeNull();
    expect('netPosition' in f).toBe(false);
  });

  it('returns null for a missing finding — there is no question of a net position to raise', () => {
    expect(netPositionLabel(undefined)).toBeNull();
  });
});

describe('netPositionAmendmentLabel', () => {
  it('says a human wrote the text for an amended position', () => {
    const pos = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(netPositionAmendmentLabel(f)).toMatch(/amend/i);
    expect(netPositionAmendmentLabel(f)).toMatch(/person/i);
  });

  it('does not say a person wrote it for a merely confirmed (unamended) position', () => {
    const pos = confirmPosition(unconfirmedPosition('model text', trail), 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(netPositionAmendmentLabel(f)).toBeNull();
  });

  it('does not say a person wrote it for an unconfirmed position', () => {
    expect(netPositionAmendmentLabel(collectionFinding())).toBeNull();
  });

  it('returns null for a finding with no net position at all', () => {
    const f: Finding = { clauseId: 'c', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(netPositionAmendmentLabel(f)).toBeNull();
  });
});

describe('trailLines — the derivation behind a net position', () => {
  it('emits one line per contributing document, naming the document and its effect', () => {
    const lines = trailLines(collectionFinding());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('lease');
    expect(lines[0]).toContain('Break on 12 months notice.');
    expect(lines[1]).toContain('deed');
    expect(lines[1]).toContain('Notice cut to 6 months.');
  });

  it('distinguishes the original document from a varying one', () => {
    const lines = trailLines(collectionFinding());
    expect(lines[0]).toMatch(/original/i);
    expect(lines[1]).toMatch(/varies/i);
  });

  // C1: a step whose effect the model left blank used to export as
  // `2. Varies (Deed of Variation.pdf): ` — nothing after the colon, which
  // reads as "considered, does nothing". Shares its wording with the trail
  // modal via `stepEffectText`, so the screen and the exports cannot
  // disagree about what a blank effect means.
  it('says a step has no effect rather than emitting nothing after the colon', () => {
    const f = collectionFinding();
    f.netPosition!.trail[1] = { ...f.netPosition!.trail[1], effect: '' };
    const lines = trailLines(f);
    expect(lines[1]).not.toMatch(/:\s*$/);
    expect(lines[1]).toMatch(/no effect|not say/i);
  });

  it('returns nothing for a finding with no net position', () => {
    const f: Finding = { clauseId: 'c', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(trailLines(f)).toEqual([]);
  });

  it('returns nothing for a missing finding', () => {
    expect(trailLines(undefined)).toEqual([]);
  });
});

describe('describeFindingOutcome — a collection finding\'s net position', () => {
  // A collection finding (`extractCollectionClause`) never sets `summary` —
  // only `netPosition`. Before this, a done collection finding's outcome was
  // `finding.summary ?? ''`, i.e. always the empty string: exactly the
  // founding defect (an empty cell reading as "checked, nothing found") for
  // every collection review, independent of the Step 0 key bug.
  it('uses the proposed net position text when there is no summary', () => {
    const f = collectionFinding();
    expect(describeFindingOutcome(f)).toBe('Break on 6 months notice.');
  });

  it('prefers the human amendment over the model\'s proposal', () => {
    const pos = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(describeFindingOutcome(f)).toBe('human text');
  });

  it('still prefers an explicit summary when both are somehow present', () => {
    const f = collectionFinding({ summary: 'Explicit summary.' });
    expect(describeFindingOutcome(f)).toBe('Explicit summary.');
  });
});

/**
 * m1 (final review). When a collection clause's retry cannot even reach the
 * extractor — the document's stored bytes could not be re-read —
 * `failRetryCell` lands an `error` finding that carries the previous
 * attempt's `netPosition` forward. `FindingCard`'s error branch returns
 * early and renders only the message: no position panel, no trail.
 *
 * Both exporters, however, took the non-`done` branch of `buildReportRows`
 * and emitted `netPositionLabel` plus the whole derivation alongside "This
 * clause could not be reviewed" — so a DOCX row read "could not be
 * reviewed", then "UNCONFIRMED NET POSITION", then a Derivation table of
 * quotes from an attempt that no longer stands, which the app itself
 * refuses to show on screen. Two surfaces disagreeing about whether a piece
 * of evidence still stands is the drift this module exists to prevent.
 *
 * A derivation belongs to settled output. `isVerifiable` is the same rule,
 * already stated once here, so it is reused rather than copied.
 */
describe('a derivation does not outlive the output it described', () => {
  function stale(status: Finding['status']): Finding {
    return { ...collectionFinding(), status, error: 'This clause was not re-run: the file could not be read.' };
  }

  it('raises no net-position caveat on a finding that failed', () => {
    expect(netPositionLabel(stale('error'))).toBeNull();
    expect(netPositionAmendmentLabel(stale('error'))).toBeNull();
  });

  it('exports no trail for a finding that failed', () => {
    expect(trailLines(stale('error'))).toEqual([]);
  });

  it.each(['pending', 'running', 'cancelled'] as const)('does the same for a %s finding', (status) => {
    expect(netPositionLabel(stale(status))).toBeNull();
    expect(trailLines(stale(status))).toEqual([]);
  });

  it('still labels and exports the derivation of a done finding', () => {
    expect(netPositionLabel(collectionFinding())).toBe('UNCONFIRMED NET POSITION');
    expect(trailLines(collectionFinding())).toHaveLength(2);
  });
});

/**
 * mn4/mn5 (re-review). Two exporters named the same collection two
 * different ways — the CSV as "Collection: Lease.pdf + Deed of
 * Variation.pdf", the DOCX as "<template name> - collection of 2 linked
 * documents", which identifies the TEMPLATE and not the collection: two
 * collections in one matter under one playbook produced the same report
 * title and the same filename. That divergence was written in the very
 * round that fixed M1, itself a divergence between these same two
 * exporters, which is why the rule now lives here beside the other shared
 * export wording rather than once in each caller.
 */
describe('collectionExportLabel', () => {
  it('names every member, in the order the review covered them', () => {
    expect(collectionExportLabel(['lease', 'deed'], { lease: 'Lease.pdf', deed: 'Deed of Variation.pdf' }))
      .toBe('Collection: Lease.pdf + Deed of Variation.pdf');
  });

  it('says in words that a member no longer resolves, rather than printing its raw id', () => {
    const label = collectionExportLabel(['lease', 'deed'], { lease: 'Lease.pdf' });
    expect(label).toContain('Lease.pdf');
    expect(label).not.toContain('deed');
    expect(label).toMatch(/unavailable/i);
  });

  it('still says what it is when no member resolves at all', () => {
    expect(collectionExportLabel([], {})).toBe('Collection');
  });
});

/**
 * mn5. A DOCX report's filename used to be built from `docName`, always a
 * real filename. It is now built from a collection label assembled from
 * user-authored text, which can carry `/`, `\`, `:` and friends. Browsers
 * sanitise `a.download` themselves, so this is about a legible name rather
 * than a security boundary — but the input class changed and nothing had
 * noticed.
 */
describe('safeFileName', () => {
  it('removes path separators and characters no filesystem accepts', () => {
    expect(safeFileName('Collection: a/b\c*d?e"f<g>h|i', 'fallback'))
      .not.toMatch(/[\/:*?"<>|]/);
  });

  it('keeps the words readable rather than running them together', () => {
    expect(safeFileName('Collection: Lease.pdf + Deed.pdf', 'fallback'))
      .toBe('Collection Lease.pdf + Deed.pdf');
  });

  it('falls back rather than producing an empty or dot-only name', () => {
    expect(safeFileName('', 'fallback')).toBe('fallback');
    expect(safeFileName('   ', 'fallback')).toBe('fallback');
    expect(safeFileName('...', 'fallback')).toBe('fallback');
    expect(safeFileName('///', 'fallback')).toBe('fallback');
  });

  it('leaves an ordinary name exactly as it was', () => {
    expect(safeFileName('MSA', 'fallback')).toBe('MSA');
  });
});

/**
 * mn6 (residual, pre-existing). M3 made truncation legible on the card and
 * in `CellDetail`, and neither exporter mentioned it at all — so the DOCX a
 * client receives said nothing about a deed of variation the model only read
 * half of. Spec §11: "a silently truncated deed of variation produces a net
 * position that is confidently wrong about exactly the thing the user
 * grouped the documents to find out." Every other honesty signal in this app
 * is single-sourced into both exporters through this module; this one now is
 * too.
 */
describe('truncationLabel', () => {
  function done(overrides: Partial<Finding> = {}): Finding {
    return {
      clauseId: 'c1', status: 'done', summary: 's', citations: [],
      verification: { state: 'unchecked' }, notes: [], ...overrides,
    };
  }

  it('names the documents that were cut short', () => {
    const label = truncationLabel(done({ truncated: true, truncatedDocuments: ['Deed of Variation.pdf'] }));
    expect(label).toMatch(/incomplete/i);
    expect(label).toContain('Deed of Variation.pdf');
  });

  it('names every cut document, not just the first', () => {
    const label = truncationLabel(done({ truncated: true, truncatedDocuments: ['Lease.pdf', 'Deed.pdf'] }));
    expect(label).toContain('Lease.pdf');
    expect(label).toContain('Deed.pdf');
  });

  it('still says the text was cut when there is only one document to name', () => {
    // A single-document finding records `truncated` with no names — the
    // document it reports on is the only one there is.
    const label = truncationLabel(done({ truncated: true }));
    expect(label).toMatch(/incomplete/i);
    expect(label).toMatch(/only part/i);
  });

  it('says nothing when the whole text fit', () => {
    expect(truncationLabel(done())).toBeNull();
  });

  it('says nothing for a finding with no settled output, exactly as the card does', () => {
    expect(truncationLabel(done({ status: 'error', truncated: true }))).toBeNull();
    expect(truncationLabel(undefined)).toBeNull();
  });
});

/**
 * Task 11. `positionOutcomeLabel` is the export-side counterpart to
 * `PositionChip`/`PositionComparison` on the card. Absent is not zero, and
 * `unclear` is not a deviation: a clause that never carried a standard
 * position gets no caveat at all, and a model that could not tell must not
 * be reported as though it found a conflict.
 */
describe('positionOutcomeLabel', () => {
  const deviating: Finding = {
    clauseId: 'c1', status: 'done', summary: 'The lease gives 9 months.',
    citations: [], verification: { state: 'unchecked' }, notes: [],
    positionOutcome: 'deviates', positionRationale: 'Nine months, not six.',
  };

  it('labels a deviation', () => {
    expect(positionOutcomeLabel(deviating)).toBe('DEVIATES FROM OUR STANDARD POSITION');
  });

  it('labels an unclear outcome as unclear, never as met', () => {
    expect(positionOutcomeLabel({ ...deviating, positionOutcome: 'unclear' }))
      .toBe('UNCLEAR AGAINST OUR STANDARD POSITION');
  });

  it('returns null for meets — a label there would be a caveat where there is none', () => {
    expect(positionOutcomeLabel({ ...deviating, positionOutcome: 'meets' })).toBeNull();
  });

  it('returns null when there was no position to compare against', () => {
    const { positionOutcome: _o, positionRationale: _r, ...noPosition } = deviating;
    expect(positionOutcomeLabel(noPosition as Finding)).toBeNull();
  });

  it('returns null for a missing finding, rather than throwing', () => {
    expect(positionOutcomeLabel(undefined)).toBeNull();
  });
});
