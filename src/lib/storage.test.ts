import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings } from './storage';

beforeEach(() => localStorage.clear());

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings().concurrency).toBe(5);
    expect(loadSettings().apiKey).toBe('');
  });

  it('persists and reloads', () => {
    saveSettings({ apiKey: 'k', modelId: 'm', concurrency: 3 });
    expect(loadSettings()).toEqual({ apiKey: 'k', modelId: 'm', concurrency: 3 });
  });

  it('survives corrupt stored JSON by falling back to defaults', () => {
    localStorage.setItem('lexprompt.settings', '{broken');
    expect(loadSettings().concurrency).toBe(5);
  });
});
