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

/**
 * Replaces `API_KEY_PRIVACY`, which is void: there is no user key.
 *
 * Stage 1 makes the first sentence true; Stage 2 makes the second one true
 * and rewrites `STORAGE_PRIVACY` with it.
 */
export const INFERENCE_PRIVACY =
  "You do not need an API key. Requests go to your firm's own LexPrompt service, which "
  + 'holds the credentials for the AI provider your administrator has configured and keeps '
  + 'a record of every request — who made it, when, which model, and which document or '
  + "review it was for. The text of your documents and the model's answers are never "
  + 'written to that record.';

/**
 * Said ONCE, on the first load after the key was removed.
 *
 * The only thing a reader can act on is the last sentence, so it is the last
 * sentence. Deleting a key from a browser is NOT revoking it — the copy has
 * to leave a reader in no doubt that the credential still exists at
 * OpenRouter until they go and kill it themselves.
 */
export const API_KEY_PURGED_NOTICE = {
  before:
    'LexPrompt no longer uses an OpenRouter key, and the key stored in this browser has been '
    + 'removed. If you no longer need it, revoke it at ',
  linkText: 'openrouter.ai/keys',
  href: 'https://openrouter.ai/keys',
  after: '.',
} as const;

/** The same notice as one string, for a test or a copy sweep. Derived, so
 *  the rendered text and the asserted text cannot drift. */
export const API_KEY_PURGED_SENTENCE =
  API_KEY_PURGED_NOTICE.before + API_KEY_PURGED_NOTICE.linkText + API_KEY_PURGED_NOTICE.after;

export const STORAGE_PRIVACY = [
  'Matters, documents (including the original file bytes), and reviews are stored in '
  + "this browser's IndexedDB — on this device, in this browser, and nowhere else. "
  // Stage 1 changed THIS CLAUSE ONLY. The IndexedDB sentences around it are
  // still true — matters, documents and reviews genuinely are in this
  // browser until Stage 2 — and rewriting them early would be a disclosure
  // describing an app that does not exist yet.
  + "Nothing is uploaded anywhere except to your firm's LexPrompt service, at the "
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
