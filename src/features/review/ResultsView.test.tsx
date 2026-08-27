import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, keyDown } from '../../test/mount';
import { ResultsView } from './ResultsView';
import type { DocumentFile, Finding, ReviewRun, Settings, Template } from '../../types';

// Critical 2 (final whole-branch review, redesign sub-project B): the
// keyboard verify loop (`useVerifyKeys`, wired here) acted on any clause
// index with no gate on the finding's status. The mouse path only ever
// offers verification controls on a `done` finding (`FindingCard` renders
// `VerificationControls`/`StateChip` only in its `done` branch), so pressing
// `v`/`f`/`r` while the keyboard cursor sat on a pending, error or cancelled
// card silently wrote a verification nobody could have read — and it then
// counted in progress indicators and export summaries. This file is the
// seam nothing tested before: the hook-to-finding adaptor in `ResultsView`.
//
function makeTemplate(): Template {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    mode: 'extraction',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [
      { id: 'c1', title: 'Governing Law', prompt: 'Extract the governing law clause.' },
      { id: 'c2', title: 'Term', prompt: 'Extract the term.' },
      { id: 'c3', title: 'Indemnity', prompt: 'Extract the indemnity clause.' },
      { id: 'c4', title: 'Assignment', prompt: 'Extract the assignment clause.' },
    ],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 2,
  };
}

function makeFinding(clauseId: string, status: Finding['status']): Finding {
  return {
    clauseId,
    status,
    citations: status === 'done' ? [{ quote: 'x', documentId: 'd1' }] : [],
    summary: status === 'done' ? 'Some finding.' : undefined,
    verification: { state: 'unchecked' },
    notes: [],
  };
}

/** c1 pending, c2 error, c3 cancelled, c4 done — one of each of the statuses
 *  the mouse path denies verification controls to, plus the one it grants
 *  them to, so the gate can be proven both ways in one run. */
function makeRun(): ReviewRun {
  return {
    id: 'r1',
    templateSnapshot: makeTemplate(),
    documentIds: ['d1'],
    findings: {
      d1: {
        c1: makeFinding('c1', 'pending'),
        c2: makeFinding('c2', 'error'),
        c3: makeFinding('c3', 'cancelled'),
        c4: makeFinding('c4', 'done'),
      },
    },
    startedAt: 1,
  };
}

const documents: DocumentFile[] = [];
const settings: Settings = { apiKey: '', modelId: 'test/model', concurrency: 2 };

function renderResultsView(onVerify: ReturnType<typeof vi.fn>, run: ReviewRun = makeRun()) {
  return mount(
    <ResultsView
      run={run}
      documents={documents}
      settings={settings}
      onRetryCell={() => {}}
      onVerify={onVerify}
    />,
  );
}

describe('ResultsView — keyboard verify loop gated on status (Critical 2)', () => {
  it('does not call onVerify for v/f/r on a pending finding, and r does not open the reject dialog', () => {
    const onVerify = vi.fn();
    const container = renderResultsView(onVerify);
    // Focus starts at index 0 (c1, pending).
    keyDown({ key: 'v' });
    keyDown({ key: 'f' });
    keyDown({ key: 'r' });
    expect(onVerify).not.toHaveBeenCalled();
    // `r` never calls `onVerify` directly on ANY finding — it opens
    // `RejectReasonModal` instead, which then calls `onVerify` once a reason
    // is submitted. So an ungated ("2 calls, not 3") ok-and-onVerify-was-
    // never-called assertion alone cannot tell "the gate blocked `r`" apart
    // from "`r` opened the dialog and nobody submitted it yet" — this is the
    // assertion that actually distinguishes them.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not call onVerify for v/f/r on an error finding, and r does not open the reject dialog', () => {
    const onVerify = vi.fn();
    const container = renderResultsView(onVerify);
    keyDown({ key: 'j' }); // move to c2, error
    keyDown({ key: 'v' });
    keyDown({ key: 'f' });
    keyDown({ key: 'r' });
    expect(onVerify).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not call onVerify for v/f/r on a cancelled finding, and r does not open the reject dialog', () => {
    const onVerify = vi.fn();
    const container = renderResultsView(onVerify);
    keyDown({ key: 'j' }); // c2
    keyDown({ key: 'j' }); // c3, cancelled
    keyDown({ key: 'v' });
    keyDown({ key: 'f' });
    keyDown({ key: 'r' });
    expect(onVerify).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('still calls onVerify on a done finding, proving the gate is on status and not a blanket no-op', () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    renderResultsView(onVerify);
    keyDown({ key: 'j' }); // c2
    keyDown({ key: 'j' }); // c3
    keyDown({ key: 'j' }); // c4, done
    keyDown({ key: 'v' });
    expect(onVerify).toHaveBeenCalledWith('d1', 'c4', { state: 'verified' });
  });

  it('still moves the cursor across every clause regardless of status (j/k are not gated)', () => {
    const onVerify = vi.fn();
    const container = renderResultsView(onVerify);
    // Four clauses; j three times should reach the fourth and no further.
    keyDown({ key: 'j' });
    keyDown({ key: 'j' });
    keyDown({ key: 'j' });
    keyDown({ key: 'j' }); // no-op, already at the end
    keyDown({ key: 'v' });
    // Only the done clause (c4, index 3) can have produced a call.
    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(onVerify).toHaveBeenCalledWith('d1', 'c4', { state: 'verified' });
    expect(container.textContent).toContain('Assignment');
  });
});

// Minor 3: the two `RejectReasonModal` mounts (the mouse path in
// `VerificationControls`, and this keyboard path here) had diverged — the
// mouse mount passes `initialReason` for an already-rejected finding, this
// one did not, so the same action ("re-reject this") behaved differently
// depending on which entry point triggered it.
describe('ResultsView — keyboard reject dialog prefills an existing reason (Minor 3)', () => {
  function rejectedRun(): ReviewRun {
    const run = makeRun();
    run.findings.d1.c4 = {
      ...run.findings.d1.c4,
      verification: { state: 'rejected', reason: 'Cites the indemnity, not the cap', byUserId: 'u1', at: 1 },
    };
    return run;
  }

  it('prefills the reason when re-rejecting a done, already-rejected finding via r', () => {
    const onVerify = vi.fn();
    const container = renderResultsView(onVerify, rejectedRun());
    keyDown({ key: 'j' }); // c2
    keyDown({ key: 'j' }); // c3
    keyDown({ key: 'j' }); // c4, done + already rejected
    keyDown({ key: 'r' });

    const textarea = container.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe('Cites the indemnity, not the cap');
  });

  it('leaves the reason blank when rejecting a finding for the first time', () => {
    const onVerify = vi.fn();
    const container = renderResultsView(onVerify); // c4 is `done` but unchecked
    keyDown({ key: 'j' }); keyDown({ key: 'j' }); keyDown({ key: 'j' }); // c4
    keyDown({ key: 'r' });

    // Scoped to the dialog, not a bare `textarea`: `FindingCard`'s own
    // `NotesPanel` renders a `textarea` too (for adding a note), and an
    // unscoped query can match that one and pass even if the reject dialog
    // never opened at all.
    const textarea = container.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe('');
  });
});

// Minor 5: the mouse path (`VerificationControls`) disables its own buttons
// while `verifyBusy` is true for that finding; the keyboard path had no
// equivalent, so a fast `v`-then-`v` (or `v`-then-`f`) could fire a second
// write before the first write's `onVerify` promise even settled.
describe('ResultsView — keyboard verify loop gated on verifyBusyKey (Minor 5)', () => {
  it('does not call onVerify for the finding currently being written', () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const container = mount(
      <ResultsView
        run={makeRun()}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
        onVerify={onVerify}
        verifyBusyKey="d1::c4"
      />,
    );
    keyDown({ key: 'j' }); // c2
    keyDown({ key: 'j' }); // c3
    keyDown({ key: 'j' }); // c4, done — but busy
    keyDown({ key: 'v' });
    expect(onVerify).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('still calls onVerify for a different finding while another is busy', () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const run = makeRun();
    // c4 is the only `done` finding in `makeRun()` by default — mark c1
    // done too so a second, non-busy verifiable finding exists to prove the
    // gate is scoped to the busy key, not a blanket freeze.
    run.findings.d1.c1 = makeFinding('c1', 'done');
    const container = mount(
      <ResultsView
        run={run}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
        onVerify={onVerify}
        verifyBusyKey="d1::c4"
      />,
    );
    // Focus starts at c1 (index 0), which is done and not the busy key.
    keyDown({ key: 'v' });
    expect(onVerify).toHaveBeenCalledWith('d1', 'c1', { state: 'verified' });
    expect(container.textContent).toContain('Governing Law');
  });
});
