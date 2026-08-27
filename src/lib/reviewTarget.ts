import type { ReviewTarget } from '../types';

export function isCollectionTarget(
  target: ReviewTarget,
): target is Extract<ReviewTarget, { kind: 'collection' }> {
  return target.kind === 'collection';
}

/** Every document the review covers, whichever kind of target it is. The
 *  viewer's tab strip, the exporters and the hydration path all need the
 *  flat list and must not each unpack the union themselves. */
export function targetDocumentIds(target: ReviewTarget): string[] {
  return target.documentIds;
}

/**
 * The key a finding is stored under in `Review.findings`.
 *
 * A document review keys by document — one finding per document per clause,
 * as it always has. A collection review keys by the COLLECTION (ruling
 * R-C1), because it produces one position per clause however many documents
 * fed it; keying by document would force an arbitrary choice of which
 * document "owns" the answer, and every consumer would have to make the
 * same choice the same way.
 *
 * Throws rather than guessing when a document review is asked for a key
 * with no document: there is genuinely no single answer, and returning
 * something plausible would put findings under a key nothing reads.
 */
export function findingsKeyFor(target: ReviewTarget, documentId?: string): string {
  if (isCollectionTarget(target)) return target.collectionId;
  if (!documentId) {
    throw new Error('A document review needs a document id to key a finding by.');
  }
  return documentId;
}
