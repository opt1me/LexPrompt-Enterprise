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
