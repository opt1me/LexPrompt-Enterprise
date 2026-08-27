import { chatJson, isAuthError } from '../../lib/openrouter';
import { assessDocument, contextBudgetChars, type DocumentReadability } from '../../lib/modelContext';
import { buildCollectionPrompt } from '../../lib/collectionPrompt';
import { repairCitations } from '../../lib/citationRepair';
import { normalizeForMatch } from '../../lib/citations';
import { unchecked } from '../../lib/verification';
import { unconfirmedPosition } from '../../lib/netPosition';
import type { CollectionMember } from '../../lib/collectionOrder';
import type { Citation, Clause, DocumentFile, Finding, Settings, Template, TrailStep } from '../../types';

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
  /** 1-based, matching the same "DOCUMENT N" labels a citation names — the
   *  step's own claim about which document it describes. Resolved, never
   *  inherited from where the step happens to sit in the array, for exactly
   *  the reason `RawCitation.document` exists: a model can skip a document
   *  it judged silent, or return the steps in a different order, and a trail
   *  zipped by array position then attributes one document's legal effect to
   *  another while the card still shows the right name and date. */
  document?: unknown;
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
          document: { type: 'integer', description: 'The DOCUMENT NUMBER this entry describes.' },
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
        required: ['document', 'effect', 'citations'],
        additionalProperties: false,
      },
      description: 'Exactly one entry per document whose text was supplied above — NOT the ones marked UNAVAILABLE — each naming its own DOCUMENT number.',
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
 * The 1-based DOCUMENT number a raw response entry claims for itself — a
 * citation's or a trail step's — or `undefined` when it names none or names
 * something unreadable.
 *
 * Shared by both resolvers rather than parsed twice, so the citation path
 * and the trail path cannot disagree about what counts as a claim. They are
 * the same claim, against the same `DOCUMENT N` labels `buildCollectionPrompt`
 * writes, and this project's most repeated defect is two copies of one rule
 * drifting apart.
 *
 * mn2: a bare integer STRING is read as the number it plainly is. Only a
 * model honouring `COLLECTION_CLAUSE_SCHEMA` is held to JSON types; without
 * structured output the response arrives through `parseJsonLoose`, and
 * `"document": "2"` is an ordinary shape there. Refusing it made the two
 * paths asymmetric in the worst direction — an unreadable number costs a
 * citation one quote, and cost a step the WHOLE CLAUSE, under a message
 * saying the model named no document when it had. By this module's own
 * stated principle, reading an explicit, unambiguous claim is not guessing,
 * and `"2"` is a claim.
 *
 * Nothing looser is accepted: no `"DOCUMENT 2"`, no `"2nd"`, no
 * `parseInt`-style prefix matching, because recovering a number from text
 * that merely contains one IS guessing, and the whole point of this
 * function's caller is to refuse that. A genuinely unparseable value still
 * returns `undefined` and still fails loudly.
 */
const INTEGER_STRING = /^[+-]?\d+$/;

function claimedDocumentNumber(entry: unknown): number | undefined {
  const field = typeof entry === 'object' && entry !== null
    ? (entry as { document?: unknown }).document
    : undefined;

  if (typeof field === 'number') return Number.isFinite(field) ? field : undefined;
  if (typeof field === 'string' && INTEGER_STRING.test(field.trim())) {
    const parsed = Number(field.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
  const number = claimedDocumentNumber(entry);

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
 * Which way an alignment failed. Carried alongside the message because the
 * three cases are not the same failure and do not have the same remedy —
 * see `misalignmentMessage`.
 */
type TrailMisalignmentKind =
  /** The trail does not carry one step per document that was sent. Nothing
   *  has been attributed to anything, and no schema can express a count. */
  | 'count'
  /** A step named no document at all. Structured output makes the field
   *  mandatory, so it is a real remedy here and only here. */
  | 'unnumbered'
  /** A step named a document that was not sent, or two named the same one.
   *  This is the case where an effect would land on the wrong document. */
  | 'unattributable';

/** Why a raw trail could not be aligned to the collection's documents, in
 *  words a reviewer can act on. Never a partial trail — see `alignTrail`. */
interface TrailMisalignment { error: string; kind: TrailMisalignmentKind }

/**
 * The whole message a reviewer sees for a refused trail: what went wrong,
 * what it means, and what would actually help.
 *
 * mn1: one sentence used to be appended to all three refusals, and it was
 * untrue for the count case (nothing had been attributed to anything) and
 * unhelpful in two more — it offered structured output when structured
 * output was already on, and when the schema could not have enforced the
 * thing that failed (`COLLECTION_CLAUSE_SCHEMA.trail` has no `minItems`, so
 * "exactly N entries" is not expressible; that is C1's own argument). And
 * "re-run it" is not a remedy for a model that will deviate the same way
 * every time.
 *
 * CLAUDE.md asks for failures that are loud, SPECIFIC and RECOVERABLE.
 * Where nothing recovers it, saying so is the honest answer; inventing a
 * remedy costs a reviewer a retry that was never going to work and teaches
 * them to distrust the next message that does have one.
 */
function misalignmentMessage(
  misalignment: TrailMisalignment,
  modelSupportsStructuredOutput: boolean,
): string {
  if (misalignment.kind === 'count') {
    return `${misalignment.error} No effect has been attributed to any document, so this clause ` +
      'is reported as an error rather than a finding. The response format cannot require a ' +
      'particular number of steps, so structured output cannot prevent this; if it keeps ' +
      'happening with this model, only a different model will help.';
  }

  if (misalignment.kind === 'unnumbered') {
    const remedy = modelSupportsStructuredOutput
      ? 'The model was asked for this field through structured output and left it out anyway, so ' +
        're-running is unlikely to help; if it keeps happening, only a different model will.'
      : 'Choosing a model that supports structured output would make this field mandatory in the ' +
        "model's response.";
    return `${misalignment.error} Its effect cannot be matched to a document, and an effect read ` +
      'against the wrong document is worse than no answer, so this clause is reported as an error ' +
      `rather than a finding. ${remedy}`;
  }

  return `${misalignment.error} An effect attributed to the wrong document reads as that ` +
    "document's own legal position, so this clause is reported as an error rather than a finding. " +
    'A misnumbered step is a mistake in one response, so re-running the clause may well produce a ' +
    'correctly numbered one.';
}

/**
 * Matches every raw trail entry to the PRESENT member it says it describes,
 * keyed by that member's position in the collection's reading order.
 *
 * This exists because the trail used to be zipped onto `ordered` by ARRAY
 * POSITION, with only an "is it empty" guard in front of it. A model that
 * judged one document silent and skipped it — an entirely ordinary shape for
 * a model asked what each document does to a clause — therefore shifted
 * every later document's effect onto the document above it, while the trail
 * card kept rendering the right name and date from the member. That is the
 * most convincing possible presentation of a false attribution, on a `done`
 * finding, inside the derivation that exists to make a synthesis checkable.
 *
 * So a step is resolved by its own claim, exactly as a citation is
 * (`resolveCitationDocument`), and every way that can fail is an error
 * finding rather than a repaired guess:
 *
 *  - the trail does not carry exactly one step per document that was SENT;
 *  - a step names no document, so nothing can be checked;
 *  - a step names a document that was not sent for this clause;
 *  - two steps name the same document (which necessarily leaves another
 *    with none).
 *
 * A trail returned in a different order but correctly numbered is NOT a
 * failure: the claim is explicit and unambiguous, so it is honoured and
 * re-ordered here. Guessing is what this function refuses; reading is what
 * it does.
 *
 * MJ1: the set matched against is the PRESENT members, never `ordered`. A
 * member whose document is missing had no text in the prompt, so the model
 * cannot have read it and the app already has its own deterministic step for
 * it (see the `trail` build in `extractCollectionClause`). Demanding a step
 * for it made that safeguard — and the "[Incomplete set: ...]" note beside
 * it — conditional on the model inventing one, and failed every clause of a
 * base-plus-missing-amendment collection when it sensibly did not.
 *
 * The bijection C1 rests on still holds, over the present set: `position` is
 * `index + 1` from `orderedMembers` and so is unique per member; this
 * function asserts one step per present member, every number resolving to a
 * present position, and no number repeating. N distinct in-range numbers
 * over N distinctly-positioned present members is injective and therefore
 * bijective, so `byPosition.get(m.position)` is defined for every present
 * member and no hole can appear.
 */
function alignTrail(
  rawTrail: unknown[],
  ordered: CollectionMember<DocumentFile>[],
  present: AssessedMember[],
): { byPosition: Map<number, RawTrailStep> } | TrailMisalignment {
  const presentPositions = new Set(present.map(p => p.member.position));
  const absentPositions = new Set(
    ordered.filter(m => !m.document).map(m => m.position),
  );

  // A step claiming a member whose text was never sent is discarded, not
  // counted and not rendered. Its effect cannot be evidence of anything —
  // the model has not read that document — so keeping it would print
  // invented text as a document's own legal effect, on a `done` finding,
  // inside the derivation that exists to make a synthesis checkable. The
  // deterministic "this document is unavailable" wording replaces it. The
  // original index is kept so an error still names the step the model
  // actually returned.
  const claimed = rawTrail.map((step, index) => ({ step: (step ?? {}) as RawTrailStep, index }));
  const steps = claimed.filter(({ step }) => {
    const number = claimedDocumentNumber(step);
    return number === undefined || !absentPositions.has(number);
  });

  if (steps.length !== present.length) {
    return {
      kind: 'count',
      error: `The model returned ${steps.length} derivation step(s) for the ` +
        `${present.length} document(s) sent for this clause, so its reasoning cannot be matched to them.`,
    };
  }

  const byPosition = new Map<number, RawTrailStep>();
  for (const { step, index } of steps) {
    const number = claimedDocumentNumber(step);
    if (number === undefined) {
      return {
        kind: 'unnumbered',
        error: `The model's derivation step ${index + 1} does not say which document it describes.`,
      };
    }
    if (!presentPositions.has(number)) {
      return {
        kind: 'unattributable',
        error: `The model's derivation step ${index + 1} describes DOCUMENT ${number}, which is not one ` +
          'of the documents sent for this clause.',
      };
    }
    if (byPosition.has(number)) {
      return {
        kind: 'unattributable',
        error: `Two of the model's derivation steps both describe DOCUMENT ${number}, which leaves ` +
          'another document with no reasoning at all.',
      };
    }
    byPosition.set(number, step);
  }

  return { byPosition };
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
    // Checked BEFORE readability, exactly as `extractClause` does for the
    // standalone path — the two must agree on this or they drift, and this
    // one had drifted. A member whose stored bytes could not be re-read
    // arrives with `parseError` set and (for a scan) empty text; without
    // this, `assessDocument` calls it `unreadable` and the reviewer is told
    // the document has "no extractable content", blaming a file that is
    // perfectly fine for a failure to find or re-parse its bytes.
    if (member.document.parseError) {
      return { ...base, error: `Could not read ${member.document.name}: ${member.document.parseError}` };
    }
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
  const { prompt: documentsPrompt, truncated } = buildCollectionPrompt(ordered, clause, template, budget);

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

    // Aligned by each step's own DOCUMENT number, never by array position:
    // an effect attributed to the wrong document is worse than no
    // derivation at all, so anything that cannot be matched fails the
    // clause here rather than reaching `done` looking checkable.
    const aligned = alignTrail(raw.trail, ordered, present);
    if ('error' in aligned) {
      return { ...base, error: misalignmentMessage(aligned, modelSupportsStructuredOutput) };
    }

    // Built over the collection's FULL reading order, from an alignment made
    // over the present members only: a present member takes its aligned step,
    // an absent one takes the deterministic sentence below and no citations
    // (nothing could resolve to a document that was never sent anyway — see
    // `resolveCitationDocument`, which searches `present`). The reader still
    // sees every member of the collection, in order, with the missing one
    // named as missing rather than quietly dropped.
    const trail: TrailStep[] = ordered.map(member => {
      const rawStep = member.document ? aligned.byPosition.get(member.position) : undefined;
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
        // Kept, exactly as `extractClause`'s identical empty-summary branch
        // keeps it. The two extractors had drifted here: a collection whose
        // model returned nothing lost the one recorded fact that best
        // explains why. Conditional, never `undefined`-valued, for the
        // `structuredClone` reason spelled out on the `done` return below.
        ...(truncated.length > 0 ? { truncated: true, truncatedDocuments: truncated } : {}),
      };
    }

    // A missing amendment is not silently absorbed into a confident-sounding
    // position: the note is added here, deterministically, rather than
    // relying on the model to have complied with the prompt's own
    // instruction to call out an UNAVAILABLE document.
    const missingAmendments = ordered.filter(m => m.kind !== 'original' && !m.document);
    // Counted, never listed by id. This note is appended to the position
    // text itself, so it is displayed in `NetPositionPanel`, in the trail
    // modal's terminal card, in the DOCX summary row, in the CSV cell and
    // in the drafted email - every one of them a reader. A raw internal id
    // there says nothing to that reader while looking as though it should;
    // `cd89c27` fixed exactly this shape for a user id, and `trailLines`
    // carries a long comment about why a name belongs where an id was. A
    // member with `document: null` has no name anywhere by definition, so
    // the honest form is to say what is missing in words.
    const missing = missingAmendments.length;
    const proposed = missing > 0
      ? `${netPositionText}\n\n[Incomplete set: ${missing === 1 ? 'one amending document' : `${missing} amending documents`} ` +
        `could not be found, and this position does not account for ${missing === 1 ? 'it' : 'them'}.]`
      : netPositionText;

    return {
      clauseId: clause.id,
      status: 'done',
      citations: trail.flatMap(step => step.citations),
      verification: unchecked(),
      notes: [],
      // Both keys OMITTED, never assigned `undefined`: `structuredClone` —
      // how IndexedDB writes every record — preserves an undefined-valued
      // key, so an unconditional assignment persists a key that reads to any
      // `in` check as "truncation was recorded here".
      //
      // And the NAMES, not just the flag. `buildCollectionPrompt` already
      // collected the filenames it had to cut; collapsing them to a boolean
      // left the card saying "this document exceeds the context budget"
      // about a finding derived from four of them, which cannot tell a
      // reviewer whether the amendment they grouped the collection to ask
      // about is the one that was cut.
      ...(truncated.length > 0 ? { truncated: true, truncatedDocuments: truncated } : {}),
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
      // Omitted rather than set to `undefined`, same rule as `truncated`
      // above: a persisted `authError: undefined` reads to an `in` check
      // as "an auth failure was recorded against this finding".
      ...(isAuthError(error) ? { authError: true } : {}),
    };
  }
}
