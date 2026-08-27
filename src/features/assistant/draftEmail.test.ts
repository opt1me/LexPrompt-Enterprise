import { describe, it, expect, vi, beforeEach } from 'vitest';
import { draftEmail } from './draftEmail';
import type { Finding, ReviewRun, Settings, PlaybookVersion } from '../../types';
import { unconfirmedPosition, confirmPosition, amendPosition } from '../../lib/netPosition';

vi.mock('../../lib/openrouter', () => ({ chat: vi.fn() }));
const { chat } = await import('../../lib/openrouter');

beforeEach(() => vi.clearAllMocks());

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };

const template: PlaybookVersion = {
  id: 't', name: 'T', contractType: 'Lease',
  systemPrompt: '', formatPrompt: '',
  clauses: [{ id: 'break', title: 'Break clause', extractPrompt: '' }],
  playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
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

/**
 * M4 (final review). The drafted email is the most client-facing thing this
 * app produces — markdown a user copies straight into an email — and it was
 * the one consumer of `buildReportRows` that read only `title`, `summary`,
 * `riskLevel` and `riskAnalysis`. The three honesty labels the same rows
 * already carry never reached the model.
 *
 * For a collection review `row.summary` IS the net position: a synthesis no
 * document contains, which starts unconfirmed. Handing that to a model as
 * bare fact and asking it to summarise for a client is the exact failure the
 * spec forbids in as many words — "A net position starts unconfirmed and
 * says so, EVERYWHERE it appears."
 *
 * The DOCX and the CSV both label. So must the third consumer of the same
 * rows.
 */
describe('draftEmail — the honesty labels reach the prompt', () => {
  function runWith(finding: Finding): ReviewRun {
    return {
      id: 'r', templateSnapshot: template, documentIds: ['d1'],
      target: { kind: 'documents', documentIds: ['d1'] },
      findings: { d1: { break: finding } },
      startedAt: 0,
    };
  }

  function finding(overrides: Partial<Finding> = {}): Finding {
    return {
      clauseId: 'break', status: 'done', summary: 'Break on 6 months notice.',
      citations: [], verification: { state: 'unchecked' }, notes: [], ...overrides,
    };
  }

  async function promptFor(f: Finding): Promise<string> {
    vi.mocked(chat).mockResolvedValue('Dear Client, ...');
    const run = runWith(f);
    await draftEmail(run, 'd1', settings);
    return vi.mocked(chat).mock.calls[0][0].user;
  }

  it('marks an unverified finding as unverified AI output', async () => {
    expect(await promptFor(finding())).toContain('UNVERIFIED AI OUTPUT');
  });

  it('carries a rejection and its reason rather than presenting it as a finding', async () => {
    const f = finding({ verification: { state: 'rejected', reason: 'Wrong clause entirely.' } });
    const prompt = await promptFor(f);
    expect(prompt).toContain('REJECTED');
    expect(prompt).toContain('Wrong clause entirely.');
  });

  it('marks an unconfirmed net position, the most dangerous text it can send', async () => {
    const f = finding({
      summary: undefined,
      netPosition: unconfirmedPosition('The break date is 24 June 2030.', []),
    });
    const prompt = await promptFor(f);
    expect(prompt).toContain('UNCONFIRMED NET POSITION');
    expect(prompt).toContain('The break date is 24 June 2030.');
  });

  it('says a person wrote an amended position, which is a stronger claim than confirmed', async () => {
    const f = finding({
      summary: undefined,
      netPosition: amendPosition(unconfirmedPosition('Model text.', []), 'A person wrote this.', 'u1', 1),
    });
    expect(await promptFor(f)).toContain('AMENDED NET POSITION');
  });

  it('raises no caveat for a verified finding with a confirmed position', async () => {
    const f = finding({
      summary: undefined,
      verification: { state: 'verified', byUserId: 'u1', at: 1 },
      netPosition: confirmPosition(unconfirmedPosition('Confirmed text.', []), 'u1', 1),
    });
    const prompt = await promptFor(f);
    expect(prompt).not.toContain('UNVERIFIED');
    expect(prompt).not.toContain('UNCONFIRMED');
  });
});
