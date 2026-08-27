import type { DocumentRecord } from '../types';

/**
 * A proposed grouping of a base document with the amendments that appear
 * to vary it. Nothing is created from this automatically (ruling R-C4): a
 * human reviews `reason` and decides whether to accept it. A suggestion
 * with no evaluable reason is a guess wearing a UI, so `reason` always
 * names the actual documents and the wording that pointed at them.
 */
export interface CollectionSuggestion {
  baseDocumentId: string;
  variesDocumentIds: string[];
  name: string;
  reason: string;
}

// Filename wording that plausibly marks a document as amending another,
// rather than being a freestanding contract in its own right. Deliberately
// narrow: this is the ONLY signal allowed to trigger a suggestion (besides
// the shared stem below). Two documents sharing ordinary words — "lease",
// an address, "agreement" — must never be enough on their own (R-C4): a
// portfolio's unrelated leases share almost every word.
const AMENDMENT_MARKERS = [
  'deed of variation',
  'licence to alter',
  'license to alter',
  'side letter',
  'supplemental',
  'amendment',
  'addendum',
];

function normalize(name: string): string {
  const withoutExtension = name.replace(/\.[a-z0-9]+$/i, '');
  return withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findMarker(normalized: string): string | undefined {
  return AMENDMENT_MARKERS.find(marker => normalized.includes(marker));
}

/** The part of an amendment's normalized name before the marker word —
 *  what's left must match a candidate base's whole normalized name, not
 *  merely overlap with it, so "Lease - 10 High Street" and "Lease - 20
 *  High Street" (which share the word "lease") are never confused for a
 *  base and its amendment. */
function stemBeforeMarker(normalized: string, marker: string): string {
  const index = normalized.indexOf(marker);
  return normalized.slice(0, index).trim();
}

/**
 * Proposes groupings a human can accept or dismiss. Conservative by
 * construction (ruling R-C4): a suggestion requires BOTH a shared stem
 * with a candidate base AND a filename marker that plausibly names the
 * document as an amendment (a deed of variation, a side letter, and so
 * on) — never filename similarity alone, and never a lone document.
 */
export function suggestCollections(documents: DocumentRecord[]): CollectionSuggestion[] {
  if (documents.length < 2) return [];

  const suggestions: CollectionSuggestion[] = [];
  const entries = documents.map(document => ({ document, normalized: normalize(document.name) }));

  for (const { document: amendmentDoc, normalized: amendmentNormalized } of entries) {
    const marker = findMarker(amendmentNormalized);
    if (!marker) continue;

    const stem = stemBeforeMarker(amendmentNormalized, marker);
    if (!stem) continue; // No distinguishing stem left to match a base against — refuse to guess.

    const baseEntry = entries.find(
      candidate =>
        candidate.document.id !== amendmentDoc.id &&
        candidate.normalized === stem &&
        !findMarker(candidate.normalized),
    );
    if (!baseEntry) continue;

    const existing = suggestions.find(s => s.baseDocumentId === baseEntry.document.id);
    if (existing) {
      if (!existing.variesDocumentIds.includes(amendmentDoc.id)) {
        existing.variesDocumentIds.push(amendmentDoc.id);
        existing.reason += ` "${amendmentDoc.name}" also names it as a ${marker}.`;
      }
      continue;
    }

    suggestions.push({
      baseDocumentId: baseEntry.document.id,
      variesDocumentIds: [amendmentDoc.id],
      name: `${baseEntry.document.name} as varied`,
      reason:
        `"${amendmentDoc.name}" shares "${baseEntry.document.name}"'s name and is named as a ` +
        `${marker}, so it looks like an amendment to it.`,
    });
  }

  return suggestions;
}
