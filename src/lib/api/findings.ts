import {
  ModelError,
  type DispositionHistory, type DispositionView, type DispositionWithHistory,
  type DispositionWriteResult, type FindingsPage, type NetPositionWriteResult, type Note,
  type VerificationChange, type VerificationState,
} from '@lexprompt/core';
import { apiGet, apiSend } from './client';

/**
 * The browser's reader of a review's findings — Task 14's half of the flip.
 *
 * `GET /v1/reviews/:id/findings` assembles `finding`, `finding_disposition`
 * and `note` into the nested `findingsKey -> clauseId -> Finding` shape
 * `Review.findings` has always had, so nothing that renders a finding
 * changed when the storage did.
 *
 * ## The disposition version this browser last SAW
 *
 * A disposition write is version-guarded server-side: a stale version is
 * refused with a 409 carrying the current row, because the alternative is
 * silently overwriting a judgement the writer never saw. The browser has to
 * state the version it was looking at, and a `Finding` has nowhere to carry
 * one — it is the domain shape three programs share, and an
 * optimistic-concurrency token is a fact about one table's row.
 *
 * So this module remembers it, per `(reviewId, findingsKey, clauseId)`,
 * exactly as `src/lib/db/reviews.ts` remembers a review's version and for
 * the same reasons, written out there at length. In short: it records what
 * this browser has SEEN, from a read or from its own successful write; it
 * is per tab and dies with the tab; and it is deliberately not a way around
 * the check, because another writer moving the row past what this browser
 * remembers is exactly the case the refusal exists for.
 */
/**
 * `reviewId -> cellKey -> version`, nested rather than flat.
 *
 * Nested because forgetting a review has to forget everything under it, and
 * a flat map would need a prefix match over a composite key — which means
 * choosing a separator that cannot appear in a document id, a collection id
 * or a clause id. `JSON.stringify` of the pair is unambiguous with no such
 * choice to get wrong.
 */
const lastSeenVersion = new Map<string, Map<string, number>>();
/** The same, for the `finding` row's own version — see `findingVersionFor`. */
const lastSeenFindingVersion = new Map<string, Map<string, number>>();
/**
 * The same cache, one fact wider: the disposition each cell is under and the
 * event that produced it (§8, Stage 4).
 *
 * THE SAME cache rather than a second one, deliberately. It is keyed the
 * same way, forgotten by the same call, and filled by the same read — a
 * parallel structure with its own lifecycle is how one of them comes to hold
 * a review the other has dropped. What it holds is what the SERVER last
 * said, never anything this browser composed: a card renders an actor
 * because a disposition names one, not because a name happened to be
 * resolvable.
 */
const lastSeenDisposition = new Map<string, Map<string, DispositionWithHistory>>();

/**
 * WHEN THIS BROWSER LAST READ A REVIEW'S DISPOSITIONS FROM THE SERVER.
 *
 * The instant every export stamps (§6.3.1, `dispositionsAsAtLine`). Here,
 * beside the cache it describes, because the module that performed the read
 * is the only one that can say when it happened — a caller passing its own
 * `Date.now()` would be stamping the moment the file was written onto a
 * findings map fetched some time earlier, which is a claim the document
 * cannot support.
 *
 * SET BY THE READ ALONE, never by a write. A confirmed write moves one
 * cell's row forward; moving the stamp with it would over-claim freshness
 * for every OTHER cell, which were last heard about at the earlier read.
 * Understating is the safe direction here and over-stating is not: "true as
 * at 16:41" over a cell whose state was fetched at 16:41 is exact, and over
 * a cell written at 16:44 is merely conservative.
 */
const lastReadAt = new Map<string, number>();

/**
 * When this browser last read that review's dispositions, or `undefined` for
 * a review it has not read.
 *
 * `undefined` is answered rather than filled in. An export over a review
 * whose dispositions were never read must SAY it cannot date them — see
 * `dispositionsAsAtLine`, which does exactly that.
 */
export function dispositionsReadAt(reviewId: string): number | undefined {
  return lastReadAt.get(reviewId);
}

const cellKey = (findingsKey: string, clauseId: string): string =>
  JSON.stringify([findingsKey, clauseId]);

/** Records the disposition versions the server just reported. */
function remember(reviewId: string, versions: FindingsPage['dispositionVersions']): void {
  for (const [findingsKey, byClause] of Object.entries(versions)) {
    for (const [clauseId, version] of Object.entries(byClause)) {
      rememberDispositionVersion(reviewId, findingsKey, clauseId, version);
    }
  }
}

/**
 * Records the dispositions the server just reported.
 *
 * REPLACED wholesale for the review, never merged into what was there: a
 * disposition this browser still held for a cell the server no longer
 * reports would be an attribution line for a finding that is gone. The read
 * is the truth about every cell it covers.
 */
function rememberDispositions(reviewId: string, page: FindingsPage['dispositions']): void {
  const byCell = new Map<string, DispositionWithHistory>();
  for (const [findingsKey, byClause] of Object.entries(page ?? {})) {
    for (const [clauseId, entry] of Object.entries(byClause)) {
      byCell.set(cellKey(findingsKey, clauseId), entry);
    }
  }
  lastSeenDisposition.set(reviewId, byCell);
  lastReadAt.set(reviewId, Date.now());
}

/**
 * The disposition and last event the server last reported for one cell, or
 * `undefined` for a cell this browser has not read.
 *
 * `undefined` is NOT "nobody has touched this". A never-touched finding has
 * a disposition with `changedCount: 0`, which is a fact the server stated;
 * `undefined` means this browser has not been told. `dispositionLabel`
 * (`findingOutcome.ts`) is the one place that difference turns into words.
 */
export function dispositionFor(
  reviewId: string, findingsKey: string, clauseId: string,
): DispositionWithHistory | undefined {
  return lastSeenDisposition.get(reviewId)?.get(cellKey(findingsKey, clauseId));
}

/** Records one version — called after a write that returned the row it
 *  produced, so the next write from this browser is not refused as stale. */
export function rememberDispositionVersion(
  reviewId: string, findingsKey: string, clauseId: string, version: number,
): void {
  let byCell = lastSeenVersion.get(reviewId);
  if (!byCell) {
    byCell = new Map<string, number>();
    lastSeenVersion.set(reviewId, byCell);
  }
  byCell.set(cellKey(findingsKey, clauseId), version);
}

/**
 * The version this browser last saw for one finding's disposition.
 *
 * `1` is the version a `finding_disposition` row is created with, so a
 * finding this browser has read but whose version it somehow does not hold
 * states the create-shaped value rather than omitting the field — and if
 * that is wrong, the write is REFUSED with a 409 rather than applied. The
 * fallback cannot cause a silent overwrite, which is the only property it
 * needs to have.
 */
export function dispositionVersionFor(
  reviewId: string, findingsKey: string, clauseId: string,
): number {
  return lastSeenVersion.get(reviewId)?.get(cellKey(findingsKey, clauseId)) ?? 1;
}

/** Drops what this browser believes about a review's disposition versions.
 *  Exported so a test can put this module back into the state a fresh tab
 *  is in, and called when a review is deleted. */
export function forgetFindingVersions(reviewId: string): void {
  lastSeenVersion.delete(reviewId);
  lastSeenFindingVersion.delete(reviewId);
  lastSeenDisposition.delete(reviewId);
  lastReadAt.delete(reviewId);
}

/**
 * Every finding of a review, from the rows.
 *
 * REJECTS on any failure — it never resolves to an empty map. A review is a
 * record of what was examined, and "the findings could not be read" and
 * "this review found nothing" are the two things this codebase most insists
 * on keeping apart. The caller renders the rejection through
 * `describeLoadError`/`LoadErrorPanel`; a 404 arrives as a `ModelError`
 * carrying "There is no such review."
 */
export async function getFindings(reviewId: string): Promise<FindingsPage> {
  const page = await apiGet<FindingsPage>(
    `/v1/reviews/${encodeURIComponent(reviewId)}/findings`);
  remember(reviewId, page.dispositionVersions ?? {});
  rememberDispositions(reviewId, page.dispositions ?? {});
  for (const [findingsKey, byClause] of Object.entries(page.findingVersions ?? {})) {
    for (const [clauseId, version] of Object.entries(byClause)) {
      rememberFindingVersion(reviewId, findingsKey, clauseId, version);
    }
  }
  return page;
}

/** Records one finding row's version, from a read or from a write. */
export function rememberFindingVersion(
  reviewId: string, findingsKey: string, clauseId: string, version: number,
): void {
  let byCell = lastSeenFindingVersion.get(reviewId);
  if (!byCell) {
    byCell = new Map<string, number>();
    lastSeenFindingVersion.set(reviewId, byCell);
  }
  byCell.set(cellKey(findingsKey, clauseId), version);
}

/** The `finding` row version this browser last saw — the token a
 *  net-position write states. See `dispositionVersionFor` for the fallback's
 *  reasoning; it is the same one. */
export function findingVersionFor(
  reviewId: string, findingsKey: string, clauseId: string,
): number {
  return lastSeenFindingVersion.get(reviewId)?.get(cellKey(findingsKey, clauseId)) ?? 1;
}

/**
 * A PERSON'S JUDGEMENT ABOUT ONE ANSWER, written to its own row.
 *
 * Await-then-apply, unchanged in substance (§3, S8): the caller renders the
 * row the store confirmed and nothing else. What has gone is the
 * read-modify-write over a whole review, and with it the race
 * `latestRunRef`'s re-read existed to close — there is nothing left to
 * merge, because this write touches one row and the engine cannot touch that
 * row at all.
 */
export async function setDisposition(
  reviewId: string, findingsKey: string, clauseId: string, change: VerificationChange,
  atVersion?: number,
): Promise<DispositionWriteResult> {
  const result = await apiSend<DispositionWriteResult>(
    'PUT', dispositionPath(reviewId, findingsKey, clauseId),
    {
      state: change.state,
      ...(change.reason ? { reason: change.reason } : {}),
      // THE VERSION THE PERSON WAS LOOKING AT, when the caller knows it.
      //
      // The module cache is what this browser last HEARD; `atVersion` is
      // what the reviewer last SAW, and P36 is the case where those differ.
      // A change arriving while a reject-reason dialog is open is held off
      // the screen — but the read that carried it still moved this cache, so
      // a submission taking the cache would carry the NEW version, be
      // accepted, and land a rejection on a state the person never read.
      // Refused, visibly, is the correct outcome: they acted on what they
      // could see, and `ConflictNotice` tells them what replaced it.
      //
      // Optional, and the fallback is the cache: a caller with no card in
      // hand (the whole-review paths) has nothing better to state, and a
      // wrong version is REFUSED rather than applied, which is the only
      // property the fallback needs.
      version: atVersion ?? dispositionVersionFor(reviewId, findingsKey, clauseId),
    },
  );
  rememberDispositionVersion(reviewId, findingsKey, clauseId, result.disposition.version);
  // AWAIT-THEN-APPLY, on the attribution as well as on the version. The
  // write answers with the row the store actually took AND the event it
  // produced (`DispositionWriteResult`), which is exactly a
  // `DispositionWithHistory` — so the card's actor line updates from the
  // store's answer rather than from what this browser asked for. Without
  // this, a verification would show its new state with the PREVIOUS actor
  // beside it until the next read.
  const byCell = lastSeenDisposition.get(reviewId)
    ?? new Map<string, DispositionWithHistory>();
  byCell.set(cellKey(findingsKey, clauseId),
    { disposition: result.disposition, last: result.event });
  lastSeenDisposition.set(reviewId, byCell);
  return result;
}

/**
 * THE ROW THAT WON, off a refused disposition write — or `undefined` when
 * this refusal is not one this module can speak about.
 *
 * The 409 carries it (`registerErrorEnvelope` puts `current` on the envelope
 * beside `error`, and `asView` in `routes/findings.ts` maps it into the same
 * wire shape the success path answers with), `modelErrorFrom` now keeps it,
 * and this is the ONE place it is narrowed from `unknown`. `@lexprompt/core`
 * deliberately does not learn the shape of every table that can conflict;
 * the caller that knows which write it made is the one entitled to say what
 * came back.
 *
 * CHECKED, not cast. Two 409s in this application carry no disposition at
 * all — a foreign-key violation (`server.ts`'s `23503` branch, which sends
 * no `current`), and a conflict over an id this workspace may not see
 * (`ConflictError` with `current` absent, by design). A cast would turn
 * either into a notice reading "someone this record does not name changed
 * this to undefined", which is worse than the plain sentence it replaced.
 * Anything that does not check out returns `undefined` and the caller falls
 * back to `verificationRefusal`'s wording.
 */
const STATES: readonly VerificationState[] = ['unchecked', 'verified', 'flagged', 'rejected'];

export function conflictingDisposition(e: unknown): DispositionView | undefined {
  if (!(e instanceof ModelError) || e.code !== 'conflict') return undefined;
  const c = e.current as Partial<DispositionView> | null | undefined;
  if (!c || typeof c !== 'object') return undefined;
  if (typeof c.reviewId !== 'string' || typeof c.findingsKey !== 'string'
    || typeof c.clauseId !== 'string') return undefined;
  if (!STATES.includes(c.state as VerificationState)) return undefined;
  if (typeof c.version !== 'number' || typeof c.changedCount !== 'number') return undefined;
  return c as DispositionView;
}

/**
 * Records what the REFUSAL said, so the change can be offered again against
 * the row that won.
 *
 * This is mechanism 3 of four (§6.3): the version guard refuses, the refusal
 * is named, and then *a person* re-applies against the new version — which
 * they cannot do while this browser still remembers the version it was
 * refused for. Without this the re-apply would be refused too, forever, and
 * the only exit would be the reload the notice exists to avoid.
 *
 * It is NOT a way around the check. What is written here is exactly what the
 * server said in the act of refusing, and nothing re-submits on its own
 * (P25) — the next write is a click, and the person making it has been shown
 * whose judgement they are about to replace.
 *
 * The cached `last` event is DROPPED rather than kept: it described the
 * movement into the state this row has just left, so keeping it would put
 * "was Verified" on a line about somebody else's rejection — a stale clause
 * on a fresh fact, which is the drift the whole disposition read exists to
 * close.
 */
export function rememberConflict(current: DispositionView): void {
  const { reviewId, findingsKey, clauseId } = current;
  rememberDispositionVersion(reviewId, findingsKey, clauseId, current.version);
  const byCell = lastSeenDisposition.get(reviewId)
    ?? new Map<string, DispositionWithHistory>();
  byCell.set(cellKey(findingsKey, clauseId), { disposition: current });
  lastSeenDisposition.set(reviewId, byCell);
}

/** A person's remark about the clause. The actor and the instant are the
 *  server's; the note it answers with is what was stored. */
export async function addNote(
  reviewId: string, findingsKey: string, clauseId: string, text: string,
): Promise<Note> {
  return apiSend<Note>(
    'POST',
    `${findingPath(reviewId, findingsKey, clauseId)}/notes`,
    { text },
  );
}

/**
 * Confirms or amends the synthesised position, through `confirmPosition` /
 * `amendPosition` — which run on the SERVER, over what is stored.
 *
 * The browser sends the action, never a `NetPosition`: those two functions
 * are the only producers of one, and a body carrying the object could state
 * a confirmation with anybody's name on it.
 */
export async function setNetPosition(
  reviewId: string, findingsKey: string, clauseId: string,
  action: { action: 'confirm' } | { action: 'amend'; text: string },
): Promise<NetPositionWriteResult> {
  const result = await apiSend<NetPositionWriteResult>(
    'PUT', `${findingPath(reviewId, findingsKey, clauseId)}/net-position`,
    { ...action, version: findingVersionFor(reviewId, findingsKey, clauseId) },
  );
  rememberFindingVersion(reviewId, findingsKey, clauseId, result.version);
  return result;
}

/**
 * EVERY CHANGE TO ONE FINDING'S DISPOSITION, NEWEST FIRST.
 *
 * Reads the route Stage 3 shipped and left with no caller
 * (`GET …/history`) — a second route would be a second definition of what an
 * event is, over a table one module writes.
 *
 * REJECTS on any failure; it never resolves to an empty history. An empty
 * history under a disposition somebody moved is indistinguishable from a
 * change that failed to record itself, which is the exact ambiguity §6.4's
 * one-transaction rule exists to make impossible — a failed FETCH must not
 * manufacture it. The caller renders the rejection through
 * `describeLoadError`/`LoadErrorPanel`.
 *
 * NOT CACHED, deliberately, and it is the one read in this module that is
 * not. The versions and dispositions above are what the browser needs on
 * every render of every card; a history is what somebody asked to see once,
 * about one clause, and it is the surface most likely to have changed since
 * the page loaded — a cached one would show a reader a record that is
 * missing the change they opened it to check.
 */
export async function getDispositionHistory(
  reviewId: string, findingsKey: string, clauseId: string,
): Promise<DispositionHistory> {
  return apiGet<DispositionHistory>(
    `${findingPath(reviewId, findingsKey, clauseId)}/history`);
}

/** Re-runs one clause, server-side, clearing the judgement that described
 *  the answer being replaced — see `src/lib/api/runs.ts`'s `retryCell`,
 *  which is where that call lives. */
const findingPath = (reviewId: string, findingsKey: string, clauseId: string): string =>
  `/v1/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingsKey)}`
  + `/${encodeURIComponent(clauseId)}`;

const dispositionPath = (reviewId: string, findingsKey: string, clauseId: string): string =>
  `${findingPath(reviewId, findingsKey, clauseId)}/disposition`;
