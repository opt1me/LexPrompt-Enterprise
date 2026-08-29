import { createHash, randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import {
  ModelError, SERVICE_CONFIG_HINT,
  type InferContext, type Jurisdiction, type ModelErrorCode, type ProviderId, type Purpose,
} from '@lexprompt/core';
import type { CredentialConfig, ModelEntry } from './config.ts';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface AuditStart {
  kind: 'call.started';
  callId: string;
  at: string;
  purpose: Purpose;
  provider: ProviderId;
  model: string;
  modelChoiceId: string;
  jurisdiction: Jurisdiction;
  credentialSource: CredentialConfig['source'];
  workspaceId: string;
  /** Identity is (issuer, subject), never an email and never an
   *  Entra-shaped id (§7, S28). The subject is the value of the issuer's
   *  configured `subjectClaim` — `oid` for Entra, `sub` for Keycloak — and
   *  the two halves are stored separately so Stage 2 can key `app_user` on
   *  the pair without parsing a composite string back apart. */
  actorIssuer: string;
  actorSubject: string;
  matterId?: string;
  reviewId?: string;
  clauseId?: string;
  documentIds?: string[];
  promptSha256: string;
  promptChars: number;
  imageCount: number;
  streaming: boolean;
}

export interface AuditFinish {
  kind: 'call.finished';
  callId: string;
  at: string;
  status: number;
  ok: boolean;
  errorCode?: ModelErrorCode;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  retries: number;
}

export type AuditRecord = AuditStart | AuditFinish;

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

/**
 * One JSON object per line, to a stream — stdout in a container, collected
 * by Azure Monitor or by `docker logs` locally. The write is AWAITED and a
 * stream error REJECTS, which is what makes P3's fail-closed behaviour real
 * rather than aspirational: a fire-and-forget log write cannot fail closed.
 */
export class JsonlAuditSink implements AuditSink {
  #stream: Writable;
  constructor(stream: Writable) {
    this.#stream = stream;
    // A write() callback receiving an error is not the only place Node
    // surfaces it: the stream also EMITS 'error', and an EventEmitter
    // 'error' with no listener is an uncaught exception that crashes the
    // whole process — taking every in-flight call down with it, not just
    // the one whose record could not be written. `write()` below already
    // turns a callback error into a rejected promise, which is what
    // `AuditLogger.start` needs to refuse a single call loudly (P3); this
    // listener exists only so that the SAME failure does not separately
    // crash the process out from under that rejection. It is a no-op, not
    // a swallow: the failure is still reported, once, through the promise.
    this.#stream.on('error', () => {});
  }

  write(record: AuditRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#stream.write(`${JSON.stringify(record)}\n`, err => (err ? reject(err) : resolve()));
    });
  }
}

export interface AuditStartInput {
  purpose: Purpose;
  entry: ModelEntry;
  workspaceId: string;
  actorIssuer: string;
  actorSubject: string;
  context: InferContext;
  system?: string;
  user: string;
  imageCount: number;
  streaming: boolean;
}

export interface AuditFinishInput {
  status: number;
  ok: boolean;
  errorCode?: ModelErrorCode;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  retries: number;
}

/**
 * P3: the started record is written BEFORE the upstream call and its
 * failure refuses the call.
 *
 * "It writes an audit record per call" cannot be satisfied by logging
 * afterwards — a process that died mid-call would then have made an
 * unlogged egress, which is the one thing this component exists to make
 * impossible. Two records also make an egress that started and never
 * finished visible, which answers "what of ours went where" better than a
 * post-hoc record could.
 *
 * `finish` deliberately does NOT throw: by the time it runs the call has
 * happened, and refusing to return an answer the model already produced
 * would lose work without preventing anything. It is logged to stderr and
 * the response carries `callId` so support can find the started record and
 * see the gap.
 */
export class AuditLogger {
  #sink: AuditSink;
  #now: () => Date;
  #newId: () => string;

  constructor(sink: AuditSink, now: () => Date = () => new Date(), newId: () => string = randomUUID) {
    this.#sink = sink;
    this.#now = now;
    this.#newId = newId;
  }

  async start(input: AuditStartInput): Promise<string> {
    const callId = this.#newId();
    // The hashed text is exactly what is sent, so "was this the same
    // prompt?" is answerable in support without keeping the prompt.
    const prompt = input.system ? `${input.system}\n\n${input.user}` : input.user;
    const record: AuditStart = {
      kind: 'call.started',
      callId,
      at: this.#now().toISOString(),
      purpose: input.purpose,
      provider: input.entry.provider,
      model: input.entry.model,
      modelChoiceId: input.entry.id,
      jurisdiction: input.entry.jurisdiction,
      credentialSource: input.entry.credential.source,
      workspaceId: input.workspaceId,
      actorIssuer: input.actorIssuer,
      actorSubject: input.actorSubject,
      ...(input.context.matterId ? { matterId: input.context.matterId } : {}),
      ...(input.context.reviewId ? { reviewId: input.context.reviewId } : {}),
      ...(input.context.clauseId ? { clauseId: input.context.clauseId } : {}),
      ...(input.context.documentIds?.length ? { documentIds: input.context.documentIds } : {}),
      promptSha256: sha256Hex(prompt),
      promptChars: prompt.length,
      imageCount: input.imageCount,
      streaming: input.streaming,
    };

    try {
      await this.#sink.write(record);
    } catch (err) {
      // The `SERVICE_CONFIG_HINT` clause is load-bearing, not decoration.
      // A `ModelError`'s CODE does not survive the findings path —
      // `extractClause` keeps only `error.message` — so the browser
      // classifies a firm-configuration fault by matching this sentence
      // (`protocol.ts`, `ResultsView.tsx`). This was the one
      // `service_misconfigured` in the gateway that omitted it, which made
      // the single failure P3 exists to produce the one that rendered as an
      // ordinary retryable error: the lawyer retries, every retry is
      // refused for the same reason, and nothing tells them or IT that the
      // firm's logging is broken.
      throw new ModelError(
        'This request could not be recorded in the call log, so it was not made. '
        + 'LexPrompt does not send anything to a model it cannot log. This is a '
        + `configuration problem in the firm's deployment, ${SERVICE_CONFIG_HINT}. `
        + `(${(err as Error).message})`,
        'service_misconfigured',
        503,
        callId,
      );
    }
    return callId;
  }

  async finish(callId: string, outcome: AuditFinishInput): Promise<void> {
    const record: AuditFinish = {
      kind: 'call.finished',
      callId,
      at: this.#now().toISOString(),
      status: outcome.status,
      ok: outcome.ok,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      latencyMs: outcome.latencyMs,
      retries: outcome.retries,
    };
    try {
      await this.#sink.write(record);
    } catch (err) {
      process.stderr.write(
        `AUDIT WRITE FAILED for call ${callId}: ${(err as Error).message}\n`,
      );
    }
  }
}
