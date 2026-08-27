import { DbBlockedError } from './db/open';

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
 *  changes what state exists or when it resets. */
export function describeLoadError(e: unknown, fallback: string): string {
  return e instanceof DbBlockedError ? e.message : fallback;
}
