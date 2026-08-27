/** A short, collision-resistant-enough id for a local-only app: random
 *  suffix plus a timestamp, so ids are unique within a session and roughly
 *  ordered across them. Extracted after the same four lines had been
 *  written out seven times in this codebase, byte-identical each time. */
export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
