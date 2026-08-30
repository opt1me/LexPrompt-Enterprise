import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { isAuthFailure } from '../../lib/model/authFailure';
import {
  assessDocument,
  contextBudgetChars,
  repairCitations,
  unchecked,
  normalisePositionOutcome,
  riskCriteriaBlock,
} from '@lexprompt/core';
import type { WorkspaceSettings } from '@lexprompt/core';
import type { PlaybookClause, DocumentFile, Finding, PlaybookVersion, RiskLevel } from '../../types';

const RISK_LEVELS: RiskLevel[] = ['High', 'Medium', 'Low', 'Info'];

export const CLAUSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'EXACT VERBATIM SUBSTRINGS copied from the document text. Never clause numbers such as "Clause 14.2" — the literal text, so it can be located and highlighted.',
    },
    risk_level: { type: 'string', enum: RISK_LEVELS },
    risk_analysis: { type: 'string' },
  },
  required: ['summary', 'citations', 'risk_level', 'risk_analysis'],
  additionalProperties: false,
} as const;

/**
 * The schema sent for one clause's extraction call. Built per call, not a
 * module constant, so `position_outcome`/`position_rationale` are `required`
 * only when the clause actually carries a `standardPosition` — a clause with
 * no house rule must not be forced to invent a comparison. Returns the very
 * same `CLAUSE_SCHEMA` object (not a structurally-equal copy) when there is
 * no position, so callers that compare the schema they sent by reference
 * (existing tests do) see no change for the common case.
 */
export function clauseSchema(clause: PlaybookClause) {
  if (!clause.standardPosition) return CLAUSE_SCHEMA;
  return {
    ...CLAUSE_SCHEMA,
    properties: {
      ...CLAUSE_SCHEMA.properties,
      position_outcome: { type: 'string', enum: ['meets', 'deviates', 'unclear'] },
      position_rationale: { type: 'string' },
    },
    required: [...CLAUSE_SCHEMA.required, 'position_outcome', 'position_rationale'],
  };
}

interface RawFinding {
  summary?: string;
  citations?: unknown;
  risk_level?: string;
  risk_analysis?: string;
  position_outcome?: unknown;
  position_rationale?: unknown;
}

export interface BuildClausePromptOptions {
  /** Overrides `doc.text` — used by `extractClause` to pass the
   *  readability-filtered, budget-truncated text rather than the document's
   *  raw text (which may still carry `[Page N]` markers or sparse-OCR
   *  noise from pages that have a page-image fallback instead). Defaults to
   *  `doc.text` so existing callers/tests that pass a plain document are
   *  unaffected. */
  text?: string;
  /** True when `text` was cut short to fit the model's context budget
   *  (`contextBudgetChars`). Tells the model plainly rather than letting it
   *  answer "silent on this point" about a clause that was simply never
   *  sent. */
  truncated?: boolean;
}

export function buildClausePrompt(
  doc: DocumentFile,
  clause: PlaybookClause,
  template: PlaybookVersion,
  options: BuildClausePromptOptions = {},
): string {
  const riskBlock = riskCriteriaBlock(clause, template);
  const text = options.text ?? doc.text;
  const truncationNote = options.truncated
    ? '\n\nNOTE: The document text above was TRUNCATED to fit the context budget of the selected ' +
      'model and may not include the entire agreement. Do not conclude the agreement is silent on ' +
      'a point solely because it does not appear in the text shown.'
    : '';

  // The evaluation happens IN this call, not a second pass: the model is
  // already reading the clause text with the document in front of it, and a
  // second call would compare a summary against the position rather than the
  // document itself. Gated on `clause.standardPosition` alone — a clause with
  // no house rule gets no block and no `position_outcome`/`position_rationale`
  // ask, so `normalisePositionOutcome` has nothing to record and correctly
  // records nothing (see `positionOutcome.ts`).
  const positionBlock = clause.standardPosition
    ? `\n\nOUR STANDARD POSITION ON THIS CLAUSE:\n${clause.standardPosition.text}\n\n` +
      'Compare what the document says against that position.'
    : '';
  const positionReturnLines = clause.standardPosition
    ? '\n- position_outcome: one of "meets", "deviates", "unclear". Use "unclear" if you cannot tell ' +
      '— do not guess.\n- position_rationale: why. For "deviates", say what the difference is.'
    : '';

  return `DOCUMENT: ${doc.name}

DOCUMENT TEXT:
${text}${truncationNote}

CLAUSE TO REVIEW: ${clause.title}
INSTRUCTION: ${clause.extractPrompt}${riskBlock}${positionBlock}

Return:
- summary: what the document says on this point, or that it is silent.
- citations: exact verbatim substrings from the document text supporting the summary.
- risk_level: one of High, Medium, Low, Info.
- risk_analysis: why that level.${positionReturnLines}

If the document text above is empty and images are attached, read the images instead.`;
}

/**
 * Never rejects (except when the caller's own AbortSignal fires — see
 * below): a failed clause resolves to an error Finding so a run completes
 * with partial results and the cell can be retried on its own.
 *
 * Before ever calling the model, this mirrors the honest decline
 * `chatContext.ts` already makes for the chat panel (via the shared
 * `assessDocument`/`contextBudgetChars` helpers in `lib/modelContext.ts`):
 * a document with no usable text and no attached images, or with page
 * images the selected model can't read, is reported as an error Finding
 * instead of being sent to the model. Without this, a scanned PDF on a
 * text-only model — or any document mammoth/parseFile resolved to empty
 * text — got reviewed anyway and produced a confident, entirely fictional
 * "the agreement is silent on this point."
 */
export interface ExtractClauseContext {
  matterId?: string;
  reviewId?: string;
}

export async function extractClause(
  doc: DocumentFile,
  clause: PlaybookClause,
  template: PlaybookVersion,
  settings: WorkspaceSettings,
  // `signal` stays 5th, its original position: `App.verification.test.tsx`'s
  // `extractClauseMock` destructures the 5th positional argument as the
  // abort signal, and reordering it silently would hand that mock a plain
  // object with no `addEventListener` — not a type error, just a mock that
  // stops seeing the abort. `context` is appended last instead.
  signal?: AbortSignal,
  context: ExtractClauseContext = {},
): Promise<Finding> {
  const base: Finding = {
    clauseId: clause.id,
    status: 'error',
    citations: [],
    verification: unchecked(),
    notes: [],
  };

  if (doc.parseError) {
    return { ...base, error: `Could not read ${doc.name}: ${doc.parseError}` };
  }

  // Unknown capability (list not loaded, fetch failed, or a manually
  // entered model id with no matching list entry) is treated as "cannot" —
  // the same conservative default `chatContext.ts` uses (ChatPanel starts
  // `modelSupportsImages` at `false` until the list resolves).
  const modelSupportsImages = settings.modelSupportsImages ?? false;
  const modelSupportsStructuredOutput = settings.modelSupportsStructuredOutput ?? false;

  const readability = assessDocument(doc, modelSupportsImages);
  if (readability.kind === 'unreadable') {
    return {
      ...base,
      error: `${doc.name} has no readable text or images to review. It may have failed to ` +
        'parse, or be a scan with no extractable content.',
    };
  }
  if (readability.kind === 'needs-image-model') {
    return {
      ...base,
      error: `${doc.name} appears to be a scan with no extractable text, and the model selected ` +
        "in Settings doesn't support image input, so it can't read the scanned pages. Choose an " +
        'image-capable model in Settings to review this document.',
    };
  }

  const budget = contextBudgetChars(settings.modelContextLength);
  const truncated = readability.text.length > budget;
  const textForPrompt = readability.text.slice(0, budget);

  try {
    const raw = await gatewayModelClient.chatJson<RawFinding>(
      {
        modelChoiceId: settings.modelChoiceId,
        purpose: 'review.clause',
        context: {
          matterId: context.matterId,
          reviewId: context.reviewId,
          clauseId: clause.id,
          documentIds: [doc.id],
        },
        system: `${template.systemPrompt}\n\nOUTPUT RULES: ${template.formatPrompt}`,
        user: buildClausePrompt(doc, clause, template, { text: textForPrompt, truncated }),
        images: readability.useImages ? doc.pageImages : undefined,
        jsonSchema: modelSupportsStructuredOutput ? clauseSchema(clause) : undefined,
        temperature: 0.1,
      },
      signal,
    );

    // Case-insensitive on purpose: a mismatched case can only reach here via
    // parseJsonLoose's fallback for models that don't honour the strict
    // schema — exactly the models most likely to emit 'high' instead of
    // 'High'. Still strict about everything else: an unrecognised string,
    // null, or a non-string value all fall through to undefined.
    const level = typeof raw.risk_level === 'string'
      ? RISK_LEVELS.find(l => l.toLowerCase() === raw.risk_level!.toLowerCase())
      : undefined;

    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    // `repairCitations` is shared with the read-time review migration
    // (`src/lib/db/reviewMigration.ts`) precisely so fresh model output and
    // migrated v1 output can never end up in different shapes. It also
    // derives each quote's page from the document's `[Page N]` markers —
    // and leaves `page` absent where the quote cannot be located, rather
    // than guessing.
    //
    // Deliberately `doc.text`, not `readability.text`: `usableText` (the
    // source of `readability.text`) unconditionally strips every `[Page N]`
    // marker while joining surviving pages (see `modelContext.ts`,
    // pinned by `modelContext.test.ts`), so a citation's page could never be
    // derived if this passed `readability.text` instead — silently making
    // "page where derivable" mean "page: never" for every live review. R-B5
    // (redesign-b spec) already names `DocumentRecord.text` — this
    // in-memory document's analogue is `doc.text` — as the intended source:
    // "that text is what persists, what the model was shown, and what
    // survives a reload."
    const citations = repairCitations(raw.citations, doc.id, doc.text);
    const riskAnalysis = typeof raw.risk_analysis === 'string' ? raw.risk_analysis : undefined;
    // The only place a `positionOutcome` is produced — see `positionOutcome.ts`.
    // Returns `{}` when the clause has no `standardPosition`, so a model that
    // volunteers an outcome anyway for a clause with no house rule is
    // ignored: there is nothing to have compared it against.
    const positionFields = normalisePositionOutcome(
      clause.standardPosition, raw.position_outcome, raw.position_rationale,
    );

    // A model with a genuine answer always writes something — even "the
    // agreement is silent on this point" for a clause that's genuinely
    // absent. An empty (or whitespace-only) summary is not that; it's a
    // non-answer the schema happened to accept, and mapping it to 'done'
    // makes it indistinguishable from a real finding (the failure mode this
    // whole guard exists for — see empty-review-investigation.md). Checked
    // on `summary` alone: a real summary with no citations is a legitimate
    // "clause not present" finding and must stay 'done'.
    if (summary.trim() === '') {
      return {
        ...base,
        citations,
        riskLevel: level,
        riskAnalysis,
        ...(truncated ? { truncated: true } : {}),
        // A model that gave an outcome and an empty summary still gave an
        // outcome; dropping it here would lose the one thing it did say.
        ...positionFields,
        error: 'The model returned no content for this clause.',
        noContent: true,
      };
    }

    return {
      clauseId: clause.id,
      status: 'done',
      summary,
      citations,
      riskLevel: level,
      riskAnalysis,
      // Omitted, never assigned `undefined`: `structuredClone` (how
      // IndexedDB writes every record) PRESERVES an undefined-valued key,
      // so `truncated: undefined` persists a key that reads to any `in`
      // check as "truncation was recorded here". Same spread in
      // `extractCollectionClause`, deliberately identical.
      ...(truncated ? { truncated: true } : {}),
      ...positionFields,
      verification: unchecked(),
      notes: [],
    };
  } catch (error) {
    // A cancelled run is not a failure (see App.tsx's own AbortError
    // handling) — an in-flight cell whose request was aborted must show a
    // calm "cancelled" state, not a red error card with a raw DOMException
    // message and a Retry button that will only abort again.
    if ((error instanceof DOMException && error.name === 'AbortError') ||
        (error as { name?: string } | null)?.name === 'AbortError') {
      return { clauseId: clause.id, status: 'cancelled', citations: [], verification: unchecked(), notes: [] };
    }
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      // Omitted rather than set to `undefined`, same rule as `truncated`
      // above: a persisted `authError: undefined` reads to an `in` check
      // as "an auth failure was recorded against this finding".
      ...(isAuthFailure(error) ? { authError: true } : {}),
    };
  }
}
