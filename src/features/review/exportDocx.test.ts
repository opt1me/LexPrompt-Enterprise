import { describe, it, expect } from 'vitest';
import { buildReportRows } from './exportDocx';
import type { ReviewRun, Template } from '../../types';

const template: Template = {
  id: 't', name: 'T', contractType: 'NDA', mode: 'risk',
  systemPrompt: '', formatPrompt: '',
  clauses: [
    { id: 'c1', title: 'Term', prompt: '' },
    { id: 'c2', title: 'Law', prompt: '' },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

const run: ReviewRun = {
  id: 'r', templateSnapshot: template, documentIds: ['d1'],
  findings: {
    d1: {
      c1: { clauseId: 'c1', status: 'done', summary: 'Three years.', citations: ['a term of three years'], riskLevel: 'Low', riskAnalysis: 'Standard.' },
      c2: { clauseId: 'c2', status: 'error', citations: [], error: 'timed out' },
    },
  },
  startedAt: 0,
};

describe('buildReportRows', () => {
  it('emits one row per clause in template order', () => {
    expect(buildReportRows(run, 'd1').map(r => r.title)).toEqual(['Term', 'Law']);
  });

  it('carries summary, risk and citations through', () => {
    const row = buildReportRows(run, 'd1')[0];
    expect(row.summary).toBe('Three years.');
    expect(row.riskLevel).toBe('Low');
    expect(row.citations).toEqual(['a term of three years']);
  });

  it('renders a failed clause honestly rather than as an empty finding', () => {
    const row = buildReportRows(run, 'd1')[1];
    expect(row.summary).toMatch(/not (be )?review/i);
    expect(row.summary).toMatch(/timed out/);
  });

  it('marks a clause with no citations', () => {
    const noCite: ReviewRun = {
      ...run,
      findings: { d1: { c1: { clauseId: 'c1', status: 'done', summary: 's', citations: [] }, c2: run.findings.d1.c2 } },
    };
    expect(buildReportRows(noCite, 'd1')[0].citations).toEqual([]);
  });

  it('returns an empty list for an unknown document', () => {
    expect(buildReportRows(run, 'nope')).toEqual([]);
  });
});
