import { DbBlockedError } from './db/open';
import { UnconvertedPlaybookError } from './db/playbookMigration';

/** The classification half of every "load X, show an honest error instead
 *  of an empty list" call site in App.tsx: a `DbBlockedError` already
 *  carries its own explanatory, user-facing message (another tab has the
 *  database open); anything else is an opaque IndexedDB failure the user
 *  can't diagnose, so it falls back to a subject-specific generic message.
 *
 *  Extracted because this exact ternary was hand-copied at seven call sites
 *  (`App.tsx`'s matters/library/matter/documents/reviews/review/playbook
 *  loaders) — the sixth instance of this project's sibling-drift pattern.
 *  Each call site keeps its own `useState` and its own reset; only the
 *  classification itself (and its one hard-coded fallback string) is
 *  shared here, so this is a pure function, not a hook — nothing here
 *  changes what state exists or when it resets.
 *
 *  `UnconvertedPlaybookError` joins `DbBlockedError` on the pass-through
 *  side for the same reason: it names a specific, recoverable situation
 *  ("reload the page to finish the upgrade") that the generic message
 *  cannot, and it is raised precisely where a generic message would leave
 *  the user retrying something that will keep failing. */
export function describeLoadError(e: unknown, fallback: string): string {
  if (e instanceof DbBlockedError || e instanceof UnconvertedPlaybookError) return e.message;
  return fallback;
}
