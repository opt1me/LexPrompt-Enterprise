import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import type { Settings } from '../../types';

interface RawMissingClauses {
  titles?: unknown;
}

const MISSING_CLAUSES_SCHEMA = {
  type: 'object',
  properties: {
    titles: { type: 'array', items: { type: 'string' } },
  },
  required: ['titles'],
  additionalProperties: false,
} as const;

function normalise(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * "Suggest what I'm missing" (spec §6, Task 8). Proposes clause TITLES ONLY
 * against what the playbook already covers — the spec names the scope creep
 * this invites toward a general playbook assistant, and the answer is that
 * it proposes titles and nothing more. Extract prompts, risk criteria and
 * standard positions for an added title are drafted the ordinary way, one
 * field at a time, via `suggestField` — never here.
 *
 * Deduped against `existingTitles` case- and whitespace-insensitively: a
 * model proposing "break" against an existing "Break" (or "Break " with
 * trailing space) is proposing nothing. Also deduped against itself, so a
 * model that names the same gap twice in one response does not surface it
 * twice.
 *
 * An empty result is a legitimate answer — "nothing is obviously missing" —
 * not a failure, so unlike `suggestField` this never throws on an empty
 * list. Errors from `chatJson` still propagate untouched, so `isAuthFailure`
 * recognises a 401/403 on whatever this throws.
 */
export async function suggestMissingClauses(
  existingTitles: string[],
  contractType: string,
  settings: Settings,
): Promise<string[]> {
  const user = [
    `Contract type: ${contractType || 'unspecified'}.`,
    'This review playbook already covers these clauses:',
    existingTitles.length > 0 ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none yet)',
    '\nPropose clause TITLES ONLY for anything commonly reviewed in a contract of this type that ' +
      'is missing from the list above. Do not repeat a clause already covered, even if worded ' +
      'differently. List only genuinely material gaps — an empty list is a fine answer if nothing ' +
      'is missing.',
    '\nReturn just the titles, nothing else: { "titles": ["...", "..."] }.',
  ].join('\n');

  const raw = await gatewayModelClient.chatJson<RawMissingClauses>({
    modelChoiceId: settings.modelId,
    purpose: 'playbook.suggest',
    system:
      'You are an expert legal contract reviewer checking a review playbook for missing clauses. ' +
      'Propose clause TITLES ONLY — never an extract prompt, risk criteria or standard position.',
    user,
    jsonSchema: settings.modelSupportsStructuredOutput ? MISSING_CLAUSES_SCHEMA : undefined,
    temperature: 0.4,
  });

  const proposed = Array.isArray(raw.titles)
    ? raw.titles.filter((t): t is string => typeof t === 'string')
    : [];

  const existingNormalised = new Set(existingTitles.map(normalise));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of proposed) {
    const trimmed = title.trim();
    if (!trimmed) continue;
    const key = normalise(trimmed);
    if (existingNormalised.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
