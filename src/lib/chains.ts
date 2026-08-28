/**
 * Precedent intake: which loose files are the same negotiation, and which
 * role each one plays in it (spec §4.2, §7 "Precedent intake").
 *
 * **Proposed, never assumed (R-F4).** `proposeRole` never returns
 * `inferred: false` — there is no path in this module by which a role
 * becomes a stated fact rather than a guess from a filename (and, weakly,
 * from whether the file carries tracked changes at all). Getting this wrong
 * silently is the worst failure mode this sub-project has: reading the
 * counterparty's own opening draft back as the firm's house position. So the
 * UI downstream must always ask, never assert, and this module's job is only
 * to make the best guess available — not to decide it is right.
 *
 * Chain grouping is conservative for a matching reason. Two documents are
 * proposed as one chain only when their filenames reduce to the exact same
 * "deal stem" once every role/version word is stripped out — no fuzzy or
 * partial matching. A wrongly-merged chain mixes two negotiations' redlines
 * into one position's evidence, which `strength.ts` would then count as
 * votes from a document that was never about that deal.
 *
 * Pure string logic. No I/O, no AI call, no React.
 */

import { uid } from './uid';

export type PrecedentRole = 'their-draft' | 'our-markup' | 'executed' | 'unknown';

export interface PrecedentDocument {
  id: string;
  name: string;
  role: PrecedentRole;
  documentDate?: number;
  /** True when the role was inferred rather than stated, so the UI asks
   *  instead of asserting (R-F4). */
  roleInferred: boolean;
  chainId?: string;
}

/** Filenames that name the counterparty's own document: "their draft",
 *  "landlord draft", "draft from them", and similar. Checked before
 *  `OUR_MARKUP_PATTERN` and `EXECUTED_PATTERN` below only in the sense that
 *  all three are tried in an order chosen to avoid one swallowing another —
 *  see `proposeRole`. */
const THEIR_DRAFT_PATTERN =
  /\b(?:their|counterparty|opposing|landlord|tenant|vendor|purchaser)\s+draft\b|\bdraft\s+from\s+(?:them|counsel)\b/i;

/** A document someone has actually signed or exchanged in final form. Kept
 *  narrow on purpose: "final" alone is too weak a word (a "final draft" is
 *  still a draft), so it is not in this pattern — only in `ROLE_STRIP_PATTERN`
 *  below, where over-matching costs nothing. */
const EXECUTED_PATTERN = /\b(?:fully\s+)?executed\b|\bexecution\s+copy\b|\bsigned\b|\bcounterpart\b/i;

/** Filenames that name markup explicitly. `hasMarkup` (whether the file
 *  itself carries tracked changes, per `docxMarkup`/`docxRedlines`) is
 *  treated as evidence of the same thing when the name alone is silent —
 *  see `proposeRole`. */
const OUR_MARKUP_PATTERN = /\b(?:our\s+)?(?:markup|red-?line|mark-?up)\b/i;

/**
 * The best available guess at who produced a file, from its filename and
 * whether it carries tracked changes — **always** `inferred: true`. There is
 * no confident-enough filename that earns `false`: a name is evidence a
 * person typed, not a fact the document asserts about itself, and the UI's
 * "what is this?" prompt must fire on every document, even the ones this
 * function is sure about.
 *
 * Order matters: an explicit "their draft" beats a generic "markup" mention
 * (a firm might title a comparison "their draft with our markup", which is
 * still, first and foremost, their draft), and an explicit "executed" beats
 * both. `hasMarkup` is consulted last, only once the filename itself has
 * nothing to say — it is corroborating evidence for "we marked this up," not
 * proof, and must not override an explicit filename claim of any other role.
 */
export function proposeRole(name: string, hasMarkup: boolean): { role: PrecedentRole; inferred: boolean } {
  if (EXECUTED_PATTERN.test(name)) return { role: 'executed', inferred: true };
  if (THEIR_DRAFT_PATTERN.test(name)) return { role: 'their-draft', inferred: true };
  if (OUR_MARKUP_PATTERN.test(name) || hasMarkup) return { role: 'our-markup', inferred: true };
  return { role: 'unknown', inferred: true };
}

/** Every word `proposeRole` treats as identifying a role or a version, plus
 *  a few ("final", "copy", "vN") that are too weak to name a role on their
 *  own but still have to be stripped so two files that differ only by one of
 *  these words reduce to the same deal stem. Deliberately broader than the
 *  three role patterns above — over-stripping here only risks merging two
 *  filenames that were already going to collide on everything else, while
 *  under-stripping is what leaves "Brookvale - their draft" and "Brookvale -
 *  our markup" looking like two different deals. */
const ROLE_STRIP_PATTERN =
  /\b(?:their|counterparty|opposing|landlord|tenant|vendor|purchaser)\s+draft\b|\bdraft\s+from\s+(?:them|counsel)\b|\b(?:our\s+)?(?:markup|red-?line|mark-?up)\b|\b(?:fully\s+)?executed\b|\bexecution\s+copy\b|\bsigned\b|\bcounterpart\b|\bdraft\b|\bfinal\b|\bcopy\b|\bv\d+(?:\.\d+)?\b|\bversion\s*\d+\b/gi;

const EXTENSION_PATTERN = /\.[a-z0-9]+$/i;

/**
 * The filename reduced to just the deal it names: extension gone, every
 * role/version word stripped, separators collapsed, case-folded. Two
 * documents chain together only when this string matches exactly — see the
 * module comment for why exact match, not fuzzy match, is the deliberate
 * choice.
 */
function stemOf(name: string): string {
  const withoutExtension = name.replace(EXTENSION_PATTERN, '');
  const withoutRoleWords = withoutExtension.replace(ROLE_STRIP_PATTERN, ' ');
  const withoutSeparators = withoutRoleWords.replace(/[-_,]+/g, ' ');
  return withoutSeparators.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Proposes a `chainId` for every document, grouping filenames that reduce to
 * the same non-empty deal stem (`stemOf`) and never grouping ones that
 * don't. Every document gets a `chainId` — a shared one when it was grouped
 * with at least one other document, otherwise a unique one of its own so it
 * renders as a standalone card (spec §7) rather than colliding with an
 * unrelated document that also failed to match anything.
 *
 * This is a proposal like `proposeRole`'s, not a commitment: spec §8 requires
 * every chain to be user-confirmable and a rejected chain to stay ungrouped
 * rather than being re-proposed — that undo lives in the UI layer that calls
 * this, not here.
 */
export function proposeChains(docs: PrecedentDocument[]): PrecedentDocument[] {
  const stems = docs.map(d => stemOf(d.name));

  const stemCounts = new Map<string, number>();
  for (const stem of stems) {
    if (!stem) continue;
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  const chainIdByStem = new Map<string, string>();
  return docs.map((d, i) => {
    const stem = stems[i];
    const isSharedStem = stem !== '' && (stemCounts.get(stem) ?? 0) > 1;
    if (isSharedStem) {
      let chainId = chainIdByStem.get(stem);
      if (chainId === undefined) {
        chainId = uid();
        chainIdByStem.set(stem, chainId);
      }
      return { ...d, chainId };
    }
    return { ...d, chainId: uid() };
  });
}
