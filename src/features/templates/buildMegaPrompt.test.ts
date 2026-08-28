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
    // Integrity review (D/E), Major 2. This used to be the literal string
    // 'Use global tolerance' — a pointer to a value the JSON prompt never
    // contained. `riskCriteriaBlock` resolves the same fallback for the real
    // extraction call, so the DIY prompt resolves it too.
    expect(parsed.clauses[1].risk_criteria).toBe('Risk-averse on liability.');
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

  // Integrity review (D/E), Major 2 — the DIY prompt has to describe what
  // the app actually does. Compared against what `extractClause` sends:
  // system is the system prompt followed by "OUTPUT RULES: <formatPrompt>", a risk
  // block resolved through `riskCriteriaBlock` (clause criteria else the
  // playbook's tolerance), the position comparison whenever the clause has a
  // standard position, and an explicit return shape.
  describe('the JSON branch sends what the app sends (Major 2)', () => {
    const parse = (t: PlaybookDraft, includeRisk = true) => {
      const prompt = buildMegaPrompt(t, 'json', includeRisk);
      return JSON.parse(prompt.slice(prompt.indexOf('{')));
    };

    it('carries the format prompt, which the app sends as its OUTPUT RULES', () => {
      expect(parse(templateWithClauses()).output_rules).toBe('Return structured JSON.');
    });

    it('carries the global risk tolerance rather than pointing at one it never included', () => {
      const parsed = parse(templateWithClauses());
      expect(parsed.risk_tolerance).toBe('Risk-averse on liability.');
      expect(JSON.stringify(parsed)).not.toContain('Use global tolerance');
    });

    it('asks for the MEETS / DEVIATES / UNCLEAR comparison, as the app does', () => {
      const t = templateWithClauses();
      t.clauses[0]!.standardPosition = {
        text: 'A 6-month break notice.', origin: 'authored', reviewedByHuman: true,
      };
      const parsed = parse(t);
      expect(JSON.stringify(parsed.clauses[0])).toMatch(/MEETS.*DEVIATES.*UNCLEAR/);
      // Not asked of a clause with no house rule — there is nothing to have
      // compared it against, exactly as `clauseSchema` decides.
      expect(JSON.stringify(parsed.clauses[1])).not.toMatch(/MEETS/);
      expect(parsed.return_for_each_clause.position_outcome).toBeTruthy();
    });

    it('asks for nothing about a position when no clause carries one', () => {
      const parsed = parse(templateWithClauses());
      expect('position_outcome' in parsed.return_for_each_clause).toBe(false);
    });

    it('states the return shape the app asks for, including every risk level', () => {
      const parsed = parse(templateWithClauses());
      expect(parsed.return_for_each_clause.summary).toBeTruthy();
      expect(parsed.return_for_each_clause.citations).toMatch(/verbatim/i);
      expect(parsed.return_for_each_clause.risk_level).toMatch(/High.*Medium.*Low.*Info/);
      expect(parsed.return_for_each_clause.risk_analysis).toBeTruthy();
    });

    it('drops the whole risk half when risk is off, and asks for no risk level', () => {
      const parsed = parse(templateWithClauses(), false);
      expect('risk_tolerance' in parsed).toBe(false);
      expect('risk_level' in parsed.return_for_each_clause).toBe(false);
    });
  });

  // The same gaps, on the copilot side: it named three of the four risk
  // levels the app accepts, and never listed the comparison it asks for.
  it('copilot names every risk level the app accepts, and the position outcome it asks for', () => {
    const t = templateWithClauses();
    t.clauses[0]!.standardPosition = {
      text: 'A 6-month break notice.', origin: 'authored', reviewedByHuman: true,
    };
    const prompt = buildMegaPrompt(t, 'copilot', true);
    expect(prompt).toMatch(/High.*Medium.*Low.*Info/);
    expect(prompt).toMatch(/OUTPUT FORMAT[\s\S]*MEETS/);
  });

  // Minor 7 (integrity review). `StandardPositionField.tsx` labels an
  // unreviewed AI-drafted position "Drafted by AI — not yet reviewed" in the
  // editor; the DIY prompt used to emit the same text under an unqualified
  // "Our standard position" regardless of `reviewedByHuman`, handing an
  // outside model (and whoever reads its answer) a suggestion nobody at the
  // firm has read, with the same authority as an actual house rule.
  describe('an unreviewed AI-drafted position is caveated, not presented as the firm\'s own (Minor 7)', () => {
    const unreviewed = {
      text: 'A 6-month break notice, no conditions.',
      origin: 'ai-drafted', reviewedByHuman: false,
    } as const;

    it('copilot format labels it as proposed and unreviewed', () => {
      const t = templateWithClauses();
      t.clauses[0]!.standardPosition = { ...unreviewed };
      const prompt = buildMegaPrompt(t, 'copilot', true);
      expect(prompt).not.toContain('Our standard position: A 6-month break notice');
      expect(prompt).toMatch(/NOT YET REVIEWED/);
      // Still asked for the comparison — this is a caveat, not a block.
      expect(prompt).toContain('A 6-month break notice, no conditions.');
      expect(prompt).toMatch(/MEETS.*DEVIATES.*UNCLEAR/);
    });

    it('json format flags it with a status field rather than a bare standard_position', () => {
      const t = templateWithClauses();
      t.clauses[0]!.standardPosition = { ...unreviewed };
      const prompt = buildMegaPrompt(t, 'json', true);
      const parsed = JSON.parse(prompt.slice(prompt.indexOf('{')));
      expect(parsed.clauses[0].standard_position).toBe('A 6-month break notice, no conditions.');
      expect(parsed.clauses[0].standard_position_status).toMatch(/NOT YET REVIEWED/);
    });

    it('a REVIEWED position gets no caveat, in either format', () => {
      const t = templateWithClauses();
      t.clauses[0]!.standardPosition = { ...unreviewed, reviewedByHuman: true };
      const copilotPrompt = buildMegaPrompt(t, 'copilot', true);
      expect(copilotPrompt).toContain('Our standard position: A 6-month break notice, no conditions.');
      expect(copilotPrompt).not.toMatch(/NOT YET REVIEWED/);

      const jsonPrompt = buildMegaPrompt(t, 'json', true);
      const parsed = JSON.parse(jsonPrompt.slice(jsonPrompt.indexOf('{')));
      expect('standard_position_status' in parsed.clauses[0]).toBe(false);
    });
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
