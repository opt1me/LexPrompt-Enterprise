import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import type { PlaybookVersion } from '../../types';
import { SCHEMA_VERSION } from '../../types';

/**
 * `playbookVersions`, now a READ-ONLY TRANSPORT.
 *
 * What this file used to assert — monotonic version numbers, the
 * change-summary rule from v2 onwards, immutability, the one-transaction
 * allocation — moved to `apps/api/test/playbooks.pg.test.ts`, where a real
 * Postgres proves each of them against the real route. Three of those are
 * now properties of the DATABASE rather than of this code: the version
 * number is allocated inside the publish transaction, and the app role holds
 * INSERT but not UPDATE or DELETE on `playbook_version`.
 *
 * `publishVersion` and `publishVersionIn` are gone from this module
 * entirely; the second could not survive at all, because its type took an
 * `idb` object-store handle. See the module's own docstring for where it
 * went and why that is a finding rather than a tidy-up.
 */

const transport = makeFakeTransport();
vi.mock('../api/client', () => transportModule(transport));

const { getVersion, listVersions } = await import('./playbookVersions');

const V1: PlaybookVersion = {
  id: 'v1', playbookId: 'p1', version: 1, name: 'NDA', contractType: 'NDA',
  systemPrompt: 'Be careful.', formatPrompt: 'Quote verbatim.',
  clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'What is the term?' }],
  changeSummary: '', publishedAt: 1_700_000_000_000, publishedByUserId: 'u1', schemaVersion: 7,
};

beforeEach(() => transport.reset());

/** A version stored before D's rename: `prompt` rather than `extractPrompt`,
 *  and no `schemaVersion`. `getPlaybookContent` repairs one of these on
 *  read; this module did not, so the SAME stored record came back one shape
 *  through a playbook's current content and another through its version
 *  list (Part 2A m8). */
const PRE_D = {
  id: 'v0', playbookId: 'p1', version: 1, name: 'NDA', contractType: 'NDA',
  systemPrompt: 'Be careful.', formatPrompt: 'Quote verbatim.',
  clauses: [{ id: 'c1', title: 'Term', prompt: 'What is the term?' }],
  changeSummary: '', publishedAt: 1_700_000_000_000, publishedByUserId: 'u1',
};

describe('repair-on-read (Part 2A m8)', () => {
  it('migrates a pre-D version read by id, as getPlaybookContent already did', async () => {
    transport.responses.set('/v1/versions/v0', PRE_D);
    const v = await getVersion('v0');
    expect(v?.clauses[0].extractPrompt).toBe('What is the term?');
    expect(v?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('migrates every entry of the version LIST too', async () => {
    transport.responses.set('/v1/playbooks/p1/versions', [PRE_D, { ...PRE_D, id: 'v0b' }]);
    const list = await listVersions('p1');
    expect(list.map(v => v.clauses[0].extractPrompt))
      .toEqual(['What is the term?', 'What is the term?']);
    expect(list.every(v => v.schemaVersion === SCHEMA_VERSION)).toBe(true);
  });
});

describe('getVersion', () => {
  it('reads /v1/versions/:id and returns the version', async () => {
    transport.responses.set('/v1/versions/v1', V1);
    expect(await getVersion('v1')).toEqual(V1);
  });

  it('returns null for a version that is not there', async () => {
    // R-D15's dangling case: a review keeps its `playbookVersionId` after
    // the playbook is deleted, so `ReviewVersionLine` can say "deleted"
    // rather than "never recorded". That distinction rests on this `null`.
    expect(await getVersion('gone')).toBeNull();
  });

  it('propagates a 500 rather than swallowing it into null', async () => {
    // A version read answering `null` over a broken server would render a
    // review's history as though the version it ran against had been
    // deleted — a specific, wrong, actionable claim.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/versions/v1', boom);
    await expect(getVersion('v1')).rejects.toBe(boom);
  });

  it('escapes the id rather than losing it', async () => {
    transport.responses.set('/v1/versions/a%2Fb%20c%3Fd', V1);
    expect(await getVersion('a/b c?d')).toEqual(V1);
  });
});

describe('listVersions', () => {
  it('reads /v1/playbooks/:id/versions and returns the server order untouched', async () => {
    // Newest first is the server's `order by version_number desc`. A second
    // sort here is the sibling drift two orderings that must agree produce.
    const list = [{ ...V1, id: 'v2', version: 2 }, V1];
    transport.responses.set('/v1/playbooks/p1/versions', list);
    expect((await listVersions('p1')).map(v => v.version)).toEqual([2, 1]);
  });

  it('propagates a failure rather than answering with no versions', async () => {
    // An empty version history and a broken server look identical on screen,
    // and the first is a fact a reader would act on.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/playbooks/p1/versions', boom);
    await expect(listVersions('p1')).rejects.toBe(boom);
  });

  it('escapes the playbook id', async () => {
    transport.responses.set('/v1/playbooks/a%2Fb/versions', []);
    expect(await listVersions('a/b')).toEqual([]);
  });
});

describe('what this module no longer exports', () => {
  it('has no publish path at all', async () => {
    // Publishing is one route running one Postgres transaction over both
    // tables. A browser-side "publish a version" that did not also point the
    // playbook at it is the orphan `publishAndPoint` exists to prevent,
    // rebuilt across a network — so there is no way to reach one from here.
    const mod = await import('./playbookVersions') as Record<string, unknown>;
    expect('publishVersion' in mod).toBe(false);
    expect('publishVersionIn' in mod).toBe(false);
  });
});
