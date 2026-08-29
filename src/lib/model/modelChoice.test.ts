import { describe, it, expect } from 'vitest';
import type { AllowedModel } from '@lexprompt/core';
import type { WorkspaceSettings } from '@lexprompt/core';
import {
  isStaleModelChoice, modelProvenanceName,
  MODEL_CHOICE_STALE, MODEL_CHOICE_STALE_MESSAGE,
} from './modelChoice';

const model = (id: string, over: Partial<AllowedModel> = {}): AllowedModel => ({
  id,
  provider: 'azure-openai',
  model: 'gpt-4o',
  label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000,
  supportsImages: true,
  supportsStructuredOutput: true,
  isDefault: false,
  ...over,
});

const settings = (over: Partial<WorkspaceSettings>): WorkspaceSettings =>
  ({ modelChoiceId: '', concurrency: 5, ...over });

describe('isStaleModelChoice', () => {
  it('is true when the stored id names nothing on the list', () => {
    expect(isStaleModelChoice('uks-gpt4o', [model('uks-sonnet')])).toBe(true);
  });

  it('is false when the stored id is on the list', () => {
    expect(isStaleModelChoice('uks-gpt4o', [model('uks-sonnet'), model('uks-gpt4o')])).toBe(false);
  });

  it('is false when nothing was ever chosen — that is "unconfigured", not "retired"', () => {
    expect(isStaleModelChoice('', [])).toBe(false);
  });

  it('is true against an allowlist that loaded EMPTY, because nothing on it can serve the choice', () => {
    // An operator who has configured no model cannot run a review either.
    // The distinction that matters is between an empty list and a FAILED
    // read, and that one is the caller's: nothing failed is passed here.
    expect(isStaleModelChoice('uks-gpt4o', [])).toBe(true);
  });
});

/**
 * Final review M6. `modelChoiceId` is an operator-defined allowlist ALIAS.
 * `positionProvenance` prints whatever it is given as "Drafted by …" onto a
 * published `StandardPosition` that travels into every export of the
 * playbook — and an administrator can repoint the alias at a different
 * provider and a different model without touching that record, at which
 * point the sentence is not merely opaque, it is false.
 */
describe('modelProvenanceName', () => {
  it('never returns the allowlist alias', () => {
    const s = settings({
      modelChoiceId: 'uks-gpt4o', modelChoiceLabel: 'GPT-4o', modelChoiceModel: 'gpt-4o',
    });
    expect(modelProvenanceName(s)).not.toContain('uks-gpt4o');
  });

  it('names the label and the provider-side model, which identify something outside this workspace', () => {
    const s = settings({
      modelChoiceId: 'uks-gpt4o', modelChoiceLabel: 'GPT-4o (UK South)', modelChoiceModel: 'gpt-4o',
    });
    expect(modelProvenanceName(s)).toBe('GPT-4o (UK South) (gpt-4o)');
  });

  it('does not repeat itself when the operator gave the entry no distinct label', () => {
    const s = settings({
      modelChoiceId: 'x', modelChoiceLabel: 'gpt-4o', modelChoiceModel: 'gpt-4o',
    });
    expect(modelProvenanceName(s)).toBe('gpt-4o');
  });

  it('falls back to whichever of the two it has', () => {
    expect(modelProvenanceName(settings({ modelChoiceId: 'x', modelChoiceLabel: 'GPT-4o' })))
      .toBe('GPT-4o');
    expect(modelProvenanceName(settings({ modelChoiceId: 'x', modelChoiceModel: 'gpt-4o' })))
      .toBe('gpt-4o');
  });

  it('returns the empty string — never the alias — when neither is known', () => {
    // A settings blob written before those fields existed. The caller
    // (`positionProvenance`) renders this as "an AI model": vague and true,
    // rather than specific and unresolvable.
    expect(modelProvenanceName(settings({ modelChoiceId: 'uks-gpt4o' }))).toBe('');
  });
});

describe('the retired-choice wording', () => {
  it('is one sentence opening shared by the picker and the toast', () => {
    expect(MODEL_CHOICE_STALE_MESSAGE.startsWith(MODEL_CHOICE_STALE)).toBe(true);
    expect(MODEL_CHOICE_STALE_MESSAGE).toContain('Settings');
  });
});
