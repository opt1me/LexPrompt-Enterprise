import { ModelError, uid } from '@lexprompt/core';
import type {
  Changeset, Collection, DocumentRecord, Matter, Playbook, PlaybookDraft, PlaybookVersion, Review,
} from '../types';
import type { StoreName } from '../lib/upload/report';

/**
 * A stand-in for `apps/api`, behaving the way the shipped routes behave in
 * the four respects the uploader depends on.
 *
 * It is a double, not a simulation, and what it doubles is deliberate:
 *
 *  1. **A create over an existing id is a `conflict`, never an overwrite.**
 *     Every repository write the uploader makes carries no `version`, which
 *     the routes read as "I believe this is a create" — `matter.version =
 *     NULL` is never true, so the `DO UPDATE`'s `where` refuses. That is
 *     what makes a second run of a partial first one a confirmation rather
 *     than a duplication, and it has to be real here or the idempotency case
 *     proves nothing.
 *  2. **A published version gets a FRESH id and a server-allocated number.**
 *     `publishInto` mints `uid()` every time and takes
 *     `max(version_number) + 1`. The uploader's whole version-id remap
 *     exists because of this, so a double that echoed the id back would make
 *     the remap untestable — and would let a broken remap pass.
 *  3. **Publishing consumes the draft.** The route sets `draft = null`.
 *  4. **Attribution comes from the actor.** Whatever the body claims about
 *     `ownerId`/`addedByUserId`/`createdByUserId` is discarded. `findings`
 *     jsonb is NOT — nothing on the server looks inside it — which is
 *     exactly why the uploader has to rewrite what is in there itself.
 *
 * `apps/api/test/upload.pg.test.ts` is where the real routes answer for
 * themselves; this is for the browser half.
 */

export const ACTOR_ID = '00000000-0000-0000-0000-0000000000aa';

export interface FakeServer {
  matters: Map<string, Matter>;
  documents: Map<string, { record: DocumentRecord; bytes: Blob }>;
  collections: Map<string, Collection>;
  playbooks: Map<string, Playbook>;
  /** Keyed by the id the SERVER minted, not the id the browser sent. */
  versions: Map<string, PlaybookVersion>;
  reviews: Map<string, Review>;
  changesets: Map<string, Changeset>;
}

export const server: FakeServer = {
  matters: new Map(), documents: new Map(), collections: new Map(), playbooks: new Map(),
  versions: new Map(), reviews: new Map(), changesets: new Map(),
};

/** Every write, in the order it was made. `store` is the uploader's own
 *  vocabulary so a test can assert the dependency ORDER without knowing
 *  which function each store is written by. */
export const calls: { store: StoreName; id: string }[] = [];

/** `${store}:${id-or-name}` -> the error to throw instead of writing. */
export const failures = new Map<string, unknown>();

export function resetServer(): void {
  for (const map of Object.values(server)) map.clear();
  calls.length = 0;
  failures.clear();
}

/** Makes the next (and every) write of one named record fail. Keyed on the
 *  NAME as well as the id, because "the document that failed" is a filename
 *  to a person and an id to nobody. */
export function failUploadOf(store: StoreName, nameOrId: string, error: unknown): void {
  failures.set(`${store}:${nameOrId}`, error);
}

export function unfail(): void {
  failures.clear();
}

function checkFail(store: StoreName, ...keys: (string | undefined)[]): void {
  for (const key of keys) {
    if (key === undefined) continue;
    const error = failures.get(`${store}:${key}`);
    if (error) throw error;
  }
}

/** The refusal every route gives a create that collides with an existing
 *  row. `code: 'conflict'` is the contract; the message is not. */
function conflict(): ModelError {
  return new ModelError(
    'Something else already uses that identifier, and it is not yours to overwrite. '
    + 'Nothing was saved.', 'conflict', 409);
}

function note(store: StoreName, id: string): void {
  calls.push({ store, id });
}

export function mattersModule(): Record<string, unknown> {
  return {
    async saveMatter(m: Matter): Promise<Matter> {
      note('matters', m.id);
      checkFail('matters', m.id, m.name);
      if (server.matters.has(m.id)) throw conflict();
      // Property 3: attribution from the actor, never from the body.
      const stored = { ...m, ownerId: ACTOR_ID, version: 0 };
      server.matters.set(m.id, stored);
      return stored;
    },
    async getMatter(id: string): Promise<Matter | null> {
      return server.matters.get(id) ?? null;
    },
  };
}

export function documentsModule(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    // Repair-on-read is REAL, not doubled: it is the uploader's own reader
    // and doubling it would hide a break in it.
    migrateDocumentRecord: actual.migrateDocumentRecord,
    async addDocument(record: DocumentRecord, bytes: Blob): Promise<void> {
      note('documents', record.id);
      checkFail('documents', record.id, record.name);
      if (server.documents.has(record.id)) throw conflict();
      if (!server.matters.has(record.matterId)) {
        throw new ModelError(
          `There is no matter ${record.matterId} to add this document to.`, 'not_found', 404);
      }
      server.documents.set(record.id, { record: { ...record, addedByUserId: ACTOR_ID }, bytes });
    },
    async getDocument(id: string): Promise<DocumentRecord | null> {
      return server.documents.get(id)?.record ?? null;
    },
  };
}

export function collectionsModule(): Record<string, unknown> {
  return {
    async saveCollection(c: Collection): Promise<Collection> {
      note('collections', c.id);
      checkFail('collections', c.id, c.name);
      if (server.collections.has(c.id)) throw conflict();
      // The check the shipped route makes, and the reason documents are
      // uploaded before collections.
      for (const documentId of [c.baseDocumentId, ...c.variesDocumentIds]) {
        if (!server.documents.has(documentId)) {
          throw new ModelError(
            `Document ${documentId} is not in this matter.`, 'not_found', 404);
        }
      }
      const stored = { ...c, createdByUserId: ACTOR_ID, version: 0 };
      server.collections.set(c.id, stored);
      return stored;
    },
    async getCollection(id: string): Promise<Collection | null> {
      return server.collections.get(id) ?? null;
    },
  };
}

export function playbooksModule(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    async savePlaybook(p: Playbook): Promise<Playbook> {
      note('playbooks', p.id);
      checkFail('playbooks', p.id, p.name);
      const held = server.playbooks.get(p.id);
      // An upsert refused unless the caller states the version it read.
      if (held && p.version !== held.version) throw conflict();
      const stored = { ...p, version: (held?.version ?? -1) + 1 };
      server.playbooks.set(p.id, stored);
      return stored;
    },
    async getPlaybook(id: string): Promise<Playbook | null> {
      return server.playbooks.get(id) ?? null;
    },
    async publishAndPoint(
      playbook: Playbook, draft: PlaybookDraft, byUserId: string,
    ): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
      note('playbookVersions', playbook.id);
      checkFail('playbookVersions', playbook.id, draft.name, draft.changeSummary ?? '');
      const mine = [...server.versions.values()].filter(v => v.playbookId === playbook.id);
      const number = mine.reduce((max, v) => Math.max(max, v.version), 0) + 1;
      if (number > 1 && !(draft.changeSummary ?? '').trim()) {
        throw new ModelError(
          'A new version needs a short note saying what changed.', 'conflict', 400);
      }
      // A FRESH id every time — the property the uploader's remap exists for.
      const version: PlaybookVersion = {
        ...draft,
        changeSummary: (draft.changeSummary ?? '').trim(),
        id: uid(),
        playbookId: playbook.id,
        version: number,
        publishedAt: Date.now(),
        publishedByUserId: byUserId || ACTOR_ID,
        schemaVersion: playbook.schemaVersion,
      };
      server.versions.set(version.id, version);
      const held = server.playbooks.get(playbook.id);
      // PUBLISHING CONSUMES THE DRAFT.
      const { draft: _consumed, ...identity } = { ...playbook };
      void _consumed;
      const stored: Playbook = {
        ...identity, currentVersionId: version.id, version: (held?.version ?? -1) + 1,
      };
      server.playbooks.set(playbook.id, stored);
      return { playbook: stored, version };
    },
  };
}

export function playbookVersionsModule(): Record<string, unknown> {
  return {
    async listVersions(playbookId: string): Promise<PlaybookVersion[]> {
      if (!server.playbooks.has(playbookId)) {
        throw new ModelError('There is no such playbook.', 'not_found', 404);
      }
      return [...server.versions.values()]
        .filter(v => v.playbookId === playbookId)
        .sort((a, b) => b.version - a.version);
    },
    async getVersion(id: string): Promise<PlaybookVersion | null> {
      return server.versions.get(id) ?? null;
    },
  };
}

export function reviewsModule(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    /**
     * `importReview` IS THE UPLOADER'S CALL NOW (Stage 3 Task 22), and the
     * distinction is the whole point of it: `saveReview` drops the findings
     * key because a whole-review save has nothing to say about findings and
     * the real route refuses one that claims otherwise, while an import
     * carries them and the route writes them as ROWS for a review this
     * workspace has never seen. This fake stores the map verbatim under the
     * same key, which is why the uploader still has to rewrite the
     * attributions inside it.
     */
    async importReview(r: Review): Promise<Review> {
      note('reviews', r.id);
      checkFail('reviews', r.id);
      if (server.reviews.has(r.id)) throw conflict();
      if (!server.matters.has(r.matterId)) {
        throw new ModelError(
          `There is no matter ${r.matterId} for this review to belong to.`, 'not_found', 404);
      }
      if (r.playbookVersionId !== undefined && !server.versions.has(r.playbookVersionId)) {
        throw new ModelError(
          `This review names playbook version ${r.playbookVersionId}, which is no longer here.`,
          'conflict', 400);
      }
      // `created_by_user_id` from the actor; `findings` jsonb stored VERBATIM,
      // which is why the uploader has to rewrite the attributions inside it.
      const stored = { ...r, createdByUserId: ACTOR_ID, version: 0 };
      server.reviews.set(r.id, stored);
      return stored;
    },
    async getReview(id: string): Promise<Review | null> {
      return server.reviews.get(id) ?? null;
    },
  };
}

export function changesetsModule(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    async saveChangeset(c: Changeset): Promise<Changeset> {
      note('changesets', c.id);
      checkFail('changesets', c.id, c.sourceSummary);
      if (server.changesets.has(c.id)) throw conflict();
      // `from_version_id text not null references playbook_version(id)`.
      if (!server.versions.has(c.fromVersionId)) {
        throw new ModelError(
          'This record names a playbook version LexPrompt does not know.', 'conflict', 409);
      }
      const stored = { ...c, createdByUserId: ACTOR_ID, version: 0 };
      server.changesets.set(c.id, stored);
      return stored;
    },
    async getChangeset(id: string): Promise<Changeset | null> {
      return server.changesets.get(id) ?? null;
    },
  };
}

export function profileModule(): Record<string, unknown> {
  return {
    async getProfile() {
      return { id: ACTOR_ID, name: 'Signed In', initials: 'SI' };
    },
    forgetProfile() { /* nothing to forget */ },
  };
}
