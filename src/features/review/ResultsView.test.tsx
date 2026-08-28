import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, keyDown, click, buttonNamed } from '../../test/mount';
import { ResultsView } from './ResultsView';
import { TRACKED_CHANGES_NOTICE } from '../../lib/docxMarkup';
import type { DocumentFile, Finding, ReviewRun, Settings, PlaybookVersion } from '../../types';

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
function makeTemplate(): PlaybookVersion {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [
      { id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' },
      { id: 'c2', title: 'Term', extractPrompt: 'Extract the term.' },
      { id: 'c3', title: 'Indemnity', extractPrompt: 'Extract the indemnity clause.' },
      { id: 'c4', title: 'Assignment', extractPrompt: 'Extract the assignment clause.' },
    ],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
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
    target: { kind: 'documents', documentIds: ['d1'] },
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

// Task 8A: the read side of a collection review. Task 6A made a collection
// run seed and write its findings under `findingsKeyFor(target)` — the
// collection id — but `ResultsView` still read `run.findings[activeDocId]`,
// so a collection review rendered an empty findings pane no matter how much
// work the run actually did.
describe('ResultsView — reading a collection review\'s findings (Task 8A)', () => {
  function makeCollectionRun(): ReviewRun {
    return {
      id: 'r1',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: {
        'coll-1': {
          c1: {
            clauseId: 'c1', status: 'done',
            summary: 'The notice period is now 6 months.',
            citations: [{ quote: 'q', documentId: 'd2' }],
            verification: { state: 'unchecked' }, notes: [],
          },
          c2: makeFinding('c2', 'pending'),
          c3: makeFinding('c3', 'pending'),
          c4: makeFinding('c4', 'pending'),
        },
      },
      startedAt: 1,
    };
  }

  it('renders a collection review\'s findings, keyed by the collection id — not an empty pane', () => {
    const container = mount(
      <ResultsView
        run={makeCollectionRun()}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
      />,
    );
    expect(container.textContent).toContain('The notice period is now 6 months.');
  });

  it('a standalone (document-keyed) review still renders exactly as before (regression pin)', () => {
    const container = mount(
      <ResultsView
        run={makeRun()}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
      />,
    );
    // c4 (done) is the only finding in `makeRun()` with a real summary.
    expect(container.textContent).toContain('Some finding.');
  });
});

// Found by driving the real app during sub-project C's browser
// verification, and the seventh instance of this sub-project's recurring
// shape: a `documentId` sits on the record and the consumer ignores it.
//
// A collection review keys ONE finding per clause, and that finding's
// citations can belong to any of the collection's documents. Clicking a
// citation only ever set `highlights`, leaving `activeDocId` alone — so a
// quote from the base clicked while the amendment was on screen made the
// viewer search the AMENDMENT for it and report "Couldn't locate this quote
// in the document ... the wording may not match exactly". That is the
// confident-wrong-answer failure this project exists to remove: the reader
// is told the evidence cannot be found, about evidence that is verbatim
// present in a document one tab away.
describe('ResultsView — a citation opens its own document, not the active one', () => {
  function makeCollectionRun(): ReviewRun {
    return {
      id: 'r1',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: {
        'coll-1': {
          c1: {
            clauseId: 'c1', status: 'done',
            summary: 'The notice period is now 6 months.',
            // Belongs to d2, while the view opens on d1.
            citations: [{ quote: 'six months notice', documentId: 'd2' }],
            verification: { state: 'unchecked' }, notes: [],
          },
          c2: makeFinding('c2', 'pending'),
          c3: makeFinding('c3', 'pending'),
          c4: makeFinding('c4', 'pending'),
        },
      },
      startedAt: 1,
    };
  }

  function activeDoc(container: HTMLElement): string {
    return (container.querySelector('select') as HTMLSelectElement).value;
  }

  /** The evidence block is the only button whose text carries the quote. */
  function evidenceButton(container: HTMLElement, quote: string): HTMLElement {
    const found = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes(quote));
    if (!found) throw new Error(`No evidence button containing "${quote}"`);
    return found as HTMLElement;
  }

  it('switches the viewer to the citation\'s document before highlighting', () => {
    const container = mount(
      <ResultsView
        run={makeCollectionRun()}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
      />,
    );
    expect(activeDoc(container)).toBe('d1');
    click(evidenceButton(container, 'six months notice'));
    expect(activeDoc(container)).toBe('d2');
  });

  it('leaves the viewer where it is when the citation belongs to the document already shown', () => {
    const run = makeCollectionRun();
    run.findings['coll-1'].c1.citations = [{ quote: 'six months notice', documentId: 'd1' }];
    const container = mount(
      <ResultsView run={run} documents={documents} settings={settings} onRetryCell={() => {}} />,
    );
    click(evidenceButton(container, 'six months notice'));
    expect(activeDoc(container)).toBe('d1');
  });

  // Deliberately NOT tested: a citation naming a document outside
  // `run.documentIds`. `handleCiteClick` guards against it, but the case is
  // unreachable from live data (`repairCitations` stamps the reviewed
  // document's own id; `resolveStepCitations` resolves only against the
  // collection's members), and the existing `activeDocId` effect bounces an
  // unknown id back to `documentIds[0]` regardless — so no assertion can
  // tell the guarded implementation from the unguarded one. A test written
  // here passes against broken code, which is worse than no test at all.
});

// C's spec requires CSV export to label an unconfirmed net position and carry
// its derivation (§3.8, §9's `export` row, DoD §10.7). `buildTabularCsv` does
// both, and is well tested — but the ONLY control that called it lived in the
// tabular grid's header, and the grid deliberately refuses to render at all
// for a collection target (`CollectionNotComparable`), taking its header and
// that button with it. So a collection review could not be exported to CSV by
// any route, and the fix Task 9 made to `buildTabularCsv` for exactly this
// case was unreachable.
//
// Eighth instance of this sub-project's signature shape: a correct mechanism
// with no path to it. Found by driving the app, not by a test — every CSV
// test calls `buildTabularCsv` directly.
describe('ResultsView — CSV export is reachable for every review, collections included', () => {
  /** The export controls are icon-only buttons labelled by `title`, so that
   *  is what a user (and a screen reader) actually reads. */
  const labelled = (container: HTMLElement, re: RegExp) =>
    Array.from(container.querySelectorAll('button'))
      .find(b => re.test(b.getAttribute('title') || '') || re.test(b.textContent || ''));

  it('offers a CSV export on a collection review, which the grid cannot', () => {
    const run: ReviewRun = {
      id: 'r1',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: { 'coll-1': { c1: makeFinding('c1', 'done') } },
      startedAt: 1,
    };
    const container = mount(
      <ResultsView run={run} documents={documents} settings={settings} onRetryCell={() => {}} />,
    );
    expect(labelled(container, /csv/i)).toBeTruthy();
  });

  it('offers it on a standalone review too, beside the DOCX export', () => {
    const container = mount(
      <ResultsView run={makeRun()} documents={documents} settings={settings} onRetryCell={() => {}} />,
    );
    expect(labelled(container, /csv/i)).toBeTruthy();
    // The two exporters have drifted before; they are reachable from the same
    // place so a reader cannot get one without knowing the other exists.
    expect(labelled(container, /docx/i)).toBeTruthy();
  });
});

describe('ResultsView — the comparison grid\'s "Open in review" handoff', () => {
  it('lands the keyboard cursor on the clause the reader clicked, not clause 1', () => {
    // The grid is a triage surface: its whole value is that you scan a
    // matrix, spot a cell, and go to it. A handoff that drops you at the
    // top of the list loses your place, and a triage surface whose handoff
    // loses your place is one nobody uses twice.
    const onVerify = vi.fn();
    const run = makeRun();
    const container = mount(
      <ResultsView
        run={run}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
        onVerify={onVerify}
        openAt={{ docId: 'd1', clauseId: 'c4' }}
      />,
    );
    // c4 is the only `done` finding, so it is the only one the keyboard
    // gate lets `v` act on. If the cursor had defaulted to index 0 (c1,
    // pending) this would not fire at all.
    keyDown({ key: 'v' });
    expect(onVerify).toHaveBeenCalledWith('d1', 'c4', { state: 'verified' });
    expect(container).toBeTruthy();
  });

  it('leaves the cursor alone when handed a clause this run does not have', () => {
    // Being dropped at the top of a list is a worse answer than staying
    // put, because it looks deliberate. c1 is pending, so a cursor that
    // wrongly moved to index 0 would be silently gated and look like
    // nothing happened.
    const onVerify = vi.fn();
    mount(
      <ResultsView
        run={makeRun()}
        documents={documents}
        settings={settings}
        onRetryCell={() => {}}
        onVerify={onVerify}
        openAt={{ docId: 'd1', clauseId: 'not-in-this-playbook' }}
      />,
    );
    keyDown({ key: 'v' });
    expect(onVerify).not.toHaveBeenCalled();
  });
});

describe('ResultsView — a marked-up document says so beside its findings', () => {
  // Spike 1: mammoth reads a .docx with every tracked change accepted and
  // says nothing. The disclosure has to reach THIS screen — the one where
  // someone reads what the contract supposedly says and acts on it — not
  // just the upload screen the reader may never have seen.
  it('renders the document’s markup notice in the review', () => {
    const marked: DocumentFile = {
      id: 'd1',
      name: 'lease.docx',
      text: 'Consent may be withheld only where it is reasonable to do so.',
      file: new File([], 'lease.docx'),
      kind: 'docx',
      markupNotice: TRACKED_CHANGES_NOTICE,
    };
    const container = mount(
      <ResultsView
        run={makeRun()}
        documents={[marked]}
        settings={settings}
        onRetryCell={() => {}}
        onVerify={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(TRACKED_CHANGES_NOTICE);
  });

  it('says nothing about markup for a document that carries no notice', () => {
    const clean: DocumentFile = {
      id: 'd1',
      name: 'lease.docx',
      text: 'Consent may be withheld only where it is reasonable to do so.',
      file: new File([], 'lease.docx'),
      kind: 'docx',
    };
    const container = mount(
      <ResultsView
        run={makeRun()}
        documents={[clean]}
        settings={settings}
        onRetryCell={() => {}}
        onVerify={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain('tracked changes');
  });
});

// Task 10 / R-D15: the results header's "ran against vN" line must
// distinguish never-recorded, resolved and DELETED — never render a version
// claim from `run.playbookVersionId`'s presence alone.
describe('ResultsView — the header names the version this run ran against (R-D15)', () => {
  function runWithVersionId(id: string | undefined): ReviewRun {
    const run = makeRun();
    return id === undefined ? run : { ...run, playbookVersionId: id };
  }

  it('says the version is not recorded when the run never had one', () => {
    const container = mount(
      <ResultsView run={runWithVersionId(undefined)} documents={[]} settings={settings} onRetryCell={() => {}} />,
    );
    expect(container.textContent).toMatch(/predates playbook versioning|does not record which version/i);
  });

  it('says which version once the caller has resolved it', () => {
    const version = makeTemplate();
    const container = mount(
      <ResultsView
        run={runWithVersionId('v1')}
        documents={[]}
        settings={settings}
        onRetryCell={() => {}}
        playbookVersion={version}
      />,
    );
    expect(container.textContent).toMatch(new RegExp(`ran against v${version.version}`, 'i'));
  });

  // Distinct from "not recorded" above, and the distinction is the point:
  // the trail went cold because the version was DELETED, not because it was
  // never written down.
  it('says the version was deleted when the id resolves to nothing', () => {
    const container = mount(
      <ResultsView
        run={runWithVersionId('v-gone')}
        documents={[]}
        settings={settings}
        onRetryCell={() => {}}
        playbookVersion={null}
      />,
    );
    expect(container.textContent).toMatch(/deleted|no longer exists/i);
    expect(container.textContent).not.toMatch(/ran against v/i);
  });

  // The id is present but the caller's lookup has not settled yet
  // (`playbookVersion` omitted, not `null`) — the header must stay silent
  // rather than guess "deleted" ahead of the real answer.
  it('says nothing yet while the caller has not resolved the id', () => {
    const container = mount(
      <ResultsView run={runWithVersionId('v1')} documents={[]} settings={settings} onRetryCell={() => {}} />,
    );
    expect(container.textContent).not.toMatch(/ran against v/i);
    expect(container.textContent).not.toMatch(/deleted|no longer exists/i);
    expect(container.textContent).not.toMatch(/predates playbook versioning|does not record which version/i);
  });

  it('opens version history when the resolved line is clicked', () => {
    const onShowVersionHistory = vi.fn();
    const version = makeTemplate();
    const container = mount(
      <ResultsView
        run={runWithVersionId('v1')}
        documents={[]}
        settings={settings}
        onRetryCell={() => {}}
        playbookVersion={version}
        onShowVersionHistory={onShowVersionHistory}
      />,
    );
    click(buttonNamed(container, new RegExp(`ran against v${version.version}`, 'i')));
    expect(onShowVersionHistory).toHaveBeenCalled();
  });
});
