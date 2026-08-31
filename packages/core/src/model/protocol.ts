/**
 * The wire contract between the browser, `apps/api` and `apps/gateway`.
 *
 * Lives in `packages/core` because all three speak it, and because a
 * second copy of a purpose list or an error code is exactly the drift
 * S14 exists to prevent — here it would mean a call the gateway refuses
 * for a reason the browser has no wording for.
 */

/** §10's purpose allowlist. Closed set: the gateway refuses anything else,
 *  and "what does this system send to a model, and why" is answerable from
 *  this array rather than by reading the application. */
export const PURPOSES = [
  'review.clause',
  'review.collection_clause',
  'assistant.chat',
  'playbook.draft',
  'playbook.suggest',
  'redlines.infer',
  'changeset.build',
  'export.email',
  'export.suggest_fix',
] as const;

export type Purpose = (typeof PURPOSES)[number];

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);
}

/** The provider backends an operator may configure (owner decision 1).
 *  Adding a sixth means adding it here, adding an adapter, and adding a
 *  conformance fixture — and nothing else. */
export const PROVIDER_IDS = [
  'azure-foundry',
  'azure-openai',
  'openai',
  'anthropic',
  'openrouter',
  // The offline recorded-response provider (§5.1). It is an ADAPTER, not a
  // bypass: being on this list is what puts it through the registry
  // completeness test, the stream conformance suite and the jurisdiction
  // gate exactly like the other five, and what lets a firm deployment refuse
  // it through S27's existing mechanism rather than through a new one.
  'recorded',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * The closed set of processing blocs. **Deliberately NOT ISO country codes.**
 *
 * `UK`, never `GB`. Two of these four — `EU` and `other` — are not countries,
 * so one ISO alpha-2 code sitting among them would invite the wrong
 * inference: that these join to country data, and that `DE` or `FR` would be
 * valid. They are not; a German deployment declares `EU`. This comment
 * exists because the next reader's instinct is to "correct" `UK` to `GB`,
 * and the value reaches configuration, every audit record and a picker
 * label — so a rename is a data migration, not a typo fix.
 */
export type Bloc = 'UK' | 'EU' | 'US' | 'other';

/**
 * Where a call is processed (owner decision 3).
 *
 * Declared per allowlist entry by the operator, checked against the
 * gateway's permitted blocs at startup, returned to the browser so it can
 * be shown on the option itself, and written to every audit record. A firm
 * must not be able to believe it is UK-only while routing privileged text
 * to a US region, and the defence against that is this value being
 * unavoidable rather than documented.
 */
export interface Jurisdiction {
  bloc: Bloc;
  /** The provider's own region identifier, e.g. 'uksouth', 'swedencentral', 'us'. */
  region: string;
  /** Human wording for the region, e.g. 'UK South'. */
  label: string;
}

export function jurisdictionLabel(j: Jurisdiction): string {
  return `${j.bloc} · ${j.label}`;
}

/**
 * The operator's record of the retention, training and sub-processing terms
 * they hold with a provider (S26) — **their record of terms they agreed**,
 * not the system's assessment of the provider. `lastCheckedAt` exists so the
 * note can be shown as stale and prompt the operator to re-read their own
 * contract; no code path grades, scores or infers anything from this value.
 */
export interface DataHandling {
  summary: string;
  lastCheckedAt: string;
  reference?: string;
}

/**
 * One entry on the operator's allowlist: a provider and a model on it
 * (S15, as revised to provider+model pairs).
 *
 * `id` is what the browser names. `model` is the provider-side name and
 * never crosses the wire outwards — a user who could name one could name
 * an unreviewed egress destination, which is the whole of what S15 forbids.
 */
export interface AllowedModel {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
  jurisdiction: Jurisdiction;
  contextLength: number;
  supportsImages: boolean;
  supportsStructuredOutput: boolean;
  isDefault: boolean;
  /** S26's dated note. Optional in Stage 1; rendered in Stage 2. */
  dataHandling?: DataHandling;
}

/**
 * WHETHER A CREDENTIAL IS CONFIGURED, AND WHEN IT WAS ROTATED — §14's
 * `credential` suite: *"the admin endpoint reports only whether a credential
 * is configured and when it was rotated."*
 *
 * Nothing else is on this type, and the absence is the feature. There is no
 * `key`, no `keyPrefix`, no `last4`, no `fingerprint` and no `length`. Each
 * of those has been argued for somewhere as a debugging aid; each is a fact
 * about a secret, on an endpoint an administrator would screenshot into a
 * risk pack.
 *
 * Declared beside `AllowedModel` because that is where a reader looks for
 * "what the gateway says about a provider", and because the API's own
 * providers screen joins the two by `provider`.
 */
export interface ProviderStatus {
  provider: ProviderId;
  /**
   * How this deployment authenticates to that provider.
   *
   * `'managed-identity'` is the case where S2's no-key half is TRUE and a
   * screen may say so; every other value is the case where only the custody
   * half holds — the key exists and the gateway is the only process that
   * holds it. §18 item 8 forbids the unconditional claim anywhere, and this
   * field is what lets a screen make the true one instead.
   */
  auth: 'managed-identity' | 'key' | 'none';
  /** Whether a SOURCE IS CONFIGURED for this provider. Never "a token was
   *  obtained" — reporting status must not itself perform an acquisition. */
  configured: boolean;
  /** ISO 8601, or ABSENT. Absent means *not recorded*, never *never*. */
  rotatedAt?: string;
  /** How many allowlist entries route to this provider. Zero is a real and
   *  useful answer: a configured credential nothing uses. */
  modelCount: number;
}

/** The answer to the gateway's `GET /v1/admin/credentials`. */
export interface ProvidersPage {
  providers: ProviderStatus[];
  /** The operator's declared jurisdiction set (S27), echoed so a screen can
   *  show what is ENFORCED rather than what it assumes. */
  declaredJurisdictions: Bloc[];
}

/**
 * What the call was for, in the app's own terms — logged so a client's
 * "what of ours went where, and when" is answerable.
 *
 * `documentIds` is a deliberate addition to §10's listed body fields. §10
 * requires matter/review/clause ids; Stage 1's own goal is that the record
 * says "which document or review the call served", and a clause extraction
 * over three documents cannot say that from a review id alone.
 */
export interface InferContext {
  matterId?: string;
  reviewId?: string;
  clauseId?: string;
  documentIds?: string[];
}

export interface InferRequest {
  /** An `AllowedModel.id` — never a provider-side model name (S15). */
  modelChoiceId: string;
  purpose: Purpose;
  system?: string;
  user: string;
  images?: { mime: string; data: string }[];
  jsonSchema?: object;
  temperature?: number;
  /** Anthropic requires one; the OpenAI-shaped providers do not. The
   *  gateway supplies its configured default when a caller omits it, so no
   *  call site has to know which provider it happens to be talking to. */
  maxTokens?: number;
  context?: InferContext;
}

export interface InferUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Why the model stopped generating, normalised across providers.
 *
 * The providers spell it three ways — OpenAI-shaped ones send
 * `finish_reason: 'length'`, Anthropic sends `stop_reason: 'max_tokens'`,
 * and some relays send nothing at all — and every one of those spellings
 * lives inside `apps/gateway/src/adapters/`. Nothing outside an adapter
 * reads a provider's own wording; `callModel` and the stream route see only
 * these four values.
 *
 *  - `stop`    the model chose to end (including a stop sequence or a
 *              completed tool call). The answer is whole.
 *  - `length`  the provider cut the answer off at a token ceiling. The
 *              answer is a fragment. See `truncationRefusal`.
 *  - `other`   a reason that is neither of those — a content filter, a
 *              refusal, a paused turn. Carried as its own value rather than
 *              folded into `stop`, so "the model finished" is never claimed
 *              on this project's behalf about something else.
 *  - `unknown` the provider said nothing. NOT the same as `stop`: an
 *              absent reason is silence, and silence reading as success is
 *              the failure this whole file is written against.
 */
export type StopReason = 'stop' | 'length' | 'other' | 'unknown';

export interface InferResponse {
  content: string;
  usage: InferUsage;
  /** Quotable to IT when something is wrong. Present on success and on error. */
  callId: string;
  /** Which backend actually answered, and from where. Returned, not just
   *  logged, so the browser can show it rather than assert it. */
  provider: ProviderId;
  jurisdiction: Jurisdiction;
  /**
   * Why the model stopped. The gateway ALWAYS sets it on both paths.
   *
   * Optional on the type only because `src/lib/model/gatewayModelClient.ts`
   * rebuilds an `InferResponse` from a `done` frame and is a separate
   * workspace; `Frame`'s `done` variant and `StreamEnd` both carry it as a
   * REQUIRED field, so the fact always crosses the wire. Nothing is lost by
   * the optionality: a `length` stop never reaches an `InferResponse` at
   * all, because `truncationRefusal` turns it into a `ModelError` first.
   */
  stopReason?: StopReason;
}

// There is deliberately NO `stubbed` flag. `provider === 'recorded'` is the
// fact, and a second field carrying the same fact is the sibling drift S14
// exists to prevent — in the one place where the two copies disagreeing
// would mean the app telling a lawyer an answer came from a model when it
// came from a file (§5.1).

/**
 * The closed set of error codes, as an array rather than a bare union so
 * the wire boundary can CHECK one at runtime (`isModelErrorCode`). An
 * `error` frame arriving with a code nothing recognises used to decode into
 * `new ModelError(msg, undefined, undefined)` — an error whose
 * `isServiceConfigError`, `isSignInError` and `retryable` all read false by
 * accident rather than by judgement.
 */
export const MODEL_ERROR_CODES = [
  'sign_in_required',
  'not_permitted',
  'group_overage',
  'model_not_allowed',
  'jurisdiction_not_allowed',
  'purpose_not_allowed',
  'prompt_too_large',
  'budget_exhausted',
  'rate_limited',
  'service_misconfigured',
  'upstream_failed',
  'stream_truncated',
  // The MODEL stopped mid-answer at a token ceiling — as distinct from
  // `stream_truncated`, where the TRANSPORT stopped. Both mean "what
  // arrived is a fragment"; they are separate codes because the remedies
  // differ. A dropped socket is worth asking again for unchanged; a token
  // ceiling will be hit again by an identical request, so the answer has to
  // be asked for differently or the ceiling raised.
  'answer_truncated',
  'network',
  'unknown',
  'account_disabled',   // 403 — an admin turned this account off. Signing in again changes nothing.
  'no_role',            // 403 — authenticated, in no mapped group. §7's "told plainly", not an empty app.
  'not_found',          // 404 — no such record in this workspace.
  'conflict',           // 409 — a stale write (P9), or an id already owned by another workspace.
  /**
   * 409 — a changeset's base version is no longer the playbook's current
   * one, so publishing it would silently REVERT whatever the newer version
   * added (`ChangesetStaleBaseError`).
   *
   * A code of its own, and that is the whole point of the entry. The refusal
   * used to be an error CLASS the browser caught by identity, and an
   * exception's identity dies at the wire. What arrives is a status and a
   * body — so either the browser matches on the message, which is S1's
   * defect exactly ("reword any one and the browser silently stops
   * classifying: no error, no failing test"), or the CODE is the contract.
   * It is the code. `src/lib/db/changesets.ts` reconstructs the class from
   * it, so every existing caller keeps catching the class it already
   * catches, and the wording is free to change without breaking anything.
   */
  'changeset_stale_base',
  /**
   * 400 — a search query below `SEARCH_MIN_CHARS` (Stage 5).
   *
   * A code rather than a status alone, for the reason the entry above gives:
   * a browser that had to match on the message would silently stop
   * classifying the day the message was reworded. And a code rather than an
   * empty result set, which is the thing this route exists not to answer —
   * "nothing in this firm matches" is a statement about the corpus, and it
   * must never be made about a query that was never run.
   */
  'query_too_short',
  /**
   * 409 — a write aimed at a role mapping that came from
   * `API_ROLE_MAPPINGS` (Stage 5 Part 5C).
   *
   * The DATABASE already refuses it: migration 015 bounds the app role to
   * `source = 'admin'` rows by row-level security. This code exists so the
   * handler can refuse FIRST, with a sentence naming the variable an
   * administrator would have to edit instead — a Postgres row-level-security
   * error is a correct refusal that tells a lawyer nothing they can act on.
   * Both layers are asserted; neither is trusted alone.
   */
  'mapping_is_configuration',
  /**
   * 409 — a change that would leave the workspace with no mapping granting
   * `admin` at all (Stage 5 Part 5C).
   *
   * The message names `API_ROLE_MAPPINGS` because that is the only recovery
   * path once it has happened: nobody would be able to reach the admin
   * screen to undo it, and the repair would be a database session — which is
   * not a repair a firm has at 17:40.
   */
  'last_admin_mapping',
  /**
   * 409 — an administrator asked to disable their own account (Stage 5 Part
   * 5C, §7).
   *
   * Same reasoning as `last_admin_mapping` one object down: the refusal is
   * about the state it would leave behind, not about the act.
   */
  'cannot_disable_self',
  /**
   * 413 — an audit extract whose range holds more rows than
   * `API_AUDIT_EXPORT_MAX_ROWS` (Stage 5 Part 5C, P57).
   *
   * REFUSED rather than truncated. An audit extract is read months later, by
   * somebody who was not there, as evidence; a file whose rows stop at a
   * ceiling nobody stated is a file whose gaps are indistinguishable from
   * absences of activity.
   */
  'export_too_large',
] as const;

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export function isModelErrorCode(value: unknown): value is ModelErrorCode {
  return typeof value === 'string' && (MODEL_ERROR_CODES as readonly string[]).includes(value);
}

/** Retries only 429 and 5xx, exactly as `openrouter.ts` did. Retrying a
 *  rejected credential or a refused deployment wastes the user's time
 *  before telling them the same thing. */
/**
 * The sentence a `service_misconfigured` message ends with, shared by the
 * gateway that WRITES it and the browser that READS it back.
 *
 * It exists as one exported constant because it was three copies across a
 * network boundary: `callModel.ts` and `credentials/resolve.ts` composed it,
 * and `ResultsView.tsx` matched on it with a regex to decide whether a
 * finding's failure was the firm's problem or the user's. Nothing made the
 * three agree. Reword any one of them and the browser silently stops
 * classifying — no error, no failing test, just a firm-configuration fault
 * presented to a lawyer as an ordinary one they might fix.
 *
 * That is sibling drift with a network in the middle, which is the version
 * of it nothing catches by accident. A finding carries only free text on
 * this path (its `code` is not preserved), so matching on wording is the
 * mechanism available — this makes the wording a contract the compiler
 * holds instead of a coincidence two files have to keep.
 */
export const SERVICE_CONFIG_HINT
  = 'not something you can fix here';

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class ModelError extends Error {
  code: ModelErrorCode;
  status: number;
  retryable: boolean;
  callId?: string;
  /**
   * THE ROW THAT WON, on a `conflict` — and nothing else ever sets it.
   *
   * `apps/api`'s `ConflictError` has carried a `current` since Stage 3 and
   * `registerErrorEnvelope` puts it on the wire as a top-level key, for a
   * stated reason: *"a caller that wants to show the reader what actually
   * happened needs no second round trip"*. The browser then threw it away —
   * `modelErrorFrom` read `body.error` and nothing else — so the only thing
   * a refused reviewer could be told was that "this finding changed", which
   * is §6.3's own example of the sentence that tells nobody anything they
   * can act on.
   *
   * Declared HERE rather than in a browser-only subclass because the two
   * ends of one wire must not describe one field two ways: the server class
   * says `readonly current?: unknown` and this says the same, and
   * `modelErrorFrom` is the single reader in the middle.
   *
   * `unknown`, deliberately. `@lexprompt/core` must not learn the shape of
   * every table that can conflict; the caller that knows which write it made
   * is the caller that may narrow it, which is what
   * `conflictingDisposition` (`src/lib/api/findings.ts`) does and the only
   * thing that does.
   *
   * ABSENT, never `current: undefined`. `structuredClone` preserves an
   * undefined-valued key, so a caller checking `'current' in err` would read
   * an absent row as a present one.
   *
   * `declare`, and that word is load-bearing. A plain `current?: unknown;`
   * field declaration EMITS `current = undefined` into the constructor
   * (`useDefineForClassFields`), so every `ModelError` ever thrown — a 404, a
   * network failure, a stream truncation — would carry an own `current` key
   * holding nothing, and `'current' in err` would answer true for all of
   * them. Caught by the test that asserts the absence rather than
   * `toEqual`-ing around it, which is the case `CLAUDE.md` says to write
   * whenever absence is the thing meant.
   */
  declare current?: unknown;

  constructor(message: string, code: ModelErrorCode, status: number, callId?: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.callId = callId;
    // 'network' has no HTTP response at all (status 0) and is always
    // transient; everything else follows the status.
    this.retryable = code === 'network' ? true : isRetryableStatus(status);
  }
}

/**
 * THE decision about a model-truncated answer, made once, for both paths.
 *
 * **A completion cut off at a token ceiling is an ERROR here, not a flagged
 * result.** That is the deliberate choice, and this comment is where it is
 * recorded.
 *
 * The alternative — return the fragment with `stopReason: 'length'` set and
 * let the caller decide — was rejected because it is only as good as every
 * consumer remembering to read a field it did not have yesterday. This
 * codebase has already paid for that exact shape twice: a CSV that wrote
 * unreviewed clauses as blank cells (the fact was present, nothing read
 * it), and a review that recorded schema-valid empty summaries as completed
 * findings. `readResponse` refuses to return `''` for the same reason, one
 * layer up: a half-answer about a contract that renders as a whole one is
 * this project's founding defect, and half a clause analysis ending
 * mid-sentence is exactly that. An exception cannot be ignored by omission;
 * an optional boolean can.
 *
 * Only `length` refuses. `other` (a content filter, a refusal, a paused
 * turn) is carried outward as its own value and NOT refused: those reasons
 * are not necessarily incomplete answers, and inventing a refusal for them
 * here would be this file guessing. `unknown` is not refused either — every
 * provider on the allowlist sends a reason, so `unknown` means a relay
 * omitted one, and refusing every such stream would take a working
 * deployment down to protect against a case nothing has evidence for. Both
 * cross the wire as themselves so a later reader can tighten this with the
 * evidence in hand rather than a schema change.
 */
export function truncationRefusal(stopReason: StopReason, callId?: string): ModelError | null {
  if (stopReason !== 'length') return null;
  return new ModelError(
    'The model ran out of room before it finished this answer, so what it produced is a '
    + 'fragment — it stops mid-thought and has not been returned. Nothing is lost. Ask for a '
    + 'shorter answer, review fewer clauses at once, or ask an administrator to raise this '
    + "deployment's token limit.",
    'answer_truncated',
    // No HTTP status means "the model hit its ceiling", and 0 is already
    // this codebase's "there was no meaningful upstream status" (`network`,
    // `stream_truncated`). It also keeps `retryable` false, which is the
    // truthful answer: an identical request meets the identical ceiling.
    0,
    callId,
  );
}

const SIGN_IN_CODES: ReadonlySet<ModelErrorCode> = new Set(['sign_in_required', 'not_permitted']);
const SERVICE_CONFIG_CODES: ReadonlySet<ModelErrorCode> = new Set([
  'service_misconfigured', 'model_not_allowed', 'purpose_not_allowed',
  // S27's per-call refusal (Task 11). The user chose a model an
  // administrator put on the allowlist; the deployment then declined its
  // jurisdiction. Neither signing in nor anything in Settings can resolve
  // that — an administrator reconciles the allowlist with
  // GATEWAY_ALLOWED_JURISDICTIONS.
  'jurisdiction_not_allowed',
  // Group overage (§7): the token carried no `groups` claim because the user
  // is in too many groups for one to fit. An admin fixes it; signing in again
  // cannot, and nothing in Settings can. So it classifies here and NOT as a
  // sign-in error — the whole point of detecting it separately is that
  // "you have no access" would be a wrong answer told confidently.
  'group_overage',
]);

/**
 * True when the person at the keyboard can fix it by signing in again.
 * The successor to `openrouter.ts`'s `isAuthError` for the half of its
 * meaning that still belongs to the user. Routes to the sign-in action.
 */
export function isSignInError(error: unknown): boolean {
  return error instanceof ModelError && SIGN_IN_CODES.has(error.code);
}

/**
 * True when the FIRM's configuration is wrong: a credential that could not
 * be resolved, a model that is not allowlisted, a purpose the gateway does
 * not know. A different message to a different person — there is nothing
 * in Settings for the user to change, so this must never route there.
 */
export function isServiceConfigError(error: unknown): boolean {
  return error instanceof ModelError && SERVICE_CONFIG_CODES.has(error.code);
}
