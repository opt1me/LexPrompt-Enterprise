import type { DBSchema } from 'idb';
import type { Playbook } from '../../types';

export const DB_NAME = 'lexprompt';
// 3 to 4: `changesets` store added (sub-project F, Task 8), with a
// `byPlaybook` index — additive only. No existing store is modified,
// reindexed, or cleared (see `open.ts`'s `upgrade`).
export const DB_VERSION = 4;

export const STORES = {
  matters: 'matters',
  documents: 'documents',
  blobs: 'blobs',
  reviews: 'reviews',
  playbooks: 'playbooks',
  profile: 'profile',
  collections: 'collections',
  playbookVersions: 'playbookVersions',
  changesets: 'changesets',
} as const;

/** The single key under which the one local profile is stored. */
export const PROFILE_KEY = 'local';

export interface LexPromptDB extends DBSchema {
  matters: { key: string; value: import('../../types').Matter };
  documents: {
    key: string;
    value: import('../../types').DocumentRecord;
    indexes: { byMatter: string };
  };
  blobs: { key: string; value: { documentId: string; bytes: Blob; mime: string } };
  reviews: {
    key: string;
    value: import('../../types').Review;
    indexes: { byMatter: string };
  };
  playbooks: { key: string; value: Playbook };
  profile: { key: string; value: import('../../types').UserProfile };
  collections: {
    key: string;
    value: import('../../types').Collection;
    indexes: { byMatter: string };
  };
  playbookVersions: {
    key: string;
    value: import('../../types').PlaybookVersion;
    indexes: { byPlaybook: string };
  };
  changesets: {
    key: string;
    value: import('../../types').Changeset;
    indexes: { byPlaybook: string };
  };
}

// Settings deliberately absent — see ruling R6. They are a few hundred bytes,
// read synchronously in render paths, and moving them would make every caller
// async for no benefit.
