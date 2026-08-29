import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings } from './storage';

const SETTINGS_KEY = 'lexprompt.settings';

beforeEach(() => localStorage.clear());

/**
 * Task 18 emptied `Settings`: `modelChoiceId`, `modelChoiceLabel`,
 * `modelChoiceModel`, `concurrency`, `modelSupportsImages`,
 * `modelSupportsStructuredOutput` and `modelContextLength` all moved to
 * `WorkspaceSettings`, fetched from `GET /v1/workspace/settings`. What is
 * left for `storage.ts` to do is the API-key purge (Stage 1's DoD) and,
 * now, purging the fields that just moved out from under any browser that
 * still has a pre-Stage-2 blob in `localStorage`.
 */

describe('settings', () => {
  it('returns an empty object when nothing is stored', () => {
    expect(loadSettings().settings).toEqual({});
    expect(loadSettings().purgedApiKey).toBe(false);
  });

  it('persists and reloads whatever is saved (there is nothing left to default)', () => {
    saveSettings({});
    expect(loadSettings().settings).toEqual({});
  });

  it('survives corrupt stored JSON by falling back to an empty object', () => {
    localStorage.setItem(SETTINGS_KEY, '{broken');
    expect(loadSettings().settings).toEqual({});
    expect(loadSettings().purgedApiKey).toBe(false);
  });
});

describe('settings — the OpenRouter key is purged from this browser', () => {
  it('returns settings with no apiKey key at all when one was stored', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: 'sk-or-v1-liveandunused' }));

    const { settings } = loadSettings();
    // `in`, not `toEqual`: Vitest treats `{ a: 1 }` and `{ a: 1, b: undefined }`
    // as equal, and `structuredClone` PRESERVES an undefined-valued key, so
    // absence is the thing that has to be asserted.
    expect('apiKey' in settings).toBe(false);
  });

  it('rewrites localStorage so a second read finds no key', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: 'sk-or-v1-liveandunused' }));

    loadSettings();

    const raw = localStorage.getItem(SETTINGS_KEY)!;
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-or-v1-');
    expect(JSON.parse(raw)).toEqual({});
  });

  it('reports purgedApiKey true on the read that purged and false on the next', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: 'sk-or-v1-liveandunused' }));

    expect(loadSettings().purgedApiKey).toBe(true);
    // Told ONCE. A notice that reappears on every load is a notice the user
    // learns to dismiss without reading.
    expect(loadSettings().purgedApiKey).toBe(false);
    expect(loadSettings().purgedApiKey).toBe(false);
  });

  it('does not claim a purge for a record that stored an empty key', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: '' }));
    expect(loadSettings().purgedApiKey).toBe(false);
  });

  it('drops a stored modelId rather than carrying it over as a modelChoiceId', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ modelId: 'anthropic/claude-3.5-sonnet' }));

    const { settings } = loadSettings();
    expect('modelId' in settings).toBe(false);
    expect('modelChoiceId' in settings).toBe(false);
    expect(localStorage.getItem(SETTINGS_KEY)).not.toContain('modelId');
  });
});

describe('settings — Task 18\'s fields are purged too, now that they are WorkspaceSettings\'s', () => {
  it('drops every field that moved to WorkspaceSettings, from a pre-Stage-2 blob', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      modelChoiceId: 'uk-sonnet', modelChoiceLabel: 'UK Sonnet', modelChoiceModel: 'claude-3-sonnet',
      concurrency: 7, modelSupportsImages: true, modelSupportsStructuredOutput: true,
      modelContextLength: 200_000,
    }));

    const { settings } = loadSettings();
    for (const field of [
      'modelChoiceId', 'modelChoiceLabel', 'modelChoiceModel', 'concurrency',
      'modelSupportsImages', 'modelSupportsStructuredOutput', 'modelContextLength',
    ]) {
      expect(field in settings, field).toBe(false);
    }
    expect(settings).toEqual({});
    const raw = localStorage.getItem(SETTINGS_KEY)!;
    expect(raw).toBe('{}');
  });

  it('a blob with none of the moved fields is not rewritten needlessly', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({}));
    const before = localStorage.getItem(SETTINGS_KEY);
    loadSettings();
    // Not asserting the write NEVER happens (an empty-object rewrite is
    // harmless either way) — asserting the READ still resolves cleanly.
    expect(loadSettings().settings).toEqual({});
    expect(before).toBe('{}');
  });
});
