/**
 * Reads the markup `mammoth` throws away: insertions, deletions, moves and
 * margin comments in a `.docx`.
 *
 * `docxMarkup.ts` answers a yes/no question ("does this file carry tracked
 * changes at all?") with a substring test over raw XML, cheaply, at ingest.
 * This module answers a different one — "what do the edits actually say,
 * who made them, and in what context?" — which needs structure, not a
 * substring test: an insertion and a deletion must not be conflated, a
 * comment must be joined to the passage it was left on, and a move must not
 * be reported as an unrelated delete-then-insert (R-F3). So this reads
 * `word/document.xml` as XML via `DOMParser`, plus `word/comments.xml` when
 * present, rather than regexing the source.
 *
 * See `docs/superpowers/redesign/spike-1-docx-tracked-changes.md` for why
 * mammoth cannot be used for this at all.
 */

export type RedlineEditKind = 'insertion' | 'deletion' | 'comment' | 'moved';

export interface ParsedEdit {
  kind: RedlineEditKind;
  /** The inserted, deleted, or comment text. */
  text: string;
  /** The surrounding paragraph, so an edit can be read in context. */
  context: string;
  author?: string;
  at?: number;
}

export interface ParsedRedlines {
  edits: ParsedEdit[];
  /** False when the document simply has no markup — distinct from a failure
   *  to read it, which throws. "No tracked changes" and "could not look" are
   *  different facts and the caller must be able to tell them apart. */
  hasMarkup: boolean;
}

/** The two package parts this module reads. Word always writes comments at
 *  this path when a document has any; there is no need to resolve
 *  `word/_rels/document.xml.rels` to find it. */
const BODY_PART = 'word/document.xml';
const COMMENTS_PART = 'word/comments.xml';

interface CommentInfo {
  author?: string;
  at?: number;
  text: string;
}

/**
 * Parses an XML part and rejects rather than returning a document that
 * silently has none of the elements we are looking for. `DOMParser` does not
 * throw on malformed XML — it returns a document containing a
 * `<parsererror>` element instead — so that has to be checked for
 * explicitly, or a corrupt part would read back as "no markup found", which
 * is exactly the collapse this module exists to prevent.
 */
function parseXml(xml: string, partName: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    throw new Error(`${partName} could not be parsed as XML: ${error.textContent?.trim() ?? 'unknown error'}`);
  }
  return doc;
}

/** Parses the numeric epoch, or `undefined` when the attribute is absent or
 *  not a date `Date.parse` can make sense of. Never `NaN` — an edit with a
 *  garbled date is one with no date, not one with an unusable number. */
function parseDate(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Every `w:t`/`w:delText` descendant of `el`, in document order, regardless
 * of how deeply nested (a run inside a hyperlink inside a smart tag is still
 * a run). This is deliberately tag-based, not text-node-based: OOXML runs
 * carry no free text outside `w:t`/`w:delText`, and walking text nodes
 * directly would also pick up whitespace from indentation between elements
 * in a pretty-printed part.
 */
function collectText(el: Element, tag: 'w:t' | 'w:delText'): string {
  const parts: string[] = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.tagName === tag) {
        parts.push(child.textContent ?? '');
      } else {
        walk(child);
      }
    }
  };
  walk(el);
  return parts.join('');
}

/**
 * The paragraph read as a single string, original wording and revised
 * wording both included in document order — the "before" and "after" of a
 * redline read together, which is what makes it legible as a change rather
 * than two unrelated fragments. Element-name matching (`w:t`/`w:delText`),
 * not letter matching: this is what keeps `w:insideH` — a real OOXML
 * table-border element that happens to start with the same letters as
 * `w:ins` — from being mistaken for run content.
 */
function contextOf(p: Element): string {
  const parts: string[] = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.tagName === 'w:t' || child.tagName === 'w:delText') {
        parts.push(child.textContent ?? '');
      } else {
        walk(child);
      }
    }
  };
  walk(p);
  return parts.join('');
}

/** The nearest enclosing `w:p`, or `null` for an edit marker that (unusually)
 *  sits outside any paragraph — a table-border element, for instance, which
 *  is exactly the case `contextFor` below has to not blow up on even though
 *  it is never itself mistaken for an edit. */
function enclosingParagraph(el: Element): Element | null {
  let node: Element | null = el.parentElement;
  while (node) {
    if (node.tagName === 'w:p') return node;
    node = node.parentElement;
  }
  return null;
}

function contextFor(el: Element): string {
  const p = enclosingParagraph(el);
  return p ? contextOf(p) : '';
}

function makeEdit(kind: RedlineEditKind, el: Element, text: string): ParsedEdit {
  return {
    kind,
    text,
    context: contextFor(el),
    author: el.getAttribute('w:author') ?? undefined,
    at: parseDate(el.getAttribute('w:date')),
  };
}

/**
 * Insertions, deletions and moves anywhere in the document.
 *
 * Matched by exact element name (`getElementsByTagName('w:ins')`, not a
 * substring test over every element) — the reason is `w:insideH`/`w:insideV`,
 * real OOXML table-border elements that happen to start with the same
 * letters as `w:ins` and appear in the properties of any table, nowhere near
 * a paragraph. A letter match run over the whole document, not just inside
 * paragraphs, would catch them and report every document with a table as
 * redlined — which teaches a reviewer to ignore the warning, the one outcome
 * worse than not having it.
 *
 * A move is `w:moveFrom`/`w:moveTo`, never `w:del`/`w:ins` — Word's own
 * distinction between "this text changed" and "this text went somewhere
 * else". Reporting a move as an unrelated deletion plus an unrelated
 * insertion is R-F3's exact defect: a clause that was relocated reads as one
 * that was cut and a different one added, which is not what happened and
 * not what a reviewer should be told happened. `w:moveFrom` content is
 * carried in `w:delText` (the moved-away text, like a deletion); `w:moveTo`
 * content is carried in `w:t` (the moved-in text, like an insertion) — that
 * is Word's own encoding, not a choice made here.
 */
function wrapperEdits(doc: Document): ParsedEdit[] {
  const edits: ParsedEdit[] = [];
  for (const el of Array.from(doc.getElementsByTagName('w:ins'))) {
    edits.push(makeEdit('insertion', el, collectText(el, 'w:t')));
  }
  for (const el of Array.from(doc.getElementsByTagName('w:del'))) {
    edits.push(makeEdit('deletion', el, collectText(el, 'w:delText')));
  }
  for (const el of Array.from(doc.getElementsByTagName('w:moveFrom'))) {
    edits.push(makeEdit('moved', el, collectText(el, 'w:delText')));
  }
  for (const el of Array.from(doc.getElementsByTagName('w:moveTo'))) {
    edits.push(makeEdit('moved', el, collectText(el, 'w:t')));
  }
  return edits;
}

/** Margin comments anywhere in the document, joined to `comments.xml` by
 *  `w:id`. A `w:commentRangeStart` whose id has no match in the comments
 *  part (a corrupt or partially-stripped package) is silently skipped
 *  rather than reported as a comment with no text — there is nothing
 *  honest to say about a comment that cannot be found. */
function commentEdits(doc: Document, comments: Map<string, CommentInfo>): ParsedEdit[] {
  const edits: ParsedEdit[] = [];
  for (const start of Array.from(doc.getElementsByTagName('w:commentRangeStart'))) {
    const id = start.getAttribute('w:id');
    const info = id != null ? comments.get(id) : undefined;
    if (!info) continue;
    edits.push({ kind: 'comment', text: info.text, context: contextFor(start), author: info.author, at: info.at });
  }
  return edits;
}

function parseComments(xml: string): Map<string, CommentInfo> {
  const doc = parseXml(xml, COMMENTS_PART);
  const map = new Map<string, CommentInfo>();
  for (const c of Array.from(doc.getElementsByTagName('w:comment'))) {
    const id = c.getAttribute('w:id');
    if (id == null) continue;
    map.set(id, {
      author: c.getAttribute('w:author') ?? undefined,
      at: parseDate(c.getAttribute('w:date')),
      text: collectText(c, 'w:t').trim(),
    });
  }
  return map;
}

/**
 * Reads a `.docx`'s tracked changes, moves and margin comments directly
 * from its OOXML, bypassing mammoth (which unwraps `w:ins` to plain text
 * and silently drops `w:del` and comment markers — see spike 1).
 *
 * REJECTS rather than reporting `{ hasMarkup: false, edits: [] }` when the
 * file cannot be read at all — not a zip, or a zip with no
 * `word/document.xml`. Collapsing "no markup" and "could not look" into the
 * same result is this project's founding defect one level up: a reviewer
 * told a marked-up draft is clean, when what actually happened is that
 * nobody checked.
 */
export async function parseDocxRedlines(file: Blob): Promise<ParsedRedlines> {
  const bytes = await file.arrayBuffer();
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);

  const bodyPart = zip.file(BODY_PART);
  if (!bodyPart) {
    throw new Error(`This .docx has no ${BODY_PART}, so its tracked changes could not be read.`);
  }
  const bodyDoc = parseXml(await bodyPart.async('string'), BODY_PART);

  const commentsPart = zip.file(COMMENTS_PART);
  const comments = commentsPart ? parseComments(await commentsPart.async('string')) : new Map<string, CommentInfo>();

  const edits = [...wrapperEdits(bodyDoc), ...commentEdits(bodyDoc, comments)];

  return { edits, hasMarkup: edits.length > 0 };
}
