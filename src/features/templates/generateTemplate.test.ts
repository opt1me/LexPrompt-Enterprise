import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTemplate } from './generateTemplate';
import type { Settings } from '../../types';

vi.mock('../../lib/openrouter', () => ({ chatJson: vi.fn() }));
const { chatJson } = await import('../../lib/openrouter');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 3 };

const plan = {
  systemPrompt: 'You are a reviewer.',
  formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.',
  clausePlans: [
    { title: 'Term', instructionSummary: 'find the term', riskCriteriaSummary: 'over 5y is risky' },
    { title: 'Rent', instructionSummary: 'find the rent', riskCriteriaSummary: 'uncapped is risky' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatJson)
    .mockResolvedValueOnce(plan)
    .mockResolvedValue({ prompt: 'generated prompt', riskCriteria: 'generated criteria' });
});

describe('generateTemplate', () => {
  it('returns a saveable template built from the plan', async () => {
    const t = await generateTemplate({
      contractType: 'Commercial Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.contractType).toBe('Commercial Lease');
    expect(t.name).toBe('Commercial Lease');
    expect(t.systemPrompt).toBe('You are a reviewer.');
    expect(t.clauses.map(c => c.title)).toEqual(['Term', 'Rent']);
    expect(t.clauses[0].prompt).toBe('generated prompt');
    expect(t.clauses[0].id).toBeTruthy();
    expect(t.schemaVersion).toBeGreaterThan(0);
  });

  it('preserves the planned clause order despite parallel generation', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson)
      .mockResolvedValueOnce(plan)
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 20));
        return { prompt: 'slow first', riskCriteria: 'x' };
      })
      .mockResolvedValueOnce({ prompt: 'fast second', riskCriteria: 'y' });

    const t = await generateTemplate({
      contractType: 'Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.clauses[0].prompt).toBe('slow first');
    expect(t.clauses[1].prompt).toBe('fast second');
  });

  it('keeps a clause whose prompt generation failed, using the planned summary', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson)
      .mockResolvedValueOnce(plan)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ prompt: 'ok', riskCriteria: 'ok' });

    const t = await generateTemplate({
      contractType: 'Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.clauses.length).toBe(2);
    expect(t.clauses[0].prompt).toBe('find the term');
    expect(t.clauses[1].prompt).toBe('ok');
  });

  it('reports status as it progresses', async () => {
    const messages: string[] = [];
    await generateTemplate({
      contractType: 'NDA', depth: 'Light-Touch', verbosity: 'Concise', settings,
      onStatus: m => messages.push(m),
    });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.join(' ')).toMatch(/NDA/);
  });

  it('includes the requested depth guidance in the planning prompt', async () => {
    await generateTemplate({
      contractType: 'NDA', depth: 'Detailed', verbosity: 'Standard', settings,
    });
    expect(vi.mocked(chatJson).mock.calls[0][0].user).toContain('Detailed');
  });

  it('passes optional context through to the planner', async () => {
    await generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard',
      context: 'We are the disclosing party.', settings,
    });
    expect(vi.mocked(chatJson).mock.calls[0][0].user).toContain('We are the disclosing party.');
  });

  it('fails loudly when planning itself fails', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson).mockRejectedValue(new Error('bad key'));

    await expect(generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard', settings,
    })).rejects.toThrow(/bad key/);
  });

  it('rejects a plan with no clauses', async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson).mockResolvedValueOnce({ ...plan, clausePlans: [] });

    await expect(generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard', settings,
    })).rejects.toThrow(/no clauses/i);
  });
});
