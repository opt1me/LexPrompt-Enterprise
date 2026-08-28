/**
 * The privacy and storage disclosures, in one place.
 *
 * Extracted at the SECOND copy rather than the third: sub-project G's
 * intake wizard needs to say the storage sentence at the point of upload,
 * and the alternative was a paraphrase of a disclosure — the one kind of
 * string this app must never have two versions of. These are the SHIPPED
 * words; where a prototype says something different, these win (R-G5).
 *
 * Not exported through findingOutcome.ts: that module is export wording,
 * printed into a DOCX and a CSV. This is screen wording. Two different
 * jobs, deliberately two modules.
 */
export const API_KEY_PRIVACY =
  "Your key is stored only in this browser's local storage and is sent only to OpenRouter "
  + 'when making a request. It is never sent anywhere else.';

export const STORAGE_PRIVACY = [
  'Matters, documents (including the original file bytes), and reviews are stored in '
  + "this browser's IndexedDB — on this device, in this browser, and nowhere else. "
  + 'Nothing is uploaded anywhere except to the model you chose, via OpenRouter, at the '
  + 'moment you run a review.',
  'Deleting a matter deletes its documents and their stored bytes, not just its entry '
  + "in a list. Data is per-browser: clearing this browser's site data removes your "
  + 'matters permanently, and there is no sync or backup.',
  // STRAIGHT apostrophes, both of them. SettingsPanel.tsx:116-117 ships
  // `they're` (U+0027) and the file contains no U+2019 anywhere; an
  // extraction whose entire purpose is to stop the wording drifting must
  // not itself change two characters of a frozen disclosure (F7).
  "Page images generated for scanned PDFs are never stored — they're regenerated from "
  + "the original file bytes whenever they're needed again.",
] as const;

export const SOURCE_PRIVACY =
  'Selecting a matter sends its verified findings to the model you have chosen — the only '
  // CURLY here, deliberately and in contrast to the block above:
  // SourcePicker.tsx:94 renders `matter&rsquo;s`, so U+2019 is what the
  // DOM actually contains and what SourcePicker.test.tsx matches against.
  + "place in this app another matter’s content leaves your browser.";
