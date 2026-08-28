/**
 * Guards against a Tailwind class assembled by string interpolation, e.g.
 * `` `lg:grid-cols-${n}` `` or `` `text-health-${kind}` ``.
 *
 * Why this needs its own scanner rather than a unit test: mutating a class
 * to `` `lg:grid-cols-${2}` `` produces an IDENTICAL runtime `className`
 * string to the literal `lg:grid-cols-2` — jsdom, and any test asserting on
 * `element.className`, sees nothing wrong. What actually breaks is
 * Tailwind's build-time class extractor: it scans source *text* for
 * complete literal class tokens, so an interpolated one is never generated
 * and the element silently renders with no styling at all. No runtime test
 * can see this failure; only source text (this scanner) or the built CSS
 * can. See the sub-project G report this closes.
 *
 * The rule: a `className` (or `...ClassName`) attribute whose value
 * contains a template literal is fine — interpolating a *whole* class
 * string is the recommended pattern in this codebase (a ternary between two
 * complete literals, or a static lookup record indexed by a variable). What
 * is never fine is an interpolation that is glued, with no whitespace,
 * to literal class characters on either side — that fuses a dynamic
 * fragment into what Tailwind needs to see as one complete literal token.
 *
 * Concretely: an interpolation is flagged unless both the character
 * immediately before its `${` and the character immediately after its
 * matching `}` are one of — whitespace, the template literal's own
 * backtick, or nothing (start/end of the surrounding text). Anything else
 * (a letter, digit, hyphen, colon, bracket, or another interpolation
 * butted up against this one) means the interpolation contributes a
 * fragment of a class name rather than standing as a whole token.
 */

export interface ClassNameTemplateViolation {
  /** Path as handed to `scanClassNameTemplates`. */
  file: string;
  /** 1-based. */
  line: number;
  /** The offending interpolation, with a little surrounding context. */
  text: string;
}

const ATTR_RE = /\w*[Cc]lassName=\{/g;

function isSafeBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '`' || /\s/.test(ch);
}

function skipString(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) return j + 1;
    j++;
  }
  return j;
}

interface TemplateLiteral {
  start: number; // index of the opening backtick
  end: number; // index just past the closing backtick
  interpolations: { start: number; end: number }[]; // start = index of '$', end = index just past the matching '}'
}

/**
 * `text[backtickIndex]` must be a backtick. Walks the template literal,
 * finding every `${...}` interpolation with brace/string/nested-template
 * awareness so a `}` inside a nested string, object literal or template
 * doesn't get mistaken for the interpolation's own close.
 */
function scanTemplateLiteral(text: string, backtickIndex: number): TemplateLiteral {
  const interpolations: { start: number; end: number }[] = [];
  let i = backtickIndex + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return { start: backtickIndex, end: i + 1, interpolations };
    if (c === '$' && text[i + 1] === '{') {
      const interpStart = i;
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        const cj = text[j];
        if (cj === '\\') { j += 2; continue; }
        else if (cj === '{') { depth++; j++; }
        else if (cj === '}') { depth--; j++; }
        else if (cj === '`') { j = scanTemplateLiteral(text, j).end; }
        else if (cj === "'" || cj === '"') { j = skipString(text, j, cj); }
        else if (cj === '/' && text[j + 1] === '/') { const nl = text.indexOf('\n', j); j = nl === -1 ? text.length : nl; }
        else if (cj === '/' && text[j + 1] === '*') { const end = text.indexOf('*/', j + 2); j = end === -1 ? text.length : end + 2; }
        else j++;
      }
      interpolations.push({ start: interpStart, end: j });
      i = j;
      continue;
    }
    i++;
  }
  // Unterminated (shouldn't happen in valid source) — treat as ending here.
  return { start: backtickIndex, end: text.length, interpolations };
}

/** Every template literal that appears directly within one `className={…}`
 *  (or `fooClassName={…}`) attribute's value expression — including ones
 *  nested inside a ternary or function call — found by walking the
 *  attribute's balanced braces and collecting any backtick span met along
 *  the way. */
function findClassNameTemplates(text: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];
  ATTR_RE.lastIndex = 0;
  for (const m of text.matchAll(ATTR_RE)) {
    let i = m.index! + m[0].length; // just past the attribute's opening '{'
    let depth = 1;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      else if (c === '`') { const t = scanTemplateLiteral(text, i); out.push(t); i = t.end; }
      else if (c === "'" || c === '"') { i = skipString(text, i, c); }
      else if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? text.length : nl; }
      else if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; }
      else if (c === '{') { depth++; i++; }
      else if (c === '}') { depth--; i++; }
      else i++;
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** Pure: one file's text in, its violations out. No IO. */
export function scanClassNameTemplates(file: string, source: string): ClassNameTemplateViolation[] {
  const out: ClassNameTemplateViolation[] = [];
  for (const tpl of findClassNameTemplates(source)) {
    for (const interp of tpl.interpolations) {
      const before = interp.start > 0 ? source[interp.start - 1] : undefined;
      const after = interp.end < source.length ? source[interp.end] : undefined;
      if (isSafeBoundary(before) && isSafeBoundary(after)) continue;
      const ctxStart = Math.max(tpl.start, interp.start - 20);
      const ctxEnd = Math.min(tpl.end, interp.end + 20);
      const text = source.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
      out.push({ file, line: lineOf(source, interp.start), text });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
