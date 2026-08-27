import { describe, it, expect, vi, beforeEach } from 'vitest';
import { draftEmail } from './draftEmail';
import type { ReviewRun, Settings, Template } from '../../types';

vi.mock('../../lib/openrouter', () => ({ chat: vi.fn() }));
const { chat } = await import('../../lib/openrouter');

beforeEach(() => vi.clearAllMocks());

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };

const template: Template = {
  id: 't', name: 'T', contractType: 'Lease', mode: 'risk',
  systemPrompt: '', formatPrompt: '',
  clauses: [{ id: 'break', title: 'Break clause', prompt: '' }],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

// Step 0: `draftEmail` is built on `buildReportRows` (see its own doc
// comment) precisely so the two exporters can't drift on "what findings does
// this run have for this document." Before `buildReportRows` was fixed to
// key by `findingsKeyFor(run.target, docId)`, a collection review's findings
// (stored under the COLLECTION id) were invisible here too — the drafted
// email would summarise nothing, with no error, from a run that genuinely
// found something.
describe('draftEmail — a collection review (Step 0)', () => {
  function collectionRun(): ReviewRun {
    return {
      id: 'run-coll',
      templateSnapshot: template,
      documentIds: ['lease', 'deed'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['lease', 'deed'] },
      findings: {
        'coll-1': {
          break: {
            clauseId: 'break', status: 'done', summary: 'Break on 6 months notice, as amended.',
            citations: [], verification: { state: 'unchecked' }, notes: [],
          },
        },
      },
      startedAt: 0,
    };
  }

  it('sends the collection\'s findings to the model, not an empty set', async () => {
    vi.mocked(chat).mockResolvedValue('Dear Client, ...');
    await draftEmail(collectionRun(), 'lease', settings);

    expect(chat).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(chat).mock.calls;
    expect(call[0].user).toContain('Break on 6 months notice, as amended.');
  });

  // The fail-loudly rule: a drafted email built from zero findings is exactly
  // the kind of confidently-empty artifact a lawyer might send without
  // noticing it says nothing real.
  it('refuses to draft an email when there are no findings at all', async () => {
    const run = collectionRun();
    run.findings = {}; // No key for 'coll-1' at all.
    await expect(draftEmail(run, 'lease', settings)).rejects.toThrow(/no findings/i);
    expect(chat).not.toHaveBeenCalled();
  });
});
