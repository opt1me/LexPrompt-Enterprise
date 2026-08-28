import { readFileSync } from 'node:fs';

export interface TokenTable {
  /** `--lex-*` names, without the prefix: `teal`, `ink-1`, `teal-rgb`. */
  palette: Record<string, string>;
  /** `--color-*` names, without the prefix: `accent`, `risk-high-tint`. */
  roles: Record<string, string>;
}

export interface Rgba { r: number; g: number; b: number; a: number }

/** Reads both layers out of index.css. Deliberately a parse of the real
 *  file rather than a duplicated table: a second copy of the palette is
 *  exactly the sibling drift this project keeps paying for. */
export function readTokens(cssPath: string): TokenTable {
  const raw = readFileSync(cssPath, 'utf8');
  // Strip comments first. The declaration regex's value group spans
  // newlines (a triplet like `rgb(var(--lex-teal-rgb) / 0.09)` can wrap),
  // so an unstripped comment mentioning a token name — e.g. "not an alias
  // of `--lex-teal`" above the `--lex-teal-strong` declaration — reads as
  // a bogus `--lex-teal: <rest of the comment>...` match that swallows the
  // real declaration below it. Comments never carry real values, so this
  // cannot remove a token; it only removes the collision.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const palette: Record<string, string> = {};
  const roles: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--lex-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    palette[name] = value.trim();
  }
  for (const [, name, value] of css.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    roles[name] = value.trim();
  }
  return { palette, roles };
}

function parseHex(hex: string): Rgba {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

/** Resolves a role name to concrete channels, following `var()` through the
 *  palette layer and expanding `rgb(<triplet> / <alpha>)`. */
export function resolveColour(name: string, tokens: TokenTable): Rgba {
  let value = tokens.roles[name];
  if (value === undefined) throw new Error(`No --color-${name} in index.css`);

  const rgbFn = value.match(/^rgb\(\s*var\(--lex-([a-z0-9-]+)\)\s*\/\s*([0-9.]+)\s*\)$/);
  if (rgbFn) {
    const triplet = tokens.palette[rgbFn[1]];
    if (triplet === undefined) throw new Error(`No --lex-${rgbFn[1]} in index.css`);
    const [r, g, b] = triplet.split(/\s+/).map(Number);
    return { r, g, b, a: Number(rgbFn[2]) };
  }

  const varRef = value.match(/^var\(--lex-([a-z0-9-]+)\)$/);
  if (varRef) {
    const resolved = tokens.palette[varRef[1]];
    if (resolved === undefined) throw new Error(`No --lex-${varRef[1]} in index.css`);
    value = resolved;
  }
  if (!value.startsWith('#')) throw new Error(`--color-${name} is not a resolvable colour: ${value}`);
  return parseHex(value);
}

/** Source-over compositing, so a tint's real appearance is measured rather
 *  than its nominal channels — a 9% teal wash IS what the eye sees, and
 *  measuring the unblended colour would report a contrast nobody has. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * WCAG 2.1 contrast ratio between two role tokens.
 *
 * A translucent background is composited over `card` first, because every
 * tint in this system is painted on a card or on paper and `card` is the
 * lighter of the two (so this reports the WORSE of the two ratios for dark
 * ink, which is the honest direction to round in).
 */
export function contrastRatio(fgName: string, bgName: string, tokens: TokenTable): number {
  const card = resolveColour('card', tokens);
  let bg = resolveColour(bgName, tokens);
  if (bg.a < 1) bg = composite(bg, card);
  let fg = resolveColour(fgName, tokens);
  if (fg.a < 1) fg = composite(fg, bg);

  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [light, dark] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}
