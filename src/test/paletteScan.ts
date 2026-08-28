import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ColourViolation {
  /** Path as handed to `scanSource`. */
  file: string;
  /** 1-based. */
  line: number;
  /** `hex-literal` | `arbitrary-colour` | `tailwind-palette` | `palette-layer-leak` */
  rule: string;
  /** The offending text, for a message that points at something. */
  text: string;
}

/**
 * Files the scan collects and then skips. Exactly one, and it is a real
 * exemption rather than a decorative one.
 *
 * `PdfCanvas.tsx` is exempt by spec §13.4 because canvas draw calls are not
 * styling; its highlight overlay DIVS are nevertheless moved onto the
 * highlight tokens by Task 9 (R-GP1), so the exemption covers only what it
 * is meant to.
 *
 * `index.css` is deliberately NOT listed. It is where the tokens are
 * defined and the palette layer legitimately lives, but the walker below
 * collects `.ts`/`.tsx` only, so a `.css` entry here would never match and
 * would read as a guarantee it was not providing. If the scan is ever
 * widened to `.css` — a genuine improvement, since index.css is the one
 * place a raw colour is legal — add it here in the same change.
 *
 * `test/` is excluded by the walker, not by this list: it holds this
 * scanner and the token reader, both of which contain colour patterns as
 * DATA.
 */
export const SCAN_EXEMPT: readonly string[] = [
  'features/review/PdfCanvas.tsx',
];

const TAILWIND_HUES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const COLOUR_PROPS =
  'bg|text|border|from|to|via|ring|divide|outline|decoration|shadow|fill|stroke|accent|caret|placeholder';

const RULES: { rule: string; re: RegExp }[] = [
  // A Tailwind arbitrary value whose contents are a colour: bg-[#fff],
  // text-[rgb(…)], shadow-[inset_0_0_0_2px_rgba(…)].
  { rule: 'arbitrary-colour', re: new RegExp(`\\b(?:${COLOUR_PROPS})-\\[[^\\]]*(?:#[0-9a-fA-F]{3,8}|rgba?\\()[^\\]]*\\]`, 'g') },
  // A hex literal in a quoted string or a style property value.
  { rule: 'hex-literal', re: /(?:['"`]|:\s*)#[0-9a-fA-F]{3,8}\b/g },
  // A bare rgb()/rgba() outside an arbitrary value (an inline style).
  { rule: 'hex-literal', re: /(?:['"`]|:\s*)rgba?\([^)]*\)/g },
  // A generic Tailwind palette class, with or without an opacity suffix.
  { rule: 'tailwind-palette', re: new RegExp(`\\b(?:${COLOUR_PROPS})-(?:(?:${TAILWIND_HUES})-\\d{2,3}|white|black)(?:/\\d{1,3})?\\b`, 'g') },
  // The palette layer, reached from outside index.css.
  { rule: 'palette-layer-leak', re: /--lex-[a-z0-9-]+/g },
];

/** Pure: one file's text in, its violations out. No IO, so it is trivially
 *  unit-testable and the repo-wide guard is just a loop over it. */
export function scanSource(file: string, source: string): ColourViolation[] {
  const out: ColourViolation[] = [];
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    for (const { rule, re } of RULES) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        out.push({ file, line: i + 1, rule, text: match[0].trim() });
      }
    }
  });
  // Stable order: by line, then by the order RULES declares.
  return out.sort((a, b) => a.line - b.line);
}

/** Every application `.ts`/`.tsx` under `root`, as paths relative to it
 *  with forward slashes. Tests, the test harness and `SCAN_EXEMPT` are
 *  excluded. */
export function collectScannableFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(root, full).split(sep).join('/');
      if (!/\.tsx?$/.test(rel)) continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      if (rel.startsWith('test/')) continue;
      if (SCAN_EXEMPT.includes(rel)) continue;
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}
