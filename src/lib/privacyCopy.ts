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
 * Stage 1 made the first sentence true; Stage 2 makes the second one true
 * and has rewritten `STORAGE_PRIVACY` with it.
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

/**
 * Stage 2 rewrote the first two entries, per §2's table.
 *
 * The old wording said matters, documents and reviews lived in this
 * browser's IndexedDB "and nowhere else". That was true until this stage and
 * is false now: they are in the firm's own database and object storage. The
 * clause that had already been narrowed for Stage 1 — "nothing is uploaded
 * anywhere except to your firm's LexPrompt service, at the moment you run a
 * review" — is gone with it, because the upload is no longer deferred to the
 * moment of a review.
 *
 * TWO CLAUSES SURVIVE VERBATIM, deliberately, and one of them down to its
 * punctuation:
 *
 *  - *"Deleting a matter deletes its documents and their stored bytes, not
 *    just its entry in a list"* — still true, and now enforced by the API's
 *    cascade over Postgres and Blob Storage rather than by an IndexedDB
 *    transaction. What changed is the mechanism, not the promise.
 *  - The page-images sentence, **including its straight apostrophes**
 *    (U+0027). This module exists to stop a disclosure drifting into two
 *    wordings; an extraction that then changed two characters of a frozen
 *    sentence would be the very thing it was written to prevent (F7).
 */
export const STORAGE_PRIVACY = [
  // STRAIGHT apostrophes throughout, matching the frozen third entry below
  // rather than `SOURCE_PRIVACY`'s curly one — that one is curly because the
  // DOM it describes contains `&rsquo;`, which is a fact about a rendered
  // screen and not a house style.
  'Matters, documents (including the original file bytes), and reviews are stored by '
  + "your firm's own LexPrompt service — the records and their text in its database, the "
  + "original files in its object storage, both inside your firm's own cloud tenant. "
  + 'Your colleagues with access to a matter can see it; nothing about it is kept in this '
  + 'browser.',
  'Deleting a matter deletes its documents and their stored bytes, not just its entry '
  + "in a list. Your firm's administrator decides how long everything else is kept, and "
  + "its backups are your firm's rather than this app's.",
  // STRAIGHT apostrophes, both of them. SettingsPanel.tsx:116-117 ships
  // `they're` (U+0027) and the file contains no U+2019 anywhere; an
  // extraction whose entire purpose is to stop the wording drifting must
  // not itself change two characters of a frozen disclosure (F7).
  "Page images generated for scanned PDFs are never stored — they're regenerated from "
  + "the original file bytes whenever they're needed again.",
] as const;

/**
 * Replaces `PrecedentIntake`'s "Read once to learn from. Never stored."
 *
 * That sentence was TRUE when it was written and this module's job is to
 * make sure the one that replaces it is true now. §11.1 stores precedent
 * documents server-side, so the promise changes in the same commit as the
 * storage — a screen that told a lawyer their client's marked-up lease was
 * never stored, while storing it, is this project's founding defect in its
 * purest form.
 *
 * Three facts, in the order a person choosing a file needs them: it is
 * kept, it is kept apart, and somebody decides for how long. The middle one
 * is the one S23 exists for — a precedent that could be opened as the deal
 * in hand is a citation with apparent authority pointing at another client's
 * document.
 */
export const PRECEDENT_STORAGE_PRIVACY =
  "Stored in your firm's LexPrompt, with the playbook you build from them. Kept apart from "
  + 'matter documents: a precedent is never offered as something to review, added to a '
  + 'collection, or cited in a report. Your firm decides how long they are kept.';

export const SOURCE_PRIVACY =
  'Selecting a matter sends its verified findings to the model you have chosen — the only '
  // CURLY here, deliberately and in contrast to the block above:
  // SourcePicker.tsx:94 renders `matter&rsquo;s`, so U+2019 is what the
  // DOM actually contains and what SourcePicker.test.tsx matches against.
  + "place in this app another matter’s content leaves your browser.";
