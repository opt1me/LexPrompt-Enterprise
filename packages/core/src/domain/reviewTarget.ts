import type { ReviewTarget } from './types.ts';

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
 *
 * Six defects in sub-project C came from code that keyed by document id
 * directly: an empty findings pane, a verification and a note written under
 * a key nothing read, a silently empty DOCX export, a silently empty CSV
 * export, and a retry that overwrote a synthesised net position with a
 * one-document answer. This function is now the client/server boundary's
 * copy of that rule as well — the browser, the API and the worker all key
 * through it. If you are reading a findings key anywhere, come through here.
 */
export function findingsKeyFor(target: ReviewTarget, documentId?: string): string {
  if (isCollectionTarget(target)) return target.collectionId;
  if (!documentId) {
    throw new Error('A document review needs a document id to key a finding by.');
  }
  return documentId;
}
