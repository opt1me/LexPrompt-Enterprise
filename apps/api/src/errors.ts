import { ModelError } from '@lexprompt/core';

/**
 * A write that was refused because the row it meant to replace is no longer
 * the row it read (§8's optimistic concurrency), or because the id it
 * claimed belongs to another workspace (P6).
 *
 * ONE class, used by every repository route, because a 409 composed by hand
 * seven times is seven chances for the body shape to drift — and the body
 * shape is what Stage 4's "here is what replaced it" will read. This is the
 * sibling-drift rule applied before the second copy exists rather than after
 * the third.
 *
 * `current` travels WITH the refusal, so a caller that wants to show the
 * reader what actually happened needs no second round trip and no second
 * mechanism. It is `undefined` — and the key is then ABSENT from the body,
 * never `current: null` — when this workspace may not see the row that
 * caused the conflict: a foreign row's contents are not a fact this caller
 * is entitled to, and the difference between "someone else changed it, here
 * it is" and "that id is taken and you may not see by what" is exactly the
 * difference the two branches exist to keep.
 *
 * A `ModelError` subclass rather than a new error type, so `registerUser`'s
 * envelope and `registerErrorEnvelope` answer it verbatim with no new branch
 * beyond the one that attaches `current`, and so the browser's
 * `toModelError` reads `code: 'conflict'` through the vocabulary it already
 * shares with the gateway.
 */
export class ConflictError extends ModelError {
  /** The row as it stands NOW, when this workspace is entitled to see it. */
  readonly current?: unknown;

  constructor(current?: unknown, message?: string) {
    super(
      message ?? (current === undefined
        ? 'Something else already uses that identifier, and it is not yours to overwrite. '
          + 'Nothing was saved.'
        : 'This was changed since you opened it — by another tab, or by someone else — so '
          + 'saving now would overwrite work you have not seen. Nothing was saved; reload to '
          + 'see the current version.'),
      'conflict',
      409,
    );
    this.name = 'ConflictError';
    if (current !== undefined) this.current = current;
  }
}
