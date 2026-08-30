import type { Collection, DocumentRecord } from './types.ts';

/**
 * One position in a collection's reading order: either the base document
 * or one of its amendments. `document` is `null` — never omitted — when
 * the id the `Collection` names is not among the documents supplied: the
 * caller must be able to say "the deed of variation is gone" instead of
 * silently reading an incomplete set as though it were whole.
 *
 * Generic over the document shape on purpose. Two callers need different
 * ones and neither can be converted to the other:
 *
 *  - The matter home and the variation trail hold `DocumentRecord`s — the
 *    persisted shape, which by design carries no page images (sub-project
 *    A's ruling: page images are derived data, regenerated on demand, never
 *    stored).
 *  - Extraction holds `DocumentFile`s — hydrated at run time, *with* page
 *    images where a document is a scan.
 *
 * Pinning this to `DocumentRecord` would force extraction to either give up
 * the image fallback or bypass this function, and a collection containing a
 * scanned deed of variation would then be reviewed as though that document
 * said nothing. This project's founding defect was a scanned PDF reviewed
 * by a text-only model answering "the agreement is silent on this point"
 * for every clause; the same hole must not reopen one level up.
 */
export interface CollectionMember<T = DocumentRecord> {
  document: T | null;
  documentId: string;
  kind: 'original' | 'varies';
  /** 1-based position in reading order. */
  position: number;
}

/**
 * The order a collection reads in: the base document, then its amendments
 * in the order `Collection.variesDocumentIds` stores them.
 *
 * Deliberately NOT a sort by `documentDate` (ruling R-C3): a date can be
 * missing, wrong or ambiguous, and the order in which amendments take
 * effect is a legal judgement someone made when they built the collection,
 * not something to re-derive on every render. `documentDate` is shown to
 * the reader; it never decides order here.
 *
 * A member whose document isn't in `documents` comes back with
 * `document: null` at its rightful position rather than being dropped —
 * including the base itself, which is never silently promoted away from
 * position 1 by an amendment moving up to fill the gap.
 */
export function orderedMembers<T extends { id: string }>(
  collection: Collection,
  documents: T[],
): CollectionMember<T>[] {
  const byId = new Map(documents.map(doc => [doc.id, doc]));

  const memberIds: { documentId: string; kind: CollectionMember['kind'] }[] = [
    { documentId: collection.baseDocumentId, kind: 'original' },
    ...collection.variesDocumentIds.map(documentId => ({ documentId, kind: 'varies' as const })),
  ];

  return memberIds.map((member, index) => ({
    document: byId.get(member.documentId) ?? null,
    documentId: member.documentId,
    kind: member.kind,
    position: index + 1,
  }));
}
