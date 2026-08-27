import { repairCitations } from '../citationRepair';
import { unchecked } from '../verification';
import type { Finding, Note, Review, Verification } from '../../types';

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
  if (src.noContent === true) finding.noContent = true;

  return finding;
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
 */
export function migrateReviewRecord(
  raw: unknown,
  documentText?: (documentId: string) => string | undefined,
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

  return { ...(src as Review), findings };
}
