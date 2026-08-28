/**
 * Parses a JSON object out of a model response, tolerating a prose preamble
 * or a markdown code fence. Models vary in schema adherence and a run must
 * not fail because one added "Sure! Here you go:".
 *
 * Scans EVERY candidate `{` position (not just the first) and returns the
 * LAST one that parses as valid JSON, rather than the first. Two reasons:
 *  - The first `{` in the text may not actually open valid JSON (e.g. a
 *    stray "{approx}" in prose before the real object) — bailing out after
 *    that one failure would wrongly throw despite valid JSON existing later.
 *  - When multiple *valid* JSON objects are present (e.g. the model shows an
 *    example before its real answer), the model's answer is the last one it
 *    writes, not the first. This function is the fallback path for models
 *    that don't honor strict schemas — precisely the ones most likely to
 *    waffle — so silently returning the wrong (first) object is a real risk,
 *    not a theoretical one: it produces a plausible-looking wrong finding
 *    instead of a visible error.
 * A successful match causes the scan to resume AFTER that match's closing
 * brace (not inside it), so a valid outer object's nested braces are never
 * reprocessed as separate candidates.
 */
export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to extraction
  }

  let lastValid: T | undefined;
  let found = false;
  let pos = 0;

  while (pos < text.length) {
    const start = text.indexOf('{', pos);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) {
      // Never balances to depth 0 before the text ends (truncated/unclosed).
      // Try the next '{' rather than giving up entirely.
      pos = start + 1;
      continue;
    }

    try {
      lastValid = JSON.parse(text.slice(start, end + 1)) as T;
      found = true;
      pos = end + 1; // resume after the whole match; don't descend into it
    } catch {
      pos = start + 1; // not valid JSON from this start; try the next '{'
    }
  }

  if (found) return lastValid as T;
  throw new Error(`Could not parse a JSON object from the model response: ${text.slice(0, 200)}`);
}
