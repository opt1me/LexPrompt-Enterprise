import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractClause, buildClausePrompt, CLAUSE_SCHEMA } from './extractClause';
import type { Clause, Template, DocumentFile, Settings } from '../../types';

vi.mock('../../lib/openrouter', () => ({ chatJson: vi.fn() }));
const { chatJson } = await import('../../lib/openrouter');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };

const clause: Clause = {
  id: 'c1',
  title: 'Governing Law',
  prompt: 'Identify the governing law.',
  riskCriteria: 'Must be England and Wales.',
};

const template: Template = {
  id: 't1', name: 'Lease', contractType: 'Lease', mode: 'risk',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.', clauses: [clause],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

const doc: DocumentFile = {
  id: 'd1', name: 'lease.pdf', kind: 'pdf',
  text: 'This deed is governed by the laws of England and Wales.',
  file: new File([''], 'lease.pdf'),
};

beforeEach(() => vi.clearAllMocks());

describe('buildClausePrompt', () => {
  it('includes the clause instruction and the document text', () => {
    const prompt = buildClausePrompt(doc, clause, template);
    expect(prompt).toContain('Identify the governing law.');
    expect(prompt).toContain('England and Wales');
  });

  it('includes risk criteria in risk mode', () => {
    expect(buildClausePrompt(doc, clause, template)).toContain('Must be England and Wales.');
  });

  it('omits risk criteria in extraction mode', () => {
    const prompt = buildClausePrompt(doc, clause, { ...template, mode: 'extraction' });
    expect(prompt).not.toContain('Must be England and Wales.');
  });
});

describe('extractClause', () => {
  it('returns a done finding on success', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'England and Wales.',
      citations: ['governed by the laws of England and Wales'],
      risk_level: 'Low',
      risk_analysis: 'Matches the preferred jurisdiction.',
    });

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.clauseId).toBe('c1');
    expect(finding.summary).toBe('England and Wales.');
    expect(finding.citations).toEqual(['governed by the laws of England and Wales']);
    expect(finding.riskLevel).toBe('Low');
  });

  it('resolves to an error finding rather than rejecting', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/rate limited/);
    expect(finding.citations).toEqual([]);
  });

  it('passes the JSON schema through to the model', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(CLAUSE_SCHEMA);
  });

  it('coerces a missing citations array to empty', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'no citations given' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
    expect(finding.status).toBe('done');
  });

  it('drops a risk level the model invented outside the allowed set', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 'Catastrophic' });
    expect((await extractClause(doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('attaches page images for a scanned document', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const scan: DocumentFile = { ...doc, text: '', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] };

    await extractClause(scan, clause, template, settings);

    expect(vi.mocked(chatJson).mock.calls[0][0].images).toHaveLength(1);
  });

  it('sends no images for a document that has a text layer', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toBeUndefined();
  });

  it('reports a parse failure without calling the model', async () => {
    const broken: DocumentFile = { ...doc, text: '', parseError: 'corrupt file' };
    const finding = await extractClause(broken, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/corrupt file/);
    expect(chatJson).not.toHaveBeenCalled();
  });
});
