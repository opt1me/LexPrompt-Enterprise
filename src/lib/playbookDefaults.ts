/**
 * The generic starting point every brand-new playbook gets, wherever it is
 * created from — "Build by hand" (`db/playbooks.ts`'s `newPlaybookDraft`)
 * and AI-drafted authoring (`authoringDraft.ts`'s `toPlaybookDraft`) alike.
 *
 * Drift review, D2 — the riskiest of the three drift findings. These two
 * constants used to be declared independently, byte-identical, in both of
 * those modules; nothing pinned them equal, so improving the default wording
 * in one would silently leave the other's playbooks on the old text with no
 * test to catch it. Pulled out here — a module with NO IndexedDB import —
 * rather than having `authoringDraft.ts` import `db/playbooks.ts` directly:
 * that module is deliberately kept free of the store connection (no React,
 * no `idb`, no persistence), and importing the STRINGS from a third, pure
 * module removes the duplication without pulling IndexedDB into it. If a
 * third place ever needs this text, it imports from here too — this module
 * is that "third place" CLAUDE.md's sibling-drift rule was already warning
 * about, arrived at deliberately instead of by a fourth copy.
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are an expert legal contract reviewer.';
export const DEFAULT_FORMAT_PROMPT = 'Answer strictly from the document text. Quote verbatim.';
