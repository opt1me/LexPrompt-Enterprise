import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

/**
 * The scanning primitives §18's "searched for, not assumed" checks are built
 * from — `walk` and `codeOf` — extracted here rather than written twice
 * because `configSurface` (this workspace) and `stage1DoD` (the web
 * workspace) both need them, and this project's own rule is "when you find
 * yourself writing a second copy, extract it then".
 */

/** The repository root, from this file's location. */
export const ROOT = path.resolve(__dirname, '../../..');

/** Every `.ts`/`.tsx` source file under `dir`, excluding tests and build output. */
export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'test_docs', 'fixtures'].includes(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** `full`, relative to the repository root, with forward slashes. */
export function rel(full: string): string {
  return path.relative(ROOT, full).replace(/\\/g, '/');
}

/**
 * The source of `file` with every comment blanked out, positions preserved.
 *
 * A text search over raw source cannot tell a violation from a note SAYING
 * it must not happen, and this codebase is full of the second kind — the
 * gateway's config module explains at length why nothing reads
 * `process.env`, `src/lib/auth/oidc.ts` explains at length why the app does
 * not use MSAL, and `storage.ts` explains why it deletes an `apiKey`. A
 * regex over the raw text flags all three, which leaves an executor two
 * moves: relax the pattern until it stops biting, or exempt the file. Both
 * end with a guard that no longer searches for the thing it names.
 *
 * So the comments are removed FIRST, by the real TypeScript parser rather
 * than by a regex that cannot tell `//` in a string from `//` starting a
 * comment. Every comment is leading trivia of some token, so walking every
 * token — `getChildren`, not `forEachChild`, which skips punctuation — and
 * blanking each token's leading comment ranges removes all of them.
 * Whitespace is substituted so offsets and line numbers still line up with
 * the file on disk.
 */
export function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const chars = text.split('');
  const visit = (node: ts.Node): void => {
    const full = node.getFullStart();
    if (full < node.getStart(source, false)) {
      for (const range of ts.getLeadingCommentRanges(text, full) ?? []) {
        for (let i = range.pos; i < range.end; i++) {
          if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        }
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return chars.join('');
}

/** Every uppercase environment-variable name this repository's apps use. */
export const ENV_NAME = /\b(?:API|GATEWAY|VITE|KC|OPENAI|ANTHROPIC|OPENROUTER)_[A-Z0-9_]+\b/g;
