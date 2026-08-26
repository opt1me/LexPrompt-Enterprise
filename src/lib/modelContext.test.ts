import { describe, it, expect } from 'vitest';
import { assessDocument, contextBudgetChars, extractableText, usableText } from './modelContext';
import type { DocumentFile } from '../types';

function doc(overrides: Partial<DocumentFile> = {}): DocumentFile {
  return {
    id: 'd1', name: 'doc.pdf', kind: 'pdf', text: 'This lease runs for twelve months.',
    file: new File([''], 'doc.pdf'), ...overrides,
  };
}

describe('extractableText / usableText', () => {
  it('extractableText strips page markers', () => {
    expect(extractableText(doc({ text: '[Page 1]\nHello\n\n' }))).toBe('Hello');
  });

  it('usableText drops a page below the scan threshold', () => {
    expect(usableText(doc({ text: '[Page 1]\nAB\n\n' }))).toBe('');
  });

  it('usableText keeps a page at/above the scan threshold', () => {
    const longEnough = 'x'.repeat(25);
    expect(usableText(doc({ text: `[Page 1]\n${longEnough}\n\n` }))).toBe(longEnough);
  });
});

describe('assessDocument', () => {
  it('is "ok" with the document text when text is present, regardless of image support', () => {
    const result = assessDocument(doc(), false);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.text).toContain('twelve months');
      expect(result.useImages).toBe(false);
    }
  });

  it('is "unreadable" for empty text and no images (Critical 2: e.g. a DOCX mammoth resolved to "")', () => {
    expect(assessDocument(doc({ text: '' }), true).kind).toBe('unreadable');
  });

  it('is "unreadable" for whitespace-only / sub-threshold text and no images', () => {
    expect(assessDocument(doc({ text: '   ' }), true).kind).toBe('unreadable');
  });

  it('is "ok" with images when there is no text and the model supports images', () => {
    const scan = doc({ text: '', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const result = assessDocument(scan, true);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.text).toBe('');
      expect(result.useImages).toBe(true);
    }
  });

  it('is "needs-image-model" when there is no text, images exist, but the model cannot read them (Critical 1)', () => {
    const scan = doc({ text: '', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    expect(assessDocument(scan, false).kind).toBe('needs-image-model');
  });

  it('does not require images when there is already usable text', () => {
    const mixed = doc({ pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const result = assessDocument(mixed, false);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.useImages).toBe(false);
  });
});

describe('contextBudgetChars', () => {
  it('scales with context length', () => {
    expect(contextBudgetChars(100)).toBe(200); // floor(100 * 4 * 0.5)
    expect(contextBudgetChars(1000)).toBe(2000);
  });

  it('falls back to a conservative default when context length is unknown', () => {
    expect(contextBudgetChars(undefined)).toBe(contextBudgetChars(32_000));
  });

  it('falls back to the default for a zero or negative context length', () => {
    expect(contextBudgetChars(0)).toBe(contextBudgetChars(undefined));
    expect(contextBudgetChars(-5)).toBe(contextBudgetChars(undefined));
  });
});
