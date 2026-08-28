import { listMatters } from './db/matters';
import { listReviews } from './db/reviews';
import { listVersions } from './db/playbookVersions';
import type { Matter, PlaybookVersion, Review } from '../types';

export interface PlaybookScan {
  versions: PlaybookVersion[];
  matters: Matter[];
  /** Parallel to `matters` — `reviewsByMatter[i]` is `matters[i]`'s reviews. */
  reviewsByMatter: Review[][];
}

/**
 * Drift review, D3. `App.tsx`'s `loadVersionHistory` and `loadPositionHealth`
 * each ran this exact scan independently: `listVersions` is playbook-scoped,
 * but a playbook's REVIEWS live wherever it was run, which is matter-scoped
 * (Task 9A), so answering either screen's question means reading every
 * matter's reviews and filtering by playbook afterwards. Kept as one shared
 * read rather than two byte-identical copies — a future change to what
 * counts as "this playbook's reviews" (paginating matters, filtering deleted
 * ones) would otherwise have to be made twice by hand with nothing to
 * enforce it.
 *
 * Deliberately does NOT catch anything. The two call sites reasoned,
 * correctly, that a failure belongs to whichever SCREEN asked the question,
 * not to a scan shared between them — a shared `catch` here would collapse
 * Version History's error state and Position Health's into one message that
 * fits neither. Each caller wraps its own call in its own error handling,
 * exactly as before; this only removes the duplicated `Promise.all` shape
 * underneath it.
 */
export async function scanPlaybookAcrossMatters(playbookId: string): Promise<PlaybookScan> {
  const [versions, matters] = await Promise.all([listVersions(playbookId), listMatters()]);
  const reviewsByMatter = await Promise.all(matters.map(m => listReviews(m.id)));
  return { versions, matters, reviewsByMatter };
}
