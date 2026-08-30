/**
 * "Still being read" is not "read, and it says nothing" — in ONE place.
 *
 * Since Stage 3 the upload stores a document's bytes and returns; a parse
 * worker reads them and is the only writer of `parseState`. For the moment
 * between the two the row is `parse_state = 'pending'` with `text = ''`, and
 * a reader that cannot tell that apart from a document that genuinely says
 * nothing is looking at this project's founding defect with a different
 * cause: `assessDocument` answers `unreadable`, every clause comes back
 * *"It may have failed to parse, or be a scan with no extractable
 * content"*, and both branches of that sentence are false.
 *
 * That is exactly what shipped: `parseState` went on the wire with no reader
 * anywhere. So the fact lives here, as a predicate and a sentence, and every
 * layer that could show a not-yet-read document — the browser's two
 * hydrations, the server's two hydrations, the run route's refusal and the
 * matter's document list — reads THIS rather than writing its own wording. A
 * sentence repeated in five places is a sentence that will be true in four
 * of them.
 */

/** The fields a not-yet-read check actually reads. Typed as the fields used
 *  rather than as `DocumentRecord`, so a row slice on the server and a
 *  record in the browser can both be asked without either importing the
 *  other's shape. */
export interface ParseStateSource {
  name: string;
  parseState?: 'pending' | 'parsed' | 'failed';
}

/**
 * The document's text has not arrived yet.
 *
 * ABSENT `parseState` is NOT pending: a `DocumentFile` the browser built
 * from a file it just parsed has never been anywhere that could answer the
 * question, and treating "we do not know" as "still reading" would refuse a
 * review of a document that is sitting parsed in memory.
 */
export function isNotYetRead(doc: ParseStateSource): boolean {
  return doc.parseState === 'pending';
}

/**
 * What a reader is told about a document whose text has not arrived.
 *
 * Says what is true (the file is stored, the text is being extracted), what
 * cannot be done yet, and what to do — *"try again in a moment"* — which is
 * the whole difference between this and the unreadable-document message it
 * used to be mistaken for. It is deliberately NOT phrased as a failure: a
 * document being read is a document on its way to working.
 */
export function notYetReadMessage(name: string): string {
  return `${name} has not finished being read. LexPrompt has the file and is extracting its `
    + 'text; until that finishes there is nothing to review — a review of it now would report '
    + 'every clause as absent. Try again in a moment.';
}

/** The same fact for a LIST of documents, as one sentence. Used by the run
 *  route's refusal and by the browser's pre-flight, so the two say the same
 *  thing about the same condition. */
export function notYetReadMessageFor(names: string[]): string {
  if (names.length === 1) return `${notYetReadMessage(names[0])} Nothing was started.`;
  return `${names.join(', ')} have not finished being read. LexPrompt has the files and is `
    + 'extracting their text; until that finishes a review of them would report every clause '
    + 'as absent. Nothing was started; try again in a moment.';
}

/** The short form, for a document row in a list where a paragraph would not
 *  fit. Still says "reading", never "unreadable". */
export const STILL_READING_NOTICE = 'Still being read — its text is not available yet.';
