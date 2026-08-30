import type { CollectionMember } from './collectionOrder.ts';
import type { PlaybookClause, PlaybookVersion } from './types.ts';
import { riskCriteriaBlock } from './riskBlock.ts';
import { assessDocument } from './modelContext.ts';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// UTC, not local time: `documentDate` is a plain timestamp with no timezone
// of its own, and this module has no DOM/locale to defer to — using UTC
// components keeps the rendered date identical regardless of where or when
// the prompt is built.
function formatDocumentDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function roleLabel(kind: CollectionMember['kind']): 'BASE' | 'VARIES' {
  return kind === 'original' ? 'BASE' : 'VARIES';
}

/** The text this member actually contributes. Never sends page images —
 *  page images are never persisted (CLAUDE.md), and `DocumentRecord` never
 *  carries any, so `modelSupportsImages: false` is not a guess here, it is
 *  simply always true for a persisted record. A missing member (`document:
 *  null`) contributes no text; it is described as unavailable separately. */
function readableText<T extends { text: string }>(member: CollectionMember<T>): string {
  if (!member.document) return '';
  // `false` for image support on purpose: this is the *text* budgeting
  // path, and it must measure only what will be sent as text. Whether a
  // scanned member can additionally be sent as images is `extractClause`'s
  // and `extractCollectionClause`'s decision, made against the real model
  // capability — not something to guess at here.
  const readability = assessDocument(member.document, false);
  return readability.kind === 'ok' ? readability.text : '';
}

/**
 * Splits `budgetChars` across documents that have text, satisfying the
 * shortest documents first and dividing what's left evenly among the rest.
 * This is what keeps a single long document from starving the others: once
 * a short document's actual need is met, its unused share carries forward
 * to documents that still need more, and every document still in the pool
 * gets at least an equal cut of what remains at the moment it's considered
 * — so the base is never driven to zero merely because an amendment is
 * being sent whole (the amendment, being shorter, is settled first and
 * only its actual need is deducted from the shared pool).
 */
function allocateBudget(lengths: number[], budgetChars: number): number[] {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  const allocation = new Array(lengths.length).fill(0);
  let remainingBudget = Math.max(0, budgetChars);
  let remainingDocs = lengths.length;

  for (const i of order) {
    const share = remainingDocs > 0 ? Math.floor(remainingBudget / remainingDocs) : 0;
    const take = Math.min(lengths[i], share);
    allocation[i] = take;
    remainingBudget -= take;
    remainingDocs -= 1;
  }

  return allocation;
}

/**
 * Combines an ordered collection's documents into one prompt for a single
 * clause, asking for each document's individual effect as well as a
 * proposed net position — never just the conclusion, which would be an
 * assertion with no argument behind it (see `NetPosition.trail`).
 *
 * A document cut short to fit `budgetChars` is named — by filename — both
 * in the returned `truncated` array and in the prompt text itself, so
 * "the deed of variation was cut short" is something the model (and later
 * a reviewer) can act on, unlike a bare "the text was truncated". A member
 * whose document is missing is described as unavailable in the prompt
 * rather than silently dropped, so the model knows the set it was handed
 * is incomplete rather than concluding the missing document was silent.
 *
 * Generic over the document shape, constrained to exactly the three fields
 * this function reads. Two callers need different shapes: the UI holds
 * persisted `DocumentRecord`s, and extraction holds hydrated
 * `DocumentFile`s — which carry the page images a scanned member needs and
 * which a record never has. Neither type is assignable to the other, so
 * pinning this to either one forces the other caller into a cast.
 *
 * A cast is what it forced before this was widened, and a cast here would
 * be a lie the compiler stops checking: it asserts one shape *is* the
 * other, works only because this function happens to read fields they
 * share, and would keep on compiling the day someone reads `byteSize` or
 * `role` — fields a `DocumentFile` does not have. Constraining to what is
 * actually used says the same thing truthfully, and keeps saying it.
 */
export function buildCollectionPrompt<
  T extends { name: string; text: string; documentDate?: number },
>(
  members: CollectionMember<T>[],
  clause: PlaybookClause,
  template: PlaybookVersion,
  budgetChars: number,
): { prompt: string; truncated: string[] } {
  const ordered = [...members].sort((a, b) => a.position - b.position);
  const fullTexts = ordered.map(readableText);
  const allocation = allocateBudget(fullTexts.map(t => t.length), budgetChars);

  const truncated: string[] = [];
  // MJ1: the entry count asked for is the number of documents whose text is
  // actually in this prompt, NOT the collection's member count. An
  // UNAVAILABLE member contributes an explanatory block and no text, and
  // `alignTrail` matches steps against the documents that were sent — asking
  // for one more entry than that would either invite a sentence about a
  // document the model has not read, or (when it sensibly declines) fail
  // every clause of a collection with a missing amendment.
  const availableCount = ordered.filter(m => m.document).length;

  const blocks = ordered.map((member, i) => {
    const label = `DOCUMENT ${member.position} (${roleLabel(member.kind)})`;

    if (!member.document) {
      return (
        `${label} — UNAVAILABLE: this document (id ${member.documentId}) is missing from the ` +
        'matter, so none of its text is included below. Do not assume it is silent on this clause, ' +
        'and do not return a trail entry for it — you have not read it. Say in the net_position ' +
        'that the set is incomplete and that the position cannot account for this document.'
      );
    }

    const dateSuffix = member.document.documentDate !== undefined
      ? `, dated ${formatDocumentDate(member.document.documentDate)}`
      : '';
    const header = `${label} — "${member.document.name}"${dateSuffix}`;

    const fullText = fullTexts[i];
    const allotted = allocation[i];
    const wasTruncated = allotted < fullText.length;
    if (wasTruncated) truncated.push(member.document.name);

    const text = fullText.slice(0, allotted);
    const truncationNote = wasTruncated
      ? `\n\n[${member.document.name} was cut short to fit the context budget and may not include ` +
        'the entire document. Do not conclude it is silent on this clause solely because the text ' +
        'shown for it does not mention it.]'
      : '';

    return `${header}\n${text}${truncationNote}`;
  });

  const riskBlock = riskCriteriaBlock(clause, template);

  // Task 6: evaluation happens in this same call, against the NET POSITION
  // the model is about to derive — not the base document alone, and not a
  // second call over a summary. Gated on `clause.standardPosition` alone, so
  // a clause with no house rule gets no block and no
  // `position_outcome`/`position_rationale` ask.
  const positionBlock = clause.standardPosition
    ? `\n\nOUR STANDARD POSITION ON THIS CLAUSE:\n${clause.standardPosition.text}\n\n` +
      'Compare the NET POSITION you have just derived against our standard position.'
    : '';
  const positionReturnLines = clause.standardPosition
    ? '\n- position_outcome: one of "meets", "deviates", "unclear". Use "unclear" if you cannot tell ' +
      '— do not guess.\n- position_rationale: why. For "deviates", say what the difference is.'
    : '';

  const truncationSummary = truncated.length > 0
    ? `\n\nNOTE: The following document(s) were cut short to fit the context budget and may be ` +
      `incomplete: ${truncated.join(', ')}.`
    : '';

  const prompt = `${blocks.join('\n\n')}

CLAUSE TO REVIEW: ${clause.title}
INSTRUCTION: ${clause.extractPrompt}${riskBlock}${positionBlock}${truncationSummary}

Return EXACTLY ${availableCount} trail entr${availableCount === 1 ? 'y' : 'ies'} — one per document above whose text
was supplied — in reading order (base first, then each amendment as it takes effect). Do NOT return
an entry for a document marked UNAVAILABLE: its text was never sent, so anything written about it
would be invented rather than read, and the app records the fact that it is missing itself. Say in
the net_position that the set is incomplete instead. Each entry has:
- document: the DOCUMENT NUMBER above that this entry describes. Required on every entry: an entry
  that does not name its document cannot be matched to one, and an effect read against the wrong
  document is worse than no answer, so the whole clause is rejected rather than guessed at.
- effect: what that document does to this clause, or that it is silent on it. Never skip a document
  because you judged it silent — say that it is silent, in its own entry.
- citations: exact verbatim substrings from that document's own text supporting its effect.
- net_position: the proposed conclusion — what the documents, read together and in this order, say
  NOW about this clause. It must follow from the effects above, not stand alone as a bare answer.${positionReturnLines}`;

  return { prompt, truncated };
}
