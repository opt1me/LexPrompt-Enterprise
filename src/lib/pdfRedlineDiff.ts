/**
 * The fallback path for sub-project F when there is no markup to read at
 * all — two PDFs, an earlier and a later version, where the changes must be
 * inferred by diffing extracted text rather than read off `<w:ins>`/`<w:del>`
 * (that path is `docxRedlines.ts`). See
 * `docs/superpowers/redesign/spike-2-pdf-pair-diffing.md` — its measurements
 * are the requirements this module is built to, not background reading.
 *
 * Two things the spike found, both load-bearing:
 *
 * - **Sentence-level units, never line-level** (spike Finding 0). `parsePdf`
 *   output has no line structure — pdfjs joins text items into a handful of
 *   huge blocks per page, not visual lines — so a line diff would mark an
 *   entire page changed for a one-word amendment.
 * - **Normalise before comparing: collapse whitespace AND de-hyphenate
 *   across line breaks** (spike Finding 3). Whitespace collapse alone is
 *   predictable. De-hyphenation is the non-obvious one: with whitespace
 *   already collapsed, hyphenation across line breaks alone drops precision
 *   from 1.00 to 0.038. Skipping it does not degrade this function — it
 *   makes it useless.
 *
 * Recall, not precision, is what this function is graded on (spike Finding
 * 2): a changed sentence always differs textually from its predecessor, so
 * a text diff never *misses* an amended clause. Over-flagging gets triaged
 * by a person reading the flagged clause; under-flagging silently omits an
 * amendment from the evidence, which is the failure this project cannot
 * ship.
 */

export interface DiffUnit {
  text: string;
  /** 'amended' where the unit has a counterpart that changed; 'structural'
   *  where it has none at all (an inserted heading, a removed clause).
   *  Spike 2: the model must never be asked to explain a re-typesetting as
   *  if it were a negotiation. */
  kind: 'amended' | 'structural';
}

/** Matches the `[Page N]\n` marker `parsePdf` (`documents.ts`) writes at the
 *  start of each page's text — the same convention `pageSegments.ts` reads.
 *  Stripped, not parsed for page numbers: this module reports *which
 *  sentence* changed, not which page, and a stray marker left in place
 *  would otherwise sit inside a sentence and defeat exact-string matching
 *  for no reason. */
const PAGE_MARKER = /\[Page \d+\]\n?/g;

/** A word broken across a line (or page) break: a hyphen immediately
 *  followed by a run of whitespace containing a newline, then more
 *  whitespace, then the next word character. Deliberately narrow — a hyphen
 *  with a literal newline next to it is not a typesetting choice a real
 *  compound word ("well-known") would ever produce, so this cannot mistake
 *  one for a broken word. Must run BEFORE whitespace is collapsed: collapse
 *  first and the newline that identifies a break is gone, leaving a plain
 *  "word- word" indistinguishable from a hyphenated compound. */
const LINE_BREAK_HYPHEN = /(\w)-\s*\n\s*(\w)/g;

/** Same regex spike 2 measured sentence-splitting with, after `[Page N]`
 *  markers are stripped. Not stress-tested by the spike against `Clause
 *  12.2.1`-style numbering or quoted definitions ending in a full stop —
 *  adequate for this function's job (point at the sentence, let a model
 *  read it) but not a general-purpose sentence splitter. */
const SENTENCE_SPLIT = /(?<=\.)\s+(?=[A-Z0-9"“(])/;

/** LCS is O(n·m). At the ~214 units spike 2 measured for a 20-page lease
 *  this is instant; a 200-page lease at ~2,000 units per side is already 4M
 *  DP cells. This is the bound spike 2 flagged as worth having rather than
 *  assuming — a document pair large enough to blow past it fails loudly
 *  here instead of hanging the tab. */
const MAX_DP_CELLS = 6_000_000;

/** Strips page markers, de-hyphenates line-broken words, then collapses all
 *  remaining whitespace runs (including the newlines that separate pages
 *  and paragraphs) to a single space. Order matters: de-hyphenation must
 *  see the newline before it is collapsed away. */
function normalize(text: string): string {
  const stripped = text.replace(PAGE_MARKER, '');
  const dehyphenated = stripped.replace(LINE_BREAK_HYPHEN, '$1$2');
  return dehyphenated.replace(/\s+/g, ' ').trim();
}

function splitSentences(normalized: string): string[] {
  if (normalized.length === 0) return [];
  return normalized
    .split(SENTENCE_SPLIT)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

type DiffOp = { type: 'equal' | 'delete' | 'insert'; value: string };

/**
 * Standard LCS-backed diff over two sentence arrays, matched by exact
 * string equality on the normalised sentence text. Produces an ordered
 * sequence of equal/delete/insert ops rather than just a similarity score,
 * because `opsToUnits` below needs to know which unmatched sentences are
 * adjacent to which — that adjacency is what tells an inserted heading
 * (insert with no adjoining delete) apart from an amendment (a delete
 * immediately paired with an insert).
 */
function diffSentences(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;

  if ((n + 1) * (m + 1) > MAX_DP_CELLS) {
    throw new Error(
      `This document pair is too large to diff safely (${n} vs ${m} sentence units). ` +
        'Split it into smaller sections before comparing.'
    );
  }

  // dp[i][j] = length of the LCS of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', value: a[i] });
      i++;
    } else {
      ops.push({ type: 'insert', value: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'delete', value: a[i++] });
  }
  while (j < m) {
    ops.push({ type: 'insert', value: b[j++] });
  }
  return ops;
}

/**
 * Groups the diff ops into runs of consecutive non-equal ops ("hunks") and
 * labels each one.
 *
 * A hunk with both deletions and insertions is a genuine amendment: the
 * earlier sentence has a counterpart in the later text that reads
 * differently, so the pair is reported as 'amended', using the LATER
 * sentence's text — that is the wording a reviewer and a model need to
 * read next, not the superseded original. A hunk with only one side
 * (a heading inserted with nothing removed nearby, or a clause removed with
 * nothing put in its place) has no counterpart at all, so it is
 * 'structural' per the interface contract, reported using whichever side's
 * text actually exists.
 *
 * When a hunk's delete and insert counts differ, the first
 * `min(dels, inss)` are paired as amendments and the leftover deletions or
 * insertions on the longer side are reported as structural — they have no
 * counterpart within the hunk either.
 */
function opsToUnits(ops: DiffOp[]): DiffUnit[] {
  const units: DiffUnit[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    const dels: string[] = [];
    const inss: string[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') dels.push(ops[i].value);
      else inss.push(ops[i].value);
      i++;
    }
    const pairCount = Math.min(dels.length, inss.length);
    for (let k = 0; k < pairCount; k++) {
      units.push({ text: inss[k], kind: 'amended' });
    }
    for (let k = pairCount; k < dels.length; k++) {
      units.push({ text: dels[k], kind: 'structural' });
    }
    for (let k = pairCount; k < inss.length; k++) {
      units.push({ text: inss[k], kind: 'structural' });
    }
  }
  return units;
}

/**
 * Compares two extracted texts and returns the sentence-level units that
 * differ. Takes `DocumentRecord.text` — NEVER `usableText` output, which
 * strips `[Page N]` markers and drops sparse pages, and is tuned for model
 * readability rather than the page fidelity a diff needs.
 *
 * Throws rather than returning `[]` when `later` has no extractable text
 * once normalised (an empty string, or one reduced to nothing after its
 * page markers are stripped). A scanned later version has no text layer;
 * diffing it against a real earlier one would report the entire document
 * as deleted — the loudest possible wrong answer, and the founding defect
 * of this project one level up. Spec §3a: a scan yields NO positions, not
 * an empty set of changes. `earlier` is not held to the same guard — an
 * empty earlier text describes "nothing to compare against yet", not a
 * scan silently standing in for a real document, so it degrades to
 * reporting every later sentence as structural rather than throwing.
 */
export function diffExtractedText(earlier: string, later: string): DiffUnit[] {
  const normalizedLater = normalize(later);
  if (normalizedLater.length === 0) {
    throw new Error(
      'The later document has no extractable text to diff against — likely a scan with no text layer.'
    );
  }

  const earlierSentences = splitSentences(normalize(earlier));
  const laterSentences = splitSentences(normalizedLater);

  const ops = diffSentences(earlierSentences, laterSentences);
  return opsToUnits(ops);
}
