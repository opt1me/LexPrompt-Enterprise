import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanClassNameTemplates } from './classNameTemplateScan';
import { collectScannableFiles } from './paletteScan';

const SRC = resolve(__dirname, '..');

describe('scanClassNameTemplates — what counts as an interpolated class fragment', () => {
  it('flags a suffix interpolation glued to a hyphen', () => {
    const v = scanClassNameTemplates('x.tsx', '<div className={`text-health-${kind}`} />');
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(1);
    expect(v[0].text).toContain('${kind}');
  });

  it('flags a prefix interpolation glued to a Tailwind modifier', () => {
    const v = scanClassNameTemplates('x.tsx', '<div className={`lg:grid-cols-${2}`} />');
    expect(v).toHaveLength(1);
  });

  it('flags an interpolation glued on both sides', () => {
    const v = scanClassNameTemplates('x.tsx', '<div className={`bg-${colour}-500`} />');
    expect(v).toHaveLength(1);
  });

  it('flags a fragment interpolation across a multi-line template', () => {
    const src = [
      '<div',
      '  className={`grid gap-2 lg:grid-cols-${',
      '    columns',
      '  } p-3`}',
      '/>',
    ].join('\n');
    const v = scanClassNameTemplates('x.tsx', src);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(2);
  });

  it('does NOT flag a whole-token interpolation from a static lookup record', () => {
    const v = scanClassNameTemplates(
      'x.tsx',
      '<span className={`font-mono text-chip uppercase ${HEALTH_INK[kind]}`} />',
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a ternary between two complete literal class strings', () => {
    const v = scanClassNameTemplates(
      'x.tsx',
      "<div className={`${cond ? 'bg-card' : 'bg-paper'}`} />",
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a bare variable interpolation bounded by whitespace', () => {
    const v = scanClassNameTemplates('x.tsx', '<div className={`${className} overflow-hidden`} />');
    expect(v).toEqual([]);
  });

  it('does NOT flag two whole-token interpolations separated by a space', () => {
    const v = scanClassNameTemplates(
      'x.tsx',
      '<button className={`${VARIANT_CLASSES[variant]} ${className}`} />',
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a multi-line ternary between two complete literal strings, bounded by the template edges', () => {
    const src = [
      '<button',
      '  className={`px-3 py-2 border ${',
      '    wrapText',
      "      ? 'bg-accent-tint text-accent border-accent-edge'",
      "      : 'bg-chip-fill text-ink-2 border-rule hover:bg-rule'",
      '  }`}',
      '/>',
    ].join('\n');
    expect(scanClassNameTemplates('x.tsx', src)).toEqual([]);
  });

  it('does NOT flag a function-call interpolation whole token', () => {
    const v = scanClassNameTemplates(
      'x.tsx',
      '<div className={`${CARD_SHELL} border-rule ${riskAccent(finding?.riskLevel)}`} />',
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a className with no template literal at all', () => {
    expect(scanClassNameTemplates('x.tsx', '<div className="bg-card text-ink-1" />')).toEqual([]);
  });

  it('does NOT flag a template literal outside any className attribute', () => {
    const v = scanClassNameTemplates('x.tsx', "const msg = `No nav button found for \"${label}\"`;");
    expect(v).toEqual([]);
  });

  it('reports the file and 1-based line', () => {
    const v = scanClassNameTemplates(
      'src/features/x.tsx',
      'line one\n<div className={`text-health-${kind}`} />\nline three',
    );
    expect(v[0]).toMatchObject({ file: 'src/features/x.tsx', line: 2 });
  });
});

// ── The repo-wide guard, wired in the same shape as the palette guard in
// palette.test.ts: every scannable file, every violation, one assertion
// whose failure message names the file and line.
describe('className template guard', () => {
  it('no className interpolates a fragment of a class name', () => {
    const violations = collectScannableFiles(SRC)
      .flatMap(rel => scanClassNameTemplates(rel, readFileSync(resolve(SRC, rel), 'utf8')));
    expect(
      violations.map(v => `${v.file}:${v.line} ${v.text}`).join('\n'),
    ).toBe('');
  });
});
