#!/usr/bin/env node
// PreToolUse guard: refuse to write, edit, or shell out anything containing a
// live-looking API key literal.
//
// Why this exists: three files in this repo (bench.ts, tests/performance.test.ts,
// test_responses.ts) each carried a live OpenAI key in plaintext. They were
// untracked, so nothing caught them. This catches the next one at the point of
// writing rather than at the point of publishing.
//
// The patterns require a run of key material after the prefix, so prose and
// regexes that merely mention "sk-or-v1-" do not trip it.

import { execFileSync } from 'node:child_process';

const PATTERNS = [
  { name: 'OpenRouter key', re: /\bsk-or-v1-[A-Za-z0-9]{24,}/ },
  { name: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{24,}/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/ },
  { name: 'OpenAI key', re: /\bsk-[A-Za-z0-9]{32,}/ },
];

function scan(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return { name: p.name, sample: `${m[0].slice(0, 12)}...` };
  }
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const input = payload?.tool_input ?? {};
  const tool = payload?.tool_name ?? '';

  // Everything the tool would put on disk or into a shell.
  const candidates = [
    input.content,
    input.new_string,
    input.old_string,
    input.command,
    input.file_path,
  ];

  for (const text of candidates) {
    const hit = scan(text);
    if (hit) {
      deny(
        `Blocked: this ${tool} call contains what looks like a live ${hit.name} ` +
        `(${hit.sample}). Keys belong in the app's Settings panel in the browser, ` +
        `never in a file in this repo. If this is a placeholder, make it obviously ` +
        `fake (e.g. sk-or-v1-EXAMPLE).`
      );
    }
  }

  // A commit does not carry the secret in its command line — it carries it in the
  // index. Scan what is actually about to be committed.
  if ((tool === 'Bash' || tool === 'PowerShell') && /\bgit\s+commit\b/.test(input.command ?? '')) {
    try {
      const staged = execFileSync('git', ['diff', '--cached', '--unified=0'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const hit = scan(staged);
      if (hit) {
        deny(
          `Blocked: the staged changes contain what looks like a live ${hit.name} ` +
          `(${hit.sample}). Unstage and remove it before committing — a key in a ` +
          `commit survives deletion in later commits.`
        );
      }
    } catch {
      // git unavailable or no index: the Write/Edit guard above is the primary net.
    }
  }

  process.exit(0);
});
