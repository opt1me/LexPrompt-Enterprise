import type { Jurisdiction } from '../model/protocol.ts';
import type { Finding, NetPosition, VerificationState } from '../domain/types.ts';
/** The three roles (§7). A closed set, here, because both sides read it. */
export const ROLES = ['reviewer', 'partner', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Who the caller is, as the API answers it.
 *
 * `id` is the `app_user` row's uuid, and it is what every `*UserId` field in
 * a record holds from this stage onwards. `issuer` and `subject` travel WITH
 * it and are not replaced by it (§6.5): the gateway's Stage 1 call log
 * carries the pair and no user id, so a record written before this stage
 * stays joinable to the person who wrote it only while both are present.
 */
export interface MeResponse {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName: string;
  initials: string;
  role: Role;
  workspaceId: string;
}

/**
 * ONE PERSON IN THE WORKSPACE'S DIRECTORY (§6.3, P32).
 *
 * The answer to `GET /v1/workspace/users`, which is the ONE place a user id
 * becomes a name. `GET /v1/me` answers only for the caller, so before this
 * existed a card could not say who verified a finding even if it wanted to
 * — an id and nothing that could become a name.
 *
 * ## Why a directory rather than a name on every payload
 *
 * A `byUserId` on a `finding_disposition` is a FOREIGN KEY; a display name
 * is a MUTABLE field on `app_user` that a person changes through
 * `PUT /v1/me`. Putting the name into every disposition payload and every
 * event would be a second copy of a mutable field, refreshed at different
 * times in different places — this project's most repeated defect, landing
 * on the field a reader trusts most.
 *
 * ## A disabled person is LISTED, not hidden
 *
 * Someone who has left the firm still verified things last March, and a card
 * rendering "Verified by (unknown)" for them is worse than one that names
 * them and says the account is turned off. Hiding the row is how history
 * loses a name.
 */
export interface WorkspaceUser {
  id: string;
  displayName: string;
  initials: string;
  role: Role;
  status: 'active' | 'disabled';
  /** ABSENT when the record holds none. Never an empty string, and never
   *  `email: undefined` — `structuredClone` preserves an undefined-valued
   *  key, so an `in` check would read it as an address that is there. */
  email?: string;
}

/** The whole directory. An object rather than a bare array, for the reason
 *  `RunEventPage` is one: a response that is a top-level array has nowhere
 *  to put the next fact anybody needs about the whole answer. */
export interface WorkspaceUsers {
  users: WorkspaceUser[];
}

/**
 * §6.6: `Settings.modelChoiceId` becomes workspace configuration an admin
 * sets from the gateway's allowlist, and `Settings.concurrency` becomes a
 * value STORED here (the server-side per-run bound it becomes is Stage 3's
 * — there is no run on the server yet to bound).
 *
 * `GET /v1/workspace/settings` answers this to any signed-in role; `PUT`
 * accepts it from an admin only (`ROUTE_POLICY`, both sides of the wire).
 * `version`/`updatedAt`/`updatedByUserId` are the same optimistic-
 * concurrency and attribution shape every other record in this project
 * carries (P9, §12) — an admin changing which provider the firm's text goes
 * to is exactly the kind of change §12 asks to be answerable about.
 *
 * `modelSupportsImages`/`modelSupportsStructuredOutput`/`modelContextLength`
 * are declared here too, ALL OPTIONAL, but they are not stored anywhere and
 * `apps/api` never reads or writes them — they are resolved CLIENT-SIDE by
 * cross-referencing `modelChoiceId` against `GET /v1/models`'s allowlist
 * (exactly as `Settings`'s old capability fields were), the same way this
 * type's own docstring in `src/App.tsx` explains. Declared here, alongside
 * the fields that actually cross the wire, so both sides read one type
 * rather than the browser inventing a second one that happens to extend it.
 */
export interface WorkspaceSettings {
  /** A gateway `AllowedModel.id`, or `''` for "not yet configured" — the
   *  same "empty string means unset" convention `Settings.modelChoiceId`
   *  used, kept so `isConfigured`-style checks did not need to learn a
   *  second shape (`null`) for the same fact. */
  modelChoiceId: string;
  modelChoiceLabel?: string;
  modelChoiceModel?: string;
  concurrency: number;
  /** Optional on the TYPE, the same way `Matter.version` is (`db/rows.ts`):
   *  the wire response from `apps/api` always sets it, but a client-side
   *  value built before any fetch has answered (`App.tsx`'s zeroed default,
   *  a test fixture) has no version to state, and absence here is exactly
   *  what a create-shaped write means one layer down in `matters.ts`'s own
   *  PUT. */
  version?: number;
  /** Epoch milliseconds, matching every other timestamp on the wire
   *  (`db/rows.ts`'s `epochOf`) — never an ISO string, which would be the
   *  one record type disagreeing with the rest about how time crosses this
   *  boundary. Optional for the same reason `version` is. */
  updatedAt?: number;
  updatedByUserId?: string;
  modelSupportsImages?: boolean;
  modelSupportsStructuredOutput?: boolean;
  modelContextLength?: number;
}

/**
 * §8, §9, P22: what a run says about itself while it runs.
 *
 * ONE PAYLOAD VOCABULARY, TWO TRANSPORTS. These five types are what
 * `GET /v1/runs/:id/events` returns today and what Stage 4's socket will
 * send; declaring them here rather than in `apps/api` is what makes that a
 * protocol Stage 4 inherits instead of one it invents. The HTTP cursor and
 * the socket's resume are the same `after`/`resyncRequired` pair for the
 * same reason.
 *
 * EVERY PAYLOAD CARRIES THE `version` OF THE ROW IT DESCRIBES, and that is
 * the rule the whole thing rests on. Delivery is at-least-once — a client
 * that reconnects replays from its cursor, and a worker that retried a cell
 * may have appended two events about it — so a consumer applies an event
 * only when its `version` is newer than what it already holds. Without that
 * number, replay would be indistinguishable from progress, and a reader
 * would watch a finding go from `done` back to `running`.
 */
export const RUN_EVENT_TYPES = [
  'run.started', 'finding.running', 'finding.done', 'finding.error', 'run.finished',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === 'string' && (RUN_EVENT_TYPES as readonly string[]).includes(value);
}

/** The run has been created and its cells queued. `cells` is how many units
 *  of work there are, so a reader can render progress before a single one
 *  has finished — and, more to the point, can tell a run that stopped after
 *  12 of 40 from one that had 12 to do. */
export interface RunStartedPayload {
  runId: string;
  reviewId: string;
  cells: number;
  version: number;
}

/** One cell, keyed exactly as `findingsKeyFor` keyed it — by document for a
 *  document review, by the COLLECTION for a collection review. Never a
 *  document id chosen from a collection's members. */
export interface FindingEventPayload {
  runId: string;
  reviewId: string;
  findingsKey: string;
  clauseId: string;
  /** The `finding` row's version AFTER this write. See the rule above. */
  version: number;
  /** Present on `finding.error` only, and it is the finding's own error
   *  text — the sentence the card shows — not a class name. A cell that
   *  exhausted its attempts carries the last one it saw. */
  error?: string;
}

/**
 * How the run ended, and the four endings are deliberately not collapsed.
 *
 * `succeeded` — every cell reached `done` or `error` and the run finished.
 * `cancelled` — a person asked it to stop; what completed stays completed.
 * `failed`    — it stopped WITHOUT being asked, and `error` says so.
 *
 * `cells` and `done`/`errored`/`cancelled` travel with it so a partial run
 * cannot read as a complete one: "12 of 40" is a fact the reader is entitled
 * to, and a `state` alone cannot carry it.
 */
export interface RunFinishedPayload {
  runId: string;
  reviewId: string;
  state: 'succeeded' | 'cancelled' | 'failed';
  cells: number;
  done: number;
  errored: number;
  cancelled: number;
  error?: string;
  version: number;
}

export type RunEventPayload =
  | RunStartedPayload
  | FindingEventPayload
  | RunFinishedPayload;

export interface RunEvent {
  /** Monotonic, and the cursor `after` names. `bigint` in Postgres, a
   *  `number` here — a firm would have to append nine quadrillion events to
   *  reach the point where that is not enough. */
  id: number;
  type: RunEventType;
  reviewId: string;
  runId: string;
  /** Epoch milliseconds, like every other timestamp on this wire. */
  at: number;
  payload: RunEventPayload;
}

/**
 * The answer to `GET /v1/runs/:id/events?after=&limit=`, and to Stage 4's
 * socket resume.
 *
 * `resyncRequired` is the honest answer past retention, and it is the whole
 * reason this is not just an array. The outbox keeps
 * `API_EVENT_RETENTION_DAYS` of events — a reconnection buffer, not an
 * archive — so a cursor older than the oldest surviving event names a gap.
 * Returning the events that DO survive would hand the client a list it
 * cannot tell from a complete one: it asked for everything after 400 and
 * got everything after 900, and nothing in the shape says so.
 */
export interface RunEventPage {
  events: RunEvent[];
  /** Where to ask from next. Equal to `after` when nothing new arrived. */
  nextCursor: number;
  hasMore: boolean;
  /** Present and `true` ONLY when the cursor has fallen off the back of the
   *  buffer. Absent otherwise — never `resyncRequired: false` — so an `in`
   *  check reads the same way `structuredClone` will leave it. */
  resyncRequired?: true;
}

/**
 * §6.5: the six states a run can be in, and the four ENDINGS that must stay
 * distinguishable.
 *
 * Collapsing any pair of `succeeded` / `cancelled` / `failed` is this
 * stage's version of answering quietly wrong:
 *
 *  - `succeeded` — every cell reached `done` or `error`, and the run
 *    finished. A cell in `error` is a finding a person can retry; the run
 *    itself is over.
 *  - `cancelled` — a person asked it to stop. **Not a failure.** Everything
 *    already completed stays completed and nothing is left `pending`.
 *  - `failed`    — it stopped WITHOUT being asked: a reaped heartbeat, or a
 *    fatal error. **Not a cancellation and not a success.** It says why.
 *  - `running` with a live heartbeat — in flight, which is not the same as
 *    stuck. The heartbeat is the whole difference.
 */
export const RUN_STATES = [
  'queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_CELL_STATES = ['queued', 'leased', 'done', 'error', 'cancelled'] as const;
export type RunCellState = (typeof RUN_CELL_STATES)[number];

/**
 * How much of the run has actually happened.
 *
 * Carried on every run response and on `run.finished` because **a partial
 * run must never read as a complete one**. A worker that stops after 12 of
 * 40 cells produces a run that says twelve; there is no `state` value that
 * can carry that on its own, and a reader given only `failed` would have to
 * count the findings themselves to find out how much of the review exists.
 */
export interface RunCellCounts {
  total: number;
  queued: number;
  leased: number;
  done: number;
  error: number;
  cancelled: number;
}

/**
 * A run, as `POST /v1/reviews/:id/runs` and `GET /v1/runs/:id` answer it.
 *
 * `provider`/`model`/`jurisdiction` are ABSENT until the first cell gets an
 * answer from the gateway, and they are then whatever the GATEWAY SAID —
 * never what the configuration says now (§6.5, S26). A firm that changes its
 * allowlist must not silently rewrite where a review it ran last March was
 * processed, and a run that has not called anything yet has nothing true to
 * put there. Absent, never `provider: undefined`: `structuredClone`
 * preserves an `undefined`-valued key, so the two would be
 * indistinguishable to an `in` check.
 */
export interface RunView {
  id: string;
  reviewId: string;
  state: RunState;
  requestedByUserId: string;
  provider?: string;
  model?: string;
  /** The WHOLE `Jurisdiction`, not its bloc. "A firm must not be able to
   *  believe it is UK-only while routing privileged text to a US region" —
   *  and the region is the half that answers that, so it travels with the
   *  bloc rather than being flattened to a label on the way into the run. */
  jurisdiction?: Jurisdiction;
  /** Snapshotted from `workspace_setting.concurrency` at creation (P26), for
   *  the same reason the playbook is snapshotted: a run is a record of what
   *  was done, under the bounds that were in force when it was done. */
  concurrency: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Absent until a worker picks the run up. A `queued` run with no
   *  heartbeat is waiting, not broken — the reaper leaves it alone, and a
   *  reader must be able to tell a busy queue from a dead one. */
  heartbeatAt?: number;
  cancelRequestedAt?: number;
  /** Why it stopped, on a `failed` run. A run that failed and cannot say
   *  why is a run nobody can act on. */
  error?: string;
  cells: RunCellCounts;
  version: number;
}

// ---------------------------------------------------------------------------
// §6.2/§6.3, Part 3B: findings, dispositions and notes on the wire.
//
// Declared HERE, beside the run's payloads and for the same reason: the
// browser reads these and `apps/api` writes them, and two declarations of one
// shape — one in a browser bundle, one in a Node service, nobody able to read
// them side by side — is this project's most repeated defect. Every field
// below is a fact one of the three tables holds.
// ---------------------------------------------------------------------------

/**
 * The answer to `GET /v1/reviews/:id/findings` (Task 14).
 *
 * `findings` is exactly the nested `findingsKey -> clauseId -> Finding` shape
 * `Review.findings` has always had, assembled from `finding`,
 * `finding_disposition` and `note` — so the flip from blob to rows changed no
 * consumer.
 */
export interface FindingsPage {
  findings: Record<string, Record<string, Finding>>;
  /**
   * `findingsKey -> clauseId -> finding_disposition.version`.
   *
   * BESIDE the findings rather than inside them. A disposition write is
   * version-guarded — a stale version is refused with a 409 carrying the
   * current row — so the writer has to state the version it was looking at;
   * but an optimistic-concurrency token is a fact about one table's row, not
   * about the answer to a clause, and `Finding` is the domain shape three
   * programs share.
   */
  dispositionVersions: Record<string, Record<string, number>>;
  /**
   * `findingsKey -> clauseId -> finding.version`, for the same reason and on
   * the same terms as `dispositionVersions` above.
   *
   * A NET POSITION lives on the `finding` row rather than on the
   * disposition, so confirming or amending one is guarded by this number
   * rather than by that one. Two tokens because they guard two rows: a
   * verification and a confirmed synthesis are separate judgements, and a
   * single shared version would refuse one because the other had moved.
   */
  findingVersions: Record<string, Record<string, number>>;
  /** The `review` row's version at the moment these findings were read. Not
   *  a version OF the findings: it is what lets a caller tell that the
   *  findings it just read belong to the review it just read. */
  version: number;
}

/**
 * What a person did to a net position.
 *
 * The ACTION, never the resulting `NetPosition`. A body carrying the object
 * itself could state `state: 'confirmed'` with anybody's name on it;
 * `confirmPosition`/`amendPosition` in `@lexprompt/core` are the only
 * producers of one, and the server runs them over the STORED position with
 * the authenticated actor and its own clock — exactly as the disposition
 * route refuses a body-supplied actor and instant.
 */
export type NetPositionAction =
  | { action: 'confirm'; version: number }
  | { action: 'amend'; text: string; version: number };

/** The answer to a net-position write: what is stored now, and the finding
 *  row's new version. */
export interface NetPositionWriteResult {
  netPosition: NetPosition;
  version: number;
}

/**
 * A `finding_disposition` row — WHO SET THE CURRENT STATE, and when.
 *
 * `byUserId`/`at` are ABSENT on a finding nobody has touched, never null:
 * §6.3 says such a finding renders as "Not checked" and names nobody, and a
 * `byUserId: undefined` would survive `structuredClone` and read to an `in`
 * check as a name that is there.
 */
export interface DispositionView {
  reviewId: string;
  findingsKey: string;
  clauseId: string;
  state: VerificationState;
  reason?: string;
  byUserId?: string;
  at?: number;
  /** 0 on a disposition nobody has ever moved. */
  changedCount: number;
  version: number;
}

/** What caused a disposition to move. `rerun_reset` is the ONE write this
 *  system performs on its own behalf, and the database refuses it any
 *  `to_state` but `unchecked`. */
export type DispositionCause = 'human' | 'rerun_reset';

/** One `finding_disposition_event` — the evidence half, insert-only. */
export interface DispositionEventView {
  id: number;
  fromState: VerificationState;
  toState: VerificationState;
  reason?: string;
  cause: DispositionCause;
  byUserId: string;
  at: number;
}

/**
 * The answer to a disposition write: the row it produced AND the event that
 * produced it.
 *
 * Both, because §8 says the finding read returns both — so `fromState` is on
 * hand at first render without a second query, and Stage 4's *"was
 * Rejected"* needs no new mechanism.
 */
export interface DispositionWriteResult {
  disposition: DispositionView;
  event: DispositionEventView;
}

/** The answer to `GET …/history`. Newest first. */
export interface DispositionHistory {
  events: DispositionEventView[];
}

/**
 * What a per-clause retry cleared, so the browser can say so in the words it
 * has always used.
 *
 * The transaction that resets a finding knows what the finding actually
 * held; the browser composing that sentence from its own copy would be a
 * second place deciding it.
 */
export interface RetryCleared {
  verification: boolean;
  netPosition: boolean;
}

/** The answer to a per-clause retry: the run it queued, and what it cleared. */
export interface RetryResult {
  run: RunView;
  cleared: RetryCleared;
}
