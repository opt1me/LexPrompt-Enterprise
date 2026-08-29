/**
 * A short, collision-resistant-enough id: a random suffix plus a timestamp.
 *
 * DELIBERATELY the same four lines as `src/lib/uid.ts`, and this note is the
 * reason rather than an excuse. That module is browser code in the web app's
 * program, and `rows.ts`'s docstring explains at length why `apps/api`
 * cannot import from `src/` at all (one inline `import('./lib/docxRedlines')`
 * in `types.ts` pulls DOM globals into a Node service's typecheck). So the
 * choice was a duplicated four-line function or a DOM lib in the API's
 * tsconfig, and the second is worse: it removes the one thing that catches a
 * server file reaching for a browser API by mistake.
 *
 * What matters is that the two agree on the SHAPE — base36, no separators,
 * nothing needing URL escaping — because ids are minted on both sides now
 * (the browser mints a playbook's identity, the server mints each published
 * version's id) and both end up in the same `text` primary keys.
 *
 * `uid()` in the browser is this project's cautionary extraction: the same
 * four lines were written out SEVEN times before anybody pulled them into a
 * module. This is the second home, not the eighth copy, and it exists
 * because a module boundary makes it necessary rather than because nobody
 * noticed.
 */
export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
