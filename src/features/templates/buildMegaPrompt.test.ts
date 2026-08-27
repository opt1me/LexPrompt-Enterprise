import { describe, it, expect } from 'vitest';
import { buildMegaPrompt, defaultIncludeRisk } from './buildMegaPrompt';
import { newPlaybookDraft } from '../../lib/db/playbooks';
import type { PlaybookDraft } from '../../types';

function templateWithClauses(): PlaybookDraft {
  const t = newPlaybookDraft('Lease Review');
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
    const t = newPlaybookDraft('Empty');
    expect(() => buildMegaPrompt(t, 'copilot', true)).not.toThrow();
    expect(() => buildMegaPrompt(t, 'json', true)).not.toThrow();
  });

  // The DIY prompt has to ask the same question the app asks for the same
  // playbook: with a position present, a comparison rather than a summary.
  it('carries a clause standard position and asks for the comparison', () => {
    const t = templateWithClauses();
    t.clauses[0]!.standardPosition = {
      text: 'A 6-month break notice, no conditions.',
      origin: 'authored',
      reviewedByHuman: true,
    };
    const prompt = buildMegaPrompt(t, 'copilot', true);
    expect(prompt).toContain('A 6-month break notice, no conditions.');
    expect(prompt).toMatch(/MEETS.*DEVIATES.*UNCLEAR/);
  });

  it('carries a standard position into the json format too, and omits it where absent', () => {
    const t = templateWithClauses();
    t.clauses[0]!.standardPosition = {
      text: 'A 6-month break notice.',
      origin: 'authored',
      reviewedByHuman: true,
    };
    const prompt = buildMegaPrompt(t, 'json', true);
    const parsed = JSON.parse(prompt.slice(prompt.indexOf('{')));
    expect(parsed.clauses[0].standard_position).toBe('A 6-month break notice.');
    expect('standard_position' in parsed.clauses[1]).toBe(false);
  });

  // The risk block is off unless the playbook says something about risk —
  // R-D1's rule that presence, not a flag, decides.
  it('turns the risk block on only when the playbook says something about risk', () => {
    expect(defaultIncludeRisk(templateWithClauses())).toBe(true);

    const noTolerance = templateWithClauses();
    delete noTolerance.riskTolerance;
    expect(defaultIncludeRisk(noTolerance)).toBe(true); // clause criteria still count

    delete noTolerance.clauses[0]!.riskCriteria;
    expect(defaultIncludeRisk(noTolerance)).toBe(false);

    expect(defaultIncludeRisk(newPlaybookDraft('Empty'))).toBe(false);
  });
});
