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

  it('drops a malformed clause plan entry and keeps the well-formed one', async () => {
    vi.mocked(chatJson).mockReset();
    const mixedPlan = {
      ...plan,
      clausePlans: [
        // Malformed: missing title entirely, the loose-parse-fallback shape
        // a non-structured-output model can produce.
        { instructionSummary: 'find the term', riskCriteriaSummary: 'over 5y is risky' },
        { title: 'Rent', instructionSummary: 'find the rent', riskCriteriaSummary: 'uncapped is risky' },
      ],
    };
    vi.mocked(chatJson)
      .mockResolvedValueOnce(mixedPlan)
      .mockResolvedValue({ prompt: 'ok', riskCriteria: 'ok' });

    const t = await generateTemplate({
      contractType: 'Lease', depth: 'Standard', verbosity: 'Standard', settings,
    });

    expect(t.clauses.length).toBe(1);
    expect(t.clauses[0].title).toBe('Rent');
  });

  it('rejects a plan where every clause entry is malformed', async () => {
    vi.mocked(chatJson).mockReset();
    const allBadPlan = {
      ...plan,
      clausePlans: [
        { title: '', instructionSummary: 'find the term', riskCriteriaSummary: 'x' },
        { title: 'Rent', instructionSummary: '', riskCriteriaSummary: 'y' },
      ],
    };
    vi.mocked(chatJson).mockResolvedValueOnce(allBadPlan);

    await expect(generateTemplate({
      contractType: 'NDA', depth: 'Standard', verbosity: 'Standard', settings,
    })).rejects.toThrow(/no (usable )?clauses/i);
  });

  it('never exceeds the configured concurrency limit during clause generation', async () => {
    vi.mocked(chatJson).mockReset();

    const manyClausesPlan = {
      ...plan,
      clausePlans: Array.from({ length: 6 }, (_, i) => ({
        title: `Clause ${i}`,
        instructionSummary: `summary ${i}`,
        riskCriteriaSummary: `risk ${i}`,
      })),
    };

    let inFlight = 0;
    let peak = 0;

    vi.mocked(chatJson).mockImplementation(async (req: { system?: string }) => {
      // The planning call has a distinct system prompt; only clause-generation
      // calls (phase two, the ones bound by settings.concurrency) count here.
      if (req.system?.includes('contract architect')) {
        return manyClausesPlan;
      }
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return { prompt: 'p', riskCriteria: 'r' };
    });

    const limited: Settings = { ...settings, concurrency: 2 };
    await generateTemplate({
      contractType: 'Lease', depth: 'Standard', verbosity: 'Standard', settings: limited,
    });

    // Bounded: never more in flight than the configured limit.
    expect(peak).toBeLessThanOrEqual(2);
    // Genuinely exercised the limiter (not an artifact of accidental
    // serial execution) — with 6 clauses and a shared delay, at least 2
    // must have overlapped.
    expect(peak).toBeGreaterThan(1);
  });
});
