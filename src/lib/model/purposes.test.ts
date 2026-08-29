import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { PURPOSES, type Purpose } from '@lexprompt/core';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Nine purposes, TEN call sites: `playbook.suggest` serves two files, so the
 * map is purpose -> files. A one-file-per-purpose map would let
 * `suggestMissingClauses.ts` lose its purpose with only `tsc` to catch it,
 * and `tsconfig.json` sets neither `strict` nor `noUnusedLocals`.
 */
const SITES: Record<Purpose, string[]> = {
  'review.clause': ['src/features/review/extractClause.ts'],
  'review.collection_clause': ['src/features/review/extractCollectionClause.ts'],
  'assistant.chat': ['src/features/assistant/chatContext.ts'],
  'playbook.draft': ['src/features/authoring/generateDraft.ts'],
  'playbook.suggest': [
    'src/features/templates/suggestField.ts',
    'src/features/templates/suggestMissingClauses.ts',
  ],
  'redlines.infer': ['src/lib/inferPositions.ts'],
  'changeset.build': ['src/lib/buildChangeset.ts'],
  'export.email': ['src/features/assistant/draftEmail.ts'],
  'export.suggest_fix': ['src/features/assistant/suggestRevision.ts'],
};

describe('every purpose has a call site, and every call site names one', () => {
  it('covers all nine purposes', () => {
    expect(Object.keys(SITES).sort()).toEqual([...PURPOSES].sort());
  });

  it('covers all ten call sites', () => {
    expect(Object.values(SITES).flat()).toHaveLength(10);
  });

  it.each(Object.entries(SITES).flatMap(([p, fs]) => fs.map(f => [p, f] as const)))(
    '%s is named in %s', (purpose, file) => {
      expect(readFileSync(path.join(ROOT, file), 'utf8')).toContain(`'${purpose}'`);
    });

  // A whole-file text search for `apiKey`/`modelId` is the wrong check here:
  // `generateDraft.ts` legitimately writes `AuthoringDraft.modelId` (which
  // model drafted this playbook — a persisted fact, nothing to do with the
  // deleted `Settings.modelId`/`InferRequest` shape), and a bare-string scan
  // would flag that as if it were the old request shape. What must actually
  // be empty is the SET OF PROPERTIES ON THE REQUEST OBJECT LITERAL each
  // `chat`/`chatJson`/`chatStream` call sends — checked via the same AST
  // walk the call-coverage guard below uses, over exactly these ten files.
  it('no call site still passes an apiKey or a modelId on its request object', () => {
    const offenders: string[] = [];
    for (const file of Object.values(SITES).flat()) {
      const full = path.join(ROOT, file);
      const text = readFileSync(full, 'utf8');
      const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const call of findChatCalls(source)) {
        if (call.requestKeys.includes('apiKey')) offenders.push(`${file}:${call.line} still passes apiKey`);
        if (call.requestKeys.includes('modelId')) offenders.push(`${file}:${call.line} still passes modelId`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The brief's own coverage test (above) checks `purpose` only — a call could
 * pass a correct `purpose` and a quietly-empty (or entirely absent) context
 * and still pass every check above it, which is exactly the "context
 * quietly left {}" failure this task exists to prevent (§12: the audit
 * record must answer which matter, review, clause or document a call
 * served). This table is the brief's own mapping, restated as the ids each
 * site's `context` must carry — `generateDraft.ts`/`suggestField.ts`/
 * `suggestMissingClauses.ts` genuinely carry none (drafted before a matter,
 * review or document exists), so `[]` there is correct, not an oversight.
 */
const EXPECTED_CONTEXT_KEYS: Record<string, string[]> = {
  'src/features/review/extractClause.ts': ['matterId', 'reviewId', 'clauseId', 'documentIds'],
  'src/features/review/extractCollectionClause.ts': ['matterId', 'reviewId', 'clauseId', 'documentIds'],
  'src/features/assistant/chatContext.ts': ['matterId', 'documentIds'],
  'src/features/authoring/generateDraft.ts': [],
  'src/features/templates/suggestField.ts': [],
  'src/features/templates/suggestMissingClauses.ts': [],
  // `[]`, not `['documentIds']`: both read redlines documents that are never
  // persisted, so an id sent here would name nothing anywhere. See the
  // comment at each call site.
  'src/lib/inferPositions.ts': [],
  'src/lib/buildChangeset.ts': [],
  'src/features/assistant/draftEmail.ts': ['matterId', 'reviewId'],
  'src/features/assistant/suggestRevision.ts': ['matterId', 'reviewId', 'clauseId'],
};

describe('every call site carries the context its table row names', () => {
  it.each(Object.entries(EXPECTED_CONTEXT_KEYS))('%s', (file, expectedKeys) => {
    const full = path.join(ROOT, file);
    const text = readFileSync(full, 'utf8');
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls = findChatCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // `undefined` (no `context:` property, or not an object literal in
      // place) fails exactly like a wrong key set — both are "this call's
      // context cannot be confirmed to carry what its row names".
      expect([...(call.contextKeys ?? [])].sort()).toEqual([...expectedKeys].sort());
    }
  });
});

/**
 * The guard that actually protects the FUTURE, not just today's ten sites
 * (CLAUDE.md's "correct mechanism with no path to it" defect, hit seventeen
 * times in this codebase): every `chat`/`chatJson`/`chatStream` call anywhere
 * under `src/` must pass a `purpose` that is a member of `PURPOSES`, found by
 * parsing each file's AST rather than by enumerating file names — a listed
 * file passes because it is on the list above; an unlisted eleventh call
 * site is caught here because it is a `chat*` call with no recognisable
 * `purpose` property at all, which is exactly the shape a forgotten purpose
 * takes. A hand-maintained list of "every current call site" would pass
 * forever while a future one goes untracked; this walks the actual source
 * instead.
 */
interface FoundCall {
  file: string;
  line: number;
  purposeLiteral: string | undefined;
  /** Every property NAME on the request object literal — used both to
   *  confirm `purpose` (above) and to confirm `apiKey`/`modelId` are
   *  genuinely gone from the shape sent to the gateway, not just absent from
   *  a whole-file text search that a same-named, unrelated field would
   *  defeat. */
  requestKeys: string[];
  /** Property NAMES on the `context` object literal, when the request
   *  carries one written as an object literal in place (every call site in
   *  this codebase writes it this way — none spreads or forwards a
   *  precomputed context variable). `undefined` when there is no `context`
   *  property at all, or when it is not written as an object literal in
   *  place — either way, `undefined` reads as "this call's context cannot be
   *  confirmed present", which is exactly the failure §12 warns about: a
   *  call whose audit record cannot answer which matter, review, clause or
   *  document it served. */
  contextKeys: string[] | undefined;
}

const CHAT_METHODS = new Set(['chat', 'chatJson', 'chatStream']);

function findChatCalls(sourceFile: ts.SourceFile): FoundCall[] {
  const found: FoundCall[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      let methodName: string | undefined;
      if (ts.isPropertyAccessExpression(expr)) {
        methodName = expr.name.text;
      } else if (ts.isIdentifier(expr)) {
        // A BARE call, e.g. `chatJson({...})`. `gatewayModelClient.ts`
        // returns plain closures precisely so that
        // `const { chatJson } = client` works, and its own suite tests that
        // — so this is a usage the client documents as supported, and a
        // walk that only recognised `x.chatJson(...)` would let an
        // eleventh call site written that way go untracked while this
        // forever-guard reported green.
        methodName = expr.text;
      }
      if (methodName && CHAT_METHODS.has(methodName)) {
        // The request object is always the call's first argument in this
        // codebase's `ModelClient` shape (`req: InferRequest`, ...rest).
        const arg = node.arguments[0];
        let purposeLiteral: string | undefined;
        let contextKeys: string[] | undefined;
        const requestKeys: string[] = [];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : undefined;
            if (name) requestKeys.push(name);
            if (
              ts.isPropertyAssignment(prop) &&
              name === 'purpose' &&
              ts.isStringLiteral(prop.initializer)
            ) {
              purposeLiteral = prop.initializer.text;
            }
            if (
              ts.isPropertyAssignment(prop) &&
              name === 'context' &&
              ts.isObjectLiteralExpression(prop.initializer)
            ) {
              contextKeys = prop.initializer.properties
                .map(p => (p.name && ts.isIdentifier(p.name) ? p.name.text : undefined))
                .filter((n): n is string => n !== undefined);
            }
          }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        found.push({ file: sourceFile.fileName, line: line + 1, purposeLiteral, requestKeys, contextKeys });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The client ITSELF, which defines `chat`/`chatJson`/`chatStream` and calls
 * `chat` from inside `chatJson`. Those are the implementation, not call
 * sites, and they carry no `purpose` because the purpose is their caller's.
 *
 * ONE named file, asserted below to be exactly that file, for the reason
 * `stage1DoD.test.ts` gives about its own single exemption: a guard whose
 * exemption list can grow silently is a guard that reports whatever is
 * convenient. (The guard exempts the definition site precisely so it can
 * recognise BARE calls everywhere else — see `findChatCalls`.)
 */
const CLIENT_DEFINITION = 'src/lib/model/gatewayModelClient.ts';

describe('every chat/chatJson/chatStream call in src/ carries a valid purpose', () => {
  const files = listSourceFiles(path.join(ROOT, 'src'))
    .filter(f => path.relative(ROOT, f).replace(/\\/g, '/') !== CLIENT_DEFINITION);

  it('exempts exactly one file, and it is the client that defines the methods', () => {
    const all = listSourceFiles(path.join(ROOT, 'src'))
      .map(f => path.relative(ROOT, f).replace(/\\/g, '/'));
    expect(all).toContain(CLIENT_DEFINITION);
    expect(all.length - files.length).toBe(1);
  });

  it('finds at least the ten known call sites (sanity check on the AST walk itself)', () => {
    let total = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      total += findChatCalls(source).length;
    }
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('every call passes a purpose literal that is a member of PURPOSES', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const call of findChatCalls(source)) {
        const rel = path.relative(ROOT, call.file).replace(/\\/g, '/');
        if (!call.purposeLiteral) {
          offenders.push(`${rel}:${call.line} — no literal 'purpose' property on this call`);
        } else if (!(PURPOSES as readonly string[]).includes(call.purposeLiteral)) {
          offenders.push(`${rel}:${call.line} — purpose '${call.purposeLiteral}' is not in PURPOSES`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The walk itself, exercised against synthetic source.
 *
 * `findChatCalls` used to recognise only `x.chatJson(...)`. But
 * `gatewayModelClient.ts` returns plain closures explicitly so that
 * `const { chatJson } = client` works, and its own suite tests that — so a
 * future eleventh call site written the supported way would have been
 * invisible to the "every call in `src/` carries a valid purpose" guard,
 * which would have gone on reporting green over an untracked call.
 */
describe('the AST walk recognises the call shapes this codebase supports', () => {
  function parse(text: string): ts.SourceFile {
    return ts.createSourceFile('synthetic.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  }

  it('finds a method call on the client', () => {
    const calls = findChatCalls(parse(
      "await gatewayModelClient.chatJson({ purpose: 'review.clause', context: { matterId: 'm' } });",
    ));
    expect(calls).toHaveLength(1);
    expect(calls[0].purposeLiteral).toBe('review.clause');
    expect(calls[0].contextKeys).toEqual(['matterId']);
  });

  it('finds a DESTRUCTURED call, which the client documents as supported', () => {
    const calls = findChatCalls(parse(
      "const { chatJson } = gatewayModelClient;\nawait chatJson({ purpose: 'review.clause', context: {} });",
    ));
    expect(calls).toHaveLength(1);
    expect(calls[0].purposeLiteral).toBe('review.clause');
  });

  it('reports a destructured call with no purpose, which is the shape a forgotten one takes', () => {
    const calls = findChatCalls(parse("await chat({ user: 'hello' });"));
    expect(calls).toHaveLength(1);
    expect(calls[0].purposeLiteral).toBeUndefined();
  });
});
