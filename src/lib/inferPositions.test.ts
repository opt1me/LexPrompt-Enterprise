import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Settings } from '../types';
import type { ParsedEdit } from './docxRedlines';

// The module-mock idiom used elsewhere in this codebase (e.g.
// `suggestMissingClauses.test.ts`): `isAuthError` must stay real, since the
// point of propagating errors untouched is that it still recognises them.
vi.mock('./openrouter', async () => {
  const actual = await vi.importActual<typeof import('./openrouter')>('./openrouter');
  return { ...actual, chatJson: vi.fn() };
});
const { chatJson } = await import('./openrouter');
const { inferPositions } = await import('./inferPositions');

beforeEach(() => vi.clearAllMocks());

const settings: Settings = { apiKey: 'k', modelId: 'test/model', concurrency: 5 };

type EditEntry = { documentId: string; edit: ParsedEdit; source: 'tracked' | 'diff' };

/** A local factory, since the brief's `edit()`/`supporting()`/`opposing()`/
 *  `diffEdit()` helpers are never actually defined there. The string `id`
 *  argument names nothing on the produced object — `inferPositions` assigns
 *  its own stable ids (`e1`, `e2`, …) by array position — it is there only
 *  so a test reads as "this is the edit the model will call e1", matching
 *  the position of the entry in the array passed to `inferPositions`. */
function edit(id: string, documentId: string, source: 'tracked' | 'diff' = 'tracked'): EditEntry {
  return {
    documentId,
    edit: { kind: 'deletion', text: `text for ${id}`, context: `context for ${id}` },
    source,
  };
}

/** Semantically identical to `edit()` — whether an edit ends up supporting
 *  or opposing a proposed statement is decided by which of the model's two
 *  id arrays (`edit_ids` vs `opposing_edit_ids`) names it, not by anything
 *  on the edit itself. These aliases exist only so a test reads as intent. */
function supporting(id: string, documentId: string): EditEntry {
  return edit(id, documentId);
}
function opposing(id: string, documentId: string): EditEntry {
  return edit(id, documentId);
}
function diffEdit(id: string, documentId: string): EditEntry {
  return edit(id, documentId, 'diff');
}

function mockGroups(groups: unknown[]): void {
  vi.mocked(chatJson).mockResolvedValue({ groups });
}

describe('inferPositions', () => {
  it('NEVER produces a position from silence — an un-amended clause becomes a question', async () => {
    // Spec §11: "the one that would be easiest to get wrong and hardest to
    // notice". Every lease had a break clause; none was ever amended. That
    // is not "the firm accepts standard break clauses" — it is a question.
    mockGroups([]);
    const out = await inferPositions([], [{ title: 'Break', documentIds: ['a', 'b', 'c', 'd'] }], settings);
    expect(out.positions).toEqual([]);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].clauseTitle).toBe('Break');
    expect(out.questions[0].question).toMatch(/never amended|do you have a position/i);
  });

  it('ignores a strength the model volunteers and computes its own', async () => {
    // Letting the model count would let it be confidently wrong about "4 of
    // 4", the single number this feature's credibility rests on.
    mockGroups([
      {
        clause_title: 'Consent',
        statement: 'We strike absolute discretion.',
        edit_ids: ['e1'],
        strength: 'consistent',
      },
    ]);
    const out = await inferPositions([edit('e1', 'doc-a')], [], settings);
    expect(out.positions[0].strength).toBe('weak'); // one document, not consistent
    expect(out.positions[0].total).toBe(1);
  });

  it('counts supporting and total from the edits, not from the model', async () => {
    mockGroups([
      {
        clause_title: 'Consent',
        statement: 'x',
        edit_ids: ['e1', 'e2', 'e3'],
        supporting: 99,
        total: 99,
      },
    ]);
    const out = await inferPositions(
      [edit('e1', 'doc-a'), edit('e2', 'doc-b'), edit('e3', 'doc-c')],
      [],
      settings
    );
    expect(out.positions[0].total).toBe(3);
    expect(out.positions[0].supporting).toBe(3);
  });

  it('drops an edit id the model invented rather than trusting the group (R-F5)', async () => {
    mockGroups([{ clause_title: 'C', statement: 'x', edit_ids: ['e1', 'does-not-exist'] }]);
    const out = await inferPositions([edit('e1', 'doc-a')], [], settings);
    expect(out.positions[0].total).toBe(1);
  });

  it('drops a group entirely when every id it named was invented', async () => {
    // A group with zero real edits behind it is a position from silence
    // wearing a model's confident-sounding statement — never kept.
    mockGroups([{ clause_title: 'C', statement: 'x', edit_ids: ['nope', 'also-nope'] }]);
    const out = await inferPositions([edit('e1', 'doc-a')], [], settings);
    expect(out.positions).toEqual([]);
  });

  it('marks a position contradicted when its basis disagrees', async () => {
    mockGroups([{ clause_title: 'C', statement: 'x', edit_ids: ['e1'], opposing_edit_ids: ['e2'] }]);
    const out = await inferPositions([supporting('e1', 'a'), opposing('e2', 'b')], [], settings);
    expect(out.positions[0].contradicted).toBe(true);
  });

  it('flags a position resting only on diff-derived edits', async () => {
    mockGroups([{ clause_title: 'C', statement: 'x', edit_ids: ['e1'] }]);
    const out = await inferPositions([diffEdit('e1', 'a')], [], settings);
    expect(out.positions[0].diffDerivedOnly).toBe(true);
  });

  it('does not flag diffDerivedOnly when at least one supporting edit is tracked', async () => {
    mockGroups([{ clause_title: 'C', statement: 'x', edit_ids: ['e1', 'e2'] }]);
    const out = await inferPositions([diffEdit('e1', 'a'), edit('e2', 'b')], [], settings);
    expect(out.positions[0].diffDerivedOnly).toBe(false);
  });

  it('says so plainly when nothing could be inferred', async () => {
    mockGroups([]);
    const out = await inferPositions([edit('e1', 'a')], [], settings);
    expect(out.positions).toEqual([]);
    // The SCREEN says "the redlines did not settle anything we could state
    // as a position" (Task 6) — this function returning empty is the
    // honest input to that, not an error.
  });

  it('never calls the model when there are no edits to group', async () => {
    const out = await inferPositions([], [], settings);
    expect(out.positions).toEqual([]);
    expect(out.questions).toEqual([]);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('carries the full basis, including every edit from a document named twice', async () => {
    mockGroups([{ clause_title: 'C', statement: 'x', edit_ids: ['e1'], opposing_edit_ids: ['e2'] }]);
    const out = await inferPositions([supporting('e1', 'a'), opposing('e2', 'a')], [], settings);
    expect(out.positions[0].total).toBe(1); // one document, both edits
    expect(out.positions[0].basis[0].edits).toHaveLength(2);
    expect(out.positions[0].basis[0].supports).toBe(true); // supporting id processed first
  });
});
