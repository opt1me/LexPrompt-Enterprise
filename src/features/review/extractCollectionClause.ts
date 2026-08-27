import { chatJson, isAuthError } from '../../lib/openrouter';
import { assessDocument, contextBudgetChars, type DocumentReadability } from '../../lib/modelContext';
import { buildCollectionPrompt } from '../../lib/collectionPrompt';
import { repairCitations } from '../../lib/citationRepair';
import { normalizeForMatch } from '../../lib/citations';
import { unchecked } from '../../lib/verification';
import { unconfirmedPosition } from '../../lib/netPosition';
import type { CollectionMember } from '../../lib/collectionOrder';
import type { Citation, Clause, DocumentFile, DocumentRecord, Finding, Settings, Template, TrailStep } from '../../types';

interface RawCitation {
  quote?: unknown;
  /** 1-based, matching the "DOCUMENT N" labels `buildCollectionPrompt` gives
   *  the model. Independent of which trail step this citation is nested
   *  under — a model can mis-attribute a quote to the wrong step, so this is
   *  resolved per citation, never inherited from its step. */
  document?: unknown;
}

interface RawTrailStep {
  effect?: string;
  citations?: unknown;
}

interface RawCollectionFinding {
  trail?: RawTrailStep[];
  net_position?: string;
}

export const COLLECTION_CLAUSE_SCHEMA = {
  type: 'object',
  properties: {
    trail: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          effect: { type: 'string', description: 'What this document does to this clause, or that it is silent on it.' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                quote: {
                  type: 'string',
                  description: 'EXACT VERBATIM SUBSTRING copied from that document\'s own text.',
                },
                document: { type: 'integer', description: 'The DOCUMENT NUMBER this quote came from.' },
              },
              required: ['quote', 'document'],
              additionalProperties: false,
            },
          },
        },
        required: ['effect', 'citations'],
        additionalProperties: false,
      },
      description: 'One entry per document above, in the same reading order, including any marked UNAVAILABLE.',
    },
    net_position: {
      type: 'string',
      description: 'What the documents, read in order, say NOW about this clause.',
    },
  },
  required: ['trail', 'net_position'],
  additionalProperties: false,
} as const;

/** One present member's readability, computed once and reused for both the
 *  pre-flight guard and image gathering — never recomputed with a different
 *  `modelSupportsImages` value than the one actually checked. */
interface AssessedMember {
  member: CollectionMember<DocumentFile>;
  document: DocumentFile;
  readability: DocumentReadability;
}

/**
 * Resolves which real document a single raw citation came from.
 *
 * Two distinct failure modes, per the collections spec — conflating them
 * would either recover an attribution nobody claimed, or throw away one a
 * garbled response could still be matched back to:
 *
 *  - The citation names a document NUMBER that isn't one of the documents
 *    actually sent (out of range, or pointing at a member that was missing
 *    from the call) — dropped outright. No recovery is attempted: the model
 *    made an explicit, specific claim and got it wrong, so guessing which
 *    document it "really" meant would just substitute one wrong attribution
 *    for another.
 *  - The citation's document number is missing or unparseable (a bare
 *    string citation, or a malformed field from a model that doesn't honour
 *    the schema) — recovered by matching the quote's normalized text against
 *    every present document's own text, and only dropped if no document
 *    contains it.
 */
function resolveCitationDocument(
  entry: unknown,
  present: AssessedMember[],
): DocumentFile | undefined {
  const documentField = typeof entry === 'object' && entry !== null
    ? (entry as RawCitation).document
    : undefined;
  const number = typeof documentField === 'number' && Number.isFinite(documentField)
    ? documentField
    : undefined;

  if (number !== undefined) {
    return present.find(p => p.member.position === number)?.document;
  }

  const quote = typeof entry === 'string' ? entry : (entry as RawCitation | null)?.quote;
  if (typeof quote !== 'string' || !quote.trim()) return undefined;
  const needle = normalizeForMatch(quote);
  if (!needle) return undefined;

  return present.find(p => normalizeForMatch(p.document.text).includes(needle))?.document;
}

/** Resolves and repairs every citation in one trail step's raw response,
 *  one at a time — each citation can resolve to a DIFFERENT real document,
 *  so `repairCitations` (which derives a page from exactly one document's
 *  own text) is called once per citation rather than once per step. */
function resolveStepCitations(rawCitations: unknown, present: AssessedMember[]): Citation[] {
  if (!Array.isArray(rawCitations)) return [];

  const out: Citation[] = [];
  for (const entry of rawCitations) {
    const doc = resolveCitationDocument(entry, present);
    if (!doc) continue;
    // Deliberately `doc.text`, never the readability-filtered text: the
    // latter strips `[Page N]` markers, so a page could never be derived
    // from it (see extractClause.ts's identical note; this is the exact
    // instruction sub-project B got wrong).
    out.push(...repairCitations([entry], doc.id, doc.text));
  }
  return out;
}

/**
 * Reviews one clause across a whole collection (a base document plus its
 * amendments) in a single model call, returning a per-document derivation
 * trail and a proposed net position — never just the conclusion, which
 * would be an assertion with no argument behind it.
 *
 * Never rejects, mirroring `extractClause` exactly: an aborted call
 * resolves to `status: 'cancelled'`, an API failure to `status: 'error'`
 * with `authError` where applicable.
 */
export async function extractCollectionClause(
  members: CollectionMember<DocumentFile>[],
  clause: Clause,
  template: Template,
  settings: Settings,
  signal?: AbortSignal,
): Promise<Finding> {
  const base: Finding = {
    clauseId: clause.id,
    status: 'error',
    citations: [],
    verification: unchecked(),
    notes: [],
  };

  const ordered = [...members].sort((a, b) => a.position - b.position);
  const baseMember = ordered.find(m => m.kind === 'original');

  // Nothing to vary: without the base document there is no starting
  // position for any amendment to act on, so the clause fails loudly rather
  // than reviewing the amendments as if they stood alone.
  if (!baseMember || !baseMember.document) {
    return {
      ...base,
      error: 'The base document for this collection is missing, so there is nothing to vary. ' +
        'Add or restore it before reviewing this collection.',
    };
  }

  const modelSupportsImages = settings.modelSupportsImages ?? false;
  const modelSupportsStructuredOutput = settings.modelSupportsStructuredOutput ?? false;

  // Assessed with the REAL model capability, unlike `buildCollectionPrompt`'s
  // own internal check (which is deliberately text-only — a persisted
  // `DocumentRecord` never carries page images at all). This is the one
  // place that decides whether a scanned member can actually be read: a
  // persisted-record-only path would review a scanned amendment as though it
  // said nothing, which is the defect this whole app was built around,
  // reopened one level up.
  const present: AssessedMember[] = [];
  for (const member of ordered) {
    if (!member.document) continue;
    const readability = assessDocument(member.document, modelSupportsImages);
    if (readability.kind === 'unreadable') {
      return {
        ...base,
        error: `${member.document.name} has no readable text or images to review. It may have ` +
          'failed to parse, or be a scan with no extractable content.',
      };
    }
    if (readability.kind === 'needs-image-model') {
      return {
        ...base,
        error: `${member.document.name} appears to be a scan with no extractable text, and the ` +
          "model selected in Settings doesn't support image input, so it can't read the scanned " +
          'pages. Choose an image-capable model in Settings to review this collection.',
      };
    }
    present.push({ member, document: member.document, readability });
  }

  const budget = contextBudgetChars(settings.modelContextLength);
  // `buildCollectionPrompt`'s landed signature (Task 4) is
  // `CollectionMember<DocumentRecord>[]` — Task 4 never needed page images,
  // so it was never widened to a generic document shape, even though
  // `CollectionMember` itself already documents both callers (see
  // collectionOrder.ts). At runtime it only ever reads `.name`,
  // `.documentDate` and, via `assessDocument`, `.text`/`.pageImages` — every
  // field a `DocumentFile` actually has — so this cast is behaviourally
  // exact; TypeScript can't see that because `DocumentFile` is missing
  // `DocumentRecord`'s persistence-only fields (`matterId`, `byteSize`, ...)
  // that this function never touches. Reported in task-5-report.md rather
  // than widening `collectionPrompt.ts` here, which is out of this task's
  // file scope.
  const membersForPrompt = ordered as unknown as CollectionMember<DocumentRecord>[];
  const { prompt: documentsPrompt, truncated } = buildCollectionPrompt(membersForPrompt, clause, template, budget);

  const imagedMembers = present.filter(p => p.readability.kind === 'ok' && p.readability.useImages);
  const images = imagedMembers.flatMap(p => p.document.pageImages ?? []);
  const imageNote = imagedMembers.length > 0
    ? `\n\nNOTE: DOCUMENT ${imagedMembers.map(p => p.member.position).join(', ')} has no extractable ` +
      'text and is provided as attached image(s) instead. Read the image(s) for that document\'s ' +
      'content rather than concluding it is silent.'
    : '';

  try {
    const raw = await chatJson<RawCollectionFinding>(
      {
        apiKey: settings.apiKey,
        modelId: settings.modelId,
        system: `${template.systemPrompt}\n\nOUTPUT RULES: ${template.formatPrompt}`,
        user: documentsPrompt + imageNote,
        images: images.length > 0 ? images : undefined,
        jsonSchema: modelSupportsStructuredOutput ? COLLECTION_CLAUSE_SCHEMA : undefined,
        temperature: 0.1,
      },
      signal,
    );

    // A conclusion with no trail is an assertion, not a derivation — this
    // must never become a 'done' finding no matter how confident the
    // `net_position` text reads.
    if (!Array.isArray(raw.trail) || raw.trail.length === 0) {
      return {
        ...base,
        error: 'The model returned a net position with no derivation trail. A conclusion drawn ' +
          'across documents needs its per-document reasoning to be trusted, so this is reported as ' +
          'an error rather than a finding.',
      };
    }

    const trail: TrailStep[] = ordered.map((member, index) => {
      const rawStep = raw.trail![index] as RawTrailStep | undefined;
      const modelEffect = typeof rawStep?.effect === 'string' ? rawStep.effect.trim() : '';
      const effect = modelEffect || (member.document
        ? ''
        : 'This document is unavailable and could not be reviewed; the position below cannot account for it.');
      const citations = resolveStepCitations(rawStep?.citations, present);
      return { documentId: member.documentId, kind: member.kind, effect, citations };
    });

    const netPositionText = typeof raw.net_position === 'string' ? raw.net_position.trim() : '';

    // A model with a genuine synthesis always writes something — mirrors
    // extractClause's identical empty-summary guard. An empty string is a
    // non-answer the schema happened to accept, not a real net position.
    if (netPositionText === '') {
      return {
        ...base,
        citations: trail.flatMap(step => step.citations),
        error: 'The model returned no content for this clause.',
        noContent: true,
      };
    }

    // A missing amendment is not silently absorbed into a confident-sounding
    // position: the note is added here, deterministically, rather than
    // relying on the model to have complied with the prompt's own
    // instruction to call out an UNAVAILABLE document.
    const missingAmendments = ordered.filter(m => m.kind !== 'original' && !m.document);
    const proposed = missingAmendments.length > 0
      ? `${netPositionText}\n\n[Incomplete set: ${missingAmendments.map(m => m.documentId).join(', ')} ` +
        'could not be found and this position does not account for it.]'
      : netPositionText;

    return {
      clauseId: clause.id,
      status: 'done',
      citations: trail.flatMap(step => step.citations),
      verification: unchecked(),
      notes: [],
      truncated: truncated.length > 0 || undefined,
      netPosition: unconfirmedPosition(proposed, trail),
    };
  } catch (error) {
    // A cancelled run is not a failure — mirrors extractClause's identical
    // AbortError handling exactly.
    if ((error instanceof DOMException && error.name === 'AbortError') ||
        (error as { name?: string } | null)?.name === 'AbortError') {
      return { clauseId: clause.id, status: 'cancelled', citations: [], verification: unchecked(), notes: [] };
    }
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      authError: isAuthError(error) || undefined,
    };
  }
}
