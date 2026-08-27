import { repairCitations } from '../citationRepair';
import { migrateVersionRecord } from './playbookMigration';
import { unchecked } from '../verification';
import type { Finding, NetPosition, Note, Review, ReviewTarget, TrailStep, Verification } from '../../types';

const STATUSES: Finding['status'][] = ['pending', 'running', 'done', 'error', 'cancelled'];
const STATES: Verification['state'][] = ['unchecked', 'verified', 'flagged', 'rejected'];

/** A stored status this version does not recognise becomes `error`, never
 *  `done`. A finding whose status cannot be read is a finding nobody can
 *  vouch for, and the one thing it must not do is render as a completed,
 *  trustworthy result. */
function readStatus(v: unknown): Finding['status'] {
  return STATUSES.includes(v as Finding['status']) ? (v as Finding['status']) : 'error';
}

/** A stored verification is trusted only when its state is one this version
 *  knows AND a rejection carries its reason. Anything else falls back to
 *  `unchecked` — the honest answer for "we cannot tell what a human
 *  concluded here" — because a half-read verification that renders as
 *  `verified` is exactly the false confidence this sub-project exists to
 *  remove. */
function readVerification(v: unknown): Verification {
  if (!v || typeof v !== 'object') return unchecked();
  const src = v as Partial<Verification>;
  if (!STATES.includes(src.state as Verification['state'])) return unchecked();
  if (src.state === 'rejected' && (typeof src.reason !== 'string' || src.reason.trim() === '')) {
    return unchecked();
  }

  const out: Verification = { state: src.state as Verification['state'] };
  if (typeof src.byUserId === 'string') out.byUserId = src.byUserId;
  if (typeof src.at === 'number' && Number.isFinite(src.at)) out.at = src.at;
  if (src.state === 'rejected' && typeof src.reason === 'string') out.reason = src.reason.trim();
  if (typeof src.assigneeId === 'string') out.assigneeId = src.assigneeId;
  return out;
}

function readNotes(v: unknown): Note[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((n): Note[] => {
    if (!n || typeof n !== 'object') return [];
    const src = n as Partial<Note>;
    if (typeof src.text !== 'string' || src.text.trim() === '') return [];
    return [{
      id: typeof src.id === 'string' ? src.id : `${src.findingId ?? 'note'}-${src.at ?? 0}`,
      findingId: typeof src.findingId === 'string' ? src.findingId : '',
      text: src.text,
      byUserId: typeof src.byUserId === 'string' ? src.byUserId : '',
      at: typeof src.at === 'number' && Number.isFinite(src.at) ? src.at : 0,
    }];
  });
}

/**
 * Rebuilds `Review.target` from `Review.documentIds` on EVERY read, even
 * when a `target` is already stored (ruling F-C1). `Review` holds the
 * document list twice — once at the top level, once inside `target` — and
 * two copies of one fact is this project's most repeated defect shape.
 * Trusting a stored `target.documentIds` would let the two disagree the
 * moment anything writes one without the other; rebuilding here means they
 * cannot drift no matter what wrote them, and `targetDocumentIds()` stays a
 * safe accessor.
 *
 * Only `documentIds` is re-derived. A stored `collection` target's `kind`
 * and `collectionId` are preserved — there is nothing else to derive them
 * from — and an unreadable or absent target becomes a `documents` target
 * over the (already re-derived) `documentIds`, never an absent `target`: a
 * screen that reads `target` must not crash, and an empty list is visibly
 * empty rather than silently missing.
 */
function readTarget(rawTarget: unknown, documentIds: string[]): ReviewTarget {
  if (
    rawTarget &&
    typeof rawTarget === 'object' &&
    (rawTarget as { kind?: unknown }).kind === 'collection' &&
    typeof (rawTarget as { collectionId?: unknown }).collectionId === 'string'
  ) {
    return { kind: 'collection', collectionId: (rawTarget as { collectionId: string }).collectionId, documentIds };
  }
  return { kind: 'documents', documentIds };
}

function migrateFinding(
  raw: unknown,
  documentId: string,
  clauseId: string,
  documentText: string | undefined,
): Finding {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Finding> & Record<string, unknown>;

  const finding: Finding = {
    clauseId: typeof src.clauseId === 'string' && src.clauseId ? src.clauseId : clauseId,
    status: readStatus(src.status),
    citations: repairCitations(src.citations, documentId, documentText),
    verification: readVerification(src.verification),
    notes: readNotes(src.notes),
  };

  if (typeof src.summary === 'string') finding.summary = src.summary;
  if (typeof src.riskLevel === 'string') finding.riskLevel = src.riskLevel as Finding['riskLevel'];
  if (typeof src.riskAnalysis === 'string') finding.riskAnalysis = src.riskAnalysis;
  if (typeof src.error === 'string') finding.error = src.error;
  if (src.edited === true) finding.edited = true;
  if (src.authError === true) finding.authError = true;
  if (src.truncated === true) finding.truncated = true;
  // The NAMES of the documents a collection run cut short. Rebuilt here for
  // the same reason every other field is: a field this function does not
  // add is a field silently discarded on every read, which is how
  // `netPosition` was lost once already. Non-string entries are dropped
  // rather than rendered — this text is shown to a reader as a filename —
  // and an empty result leaves no key at all rather than an empty array
  // that would read as "we checked, nothing was truncated".
  const truncatedDocuments = Array.isArray(src.truncatedDocuments)
    ? src.truncatedDocuments.filter((name): name is string => typeof name === 'string' && name !== '')
    : [];
  if (truncatedDocuments.length > 0) finding.truncatedDocuments = truncatedDocuments;
  if (src.noContent === true) finding.noContent = true;

  const netPosition = readNetPosition(src.netPosition);
  // Assigned conditionally, never as `finding.netPosition = undefined`:
  // `structuredClone` — how IndexedDB writes every record — PRESERVES an
  // `undefined`-valued key, so an unconditional assignment would persist a
  // key that reads as "there was a position here" to any `in` check.
  if (netPosition) finding.netPosition = netPosition;

  return finding;
}

/**
 * Repairs a persisted `NetPosition` on read.
 *
 * This function exists because it was missing. `migrateFinding` rebuilds a
 * `Finding` field by field, and a field nobody adds here is a field silently
 * discarded on every read — which is exactly what happened to `netPosition`:
 * a reopened collection review lost the entire synthesis and its derivation
 * while the record on disk stayed perfectly intact, and rendered as a review
 * that had simply never produced a position. That is this project's founding
 * failure mode ("a failed storage migration rendering an empty library,
 * indistinguishable from a fresh install") relocated one level down, and it
 * survived unit tests because nothing tested that a field-by-field rebuild
 * carries every field.
 *
 * Posture matches `readVerification` and `readStatus` exactly:
 *  - An unreadable `state` becomes `unconfirmed`, NEVER `confirmed`. A
 *    confirmation is a person's judgement; inferring one from a record that
 *    cannot be read would let an export claim a human accepted a synthesis
 *    they never saw.
 *  - A position with no `proposed` text is dropped rather than repaired to
 *    an empty one — an empty position renders as a conclusion that says
 *    nothing, which is worse than no conclusion.
 *  - A malformed trail is repaired to `[]`, not allowed to drop the
 *    position: the conclusion is still the model's real output, and the UI
 *    already says a position without a trail is unsupported.
 */
function readNetPosition(raw: unknown): NetPosition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Partial<NetPosition> & Record<string, unknown>;

  const proposed = typeof src.proposed === 'string' ? src.proposed : '';
  if (proposed.trim() === '') return undefined;

  const out: NetPosition = {
    proposed,
    state: src.state === 'confirmed' ? 'confirmed' : 'unconfirmed',
    trail: Array.isArray(src.trail) ? src.trail.map(readTrailStep) : [],
  };
  if (typeof src.amended === 'string' && src.amended.trim() !== '') out.amended = src.amended;
  if (typeof src.byUserId === 'string') out.byUserId = src.byUserId;
  if (typeof src.at === 'number' && Number.isFinite(src.at)) out.at = src.at;
  return out;
}

/** One step of the derivation. Its citations go through the same
 *  `repairCitations` every other citation does, keyed to the step's OWN
 *  document — a trail step's quotes come from the document that step is
 *  about, not from whatever the finding is filed under (for a collection
 *  that is the collection id, which is not a document at all). No document
 *  text is available here, so `repairCitations` keeps whatever page was
 *  derived at extraction time and invents none. */
function readTrailStep(raw: unknown): TrailStep {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<TrailStep> & Record<string, unknown>;
  const documentId = typeof src.documentId === 'string' ? src.documentId : '';
  return {
    documentId,
    kind: src.kind === 'varies' ? 'varies' : 'original',
    effect: typeof src.effect === 'string' ? src.effect : '',
    citations: repairCitations(src.citations, documentId, undefined),
  };
}

/**
 * Upgrades a persisted review to the current schema on read.
 *
 * Reviews written by sub-project A hold `citations: string[]` and have no
 * `verification` or `notes` at all. They must open — the work in them is
 * real — and they must open honestly: every finding comes back `unchecked`,
 * because nothing in the app could have verified anything before this
 * sub-project existed.
 *
 * The same posture the storage layer took in sub-project A applies here:
 * repair rather than drop. A finding whose status is unreadable becomes an
 * `error` finding that says so, not a `done` one; a verification that cannot
 * be read in full becomes `unchecked`, not a guess. Nothing is discarded
 * except a citation with no quote (which cites nothing) and a note with no
 * text.
 *
 * `documentText` is an optional lookup rather than a required argument so
 * this stays synchronous and independently testable, and so `getReview` need
 * not read the `documents` store to return a review. A caller that has the
 * document text loaded could pass it and get page pins on the migrated
 * citations — but no production caller does today (`reviews.ts`'s
 * `stripSeq`, the only one, always omits it), so a review migrated from
 * before sub-project B opens with citations and no page pins, which is the
 * honest answer spec §4 asks for when a page cannot be derived, not a bug.
 *
 * `versionIndex` (Task 4, sub-project D) maps a playbook id to that
 * playbook's v1 version id, and back-fills `Review.playbookVersionId` for a
 * review written before D — one whose `playbookSnapshot.id` names a
 * playbook that has since been converted to identity + v1 (R-D7). This
 * function stays a PURE repair function: it takes the index as a value and
 * never reaches into the store itself, so the caller (`reviews.ts`) is the
 * only place that has to touch `playbookVersions`, exactly one place. Three
 * rules:
 *  - A review that already has a `playbookVersionId` keeps it, untouched —
 *    including a stale one that no longer resolves to anything (R-D15): the
 *    id is a record of what ran, not a live handle, and only a human action
 *    (there is none here) could ever change what a review claims to have
 *    run against.
 *  - A snapshot id absent from the index (never existed, or the caller
 *    chose not to look it up) leaves the key ABSENT, never `undefined` —
 *    `structuredClone`, how IndexedDB writes every record, preserves an
 *    `undefined`-valued key, and this app's `'x' in obj` checks (R-D4) treat
 *    that as "there is a version" rather than "there is none".
 *  - An empty index (`{}`, the default) therefore leaves every review
 *    unbound rather than guessing — the same posture as every other
 *    unreadable-field fallback in this file.
 */
export function migrateReviewRecord(
  raw: unknown,
  documentText?: (documentId: string) => string | undefined,
  versionIndex: Record<string, string> = {},
): Review {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Review> & Record<string, unknown>;

  const findings: Review['findings'] = {};
  const rawFindings = src.findings;
  if (rawFindings && typeof rawFindings === 'object' && !Array.isArray(rawFindings)) {
    for (const [documentId, byClause] of Object.entries(rawFindings)) {
      if (!byClause || typeof byClause !== 'object') continue;
      const text = documentText?.(documentId);
      findings[documentId] = {};
      for (const [clauseId, finding] of Object.entries(byClause as Record<string, unknown>)) {
        findings[documentId][clauseId] = migrateFinding(finding, documentId, clauseId, text);
      }
    }
  }

  const documentIds = Array.isArray(src.documentIds)
    ? src.documentIds.filter((id): id is string => typeof id === 'string')
    : [];
  const target = readTarget(src.target, documentIds);

  // Sub-project D: `playbookSnapshot` is a `PlaybookVersion` now. A review
  // written before D holds a pre-D `Template` — `mode` and all — and it must
  // still open, because the work in it is real. `migrateVersionRecord` is
  // the same repair `getPlaybookContent` uses, deliberately: two copies of
  // "turn a stale content record into a PlaybookVersion" is the sibling
  // drift this project keeps paying for.
  const playbookSnapshot = migrateVersionRecord(src.playbookSnapshot);

  const out: Review = { ...(src as Review), findings, documentIds, target, playbookSnapshot };

  // Task 4 / R-D4 / R-D15. A review that already names a version — however
  // it got there, including one that no longer resolves to anything — keeps
  // exactly what it has; `versionIndex` never overwrites. Only a review with
  // no id at all gets one back-filled, and only when the index actually has
  // an entry for the playbook its (already-migrated) snapshot names.
  // Omitted, not assigned `undefined`, for the same `structuredClone`
  // reason every other optional field in this file is conditional.
  if (typeof src.playbookVersionId !== 'string' || src.playbookVersionId === '') {
    const versionId = versionIndex[playbookSnapshot.playbookId];
    if (versionId) out.playbookVersionId = versionId;
    else delete out.playbookVersionId;
  }

  return out;
}
