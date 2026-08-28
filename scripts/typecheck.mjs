// Typecheck every tsconfig in the repo, discovered rather than listed.
//
// This script exists because the hand-written list it replaces had three holes
// at once: it typechecked the gateway but not `packages/core`, and it chained
// `apps/api/tsconfig.json` — a workspace that does not exist until Stage 1's
// Task 16 — so the whole gate exited non-zero for a reason unrelated to any
// error in the code. Meanwhile the root `tsc --noEmit` that was being run as
// "the" gate does not cover the gateway's test files at all, so two real type
// errors sat in `allowlist.test.ts` and `audit.test.ts` across two task
// reviews without ever failing a check.
//
// A list has to be updated by whoever adds a workspace. Discovery cannot be
// forgotten: a new `apps/<name>/tsconfig.json` is covered the day it is
// created, which is the difference between a gate and a convention.
//
// Every project is checked even after one fails — `&&` stops at the first,
// which turns "three projects are broken" into "something is broken", and the
// next run into another single-error guessing game.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every tsconfig to check: the root, then each workspace that has one. */
function projects() {
  const found = ['tsconfig.json'];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(group)) continue;
    for (const name of readdirSync(group, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const path = join(group, name.name, 'tsconfig.json');
      if (existsSync(path)) found.push(path);
    }
  }
  return found;
}

const failed = [];
for (const project of projects()) {
  process.stdout.write(`typecheck ${project} ... `);
  try {
    execFileSync('npx', ['tsc', '--noEmit', '-p', project], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    process.stdout.write('ok\n');
  } catch (error) {
    process.stdout.write('FAILED\n');
    // tsc writes diagnostics to stdout, not stderr.
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    if (out) console.log(out);
    failed.push(project);
  }
}

if (failed.length > 0) {
  console.error(`\ntypecheck failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\ntypecheck clean (${projects().length} projects)`);
