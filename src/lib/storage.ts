import { type Settings, DEFAULT_SETTINGS } from '../types';

const SETTINGS_KEY = 'lexprompt.settings';

/**
 * Whether a key was purged at any point in THIS page session.
 *
 * `loadSettings`'s own `purgedApiKey` is a property of the read: true on the
 * read that removed the key, false ever after, because a notice that
 * reappears on every load is a notice a user learns to dismiss unread. That
 * is right for the store and wrong for a UI that has to survive React
 * StrictMode invoking a `useState` initializer twice — the second call would
 * report `false` and the one notice about a live credential would be lost in
 * exactly the mode a developer runs the app in. This latch is the fact the
 * screen needs ("a key was removed while this page has been open"), kept
 * separately from the fact the store reports.
 */
let purgedThisSession = false;

/** True once an OpenRouter key has been purged during this page session, and
 *  true for the rest of it. Reset only by a reload, by which point there is
 *  no key left to purge and it is correctly false again. */
export function apiKeyWasPurgedThisSession(): boolean {
  return purgedThisSession;
}

/**
 * Reads settings, and **deletes** any stored OpenRouter API key on the way
 * through.
 *
 * This is the one place this project deliberately destroys stored data.
 * "Never delete what you cannot read" is about the user's work — matters,
 * documents, findings — and this is not that. It is a credential that no
 * code path can read for any purpose any more (`openrouter.ts` is gone; every
 * request carries a bearer token), so leaving it is strictly worse than
 * removing it: a live secret sitting at rest, doing nothing, behind a screen
 * that used to imply it was in use. Stage 1's definition of done says no
 * OpenRouter key exists in any browser, and this line is where that becomes
 * true rather than merely intended.
 *
 * Removing a key from this browser is NOT revoking it, and the notice raised
 * from `purgedApiKey` says so and points at openrouter.ai/keys.
 */
export function loadSettings(): { settings: Settings; purgedApiKey: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { settings: { ...DEFAULT_SETTINGS }, purgedApiKey: false };

    const parsed: unknown = JSON.parse(raw);
    // `null`, an array, a number: anything that is not a record is a
    // corrupt settings blob, and reads as one rather than throwing on the
    // `delete` below.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { settings: { ...DEFAULT_SETTINGS }, purgedApiKey: false };
    }
    const stored = parsed as Record<string, unknown>;

    // A key worth telling the user about is a non-empty one. A stored `''`
    // is still deleted (and still triggers the rewrite below) but raises no
    // notice: there is nothing at openrouter.ai to go and revoke.
    const purgedApiKey = typeof stored.apiKey === 'string' && stored.apiKey.length > 0;
    const hadLegacyField = 'apiKey' in stored || 'modelId' in stored;
    delete stored.apiKey;
    // `modelId` was an OpenRouter model id. It has no meaning against an
    // operator's allowlist, so it is dropped rather than carried over as a
    // `modelChoiceId` the gateway would refuse — which would leave Settings
    // reporting "configured" over a choice that cannot run.
    delete stored.modelId;

    const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings;
    // Rewritten whenever either legacy field was present, not only when the
    // key was non-empty: the DoD is that no `apiKey` survives in a browser,
    // and an `"apiKey":""` left in the blob would survive it.
    if (hadLegacyField) saveSettings(settings);
    if (purgedApiKey) purgedThisSession = true;
    return { settings, purgedApiKey };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, purgedApiKey: false };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
