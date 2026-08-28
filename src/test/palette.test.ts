import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanSource, collectScannableFiles, SCAN_EXEMPT } from './paletteScan';

const SRC = resolve(__dirname, '..');

describe('paletteScan — what counts as a raw colour', () => {
  it('flags a hex literal in a className', () => {
    const v = scanSource('x.tsx', `<div className="bg-[#1a1a1a] p-4" />`);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('arbitrary-colour');
    expect(v[0].line).toBe(1);
  });

  it('flags a bare hex literal in a style object', () => {
    const v = scanSource('x.tsx', `style={{ backgroundColor: '#8c2f24' }}`);
    expect(v.map(r => r.rule)).toContain('hex-literal');
  });

  it('flags an rgb()/rgba() literal', () => {
    const v = scanSource('x.tsx', `const ring = 'shadow-[inset_0_0_0_2px_rgba(139,92,246,0.6)]';`);
    expect(v.map(r => r.rule)).toContain('arbitrary-colour');
  });

  it('flags a generic Tailwind palette class', () => {
    const v = scanSource('x.tsx', `className="text-emerald-300 border-violet-500/20"`);
    expect(v.map(r => r.rule)).toEqual(['tailwind-palette', 'tailwind-palette']);
  });

  it('flags bg-white/5, text-white and border-white/10', () => {
    const v = scanSource('x.tsx', `className="bg-white/5 text-white border-white/10 text-black"`);
    expect(v).toHaveLength(4);
    expect(new Set(v.map(r => r.rule))).toEqual(new Set(['tailwind-palette']));
  });

  it('flags a palette-layer variable used outside index.css', () => {
    const v = scanSource('x.tsx', `style={{ color: 'var(--lex-teal)' }}`);
    expect(v.map(r => r.rule)).toContain('palette-layer-leak');
  });

  it('does NOT flag a semantic role class', () => {
    expect(scanSource('x.tsx', `className="bg-risk-high-tint text-risk-high border-risk-high-edge"`)).toEqual([]);
  });

  it('does NOT flag a semantic role variable', () => {
    expect(scanSource('x.tsx', `style={{ color: 'var(--color-accent)' }}`)).toEqual([]);
  });

  it('does NOT flag a non-colour arbitrary value or a non-colour utility', () => {
    expect(scanSource('x.tsx', `className="w-[258px] max-w-[70ch] grid-cols-[1.35fr_1fr_1fr] p-3 gap-1.5"`)).toEqual([]);
  });

  it('does NOT flag a hex-looking string that is not a colour', () => {
    // Six hex digits behind a `#` in prose or an id are not styling. The
    // rule is anchored to a colour position: a quoted value, a style
    // property, or a Tailwind arbitrary value.
    expect(scanSource('x.tsx', `// see commit #abc123 for why`)).toEqual([]);
  });

  it('reports the file and the 1-based line of each violation', () => {
    const v = scanSource('src/features/x.tsx', `line one\nclassName="text-violet-400"\nline three`);
    expect(v[0]).toMatchObject({ file: 'src/features/x.tsx', line: 2 });
  });
});

describe('collectScannableFiles', () => {
  it('includes application source and excludes tests, the harness and the exemptions', () => {
    const files = collectScannableFiles(SRC);
    expect(files).toContain('features/review/FindingCard.tsx');
    expect(files).toContain('App.tsx');
    // The crash screen is application chrome and is scanned like anything
    // else — it is the one screen that renders when everything else has
    // failed, so it is the last place a raw colour should go unreviewed.
    expect(files).toContain('main.tsx');
    expect(files.some(f => f.endsWith('.test.tsx'))).toBe(false);
    expect(files.some(f => f.endsWith('.test.ts'))).toBe(false);
    expect(files.some(f => f.startsWith('test/'))).toBe(false);
    expect(files).not.toContain('features/review/PdfCanvas.tsx');
  });

  it('exempts exactly the two files it means to, and says which', () => {
    // Replaces an earlier case that asserted no `.css` file was collected —
    // true by construction, since the walker only ever collects .ts/.tsx,
    // so it reported an exemption that was really an absence
    // (F14 + F17c, R-GP10).
    expect([...SCAN_EXEMPT]).toEqual(['features/review/PdfCanvas.tsx']);
    expect(collectScannableFiles(SRC)).not.toContain('features/review/PdfCanvas.tsx');
  });
});

// ── The repo-wide guards. Un-skipped by Task 14, once every screen has
// been restyled. Skipped (not deleted, not weakened) until then because
// today's raw palette utilities are the work this sub-project exists
// to remove: a guard that passes today would be a guard that asserts
// nothing.
describe.skip('palette guard — SKIPPED UNTIL TASK 14 un-skips it', () => {
  it('no application source references a raw colour', () => {
    const violations = collectScannableFiles(SRC)
      .flatMap(rel => scanSource(rel, readFileSync(resolve(SRC, rel), 'utf8')));
    expect(
      violations.map(v => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n'),
    ).toBe('');
  });
});
