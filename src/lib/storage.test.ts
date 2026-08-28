import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings } from './storage';

const SETTINGS_KEY = 'lexprompt.settings';

beforeEach(() => localStorage.clear());

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings().settings.concurrency).toBe(5);
    expect(loadSettings().settings.modelChoiceId).toBe('');
    expect(loadSettings().purgedApiKey).toBe(false);
  });

  it('persists and reloads', () => {
    saveSettings({ modelChoiceId: 'uk-sonnet', concurrency: 3 });
    expect(loadSettings().settings).toEqual({ modelChoiceId: 'uk-sonnet', concurrency: 3 });
  });

  it('survives corrupt stored JSON by falling back to defaults', () => {
    localStorage.setItem(SETTINGS_KEY, '{broken');
    expect(loadSettings().settings.concurrency).toBe(5);
    expect(loadSettings().purgedApiKey).toBe(false);
  });
});

describe('settings — the OpenRouter key is purged from this browser', () => {
  it('returns settings with no apiKey key at all when one was stored', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      apiKey: 'sk-or-v1-liveandunused', modelChoiceId: 'uk-sonnet', concurrency: 3,
    }));

    const { settings } = loadSettings();
    // `in`, not `toEqual`: Vitest treats `{ a: 1 }` and `{ a: 1, b: undefined }`
    // as equal, and `structuredClone` PRESERVES an undefined-valued key, so
    // absence is the thing that has to be asserted.
    expect('apiKey' in settings).toBe(false);
  });

  it('rewrites localStorage so a second read finds no key', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      apiKey: 'sk-or-v1-liveandunused', modelChoiceId: 'uk-sonnet', concurrency: 3,
    }));

    loadSettings();

    const raw = localStorage.getItem(SETTINGS_KEY)!;
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-or-v1-');
    // The rest of the record survives: this deletes a credential, not the
    // user's settings.
    expect(JSON.parse(raw)).toEqual({ modelChoiceId: 'uk-sonnet', concurrency: 3 });
  });

  it('reports purgedApiKey true on the read that purged and false on the next', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      apiKey: 'sk-or-v1-liveandunused', modelChoiceId: 'uk-sonnet', concurrency: 3,
    }));

    expect(loadSettings().purgedApiKey).toBe(true);
    // Told ONCE. A notice that reappears on every load is a notice the user
    // learns to dismiss without reading.
    expect(loadSettings().purgedApiKey).toBe(false);
    expect(loadSettings().purgedApiKey).toBe(false);
  });

  it('does not claim a purge for a record that stored an empty key', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: '', concurrency: 5 }));
    expect(loadSettings().purgedApiKey).toBe(false);
  });

  it('drops a stored modelId rather than carrying it over as a modelChoiceId', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      modelId: 'anthropic/claude-3.5-sonnet', concurrency: 4,
    }));

    const { settings } = loadSettings();
    // An OpenRouter model id means nothing against an allowlist. Carried
    // over it would be a `modelChoiceId` that never resolves — a screen
    // saying "configured" over a choice the gateway will refuse.
    expect(settings.modelChoiceId).toBe('');
    expect('modelId' in settings).toBe(false);
    expect(settings.concurrency).toBe(4);
    expect(localStorage.getItem(SETTINGS_KEY)).not.toContain('modelId');
  });
});
