import {
  SCHEMA_VERSION,
  type Playbook,
  type PlaybookClause,
  type PlaybookDraft,
  type PlaybookVersion,
  type PositionOrigin,
  type StandardPosition,
} from '../../types';
import { DEFAULT_RISK_TOLERANCE, uid } from '@lexprompt/core';

/** The change summary given to the v1 minted for a playbook that existed
 *  before versioning did. Exported because Task 4 needs to recognise it and
 *  because two copies of a user-visible string is exactly the drift
 *  `verificationLabel` exists to prevent. */
export const IMPORTED_SUMMARY = 'Imported from before versioning.';

/**
 * Thrown when a stored playbook record still carries pre-D content keys
 * with no version pointing at them — i.e. the startup conversion has not
 * run over it. Carries its own user-facing message, which is why
 * `describeLoadError` passes it through rather than replacing it with a
 * generic one.
 */
export class UnconvertedPlaybookError extends Error {
  constructor() {
    super(
      "This playbook's clauses haven't finished upgrading to the new versioned " +
        'format, so it cannot be opened yet. Reload the page to finish the upgrade.',
    );
    this.name = 'UnconvertedPlaybookError';
  }
}

/**
 * True when a stored record has content that the startup conversion has not
 * turned into a `PlaybookVersion` yet.
 *
 * The distinction the editor cannot make on its own. `getPlaybookContent`
 * returns `null` both for a playbook that has never been published and for
 * one whose clauses are sitting right there un-converted, and the editor
 * answers `null` with `newPlaybookDraft` — a BLANK editor, presented as the
 * playbook's content, whose next Save publishes an empty v1 and `put`s the
 * real clauses away. The conversion is atomic and `migrateIfNeeded` failing
 * blocks the app, so this is not reachable today; it is one mis-ordered
 * statement away, and this is what turns that from silent content loss into
 * a loud, recoverable failure.
 *
 * Reads the RAW record, not a migrated one: `migratePlaybookRecord` strips
 * the pre-D keys on the way out, so by the time a `Playbook` exists the
 * evidence is gone.
 */
export function carriesUnconvertedContent(input: unknown): boolean {
  const t = (input ?? {}) as Record<string, unknown>;
  // A version pointer means the conversion ran. `draft` is a POST-D key and
  // is deliberately not consulted: a draft on a converted playbook is
  // normal, and a draft is not content the conversion owes anyone.
  if (typeof t.currentVersionId === 'string' && t.currentVersionId) return false;
  const nonEmptyString = (v: unknown) => typeof v === 'string' && v !== '';
  return (
    (Array.isArray(t.clauses) && t.clauses.length > 0) ||
    nonEmptyString(t.systemPrompt) ||
    nonEmptyString(t.formatPrompt) ||
    nonEmptyString(t.riskTolerance) ||
    nonEmptyString(t.contractType) ||
    t.mode === 'risk' ||
    t.mode === 'extraction'
  );
}

/**
 * Brings a playbook record of any earlier shape up to D's identity+versions
 * split. Returns the identity record and, when the input was a pre-D
 * content-carrying record, the draft that should be published as its v1.
 *
 * Repair, never drop (sub-project A): a record that cannot be fully read is
 * repaired to a sane default, and the source is never deleted. A `version`
 * of `null` means "already migrated" — publishing another v1 for it would
 * duplicate the user's history on every app start, which is what makes the
 * idempotency test load-bearing rather than decorative.
 *
 * PURE. It writes nothing and reads no store, so calling it from a read
 * path (`listPlaybooks`, `getPlaybook`) is safe; the WRITE half of the
 * conversion lives in `migrate.ts`'s one-time, flag-guarded startup step
 * (R-D7), because a read path that publishes races itself.
 */
export function migratePlaybookRecord(
  input: unknown,
): { playbook: Playbook; version: PlaybookDraft | null } {
  const t = (input ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const id = typeof t.id === 'string' && t.id ? t.id : uid();
  const name = typeof t.name === 'string' && t.name ? t.name : 'Untitled playbook';
  const createdAt = typeof t.createdAt === 'number' ? t.createdAt : now;
  const updatedAt = typeof t.updatedAt === 'number' ? t.updatedAt : now;

  // Keys are omitted entirely when absent rather than set to `undefined`:
  // `structuredClone` — how IndexedDB writes every record — PRESERVES an
  // `undefined`-valued key, so a plain assignment would leave a stored
  // playbook claiming it has a `draft` (or a `currentVersionId`) that any
  // `in` check would agree was there.
  const playbook: Playbook = {
    id,
    name,
    createdAt,
    updatedAt,
    schemaVersion: SCHEMA_VERSION,
    ...(typeof t.currentVersionId === 'string' && t.currentVersionId
      ? { currentVersionId: t.currentVersionId }
      : {}),
    ...(t.draft && typeof t.draft === 'object' ? { draft: migrateDraft(t.draft, name) } : {}),
  };

  // Already migrated: it has a version pointer, so its content lives in the
  // versions store and there is nothing here to publish.
  if (playbook.currentVersionId) return { playbook, version: null };

  return { playbook, version: migrateDraft(t, name) };
}

/**
 * Repairs any content-shaped record — a pre-D `Template`, a stored
 * `PlaybookDraft`, or the content half of a `PlaybookVersion` — into a
 * `PlaybookDraft`.
 */
export function migrateDraft(input: unknown, fallbackName: string): PlaybookDraft {
  const t = (input ?? {}) as Record<string, unknown>;
  // R-D1: `mode: 'risk'` keeps its risk tolerance so the migrated playbook
  // emits the same RISK CRITERIA block and produces the same review it does
  // today. `mode: 'extraction'` clears it: the editor hides the field
  // outside risk mode but never clears it, so a leftover string would make
  // an extraction playbook start emitting criteria it never had.
  //
  // A record with NO mode at all keeps its tolerance. Every pre-D record
  // has an explicit mode — `playbooks.ts`'s old `migrate()` wrote
  // `t.mode === 'risk' ? 'risk' : 'extraction'` on every read — so the
  // modeless case is a POST-D record (a draft, or a published version being
  // repaired on read through this same function), where clearing would
  // silently delete a tolerance a user typed after `mode` was retired.
  // Treating modeless as extraction, as an earlier draft of this did, would
  // strip the risk block from an already-migrated playbook on every read.
  //
  // The SAME rule governs the per-clause `riskCriteria`, and for the same
  // reason: the pre-D editor hid the "Risk Scorer" field inside the very
  // same `{isRiskMode && …}` guard that hid the tolerance, and never
  // cleared it either. A playbook generated by Create Template -> AI (which
  // wrote `mode: 'risk'` and a populated `riskCriteria` on every clause) and
  // then switched to Standard sends no risk block today; leaving the
  // criteria behind would make `riskCriteriaBlock` start emitting one on
  // every clause. That is why `keepsRisk` — not a tolerance-only flag —
  // is what the clause mapping below is given.
  const hadMode = t.mode === 'risk' || t.mode === 'extraction';
  const keepsRisk = !hadMode || t.mode === 'risk';
  const storedTolerance =
    keepsRisk && typeof t.riskTolerance === 'string' && t.riskTolerance.trim() !== ''
      ? t.riskTolerance
      : undefined;
  // An explicit `mode: 'risk'` with nothing to say still sent
  // `RISK CRITERIA: General commercial reasonableness.` on every clause that
  // had no criteria of its own — the whole block was gated on the flag, not
  // on the strings. Materialising that default here is what makes such a
  // playbook review identically after migration (spec 11); leaving it out
  // silently turned the risk block off for data the user already owns.
  // Only for a record that CARRIED the flag: a modeless (post-D) record is
  // governed by presence, so inventing a tolerance for it would switch the
  // block on instead.
  const riskTolerance =
    storedTolerance ?? (t.mode === 'risk' ? DEFAULT_RISK_TOLERANCE : undefined);

  const draft: PlaybookDraft = {
    name: typeof t.name === 'string' && t.name ? t.name : fallbackName,
    contractType: typeof t.contractType === 'string' ? t.contractType : 'Custom',
    systemPrompt: typeof t.systemPrompt === 'string' ? t.systemPrompt : '',
    formatPrompt: typeof t.formatPrompt === 'string' ? t.formatPrompt : '',
    // Explicit arrow, NOT `.map(migrateClause)`: `Array.prototype.map`
    // passes the index as the second argument, which would arrive as
    // `keepsRisk` and silently clear the criteria on clause 0 alone.
    clauses: Array.isArray(t.clauses) ? t.clauses.map(c => migrateClause(c, keepsRisk)) : [],
    // ABSENT means "a record written before `changeSummary` existed", and
    // that is the only case this labels. An EXPLICIT `''` is preserved:
    // every draft `saveDraft` writes carries `changeSummary: ''` (that is
    // all `draftFromVersion` produces — the publish summary is collected
    // separately by `PublishDialog`), so treating `''` as absent rewrote
    // every reopened draft to IMPORTED_SUMMARY and made
    // `hasUnpublishedContent` report unpublished changes over content
    // byte-identical to the published version, whatever it said. That
    // defeated the duplicate-version guard entirely — a real library holds
    // an identical v1/v2 pair minted this way — and made Version History
    // read "Imported from before versioning." for a playbook exported from
    // a versioned build. `migrateVersionRecord` already draws exactly this
    // distinction on the same field for the same reason; this is the draft
    // branch catching up with it (CLAUDE.md: sibling drift).
    changeSummary: typeof t.changeSummary === 'string' ? t.changeSummary : IMPORTED_SUMMARY,
  };
  // Omitted, never assigned as `undefined` — see the note in
  // `migratePlaybookRecord`, and `migrateClause`'s `standardPosition`.
  if (riskTolerance !== undefined) draft.riskTolerance = riskTolerance;
  return draft;
}

/**
 * Recovers a playbook's id from a possibly-pre-D content record: a real
 * `PlaybookVersion` carries it as `playbookId`; a pre-D `Template` (or a
 * `Review.playbookSnapshot` frozen from one) has no separate identity record
 * at all, so ITS `id` IS the playbook's id.
 *
 * `migrateVersionRecord` and `reviews.ts`'s `buildVersionIndex` both need
 * this exact fact, for the same reason (recovering a playbook id from
 * whichever shape a stored snapshot happens to be), and used to compute it
 * with two separately-written copies of this same fallback chain —
 * `buildVersionIndex`'s own comment even claimed it avoided the duplication
 * it was actually committing. Extracted here so there is one answer to "what
 * playbook does this snapshot belong to", not two that can drift.
 */
export function snapshotPlaybookId(input: unknown): string {
  const t = (input ?? {}) as Record<string, unknown>;
  return typeof t.playbookId === 'string' && t.playbookId !== ''
    ? t.playbookId
    : typeof t.id === 'string'
      ? t.id
      : '';
}

/**
 * Repairs a stored `PlaybookVersion` (or a pre-D `Review.playbookSnapshot`,
 * which is a `Template`) on read.
 *
 * One function rather than one per caller: `getPlaybookContent` and
 * `migrateReviewRecord` both have to turn a possibly-stale content record
 * into a `PlaybookVersion`, and two implementations of that would be the
 * sibling drift CLAUDE.md names. Nothing here invents a change summary: a
 * v1's summary is legitimately empty, and rewriting it to `IMPORTED_SUMMARY`
 * on every read would put words in the publisher's mouth.
 */
export function migrateVersionRecord(input: unknown): PlaybookVersion {
  const t = (input ?? {}) as Record<string, unknown>;
  const name = typeof t.name === 'string' && t.name ? t.name : 'Untitled playbook';
  // A real stored version carries `playbookId`. A pre-D snapshot does not:
  // its `id` IS the playbook's id, and it was never a published version, so
  // it gets no version id rather than one that would resolve to nothing.
  const isVersion = typeof t.playbookId === 'string' && t.playbookId !== '';
  const playbookId = snapshotPlaybookId(t);

  return {
    ...migrateDraft(t, name),
    changeSummary: typeof t.changeSummary === 'string' ? t.changeSummary : '',
    id: isVersion && typeof t.id === 'string' ? t.id : '',
    playbookId,
    version: typeof t.version === 'number' && Number.isFinite(t.version) && t.version > 0
      ? t.version
      : 1,
    publishedAt:
      typeof t.publishedAt === 'number' && Number.isFinite(t.publishedAt)
        ? t.publishedAt
        : typeof t.createdAt === 'number' && Number.isFinite(t.createdAt)
          ? t.createdAt
          : 0,
    publishedByUserId: typeof t.publishedByUserId === 'string' ? t.publishedByUserId : '',
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * `keepsRisk` is R-D1 applied to the clause: `false` only for a record whose
 * playbook carried an explicit `mode: 'extraction'`, where a leftover
 * `riskCriteria` is a string the editor hid and never cleared, and keeping
 * it would silently switch the risk block back on. It defaults to `true`
 * because "no opinion" must mean KEEP — the same reason `migrateDraft`
 * treats a modeless (post-D) record as keeping its tolerance.
 */
export function migrateClause(input: unknown, keepsRisk = true): PlaybookClause {
  const c = (input ?? {}) as Partial<PlaybookClause> & { prompt?: unknown };
  // Both names are read on migration; only the new one is written (spec §5).
  // A pre-D record has `prompt`; anything already migrated has
  // `extractPrompt`. Reading both is what makes this idempotent.
  const extractPrompt =
    typeof c.extractPrompt === 'string' ? c.extractPrompt :
    typeof c.prompt === 'string' ? c.prompt : '';
  const standardPosition = migratePosition(c.standardPosition);
  const riskCriteria = keepsRisk && typeof c.riskCriteria === 'string' ? c.riskCriteria : undefined;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    title: typeof c.title === 'string' ? c.title : 'Untitled clause',
    extractPrompt,
    // Keys omitted entirely when absent, not set to `undefined` — an
    // `undefined`-valued key survives structuredClone (how IndexedDB writes
    // every record), so a plain assignment here would let a cleared
    // criteria (or a dropped position) linger on the stored clause and
    // answer `'riskCriteria' in clause` with `true`.
    ...(riskCriteria !== undefined ? { riskCriteria } : {}),
    ...(standardPosition ? { standardPosition } : {}),
  };
}

/** A position that cannot be read is dropped rather than repaired to an
 *  empty one: an empty-text position would render as "we ask for: (nothing)"
 *  and would make a clause claim a house rule it does not have. Absent is
 *  the honest answer, and it is the same answer a clause that never had a
 *  position gives. */
export function migratePosition(input: unknown): StandardPosition | undefined {
  const p = (input ?? {}) as Partial<StandardPosition>;
  if (typeof p.text !== 'string' || p.text.trim() === '') return undefined;
  const origin: PositionOrigin =
    p.origin === 'ai-drafted' || p.origin === 'learned' ? p.origin : 'authored';
  return {
    text: p.text,
    origin,
    // Unreadable provenance defaults to NOT reviewed. Same reasoning as
    // `readStatus` in sub-project B: the safe default is the one that
    // prompts a human to look.
    reviewedByHuman: p.reviewedByHuman === true,
    // Omitted, never assigned as `undefined` — see the notes in
    // `migratePlaybookRecord` and `migrateClause`. `toEqual` cannot tell the
    // two apart, but `structuredClone` (how IndexedDB writes every record)
    // preserves the key, so an `in` check on a stored position would say a
    // provenance is there when there is none.
    ...(typeof p.provenance === 'string' ? { provenance: p.provenance } : {}),
  };
}
