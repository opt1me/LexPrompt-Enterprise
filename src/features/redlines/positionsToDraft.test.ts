import { describe, it, expect } from 'vitest';
import {
  positionsToDraft,
  includedPositions,
  positionText,
  learnedFromNames,
} from './positionsToDraft';
import { canSaveDraft, toPlaybookDraft } from '../../lib/authoringDraft';
import type { InferredPosition } from '../../lib/inferPositions';

function position(overrides: Partial<InferredPosition> = {}): InferredPosition {
  return {
    id: 'p1',
    clauseTitle: 'Confidentiality period',
    statement: 'We strike an indefinite confidentiality tail in favour of a fixed term.',
    strength: 'consistent',
    supporting: 2,
    total: 2,
    basis: [
      { documentId: 'd1', supports: true, edits: [] },
      { documentId: 'd2', supports: true, edits: [] },
    ],
    contradicted: false,
    disposition: 'adopted',
    diffDerivedOnly: false,
    ...overrides,
  };
}

const NAMES = { d1: 'Brookvale - our markup.docx', d2: 'Ashfield - our markup.docx' };

describe('includedPositions', () => {
  it('carries adopted and reworded positions and nothing else', () => {
    const positions = [
      position({ id: 'a', disposition: 'adopted' }),
      position({ id: 'b', disposition: 'reworded', rewordedText: 'Five years, not indefinite.' }),
      position({ id: 'c', disposition: 'rejected' }),
      position({ id: 'd', disposition: 'undecided' }),
    ];
    expect(includedPositions(positions).map(p => p.id)).toEqual(['a', 'b']);
  });
});

describe('positionText', () => {
  it('publishes what the person wrote when they reworded it', () => {
    expect(positionText(position({
      disposition: 'reworded', rewordedText: 'Five years, not indefinite.',
    }))).toBe('Five years, not indefinite.');
  });

  it('publishes the adopted statement when they did not', () => {
    expect(positionText(position())).toBe(
      'We strike an indefinite confidentiality tail in favour of a fixed term.',
    );
  });

  // A blank house rule reads as a house rule until something looks at it —
  // the same guard `StandardPositionField` and `DraftReview` apply.
  it('falls back to the statement rather than publishing a blank reword', () => {
    expect(positionText(position({ disposition: 'reworded', rewordedText: '   ' }))).toBe(
      'We strike an indefinite confidentiality tail in favour of a fixed term.',
    );
  });
});

describe('learnedFromNames', () => {
  it('credits only the documents behind a SUPPORTING basis entry', () => {
    const names = learnedFromNames([position({
      basis: [
        { documentId: 'd1', supports: true, edits: [] },
        { documentId: 'd2', supports: false, edits: [] },
      ],
    })], NAMES);
    expect(names).toEqual(['Brookvale - our markup.docx']);
  });

  it('names each document once, however many positions it supports', () => {
    expect(learnedFromNames([position({ id: 'a' }), position({ id: 'b' })], NAMES)).toEqual([
      'Brookvale - our markup.docx', 'Ashfield - our markup.docx',
    ]);
  });
});

// A stand-in for what the person typed into `PrecedentIntake`'s "Playbook
// name" field — deliberately NOT the old `REDLINES_DRAFT_NAME` constant, so
// a test asserting this value comes back cannot pass by accident if the
// function silently reverted to hardcoding that string (R-F-fix-1's gap).
const CONTRACT_TYPE = 'Brookvale Lease (Landlord)';

describe('positionsToDraft', () => {
  it('makes every clause unreviewed, so E\'s save gate holds until a person reads it', () => {
    const draft = positionsToDraft([position()], NAMES, 'test/model', CONTRACT_TYPE);
    expect(draft.clauses).toHaveLength(1);
    expect(draft.clauses[0].disposition).toBe('unreviewed');
    // The whole point: a draft straight out of this function CANNOT be
    // saved. Only keeping the clause opens the gate.
    expect(canSaveDraft(draft)).toBe(false);
  });

  it('carries the position as a learned standard position, not an AI-drafted one', () => {
    const draft = positionsToDraft([position()], NAMES, 'test/model', CONTRACT_TYPE);
    const clause = draft.clauses[0];
    expect(clause.title).toBe('Confidentiality period');
    expect(clause.extractPrompt).toContain('Confidentiality period');
    expect(clause.standardPosition).toEqual({
      text: 'We strike an indefinite confidentiality tail in favour of a fixed term.',
      origin: 'learned',
      // Set at the moment of publish by `toPlaybookDraft`, not one screen
      // earlier by this function.
      reviewedByHuman: false,
    });
  });

  it('records a reword as a person having written the wording', () => {
    const draft = positionsToDraft(
      [position({ disposition: 'reworded', rewordedText: 'Five years, not indefinite.' })],
      NAMES,
      'test/model',
      CONTRACT_TYPE,
    );
    expect(draft.clauses[0].positionEdited).toBe(true);
    expect(draft.clauses[0].edited).toBe(true);
    expect(draft.clauses[0].standardPosition?.text).toBe('Five years, not indefinite.');
  });

  it('does not claim an adopted position was rewritten', () => {
    const draft = positionsToDraft([position()], NAMES, 'test/model', CONTRACT_TYPE);
    expect(draft.clauses[0].positionEdited).toBe(false);
    expect(draft.clauses[0].edited).toBe(false);
  });

  it('excludes a rejected position from the draft entirely', () => {
    const draft = positionsToDraft(
      [position({ id: 'a' }), position({ id: 'b', clauseTitle: 'Break clause', disposition: 'rejected' })],
      NAMES,
      'test/model',
      CONTRACT_TYPE,
    );
    expect(draft.clauses.map(c => c.title)).toEqual(['Confidentiality period']);
  });

  // R-F-fix-1's gap: this used to be `REDLINES_DRAFT_NAME` no matter what —
  // unusable the moment the flow ran twice, since nothing distinguished two
  // playbooks named identically. The name is now whatever the caller
  // supplies, taken verbatim and never substituted.
  it('names the playbook exactly what the caller supplies, never a constant', () => {
    expect(positionsToDraft([position()], NAMES, 'test/model', CONTRACT_TYPE).contractType).toBe(
      CONTRACT_TYPE,
    );
    expect(positionsToDraft([position()], NAMES, 'test/model', 'Something Else').contractType).toBe(
      'Something Else',
    );
  });

  // The end of the seam: what E's publish path actually writes.
  it('produces a v1 draft whose provenance names the documents that taught it', () => {
    const authoring = positionsToDraft([position()], NAMES, 'test/model', CONTRACT_TYPE);
    const kept = { ...authoring, clauses: authoring.clauses.map(c => ({ ...c, disposition: 'kept' as const })) };
    const published = toPlaybookDraft(kept, CONTRACT_TYPE);

    expect(published.clauses).toHaveLength(1);
    expect(published.clauses[0].standardPosition?.reviewedByHuman).toBe(true);
    expect(published.clauses[0].standardPosition?.provenance).toBe(
      'Learned from Brookvale - our markup.docx, Ashfield - our markup.docx; ' +
      'accepted unchanged by a person in the draft review.',
    );
  });
});

/**
 * The redline evidence carried into the draft (server spec §6.5).
 *
 * This is the seam where a session's in-memory `ParsedEdit`s become the
 * durable `position_basis` a partner reads next year. Two things it must get
 * right and one it must refuse.
 */
describe('positionsToDraft carries the basis a house rule will be evidenced by', () => {
  const EVIDENCE = {
    precedentSetId: 's1',
    documentSource: { d1: 'tracked' as const, d2: 'diff' as const },
  };
  const edit = (text: string) => ({
    kind: 'deletion' as const, text,
    context: `The landlord may withhold consent ${text}.`,
    author: 'A Partner',
  });
  const withEdits = () => position({
    basis: [
      { documentId: 'd1', supports: true, edits: [edit('in its absolute discretion')] },
      { documentId: 'd2', supports: true, edits: [edit('at its option')] },
    ],
  });

  it('records one entry per supporting document, with its edits and its source', () => {
    const draft = positionsToDraft([withEdits()], NAMES, 'test/model', CONTRACT_TYPE, EVIDENCE);
    const basis = draft.clauses[0].basis!;
    expect(basis.map(b => b.documentId)).toEqual(['d1', 'd2']);
    expect(basis[0].precedentSetId).toBe('s1');
    expect(basis[0].edits[0].text).toBe('in its absolute discretion');
    expect(basis[0].edits[0].author).toBe('A Partner');
    // Per DOCUMENT, from the session's own record of how each was read. A
    // diff never wears a tracked change's confidence, and this is the last
    // point at which the distinction is still in hand.
    expect(basis[0].edits[0].source).toBe('tracked');
    expect(basis[1].edits[0].source).toBe('diff');
  });

  it('records only SUPPORTING documents, never the ones that opposed', () => {
    // This becomes the answer to "where did this house rule come from?", and
    // an opposing document listed among a rule's evidence would read as
    // having supported it.
    const p = position({
      basis: [
        { documentId: 'd1', supports: true, edits: [edit('in its absolute discretion')] },
        { documentId: 'd2', supports: false, edits: [edit('at its option')] },
      ],
    });
    const draft = positionsToDraft([p], NAMES, 'test/model', CONTRACT_TYPE, EVIDENCE);
    expect(draft.clauses[0].basis!.map(b => b.documentId)).toEqual(['d1']);
  });

  it('carries diffDerivedOnly from the POSITION, never recomputed here', () => {
    // `inferPositions.ts` computes it; a second implementation here would be
    // the sibling drift this project has paid for six times, on the flag
    // that keeps weaker evidence weaker.
    const draft = positionsToDraft(
      [{ ...withEdits(), diffDerivedOnly: true }], NAMES, 'test/model', CONTRACT_TYPE, EVIDENCE);
    expect(draft.clauses[0].basis!.every(b => b.diffDerivedOnly)).toBe(true);
  });

  it('records NOTHING — absent, not empty — when the session stored no documents', () => {
    const draft = positionsToDraft([withEdits()], NAMES, 'test/model', CONTRACT_TYPE);
    expect('basis' in draft.clauses[0]).toBe(false);
  });

  it('records nothing for a position with no supporting edits at all', () => {
    // An empty array would claim evidence was gathered and was empty —
    // "silence wearing a position's clothes", one layer along.
    const p = position({ basis: [{ documentId: 'd1', supports: true, edits: [] }] });
    expect('basis' in positionsToDraft([p], NAMES, 'test/model', CONTRACT_TYPE, EVIDENCE).clauses[0])
      .toBe(false);
  });

  it('carries no strength, supporting count or total into the draft', () => {
    // `strength.ts` computes those from a basis every time it is read. A
    // copy carried here would be a second, frozen answer to the one number
    // this feature's credibility rests on.
    const draft = positionsToDraft([withEdits()], NAMES, 'test/model', CONTRACT_TYPE, EVIDENCE);
    const keys = Object.keys(draft.clauses[0].basis![0]);
    expect(keys).not.toContain('strength');
    expect(keys).not.toContain('supporting');
    expect(keys).not.toContain('total');
    expect(keys).toContain('edits');
  });

  it('keeps the basis OUT of the published playbook content', () => {
    // A `PlaybookClause` is what gets persisted as the version's own jsonb.
    // The evidence belongs in `position_basis`; a second copy inside an
    // IMMUTABLE version would be the one that could never be corrected.
    const authoring = positionsToDraft(
      [withEdits()], NAMES, 'test/model', CONTRACT_TYPE, EVIDENCE);
    const kept = {
      ...authoring,
      clauses: authoring.clauses.map(c => ({ ...c, disposition: 'kept' as const })),
    };
    const published = toPlaybookDraft(kept, CONTRACT_TYPE);
    expect('basis' in published.clauses[0]).toBe(false);
    expect(JSON.stringify(published)).not.toContain('absolute discretion');
  });
});
