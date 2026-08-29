import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import type { Changeset, ChangesetItem, PlaybookVersion } from '../../types';

/**
 * The changesets repository, now a TRANSPORT — and the file where this
 * task's real subject is asserted: **the CODE is the contract, the message
 * is not.**
 *
 * Everything this file used to assert about PUBLISHING — which items reach
 * the version, whose words they carry, that a declined item leaves a
 * standing position untouched, that a refused publish loses no decision —
 * moved to `apps/api/test/changesets.pg.test.ts`, where the real route
 * publishes through a real Postgres in one transaction. The domain logic
 * underneath it moved to `packages/core/src/playbook/applyChangeset.ts` and
 * is exercised by `packages/core/test/applyChangeset.test.ts`, so those
 * assertions did not become weaker by moving; they became shared.
 *
 * What stays here is which request each export makes, and the reconstruction
 * of `ChangesetStaleBaseError` from the wire.
 */

const transport = makeFakeTransport();
vi.mock('../api/client', () => transportModule(transport));

const {
  saveChangeset, getChangeset, listChangesets, recordDecision, publishChangeset,
  ChangesetStaleBaseError,
} = await import('./changesets');

const item = (id: string, decision: ChangesetItem['decision'],
  over: Partial<ChangesetItem> = {}): ChangesetItem => ({
  id, kind: 'drift', clauseId: `c-${id}`,
  proposedText: 'A proposal.', rationale: 'Raised in this deal.',
  basis: [{ documentId: 'd1', kind: 'insertion', text: 'e', context: 'e', source: 'tracked' }],
  decision, ...over,
});

const CHANGESET: Changeset = {
  id: 'cs1', playbookId: 'p1', fromVersionId: 'v1',
  sourceSummary: 'Brookvale Retail Park — our markup + executed, Jul 2026',
  items: [item('a', 'open')],
  createdAt: 1_700_000_000_000, createdByUserId: 'u1', version: 3,
};

const VERSION = { id: 'v2', playbookId: 'p1', version: 2 } as unknown as PlaybookVersion;

beforeEach(() => transport.reset());

describe('the requests each export makes', () => {
  it('lists a playbook s changesets from /v1/playbooks/:id/changesets', async () => {
    transport.responses.set('/v1/playbooks/p1/changesets', [CHANGESET]);
    expect((await listChangesets('p1')).map(c => c.id)).toEqual(['cs1']);
  });

  it('reads one from /v1/changesets/:id', async () => {
    transport.responses.set('/v1/changesets/cs1', CHANGESET);
    expect(await getChangeset('cs1')).toEqual(CHANGESET);
  });

  it('PUTs the whole record and returns what the server saved', async () => {
    const saved = { ...CHANGESET, version: 4 };
    transport.responses.set('/v1/changesets/cs1', saved);
    expect(await saveChangeset(CHANGESET)).toEqual(saved);
    expect(transport.sent[0].method).toBe('PUT');
    expect((transport.sent[0].body as Changeset).version).toBe(3);
  });

  it('POSTs a publish to /v1/changesets/:id/publish and sends no attribution', async () => {
    // A caller's claim about who published something is not evidence of who
    // did; `byUserId` stays in the signature only so no caller changed.
    transport.responses.set('/v1/changesets/cs1/publish', VERSION);
    expect(await publishChangeset(CHANGESET, 'somebody-else')).toEqual(VERSION);
    expect(transport.sent[0].path).toBe('/v1/changesets/cs1/publish');
    expect(JSON.stringify(transport.sent[0].body)).not.toContain('somebody-else');
  });

  it('escapes an id in every path it builds', async () => {
    const id = 'a/b c?d';
    const enc = 'a%2Fb%20c%3Fd';
    transport.responses.set(`/v1/changesets/${enc}`, CHANGESET);
    transport.responses.set(`/v1/changesets/${enc}/publish`, VERSION);
    await getChangeset(id);
    await saveChangeset({ ...CHANGESET, id });
    await publishChangeset({ ...CHANGESET, id }, 'u1');
    expect(transport.sent.map(s => s.path))
      .toEqual([`/v1/changesets/${enc}`, `/v1/changesets/${enc}/publish`]);
    transport.responses.set(`/v1/playbooks/${enc}/changesets`, []);
    expect(await listChangesets(id)).toEqual([]);
  });
});

describe('recordDecision', () => {
  it('stamps the decision on one item and leaves the rest alone', async () => {
    const cs = { ...CHANGESET, items: [item('a', 'open'), item('b', 'open')] };
    transport.responses.set('/v1/changesets/cs1', cs);
    await recordDecision(cs, 'a', 'accepted');
    const sent = transport.sent[0].body as Changeset;
    expect(sent.items.map(i => i.decision)).toEqual(['accepted', 'open']);
  });

  it('carries rewordedText only for a reword, and DELETES it otherwise', async () => {
    // `structuredClone` preserves a `key: undefined` and JSON drops one —
    // two halves of the same trap. An item accepted after once being
    // reworded must not still carry stale reword text a reader could mistake
    // for what was actually decided.
    const reworded = { ...CHANGESET, items: [item('a', 'reworded', { rewordedText: 'mine' })] };
    transport.responses.set('/v1/changesets/cs1', reworded);
    await recordDecision(reworded, 'a', 'accepted');
    const sent = transport.sent[0].body as Changeset;
    expect('rewordedText' in sent.items[0]).toBe(false);
  });

  it('stamps rewordedText when the decision IS a reword', async () => {
    transport.responses.set('/v1/changesets/cs1', CHANGESET);
    await recordDecision(CHANGESET, 'a', 'reworded', 'the words a person wrote');
    const sent = transport.sent[0].body as Changeset;
    expect(sent.items[0].rewordedText).toBe('the words a person wrote');
  });

  it('propagates a conflict rather than reporting the decision as recorded', async () => {
    // Await-then-apply: the screen must not show a decision as recorded
    // until the store has confirmed it.
    const stale = new ModelError('This was changed since you opened it.', 'conflict', 409);
    transport.failures.set('/v1/changesets/cs1', stale);
    await expect(recordDecision(CHANGESET, 'a', 'accepted')).rejects.toBe(stale);
  });
});

describe('the stale-base refusal crosses the wire as a CODE', () => {
  const refusal = (message: string) =>
    new ModelError(message, 'changeset_stale_base', 409);

  it('reconstructs ChangesetStaleBaseError from the wire CODE, not from the message', async () => {
    transport.failures.set('/v1/changesets/cs1/publish',
      refusal('This changeset was built against v1, and the playbook is now on v2.'));
    await expect(publishChangeset(CHANGESET, 'u1'))
      .rejects.toBeInstanceOf(ChangesetStaleBaseError);
  });

  it('does NOT match on wording — a reworded message still classifies', async () => {
    // THE POINT. An exception's identity dies at the wire, so either the
    // browser matches on the server's exact words — ruling S1's defect, where
    // "reword any one and the browser silently stops classifying: no error,
    // no failing test" — or the code is the contract. It is the code.
    transport.failures.set('/v1/changesets/cs1/publish', refusal('totally different words'));
    await expect(publishChangeset(CHANGESET, 'u1'))
      .rejects.toBeInstanceOf(ChangesetStaleBaseError);
  });

  it('keeps its own sentence as `message` and the server s as `serverMessage`', async () => {
    // A caller rendering `err.message` shows what it always showed; the
    // server's words — which name both version numbers — are available
    // beside it rather than instead of it.
    transport.failures.set('/v1/changesets/cs1/publish',
      refusal('This changeset was built against v1, and the playbook is now on v4.'));
    const err = await publishChangeset(CHANGESET, 'u1')
      .then(() => undefined, (e: unknown) => e as InstanceType<typeof ChangesetStaleBaseError>);
    expect(err).toBeInstanceOf(ChangesetStaleBaseError);
    expect(err!.message).toMatch(/moved on since this changeset was built/);
    expect(err!.serverMessage).toMatch(/v1.*v4/);
  });

  it('a different 409 is NOT a stale base', async () => {
    const err = await (async () => {
      transport.failures.set('/v1/changesets/cs1/publish',
        new ModelError('stale write', 'conflict', 409));
      return publishChangeset(CHANGESET, 'u1').catch((e: unknown) => e);
    })();
    expect(err).not.toBeInstanceOf(ChangesetStaleBaseError);
    expect(err).toBeInstanceOf(ModelError);
  });

  it('an undecided-items refusal is NOT a stale base either', async () => {
    transport.failures.set('/v1/changesets/cs1/publish',
      new ModelError('This changeset still has undecided items.', 'conflict', 400));
    const err = await publishChangeset(CHANGESET, 'u1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChangesetStaleBaseError);
  });

  it('propagates a 500 rather than reporting a version that does not exist', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/changesets/cs1/publish', boom);
    await expect(publishChangeset(CHANGESET, 'u1')).rejects.toBe(boom);
  });
});

describe('a failure is a failure, never an empty result', () => {
  it('returns null for a changeset the server does not have', async () => {
    expect(await getChangeset('nope')).toBeNull();
  });

  it('propagates a 500 from a read rather than swallowing it into null', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/changesets/cs1', boom);
    await expect(getChangeset('cs1')).rejects.toBe(boom);
  });

  it('propagates a 500 from the list rather than answering with no changesets', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/playbooks/p1/changesets', boom);
    await expect(listChangesets('p1')).rejects.toBe(boom);
  });
});
