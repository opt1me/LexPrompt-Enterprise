/**
 * What a `.docx` carries beyond its accepted-changes text.
 *
 * DETECTION ONLY. Reading the markup — separating insertions from
 * deletions, attributing them, rendering the workings — is sub-project F's
 * job and has its own spec. Everything here exists so that, until then, the
 * app never tells a lawyer what a contract says on the basis of text whose
 * provenance it quietly changed.
 *
 * The reason this is needed at all (spike 1,
 * `docs/superpowers/redesign/spike-1-docx-tracked-changes.md`): mammoth —
 * the only DOCX reader in the app — reads `<w:ins>` straight through, so an
 * insertion arrives as ordinary unmarked text, and has `<w:del>`,
 * `<w:commentRangeStart>` and `<w:commentRangeEnd>` in its `ignoreElements`
 * map, which is specifically the list dropped WITHOUT the "an unrecognised
 * element was ignored" warning it emits for everything else. So a marked-up
 * draft comes back as fluent, plausible, accepted-changes prose with
 * `messages: []`. Nothing downstream can tell.
 */
export interface DocxMarkup {
  hasTrackedChanges: boolean;
  hasComments: boolean;
}

/**
 * Element-name tests, not letter tests.
 *
 * `<w:insideH>` and `<w:insideV>` are ordinary table-border elements, and
 * `<w:delInstrText>` is a field instruction; all three begin with the
 * letters of the elements we are looking for and appear in great numbers of
 * perfectly clean documents. Requiring the character after the name to be
 * whitespace, `>` or `/` is what separates `<w:ins ` and `<w:ins>` from
 * `<w:insideH>`. Getting this wrong would tell a lawyer that every document
 * containing a table had been redlined, which teaches them to ignore the
 * warning — the one outcome worse than not having it.
 *
 * `<w:commentRangeStart` needs no such guard (no other WordprocessingML
 * element extends that name), but is written the same way so the next
 * person adding a marker does not have to work out which ones need it.
 */
const INSERTION = /<w:ins[\s/>]/;
const DELETION = /<w:del[\s/>]/;
const COMMENT_RANGE = /<w:commentRangeStart[\s/>]/;

/**
 * A move — a clause dragged from one part of the document to another — is
 * recorded by Word as `<w:moveFrom>`/`<w:moveTo>`, NOT as a deletion and an
 * insertion, so the two markers above do not see it. mammoth has no handler
 * for either, which makes a moved clause exactly the failure this module
 * exists to stop: text that changed position (or vanished) with nothing in
 * the output to say so.
 *
 * Detecting it goes one marker beyond the fix brief, which listed
 * `w:ins`/`w:del`/`w:commentRangeStart`. Spike 1 named moves as a gap to be
 * "named in the UI rather than silently mis-rendered", and one regex is the
 * whole cost of naming it. It cannot make the notice wrong: a move is a
 * tracked change, and the notice's "deletions were removed and insertions
 * treated as final" describes what happens to a moved passage too.
 *
 * `w:moveFromRangeStart`/`w:moveToRangeStart` deliberately do not match —
 * the guard requires the name to end — so a move is detected by its content
 * elements, which is where the text actually is.
 */
const MOVE = /<w:move(From|To)[\s/>]/;

/** The name of the part every WordprocessingML document body lives in. */
const BODY_PART = 'word/document.xml';

/**
 * Reports whether a `.docx` carries tracked changes or margin comments.
 *
 * Takes the bytes rather than the `Blob` so the one caller that already
 * holds them (`parseFile`, which must read the file for mammoth regardless)
 * does not read the same file twice.
 *
 * REJECTS rather than reporting "clean" when it cannot look — a corrupt
 * archive, a file that is not a zip, a package with no document part. A
 * detector that answers "no tracked changes" when what it means is "I could
 * not check" is this project's founding failure one level up: the caller
 * would have no way to tell the two apart, and would disclose nothing. The
 * caller is expected to catch this and say that it could not check
 * (`MARKUP_UNCHECKED_NOTICE`), never to treat it as a clean result.
 */
export async function detectDocxMarkup(bytes: ArrayBuffer): Promise<DocxMarkup> {
  // jszip is imported here rather than at the top of the module so that the
  // notice wording below can be imported statically by `documents.ts`
  // (a caller that must be able to say "could not check" even when this
  // import is what failed) without pulling a zip library into the initial
  // bundle. Ingest already lazy-loads pdfjs and mammoth for the same reason.
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file(BODY_PART);
  if (!part) {
    throw new Error(`This .docx has no ${BODY_PART}, so it could not be checked for tracked changes.`);
  }
  const xml = await part.async('string');
  return {
    hasTrackedChanges: INSERTION.test(xml) || DELETION.test(xml) || MOVE.test(xml),
    hasComments: COMMENT_RANGE.test(xml),
  };
}

/**
 * The wording, in one place, for all three things the app might have to say
 * about a DOCX's markup. Every surface that discloses this — the document
 * viewer beside the findings, the document row in a matter — renders these
 * strings rather than composing its own, for the same reason
 * `verificationLabel` is the only place export wording lives: two copies of
 * a caveat drift, and a caveat that drifts stops being one.
 *
 * Each says what the app actually DID, not merely that something was found.
 * "This document contains tracked changes" on its own leaves the reader to
 * guess whether the text below is the original or the marked-up version;
 * the whole point is that it is neither.
 */
export const TRACKED_CHANGES_NOTICE =
  'This document contains tracked changes. The text reviewed below is the document with all changes '
  + 'accepted — deletions were removed and insertions treated as final. Review the original if the '
  + 'markup matters.';

export const COMMENTS_NOTICE =
  'This document contains margin comments, which are not included in the text reviewed below.';

/**
 * Shown when the check itself failed — the document parsed (mammoth read
 * it) but its package could not be opened for inspection. It deliberately
 * does not say the document is clean, and deliberately does not say it is
 * marked up: it says what is true, which is that nobody knows, and what
 * follows from that if it is.
 */
export const MARKUP_UNCHECKED_NOTICE =
  'This document could not be checked for tracked changes or margin comments. If it has any, the text '
  + 'reviewed below is the document with all changes accepted and the comments omitted.';

/** The notice for a detection result, or `undefined` when there is nothing
 *  to disclose. Undefined rather than an empty string so a caller storing
 *  it can leave the field off the record entirely. */
export function markupNoticeFor(markup: DocxMarkup): string | undefined {
  const parts: string[] = [];
  if (markup.hasTrackedChanges) parts.push(TRACKED_CHANGES_NOTICE);
  if (markup.hasComments) parts.push(COMMENTS_NOTICE);
  return parts.length ? parts.join(' ') : undefined;
}
