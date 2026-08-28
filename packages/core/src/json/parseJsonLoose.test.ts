import { describe, it, expect } from 'vitest';
import { parseJsonLoose } from './parseJsonLoose.ts';

describe('parseJsonLoose', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in a prose preamble', () => {
    expect(parseJsonLoose('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('recovers JSON inside a fenced code block', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles nested braces and braces inside strings', () => {
    expect(parseJsonLoose('x {"a":{"b":"}"},"c":2} y')).toEqual({ a: { b: '}' }, c: 2 });
  });

  it('throws a readable error when there is no JSON at all', () => {
    expect(() => parseJsonLoose('no json here')).toThrow(/could not parse/i);
  });

  // Finding 2 (fix round 1): the first `{` candidate can fail to parse (it
  // isn't really JSON) while a real JSON object sits later in the text.
  // Must not give up after the first failed candidate.
  it('skips a non-JSON first brace and finds a later valid object', () => {
    expect(parseJsonLoose('Cost is {approx} then {"a":1}')).toEqual({ a: 1 });
  });

  // Finding 2 (fix round 1): when multiple balanced, independently-valid JSON
  // objects are present, the LAST one is the model's real answer (an example
  // shown before it is a decoy). Returning the first is a silent wrong-answer
  // bug, not a crash — the dangerous kind for a contract review tool.
  it('returns the LAST balanced object when multiple valid JSON objects are present', () => {
    const text = 'Example: {"a":1} Real answer: {"a":2}';
    expect(parseJsonLoose(text)).toEqual({ a: 2 });
  });

  it('throws on a truncated/unclosed-brace response rather than returning junk', () => {
    expect(() => parseJsonLoose('Sure, {"a":1')).toThrow(/could not parse/i);
  });
});
