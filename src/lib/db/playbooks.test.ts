import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import { SCHEMA_VERSION, type Playbook, type PlaybookDraft, type PlaybookVersion } from '../../types';

/**
 * The playbooks repository, now a TRANSPORT.
 *
 * The storage half of this file moved to `apps/api/test/playbooks.pg.test.ts`
 * — the `_seq` tiebreak, the sort, the delete cascade, and above all the ONE
 * TRANSACTION behind `publishAndPoint`, which a real Postgres can prove and
 * a fake IndexedDB could only imitate. The pure helpers below
 * (`newPlaybook`, `newPlaybookDraft`, `draftFromVersion`, `exportPlaybook`)
 * are kept VERBATIM: they mint or transform values the browser already
 * holds, and their needing no edit is the evidence R3's seam held for them.
 *
 * What stays here is which request each export makes, the JSON parsing and
 * repair `importPlaybook` still does in the browser, and — the one that
 * matters — that a failure stays a failure. A `getPlaybookContent` answering
 * `null` over a 500 sends the editor to a blank draft whose next Save would
 * publish empty content over a real playbook.
 */

const transport = makeFakeTransport();
vi.mock('../api/client', () => transportModule(transport));

const {
  newPlaybook, newPlaybookDraft, draftFromVersion, listPlaybooks, getPlaybook,
  getPlaybookContent, savePlaybook, publishAndPoint, saveDraft, discardDraft,
  deletePlaybook, exportPlaybook, importPlaybook,
} = await import('./playbooks');

const PLAYBOOK: Playbook = {
  id: 'p1', name: 'Commercial Lease — Tenant', createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000, schemaVersion: SCHEMA_VERSION, version: 3,
};

const DRAFT: PlaybookDraft = {
  name: 'Commercial Lease — Tenant', contractType: 'Lease',
  systemPrompt: 'Be careful.', formatPrompt: 'Quote verbatim.',
  clauses: [{ id: 'c1', title: 'Break', extractPrompt: 'What is the break right?' }],
  changeSummary: '',
};

const VERSION: PlaybookVersion = {
  ...DRAFT, id: 'v1', playbookId: 'p1', version: 1,
  publishedAt: 1_700_000_000_000, publishedByUserId: 'u1', schemaVersion: SCHEMA_VERSION,
};

beforeEach(() => transport.reset());

describe('the pure helpers, unchanged by the storage swap', () => {
  it('newPlaybook mints an identity with no content and no version token', () => {
    const p = newPlaybook('NDA');
    expect(p.name).toBe('NDA');
    expect(p.id).toBeTruthy();
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    expect('currentVersionId' in p).toBe(false);
    expect('draft' in p).toBe(false);
    // The absence is the claim "I believe this is a create".
    expect('version' in p).toBe(false);
  });

  it('newPlaybookDraft starts with no clauses and no change summary', () => {
    const d = newPlaybookDraft('NDA');
    expect(d.clauses).toEqual([]);
    expect(d.changeSummary).toBe('');
    expect(d.contractType).toBe('Custom');
  });

  it('draftFromVersion drops the change summary and deep-copies the clauses', () => {
    // `changeSummary` describes what the version being copied changed;
    // reusing it would label the next version with the previous one's reason.
    const d = draftFromVersion(VERSION);
    expect(d.changeSummary).toBe('');
    expect(d.clauses).toEqual(VERSION.clauses);
    expect(d.clauses).not.toBe(VERSION.clauses);
    d.clauses[0].title = 'Edited';
    expect(VERSION.clauses[0].title).toBe('Break');
  });

  it('draftFromVersion keeps riskTolerance absent when the version has none', () => {
    // `riskBlock.ts` gates the risk block on PRESENCE, so a key present with
    // an undefined value is a different fact from no key.
    expect('riskTolerance' in draftFromVersion(VERSION)).toBe(false);
    expect(draftFromVersion({ ...VERSION, riskTolerance: 'Low' }).riskTolerance).toBe('Low');
  });

  it('exportPlaybook builds a JSON blob from content the browser already has', async () => {
    // Deliberately NOT a round trip: sending content to a server to have it
    // sent straight back would be a network call for nothing.
    const blob = exportPlaybook(DRAFT);
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(DRAFT);
  });
});

describe('the requests each export makes', () => {
  it('lists from /v1/playbooks in the server s order', async () => {
    transport.responses.set('/v1/playbooks', [{ ...PLAYBOOK, id: 'b' }, { ...PLAYBOOK, id: 'a' }]);
    expect((await listPlaybooks()).map(p => p.id)).toEqual(['b', 'a']);
  });

  it('reads one from /v1/playbooks/:id', async () => {
    transport.responses.set('/v1/playbooks/p1', PLAYBOOK);
    expect((await getPlaybook('p1'))!.id).toBe('p1');
  });

  it('reads content from /v1/playbooks/:id/content', async () => {
    transport.responses.set('/v1/playbooks/p1/content', VERSION);
    expect(await getPlaybookContent('p1')).toEqual(VERSION);
  });

  it('PUTs the whole identity and returns what the server saved', async () => {
    const saved = { ...PLAYBOOK, name: 'Renamed', version: 4 };
    transport.responses.set('/v1/playbooks/p1', saved);
    expect(await savePlaybook({ ...PLAYBOOK, name: 'Renamed' })).toEqual(saved);
    expect(transport.sent[0].method).toBe('PUT');
    expect((transport.sent[0].body as Playbook).version).toBe(3);
  });

  it('saveDraft PUTs the identity with the draft embedded', async () => {
    // §6.1: a draft is edited as one document, and splitting it invents a
    // merge problem that does not exist.
    transport.responses.set('/v1/playbooks/p1', { ...PLAYBOOK, draft: DRAFT });
    const saved = await saveDraft(PLAYBOOK, DRAFT);
    expect((transport.sent[0].body as Playbook).draft).toEqual(DRAFT);
    expect(saved.draft).toEqual(DRAFT);
  });

  it('publishAndPoint POSTs the identity AND the draft together', async () => {
    // Both, in one request, because the server publishes and points in one
    // transaction — and because the identity may not exist yet.
    transport.responses.set('/v1/playbooks/p1/versions',
      { playbook: { ...PLAYBOOK, currentVersionId: 'v1' }, version: VERSION });
    const out = await publishAndPoint(PLAYBOOK, DRAFT, 'u1');
    expect(transport.sent[0].method).toBe('POST');
    expect(transport.sent[0].path).toBe('/v1/playbooks/p1/versions');
    expect(transport.sent[0].body).toEqual({ playbook: PLAYBOOK, draft: DRAFT });
    expect(out.version).toEqual(VERSION);
    expect(out.playbook.currentVersionId).toBe('v1');
  });

  it('publishAndPoint sends NO attribution, because the server takes it from the token', async () => {
    // A caller's claim about who published something is not evidence of who
    // did, and `byUserId` stays in the signature only so no caller changed.
    transport.responses.set('/v1/playbooks/p1/versions',
      { playbook: PLAYBOOK, version: VERSION });
    await publishAndPoint(PLAYBOOK, DRAFT, 'somebody-else');
    expect(JSON.stringify(transport.sent[0].body)).not.toContain('somebody-else');
  });

  it('discardDraft DELETEs the draft alone, sending no record back', async () => {
    // One statement naming one column. Reading the playbook and PUTting it
    // back would rebuild the read-then-write race that once reverted
    // `currentVersionId` and orphaned a just-published version — across a
    // network, where the window is far wider.
    transport.responses.set('/v1/playbooks/p1/draft', {});
    await discardDraft('p1');
    expect(transport.deleted).toEqual(['/v1/playbooks/p1/draft']);
    expect(transport.sent).toEqual([]);
  });

  it('DELETEs a playbook at /v1/playbooks/:id', async () => {
    transport.responses.set('/v1/playbooks/p1', PLAYBOOK);
    await deletePlaybook('p1');
    expect(transport.deleted).toEqual(['/v1/playbooks/p1']);
  });

  it('escapes an id in every path segment it builds', async () => {
    const id = 'a/b c?d';
    const enc = 'a%2Fb%20c%3Fd';
    transport.responses.set(`/v1/playbooks/${enc}`, { ...PLAYBOOK, id });
    transport.responses.set(`/v1/playbooks/${enc}/content`, VERSION);
    transport.responses.set(`/v1/playbooks/${enc}/versions`,
      { playbook: PLAYBOOK, version: VERSION });
    transport.responses.set(`/v1/playbooks/${enc}/draft`, {});
    await getPlaybook(id);
    await getPlaybookContent(id);
    await savePlaybook({ ...PLAYBOOK, id });
    await publishAndPoint({ ...PLAYBOOK, id }, DRAFT, 'u1');
    await discardDraft(id);
    expect(transport.sent.map(s => s.path)).toEqual([
      `/v1/playbooks/${enc}`, `/v1/playbooks/${enc}/versions`,
    ]);
    expect(transport.deleted).toEqual([`/v1/playbooks/${enc}/draft`]);
  });
});

describe('importPlaybook', () => {
  it('parses and repairs the file in the BROWSER, then publishes it as one request', async () => {
    transport.responses.set('/v1/playbooks/import', { playbook: PLAYBOOK, version: VERSION });
    const out = await importPlaybook(JSON.stringify(DRAFT));
    expect(transport.sent[0].path).toBe('/v1/playbooks/import');
    const body = transport.sent[0].body as { playbook: Playbook; draft: PlaybookDraft };
    expect(body.draft.clauses).toEqual(DRAFT.clauses);
    // A FRESH id, so importing a playbook you already have does not
    // overwrite it.
    expect(body.playbook.id).not.toBe('p1');
    expect('version' in body.playbook).toBe(false);
    expect(out.version).toEqual(VERSION);
  });

  it('refuses a file that is not JSON, without sending anything', async () => {
    await expect(importPlaybook('{not json')).rejects.toThrow(/not valid JSON/);
    expect(transport.sent).toEqual([]);
  });

  it('refuses a file with no clauses, without sending anything', async () => {
    await expect(importPlaybook('{"name":"X"}')).rejects.toThrow(/no clauses/);
    expect(transport.sent).toEqual([]);
  });

  it('sends no attribution, because a file was written by whoever wrote it (P16)', async () => {
    transport.responses.set('/v1/playbooks/import', { playbook: PLAYBOOK, version: VERSION });
    await importPlaybook(JSON.stringify(DRAFT), 'somebody');
    expect(JSON.stringify(transport.sent[0].body)).not.toContain('somebody');
  });
});

describe('a failure is a failure, never an empty result', () => {
  it('returns null for a playbook the server does not have', async () => {
    expect(await getPlaybook('nope')).toBeNull();
  });

  it('returns null for a playbook with nothing published yet', async () => {
    // Distinguishable from an EMPTY version, which is a 200 carrying a
    // version with no clauses: a caller about to run a review has to be able
    // to tell those apart.
    expect(await getPlaybookContent('p1')).toBeNull();
    transport.responses.set('/v1/playbooks/p1/content', { ...VERSION, clauses: [] });
    expect((await getPlaybookContent('p1'))!.clauses).toEqual([]);
  });

  it('propagates a 500 from getPlaybookContent rather than answering null', async () => {
    // THE ONE THAT MATTERS HERE. `null` sends the editor to a blank draft,
    // and its next Save would publish empty content over a real playbook —
    // M3's defect at the new transport.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/playbooks/p1/content', boom);
    await expect(getPlaybookContent('p1')).rejects.toBe(boom);
  });

  it('propagates a 500 from the list rather than rendering an empty library', async () => {
    // "A failed storage migration rendering an empty library, indistinguishable
    // from a fresh install" is on CLAUDE.md's own list of shipped defects.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/playbooks', boom);
    await expect(listPlaybooks()).rejects.toBe(boom);
  });

  it('propagates a conflict from a save rather than reporting it as written', async () => {
    const stale = new ModelError('This was changed since you opened it.', 'conflict', 409);
    transport.failures.set('/v1/playbooks/p1', stale);
    await expect(savePlaybook(PLAYBOOK)).rejects.toBe(stale);
  });

  it('propagates a refused publish rather than reporting a version that does not exist', async () => {
    const refused = new ModelError('A new version needs a note.', 'conflict', 400);
    transport.failures.set('/v1/playbooks/p1/versions', refused);
    await expect(publishAndPoint(PLAYBOOK, DRAFT, 'u1')).rejects.toBe(refused);
  });

  it('resolves quietly when the playbook to delete is not there', async () => {
    await expect(deletePlaybook('gone')).resolves.toBeUndefined();
  });

  it('propagates any other delete failure', async () => {
    const denied = new ModelError('This needs the partner role.', 'not_permitted', 403);
    transport.failures.set('/v1/playbooks/p1', denied);
    await expect(deletePlaybook('p1')).rejects.toBe(denied);
  });

  it('resolves discardDraft quietly when there is nothing to discard', async () => {
    // This runs as the user LEAVES the editor, and there is nothing they
    // could do about the news.
    await expect(discardDraft('gone')).resolves.toBeUndefined();
  });
});
