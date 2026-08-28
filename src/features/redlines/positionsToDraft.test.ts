import { describe, it, expect } from 'vitest';
import {
  positionsToDraft,
  includedPositions,
  positionText,
  learnedFromNames,
  REDLINES_DRAFT_NAME,
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

describe('positionsToDraft', () => {
  it('makes every clause unreviewed, so E\'s save gate holds until a person reads it', () => {
    const draft = positionsToDraft([position()], NAMES, 'test/model');
    expect(draft.clauses).toHaveLength(1);
    expect(draft.clauses[0].disposition).toBe('unreviewed');
    // The whole point: a draft straight out of this function CANNOT be
    // saved. Only keeping the clause opens the gate.
    expect(canSaveDraft(draft)).toBe(false);
  });

  it('carries the position as a learned standard position, not an AI-drafted one', () => {
    const draft = positionsToDraft([position()], NAMES, 'test/model');
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
    );
    expect(draft.clauses[0].positionEdited).toBe(true);
    expect(draft.clauses[0].edited).toBe(true);
    expect(draft.clauses[0].standardPosition?.text).toBe('Five years, not indefinite.');
  });

  it('does not claim an adopted position was rewritten', () => {
    const draft = positionsToDraft([position()], NAMES, 'test/model');
    expect(draft.clauses[0].positionEdited).toBe(false);
    expect(draft.clauses[0].edited).toBe(false);
  });

  it('excludes a rejected position from the draft entirely', () => {
    const draft = positionsToDraft(
      [position({ id: 'a' }), position({ id: 'b', clauseTitle: 'Break clause', disposition: 'rejected' })],
      NAMES,
      'test/model',
    );
    expect(draft.clauses.map(c => c.title)).toEqual(['Confidentiality period']);
  });

  it('names the playbook after where it came from', () => {
    expect(positionsToDraft([position()], NAMES, 'test/model').contractType).toBe(REDLINES_DRAFT_NAME);
  });

  // The end of the seam: what E's publish path actually writes.
  it('produces a v1 draft whose provenance names the documents that taught it', () => {
    const authoring = positionsToDraft([position()], NAMES, 'test/model');
    const kept = { ...authoring, clauses: authoring.clauses.map(c => ({ ...c, disposition: 'kept' as const })) };
    const published = toPlaybookDraft(kept, REDLINES_DRAFT_NAME);

    expect(published.clauses).toHaveLength(1);
    expect(published.clauses[0].standardPosition?.reviewedByHuman).toBe(true);
    expect(published.clauses[0].standardPosition?.provenance).toBe(
      'Learned from Brookvale - our markup.docx, Ashfield - our markup.docx; ' +
      'accepted unchanged by a person in the draft review.',
    );
  });
});
