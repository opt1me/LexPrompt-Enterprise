import { describe, it, expect } from 'vitest';
import {
  isDecided, isPublishable, publishedTextFor, provenanceFor, newClauseTitle,
  defaultExtractPrompt, applyItem, changeSummaryFor, nextVersionContent,
  type ChangesetItem, type ChangesetLike, type PlaybookClause,
} from '../src/playbook/applyChangeset.ts';

/**
 * The domain logic that decides what a published playbook version SAYS,
 * moved here from `src/lib/db/changesets.ts` because the API needs it too.
 *
 * These assertions came WITH the functions. Nothing here is new coverage;
 * what changed is that the same code is now the one both the browser and the
 * server run, so a change to it fails in one place instead of drifting
 * between two.
 */

const edit = (over: Record<string, unknown> = {}) => ({
  documentId: 'd1', kind: 'insertion' as const, text: 'e', context: 'e',
  source: 'tracked' as const, ...over,
});

const item = (over: Partial<ChangesetItem> = {}): ChangesetItem => ({
  id: 'i1', kind: 'drift', proposedText: 'The model s proposal.',
  rationale: 'Raised in this deal.', basis: [edit()], decision: 'open', ...over,
});

const changeset = (over: Partial<ChangesetLike> = {}): ChangesetLike => ({
  id: 'cs1', playbookId: 'p1', fromVersionId: 'v1',
  sourceSummary: 'Brookvale Retail Park — our markup + executed, Jul 2026',
  items: [], ...over,
});

const clause = (id: string, over: Partial<PlaybookClause> = {}): PlaybookClause => ({
  id, title: `Clause ${id}`, extractPrompt: `Extract ${id}.`, ...over,
});

let n = 0;
const mint = () => `minted-${++n}`;

describe('isDecided / isPublishable', () => {
  it('treats declined as decided, and as unpublishable', () => {
    // `'declined'` is exactly as decided as `'accepted'`; both are excluded
    // from a published version for different reasons.
    expect(isDecided(item({ decision: 'declined' }))).toBe(true);
    expect(isPublishable(item({ decision: 'declined' }))).toBe(false);
  });

  it('treats open as neither decided nor publishable', () => {
    expect(isDecided(item({ decision: 'open' }))).toBe(false);
    expect(isPublishable(item({ decision: 'open' }))).toBe(false);
  });

  it('publishes accepted and reworded, and nothing else', () => {
    expect(isPublishable(item({ decision: 'accepted' }))).toBe(true);
    expect(isPublishable(item({ decision: 'reworded' }))).toBe(true);
  });
});

describe('publishedTextFor', () => {
  it('publishes the HUMAN s rewording, never the model s proposal', () => {
    // Rewording is itself the decision; publishing the untouched proposal
    // would put words into the playbook that nobody actually approved.
    expect(publishedTextFor(item({ decision: 'reworded', rewordedText: 'mine' }))).toBe('mine');
  });

  it('falls back to the proposal when a reworded item somehow carries no text', () => {
    // Should not happen — the reword control always supplies one — but a
    // missing field is not license to publish nothing.
    expect(publishedTextFor(item({ decision: 'reworded' }))).toBe('The model s proposal.');
  });

  it('publishes the proposal for an accepted item', () => {
    expect(publishedTextFor(item({ decision: 'accepted', rewordedText: 'ignored' })))
      .toBe('The model s proposal.');
  });
});

describe('provenanceFor', () => {
  it('says whether a person reworded it, and names the deal', () => {
    expect(provenanceFor(changeset(), item({ decision: 'accepted' })))
      .toBe('Learned from Brookvale Retail Park — our markup + executed, Jul 2026; '
        + 'accepted by a person reviewing a changeset.');
    expect(provenanceFor(changeset(), item({ decision: 'reworded' })))
      .toContain('reworded and accepted by a person reviewing a changeset');
  });
});

describe('newClauseTitle', () => {
  it('prefers the item s own title', () => {
    expect(newClauseTitle(item({ title: 'Service charge' }))).toBe('Service charge');
  });

  it('falls back to the first basis edit s clauseRef for a record saved before that field', () => {
    expect(newClauseTitle(item({ basis: [edit({ clauseRef: 'Break' })] }))).toBe('Break');
  });

  it('THROWS rather than publishing a clause with no title', () => {
    // A clause in the firm's playbook with no name is a row nobody can read
    // or maintain; refusing is the loud failure.
    expect(() => newClauseTitle(item({ title: '   ' }))).toThrow(/no title/i);
  });
});

describe('defaultExtractPrompt', () => {
  it('is a visible placeholder, not a fabricated instruction', () => {
    // An empty or generic prompt is a gap someone can see and fill in, which
    // is honester than inventing a specific instruction a changeset never
    // reasoned about.
    expect(defaultExtractPrompt('Break')).toBe('Extract the clause on Break.');
  });
});

describe('applyItem', () => {
  it('replaces a matched clause s standardPosition, keeping its id and title', () => {
    const out = applyItem([clause('c1')], changeset(),
      item({ clauseId: 'c1', decision: 'accepted' }), mint);
    expect(out[0].id).toBe('c1');
    expect(out[0].title).toBe('Clause c1');
    expect(out[0].standardPosition).toEqual({
      text: 'The model s proposal.',
      origin: 'learned',
      reviewedByHuman: true,
      provenance: expect.stringContaining('Brookvale'),
    });
  });

  it('appends a new clause for an unmatched item, with a minted id', () => {
    const out = applyItem([clause('c1')], changeset(),
      item({ kind: 'new_clause', title: 'Service charge', decision: 'accepted' }), mint);
    expect(out).toHaveLength(2);
    expect(out[1].title).toBe('Service charge');
    expect(out[1].extractPrompt).toBe('Extract the clause on Service charge.');
    expect(out[1].id).toMatch(/^minted-/);
  });

  it('THROWS when the clause it names is no longer in the playbook', () => {
    expect(() => applyItem([clause('c1')], changeset(),
      item({ clauseId: 'gone', decision: 'accepted' }), mint))
      .toThrow(/no longer exists/i);
  });

  it('does not mutate the list it was given', () => {
    const clauses = [clause('c1')];
    applyItem(clauses, changeset(), item({ clauseId: 'c1', decision: 'accepted' }), mint);
    expect(clauses[0].standardPosition).toBeUndefined();
  });
});

describe('changeSummaryFor', () => {
  it('counts accepted and reworded separately, and names the deal', () => {
    expect(changeSummaryFor(changeset(), [
      item({ decision: 'accepted' }), item({ decision: 'accepted' }),
      item({ decision: 'reworded' }),
    ])).toBe('Changeset from Brookvale Retail Park — our markup + executed, Jul 2026 '
      + '— 2 accepted, 1 reworded.');
  });

  it('says so plainly when nothing was accepted, rather than leaving it blank', () => {
    // A version history whose entries do not say what changed is a list of
    // dates.
    expect(changeSummaryFor(changeset(), [])).toContain('no changes accepted');
  });
});

describe('nextVersionContent', () => {
  it('applies only the publishable items, carrying every other clause forward untouched', () => {
    const cs = changeset({ items: [
      item({ id: 'a', clauseId: 'c1', decision: 'accepted' }),
      item({ id: 'b', clauseId: 'c2', decision: 'declined',
        proposedText: 'Nobody approved this.' }),
      item({ id: 'c', clauseId: 'c3', decision: 'open' }),
    ] });
    const base = [clause('c1'), clause('c2'), clause('c3')];
    const { clauses, changeSummary } = nextVersionContent(cs, base, mint);
    expect(clauses[0].standardPosition!.text).toBe('The model s proposal.');
    // A person's explicit "no", and an item with no decision at all, both
    // leave the standing clause exactly as it was.
    expect(clauses[1]).toEqual(clause('c2'));
    expect(clauses[2]).toEqual(clause('c3'));
    expect(changeSummary).toContain('1 accepted');
  });

  it('deep-copies the base clauses, so publishing cannot rewrite the version it read', () => {
    // The version being published FROM is immutable; mutating its clause
    // objects in place would rewrite history through a shared reference.
    const base = [clause('c1')];
    nextVersionContent(changeset({ items: [item({ clauseId: 'c1', decision: 'accepted' })] }),
      base, mint);
    expect(base[0].standardPosition).toBeUndefined();
  });
});
