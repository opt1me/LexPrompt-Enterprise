import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click, buttonNamed } from '../../test/mount';
import { WhatWeLearned, consistentPositions } from './WhatWeLearned';
import type { InferredPosition, OpenQuestion } from '../../lib/inferPositions';
import type { ParsedEdit } from '../../lib/docxRedlines';

function edit(overrides: Partial<ParsedEdit> = {}): ParsedEdit {
  return {
    kind: 'deletion',
    text: "withheld at the Landlord's absolute discretion",
    context: "Consent may be withheld at the Landlord's absolute discretion.",
    ...overrides,
  };
}

const consistentPos: InferredPosition = {
  id: 'p-consistent',
  clauseTitle: 'Consent to assign',
  statement: "We strike the landlord's absolute discretion over consent.",
  strength: 'consistent',
  supporting: 4,
  total: 4,
  basis: [
    { documentId: 'd1', supports: true, edits: [edit()] },
    { documentId: 'd2', supports: true, edits: [edit()] },
    { documentId: 'd3', supports: true, edits: [edit()] },
    { documentId: 'd4', supports: true, edits: [edit()] },
  ],
  contradicted: false,
  disposition: 'undecided',
  diffDerivedOnly: false,
};

const mixedPos: InferredPosition = {
  ...consistentPos,
  id: 'p-mixed',
  clauseTitle: 'Break clause penalty',
  strength: 'mixed',
  supporting: 3,
  total: 4,
  basis: [
    { documentId: 'd1', supports: true, edits: [edit()] },
    { documentId: 'd2', supports: true, edits: [edit()] },
    { documentId: 'd3', supports: true, edits: [edit()] },
    { documentId: 'd4', supports: false, edits: [edit()] },
  ],
  contradicted: true,
};

const weakPos: InferredPosition = {
  ...consistentPos,
  id: 'p-weak',
  clauseTitle: 'Costs indemnity',
  strength: 'weak',
  supporting: 1,
  total: 1,
  basis: [{ documentId: 'd1', supports: true, edits: [edit()] }],
  contradicted: false,
};

const contradictedPos: InferredPosition = {
  ...mixedPos,
  id: 'p-contradicted',
};

const breakQuestion: OpenQuestion = {
  id: 'q1',
  clauseTitle: 'Break clause',
  question:
    'This clause was never amended across 4 documents — do you have a position on it, or is this an open ' +
    'question the redlines never settled?',
};

function baseProps(overrides: Partial<React.ComponentProps<typeof WhatWeLearned>> = {}) {
  return {
    positions: [],
    questions: [],
    onAdopt: vi.fn(),
    onReword: vi.fn(),
    onReject: vi.fn(),
    onSeeWorkings: vi.fn(),
    onBulkAccept: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onSkipQuestion: vi.fn(),
    ...overrides,
  };
}

describe('WhatWeLearned', () => {
  it('shows the observations banner close to the handoff wording', () => {
    const el = mount(<WhatWeLearned {...baseProps()} />);
    expect(el.textContent).toMatch(/observations about what you did, not advice/i);
  });

  it('offers Accept all consistent, and ONLY for consistent positions', () => {
    const onBulkAccept = vi.fn();
    const el = mount(
      <WhatWeLearned {...baseProps({ positions: [consistentPos, mixedPos, weakPos], onBulkAccept })} />,
    );
    click(buttonNamed(el, /accept all consistent/i));
    expect(onBulkAccept).toHaveBeenCalledTimes(1);
    expect(onBulkAccept.mock.calls[0][0].map((p: InferredPosition) => p.id)).toEqual([consistentPos.id]);
  });

  it('says plainly when nothing could be inferred, rather than showing an empty screen', () => {
    const el = mount(<WhatWeLearned {...baseProps({ positions: [], questions: [] })} />);
    expect(el.textContent).toMatch(/did not settle anything/i);
  });

  it('renders an open question as a question, never as an adoptable position', () => {
    const el = mount(<WhatWeLearned {...baseProps({ positions: [], questions: [breakQuestion] })} />);
    expect(el.textContent).toContain(breakQuestion.question);
    expect(buttonNamed(el, /adopt/i)).toBeUndefined();
  });

  it('shows a contradiction callout and does not resolve it', () => {
    const el = mount(<WhatWeLearned {...baseProps({ positions: [contradictedPos] })} />);
    expect(el.textContent).toMatch(/redlines disagree/i);
    // Not resolved: the app still leaves the actions to a person.
    expect(buttonNamed(el, /adopt/i)).toBeTruthy();
    expect(buttonNamed(el, /not a house rule/i)).toBeTruthy();
  });

  it("a weak position never wears a consistent one's clothes", () => {
    const el = mount(<WhatWeLearned {...baseProps({ positions: [weakPos] })} />);
    expect(el.textContent).toMatch(/weak|single instance/i);
    expect(el.textContent).not.toMatch(/consistent — 1 of 1/i);
  });

  it('never offers a bulk-accept control when there are no consistent positions', () => {
    const el = mount(<WhatWeLearned {...baseProps({ positions: [mixedPos, weakPos] })} />);
    expect(buttonNamed(el, /accept all consistent/i)).toBeUndefined();
  });
});

describe('consistentPositions (bulk-accept filter, mutation-tested)', () => {
  it('keeps only strength === "consistent"', () => {
    expect(consistentPositions([consistentPos, mixedPos, weakPos])).toEqual([consistentPos]);
  });

  it('returns nothing when there is no consistent position at all', () => {
    expect(consistentPositions([mixedPos, weakPos])).toEqual([]);
  });

  it('returns every position when all are consistent', () => {
    const secondConsistent = { ...consistentPos, id: 'p-consistent-2' };
    expect(consistentPositions([consistentPos, secondConsistent])).toEqual([consistentPos, secondConsistent]);
  });
});
