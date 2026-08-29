import { SCHEMA_VERSION, type Playbook, type PlaybookDraft, type PlaybookVersion } from '../types';
import { uid } from '../lib/uid';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_FORMAT_PROMPT } from '../lib/playbookDefaults';

/**
 * An in-memory playbook and version store, for the suites whose SUBJECT is
 * something that publishes rather than the publish itself.
 *
 * `changesets.test.ts` is the case: it asks which items reach a published
 * version, whose words they carry, and whether a stale base is refused.
 * `publishChangeset` reaches `publishAndPoint` to do that, and since Stage 2
 * Task 13 that is an HTTP call into one Postgres transaction.
 *
 * **This is a FIXTURE, not a second implementation of the route, and the
 * difference is worth keeping.** It numbers versions and refuses a summary-
 * less v2 because the tests above it need a version to come back and need
 * the numbering to be visible — but nothing here is evidence about the
 * server. The transaction ("does both, or neither"), the concurrency, the
 * partner gate, the immutability grant and the workspace scope are all
 * proved against a REAL Postgres in `apps/api/test/playbooks.pg.test.ts`,
 * and none of them is reproduced here. If a test wants to know what the
 * SERVER does when it publishes, it belongs there.
 */
export interface MemoryPlaybooks {
  playbooks: Map<string, Playbook>;
  versions: Map<string, PlaybookVersion>;
  /** Set to make the next `publishAndPoint` reject, for the cases about what
   *  a caller does when a publish FAILS — a decision it must not lose, a
   *  changeset it must not mark published. The failure's cause does not
   *  matter to those cases and never did; what mattered was that it failed. */
  failPublish: Error | null;
  /** Every store function called, in order — so a caller can be held to
   *  "exactly one publish and no separate identity write first", which is
   *  what `publishAndPoint` being one transaction is FOR and what used to be
   *  asserted by counting IndexedDB transactions. */
  calls: string[];
  reset(): void;
}

export const memoryPlaybooks: MemoryPlaybooks = {
  playbooks: new Map<string, Playbook>(),
  versions: new Map<string, PlaybookVersion>(),
  failPublish: null,
  calls: [],
  reset() {
    memoryPlaybooks.playbooks.clear();
    memoryPlaybooks.versions.clear();
    memoryPlaybooks.failPublish = null;
    memoryPlaybooks.calls.length = 0;
  },
};

function versionsOf(playbookId: string): PlaybookVersion[] {
  return [...memoryPlaybooks.versions.values()]
    .filter(v => v.playbookId === playbookId)
    .sort((a, b) => b.version - a.version);
}

export function memoryPlaybooksModule(): Record<string, unknown> {
  return {
    newPlaybook(name: string): Playbook {
      const now = Date.now();
      return { id: uid(), name, createdAt: now, updatedAt: now, schemaVersion: SCHEMA_VERSION };
    },
    newPlaybookDraft(name: string): PlaybookDraft {
      return {
        name, contractType: 'Custom',
        systemPrompt: DEFAULT_SYSTEM_PROMPT, formatPrompt: DEFAULT_FORMAT_PROMPT,
        clauses: [], changeSummary: '',
      };
    },
    async listPlaybooks(): Promise<Playbook[]> {
      return [...memoryPlaybooks.playbooks.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async getPlaybook(id: string): Promise<Playbook | null> {
      return memoryPlaybooks.playbooks.get(id) ?? null;
    },
    async getPlaybookContent(id: string): Promise<PlaybookVersion | null> {
      const pb = memoryPlaybooks.playbooks.get(id);
      if (!pb?.currentVersionId) return null;
      return memoryPlaybooks.versions.get(pb.currentVersionId) ?? null;
    },
    async savePlaybook(playbook: Playbook): Promise<Playbook> {
      memoryPlaybooks.calls.push('savePlaybook');
      const saved: Playbook = { ...playbook, updatedAt: Date.now() };
      memoryPlaybooks.playbooks.set(saved.id, saved);
      return saved;
    },
    async publishAndPoint(
      playbook: Playbook, draft: PlaybookDraft, byUserId: string,
    ): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
      memoryPlaybooks.calls.push('publishAndPoint');
      if (memoryPlaybooks.failPublish) throw memoryPlaybooks.failPublish;
      const next = versionsOf(playbook.id).reduce((max, v) => Math.max(max, v.version), 0) + 1;
      const summary = draft.changeSummary?.trim() ?? '';
      // Kept because the tests above read the refusal, not because this is
      // where the rule lives — the API refuses it too, and that is what
      // `playbooks.pg.test.ts` proves.
      if (next > 1 && summary === '') {
        throw new Error('A change summary is required when publishing a new version.');
      }
      const version: PlaybookVersion = {
        ...draft, changeSummary: summary,
        id: uid(), playbookId: playbook.id, version: next,
        publishedAt: Date.now(), publishedByUserId: byUserId, schemaVersion: SCHEMA_VERSION,
      };
      memoryPlaybooks.versions.set(version.id, version);
      const identity: Playbook = { ...playbook };
      delete identity.draft;
      const saved: Playbook = {
        ...identity, name: version.name, currentVersionId: version.id,
        updatedAt: Date.now(), schemaVersion: SCHEMA_VERSION,
      };
      memoryPlaybooks.playbooks.set(saved.id, saved);
      return { playbook: saved, version };
    },
  };
}

export function memoryVersionsModule(): Record<string, unknown> {
  return {
    async getVersion(id: string): Promise<PlaybookVersion | null> {
      return memoryPlaybooks.versions.get(id) ?? null;
    },
    async listVersions(playbookId: string): Promise<PlaybookVersion[]> {
      return versionsOf(playbookId);
    },
  };
}
