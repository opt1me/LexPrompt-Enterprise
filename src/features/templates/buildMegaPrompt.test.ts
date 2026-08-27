import { describe, it, expect } from 'vitest';
import { buildMegaPrompt } from './buildMegaPrompt';
import { newPlaybook as newTemplate } from '../../lib/db/playbooks';
import type { Template } from '../../types';

function templateWithClauses(): Template {
  const t = newTemplate('Lease Review');
  t.systemPrompt = 'You are a reviewer.';
  t.formatPrompt = 'Return structured JSON.';
  t.riskTolerance = 'Risk-averse on liability.';
  t.clauses = [
    { id: 'c1', title: 'Term', extractPrompt: 'What is the lease term?', riskCriteria: 'Flag any term over 10 years.' },
    { id: 'c2', title: 'Rent', extractPrompt: 'What is the rent?' },
  ];
  return t;
}

describe('buildMegaPrompt', () => {
  it('includes the system/format prompts and every clause in copilot format', () => {
    const prompt = buildMegaPrompt(templateWithClauses(), 'copilot', true);
    expect(prompt).toContain('You are a reviewer.');
    expect(prompt).toContain('Return structured JSON.');
    expect(prompt).toContain('Term');
    expect(prompt).toContain('What is the lease term?');
    expect(prompt).toContain('Rent');
  });

  it('includes risk criteria and tolerance when risk is enabled', () => {
    const prompt = buildMegaPrompt(templateWithClauses(), 'copilot', true);
    expect(prompt).toContain('Risk-averse on liability.');
    expect(prompt).toContain('Flag any term over 10 years.');
    expect(prompt).toMatch(/Risk Level/);
  });

  it('omits risk criteria and disables risk reporting when risk is off', () => {
    const prompt = buildMegaPrompt(templateWithClauses(), 'copilot', false);
    expect(prompt).not.toContain('Flag any term over 10 years.');
    expect(prompt).toContain('Risk reporting is DISABLED.');
    expect(prompt).not.toMatch(/Risk Level/);
  });

  it('produces valid JSON containing every clause in json format', () => {
    const prompt = buildMegaPrompt(templateWithClauses(), 'json', true);
    const jsonStart = prompt.indexOf('{');
    const parsed = JSON.parse(prompt.slice(jsonStart));
    expect(parsed.clauses).toHaveLength(2);
    expect(parsed.clauses[0].title).toBe('Term');
    expect(parsed.clauses[0].risk_criteria).toBe('Flag any term over 10 years.');
    expect(parsed.clauses[1].risk_criteria).toBe('Use global tolerance');
  });

  it('json format omits risk_criteria entirely when risk is off', () => {
    const prompt = buildMegaPrompt(templateWithClauses(), 'json', false);
    const jsonStart = prompt.indexOf('{');
    const parsed = JSON.parse(prompt.slice(jsonStart));
    expect(parsed.clauses[0].risk_criteria).toBeUndefined();
  });

  it('handles a template with no clauses', () => {
    const t = newTemplate('Empty');
    expect(() => buildMegaPrompt(t, 'copilot', true)).not.toThrow();
    expect(() => buildMegaPrompt(t, 'json', true)).not.toThrow();
  });
});
