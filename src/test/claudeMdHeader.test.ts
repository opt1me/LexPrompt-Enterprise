import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * `CLAUDE.md`'s OPENING AND ARCHITECTURE BLOCK, CHECKED AGAINST THE REPOSITORY.
 *
 * ## Why a binding document needs a test
 *
 * `CLAUDE.md` is the first thing every agent working on this repository
 * reads, and it is read as authority. For five server stages its opening
 * paragraphs said *"A browser-only AI contract-review app … No backend. No
 * accounts. The user supplies their own OpenRouter API key"* and its
 * Architecture block named `src/lib/openrouter.ts` as *"the only route to a
 * provider"* — a file `src/lib/model/stage1DoD.test.ts` asserts does not
 * exist. The BODY of the document was kept current through two rewrites
 * (precedent storage, multi-user); the header, the part a reader trusts
 * before reading anything else, was never revisited. An agent that believed
 * it would go looking for a deleted file and conclude the repository was
 * broken — or, worse, write a browser-side provider call because the binding
 * document said that was the architecture.
 *
 * ## What this can and cannot check
 *
 * It cannot read prose for truth. What it CAN do is exactly what caught the
 * problem when a human read it, mechanically:
 *
 *  1. **Every file path the document names exists.** This is the general
 *     check and the one that catches the specific defect: a document naming
 *     a deleted file is stale in the way that misleads a reader into
 *     searching for it. Paths written as a shorthand tail (`db/reviews.ts`)
 *     are resolved by suffix, because that is how the document refers to a
 *     module inside a directory it has already named.
 *  2. **The header does not carry a sentence the shipped architecture
 *     contradicts.** Each pattern below is paired with the assertion in this
 *     repository that makes it false, so a reader of this file can check the
 *     claim rather than take it.
 *  3. **The header positively names the parts that do ship.** A header that
 *     simply deleted the false sentences would be less wrong and no more
 *     useful; the failure this guards against is an agent forming a mental
 *     model, and a header that says nothing lets them form one from the
 *     `src/`-only file tree.
 *
 * Deliberately scoped to the HEADER, not the whole document. The body
 * discusses history at length — *"this paragraph used to say the
 * opposite"*, *"R1 is superseded"* — and a scan that refused the word
 * "browser-only" anywhere would forbid the document from explaining what
 * changed, which is most of what makes it useful.
 */

const ROOT = resolve(__dirname, '../..');
const DOC = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

/**
 * Everything before the first convention — the opening paragraphs, the
 * failure list and the Architecture block — MINUS its block quotes.
 *
 * A `> ` block is this document's own way of saying what it used to say, and
 * the header carries one: the note explaining why this test exists quotes
 * the false sentences verbatim. Scanning it would make the explanation of a
 * defect indistinguishable from the defect, which is the same mistake as
 * `codeOf` stripping comments in the SQL guards — a scanner that cannot tell
 * a statement from a sentence describing one gets relaxed until it stops
 * biting.
 */
const HEADER = DOC
  .split('## Conventions that were expensive to learn')[0]
  .split('\n')
  .filter(line => !line.trimStart().startsWith('>'))
  .join('\n');

describe('the scan reads the document it claims to read', () => {
  it('finds CLAUDE.md, and a header that is a real slice of it', () => {
    expect(DOC.length).toBeGreaterThan(10000);
    // The split found its marker: a header equal to the whole document means
    // the heading was renamed and this scan silently became a whole-document
    // scan, which the docstring above says it must not be.
    expect(HEADER.length).toBeLessThan(DOC.length);
    expect(HEADER).toContain('## Architecture');
  });

  it('finds file paths to check, in the header and in the body', () => {
    // A count, because the specific paths are the thing under test — but a
    // floor high enough that a regex which stopped matching fails here.
    expect(pathsNamedIn(DOC).length).toBeGreaterThan(15);
    expect(pathsNamedIn(HEADER).length).toBeGreaterThan(3);
  });
});

/** Every backticked file path in a slice of the document. */
function pathsNamedIn(text: string): string[] {
  const found = new Set<string>();
  const pattern = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|css|json|sql|mjs))`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1].includes('/')) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Every source file in the repository, as a repo-relative path.
 *
 * Built once and reused: a path in the document is "real" if it is a suffix
 * of one of these, which is what lets `db/reviews.ts` and
 * `routes/admin/roleMappings.ts` resolve without the document having to
 * spell out a full path every time it mentions a neighbour.
 */
const REPO_FILES = ((): string[] => {
  const out: string[] = [];
  const step = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { step(full); continue; }
      out.push(full.slice(ROOT.length + 1).split('\\').join('/'));
    }
  };
  for (const root of ['src', 'apps', 'packages', 'public', 'scripts', 'docs']) {
    if (existsSync(join(ROOT, root))) step(join(ROOT, root));
  }
  return out;
})();

/**
 * The paths the document names PRECISELY IN ORDER TO SAY THEY ARE GONE.
 *
 * Listed rather than pattern-matched out of the prose, and each entry must
 * still satisfy BOTH halves: the file really is absent, and the document
 * really does say so. A stale entry — one whose file came back, or whose
 * sentence was rewritten — fails here rather than silently exempting a path
 * whose meaning has changed underneath it. That is the same posture
 * `workspaceScope.test.ts` takes with `SCOPED_BY_KEY`: an exemption nobody
 * re-reads is an exemption that covers whatever moves under it next.
 */
const NAMED_AS_GONE: { path: string; sentence: RegExp }[] = [
  {
    path: 'src/lib/openrouter.ts',
    sentence: /`src\/lib\/openrouter\.ts` \*\*is deleted\*\*/,
  },
  {
    path: 'src/lib/citations.ts',
    sentence: /it was `src\/lib\/citations\.ts` until Stage 3/,
  },
];

describe('CLAUDE.md names no file this repository does not have', () => {
  it('exempts only paths it says are gone, and each is still gone and still said to be', () => {
    for (const { path: named, sentence } of NAMED_AS_GONE) {
      expect(existsSync(join(ROOT, named)), `${named} exists again — this exemption is stale`)
        .toBe(false);
      expect(sentence.test(DOC), `CLAUDE.md no longer says ${named} is gone`).toBe(true);
    }
  });

  it('walks a real repository', () => {
    expect(REPO_FILES.length).toBeGreaterThan(300);
    expect(REPO_FILES).toContain('src/lib/storage.ts');
  });

  it('resolves every path it names, by full path or by tail', () => {
    /*
     * THE CHECK THAT WOULD HAVE CAUGHT M7. `src/lib/openrouter.ts` was named
     * as live architecture in a document a test elsewhere asserts the file's
     * absence in. Two statements about one file, in one repository, five
     * stages apart, and nothing compared them.
     */
    const gone = NAMED_AS_GONE.map(e => e.path);
    const unresolved = pathsNamedIn(DOC).filter(named =>
      !gone.includes(named)
      && !existsSync(join(ROOT, named))
      && !REPO_FILES.some(real => real === named || real.endsWith(`/${named}`)));
    expect(unresolved, 'CLAUDE.md names files that do not exist — a binding document that '
      + 'sends a reader looking for a deleted file is read as the repository being broken')
      .toEqual([]);
  });
});

/**
 * The sentences the header must not carry, each with the shipped assertion
 * that contradicts it.
 *
 * Written as the FALSE claim rather than as the true one on purpose: a
 * positive match ("does the header say the right thing") drifts into
 * asserting one phrasing of a paragraph nobody may then improve. This
 * refuses a specific wrong claim and leaves the right one free to be
 * rewritten.
 */
const CONTRADICTED: { claim: RegExp; because: string }[] = [
  {
    claim: /browser-only/i,
    because: 'apps/api, apps/gateway and a Postgres schema all ship — see docker-compose.yml',
  },
  {
    claim: /\bNo backend\b/i,
    because: 'apps/api/src/server.ts is the backend',
  },
  {
    claim: /\bNo accounts\b/i,
    because: 'apps/api/src/auth validates an OIDC token and app_user holds the accounts',
  },
  {
    claim: /supplies their own OpenRouter API key/i,
    because: 'stage1DoD.test.ts asserts the browser PURGES any stored key, and the gateway '
      + 'is the only thing holding a provider credential',
  },
  {
    claim: /`src\/lib\/openrouter\.ts` is the only route/i,
    because: 'stage1DoD.test.ts asserts existsSync(src/lib/openrouter.ts) === false',
  },
  {
    claim: /nothing leaves the browser except calls to OpenRouter/i,
    because: 'every request goes to the firm\'s own API and gateway; precedentPromise.test.ts '
      + 'polices the successor sentence',
  },
];

describe('the header does not contradict the shipped architecture', () => {
  it('recognises each false claim in the text it was written for', () => {
    // THE SANITY HALF. Six patterns that match nothing would report six
    // silences, and the whole failure this file exists for is a paragraph
    // nobody re-read. Each is exercised against the sentence it was written
    // to refuse — the exact words that shipped in this document.
    const shipped = 'A browser-only AI contract-review app. No backend. No accounts. The user '
      + 'supplies their own OpenRouter API key. `src/lib/openrouter.ts` is the only route to a '
      + 'provider. The app\'s own disclosure says nothing leaves the browser except calls to '
      + 'OpenRouter.';
    for (const { claim } of CONTRADICTED) {
      expect(claim.test(shipped), `${claim} matched nothing in the sentence it refuses`)
        .toBe(true);
    }
  });

  it('carries none of them', () => {
    const carried = CONTRADICTED
      .filter(({ claim }) => claim.test(HEADER))
      .map(({ claim, because }) => `${claim} — false because ${because}`);
    expect(carried, 'CLAUDE.md\'s header states something this repository contradicts')
      .toEqual([]);
  });

  it('and the file the header used to name really is gone', () => {
    // Stated here as well as in `stage1DoD.test.ts`, deliberately: the two
    // facts that disagreed for five stages are now asserted beside each
    // other, so they cannot drift apart again without one of them failing.
    expect(existsSync(join(ROOT, 'src/lib/openrouter.ts'))).toBe(false);
  });

  it('names the parts that do ship, so a reader forms the right model', () => {
    // A header that only deleted the false sentences would be less wrong and
    // no more useful. Substrings rather than sentences, so the paragraph
    // stays free to be rewritten.
    for (const part of ['apps/api', 'apps/gateway', 'packages/core', 'Postgres', 'gateway']) {
      expect(HEADER, `the header does not mention ${part}`).toContain(part);
    }
  });
});
