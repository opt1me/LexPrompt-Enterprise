import { describe, it, expect, vi, afterEach } from 'vitest';
import { debug } from './debug';

describe('debug', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw when called', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => debug('hello', 1)).not.toThrow();
    spy.mockRestore();
  });

  it('never touches process', () => {
    // The bug this guards: services/aiService.ts:58 called process.stdout.write,
    // which is undefined in a browser and threw on every AI retry.
    const source = debug.toString();
    expect(source).not.toContain('process');
  });
});
