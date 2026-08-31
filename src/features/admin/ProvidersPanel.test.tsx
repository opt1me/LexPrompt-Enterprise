import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { AllowedModel, ProviderStatus } from '@lexprompt/core';
import { mount, flushUntil, buttonNamed } from '../../test/mount';
import { ProvidersPanel, guaranteeFor, isStale } from './ProvidersPanel';
import type { AdminProviders } from '../../lib/api/admin';

const model = (over: Partial<AllowedModel> & { id: string }): AllowedModel => ({
  provider: 'openai',
  model: 'gpt-4o',
  label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128_000,
  supportsImages: true,
  supportsStructuredOutput: true,
  isDefault: false,
  ...over,
});

const status = (over: Partial<ProviderStatus> & { provider: ProviderStatus['provider'] }):
ProviderStatus => ({
  auth: 'key',
  configured: true,
  modelCount: 1,
  ...over,
});

async function render(page: AdminProviders): Promise<HTMLElement> {
  const container = mount(<ProvidersPanel load={vi.fn(async () => page)} />);
  await flushUntil(() => !container.textContent?.includes('Reading this deployment'),
    'the provider configuration to load');
  return container;
}

const textOf = (el: HTMLElement): string => el.textContent ?? '';

describe('ProvidersPanel', () => {
  it('labels every model with provider AND jurisdiction, with no entry unlabelled', async () => {
    // S27: the ABSENCE of a label must not carry meaning. Table-driven over a
    // fixture that includes an out-of-bloc entry, asserting the label form is
    // identical for every row.
    const container = await render({
      models: [
        model({ id: 'uk', label: 'UK model' }),
        model({
          id: 'us', label: 'US model',
          jurisdiction: { bloc: 'US', region: 'eastus', label: 'the United States' },
        }),
      ],
      providers: [status({ provider: 'openai', modelCount: 2 })],
      declaredJurisdictions: ['UK', 'US'],
    });
    for (const [id, expected] of [
      ['uk', 'UK model — openai — UK · UK South'],
      ['us', 'US model — openai — US · the United States'],
    ] as const) {
      const row = container.querySelector<HTMLElement>(`[data-model="${id}"]`)!;
      expect(textOf(row)).toContain(expected);
    }
  });

  it('shows the dataHandling note with its date, and never grades it', async () => {
    const container = await render({
      models: [model({
        id: 'uk',
        dataHandling: { summary: 'No training on our data; 30-day retention.', lastCheckedAt: '2026-02-14' },
      })],
      providers: [status({ provider: 'openai' })],
      declaredJurisdictions: ['UK'],
    });
    expect(textOf(container)).toContain('Reviewed 2026-02-14');
    expect(textOf(container)).toContain('No training on our data');
    // The note is the OPERATOR'S record of terms they agreed, never graded by
    // any code path that decides anything. A screen that scored it would
    // falsify the ruling that put it there.
    for (const word of ['good', 'poor', 'safe', 'risky', 'compliant', 'recommended']) {
      expect(textOf(container).toLowerCase(), word).not.toContain(word);
    }
  });

  it('marks a note older than a year as needing re-reading, without judging the provider', async () => {
    const container = await render({
      models: [model({
        id: 'uk',
        dataHandling: { summary: 'Terms of 2019.', lastCheckedAt: '2019-01-01' },
      })],
      providers: [status({ provider: 'openai' })],
      declaredJurisdictions: ['UK'],
    });
    expect(textOf(container)).toMatch(/last reviewed over a year ago/i);
    // A fact about the NOTE. Nothing about the provider.
    expect(textOf(container).toLowerCase()).not.toContain('unsafe');
  });

  it('says so when an entry records no terms at all, rather than showing nothing', async () => {
    const container = await render({
      models: [model({ id: 'uk' })],
      providers: [status({ provider: 'openai' })],
      declaredJurisdictions: ['UK'],
    });
    expect(textOf(container)).toMatch(/no note of this provider/i);
  });

  it('states which of S2 s two guarantees THIS deployment has', async () => {
    const managed = await render({
      models: [model({ id: 'f', provider: 'azure-foundry' })],
      providers: [status({ provider: 'azure-foundry', auth: 'managed-identity' })],
      declaredJurisdictions: ['UK'],
    });
    expect(textOf(managed)).toMatch(/no provider key exists in this deployment/i);
    expect(textOf(managed)).not.toMatch(/the key is held only by the gateway/i);

    const keyed = await render({
      models: [model({ id: 'o' })],
      providers: [status({ provider: 'openai', auth: 'key' })],
      declaredJurisdictions: ['UK'],
    });
    expect(textOf(keyed)).toMatch(/the key is held only by the gateway/i);
    // §18 item 8: the UNCONDITIONAL claim must not appear anywhere, ever. It
    // is false for every deployment using OpenAI, Anthropic or OpenRouter
    // directly, and this is the screen most likely to grow it because one
    // sentence is shorter and sounds better than two.
    expect(textOf(keyed)).not.toMatch(/no provider key exists/i);
    expect(textOf(keyed)).not.toMatch(/no provider keys anywhere/i);
  });

  it('never composes the unconditional claim, whatever `auth` says', () => {
    // The unit half of the case above, over EVERY value of the field, so a
    // third posture added later cannot quietly produce it.
    for (const auth of ['managed-identity', 'key', 'none'] as const) {
      expect(guaranteeFor(auth).toLowerCase()).not.toContain('no provider keys anywhere');
      expect(guaranteeFor(auth).length).toBeGreaterThan(40);
    }
    // …and only ONE of them makes the no-key claim.
    expect(['managed-identity', 'key', 'none'].filter(
      a => /no provider key exists/i.test(guaranteeFor(a as ProviderStatus['auth'])))).toEqual(
      ['managed-identity']);
  });

  it('treats a missing rotation instant as NOT RECORDED, never as never', async () => {
    const container = await render({
      models: [model({ id: 'o' })],
      providers: [status({ provider: 'openai' })],
      declaredJurisdictions: ['UK'],
    });
    expect(textOf(container)).toMatch(/is not recorded — which is not the same as never/i);
  });

  it('offers nothing that looks editable', async () => {
    const container = await render({
      models: [model({ id: 'o' })],
      providers: [status({ provider: 'openai' })],
      declaredJurisdictions: ['UK'],
    });
    expect(Array.from(container.querySelectorAll('input, select, textarea'))).toEqual([]);
    expect(Array.from(container.querySelectorAll('button'))).toEqual([]);
    expect(textOf(container)).toMatch(/changed in this deployment.s configuration/i);
  });

  it('renders an unreachable gateway as a refusal, never as an empty provider list', async () => {
    const container = mount(
      <ProvidersPanel load={vi.fn(async () => { throw new Error('the gateway is unreachable'); })} />);
    await flushUntil(() => !!container.textContent?.includes('could not be read'),
      'the error panel');
    expect(textOf(container)).toContain('the gateway is unreachable');
    expect(buttonNamed(container, /Retry/)).toBeDefined();
    // "This firm has no providers configured" is a statement about the
    // deployment that a failed read cannot make.
    expect(textOf(container)).not.toMatch(/no model on the allowlist/i);
  });

  it('says when a configured provider has no model routing to it', async () => {
    const container = await render({
      models: [],
      providers: [status({ provider: 'anthropic', modelCount: 0 })],
      declaredJurisdictions: ['UK'],
    });
    // Zero is a real and useful answer: a configured credential nothing uses.
    expect(textOf(container)).toMatch(/no model on the allowlist routes to this provider/i);
  });
});

describe('isStale', () => {
  it('is a fact about the NOTE, measured against a year', () => {
    const now = Date.parse('2026-08-31T00:00:00Z');
    expect(isStale('2026-02-14', now)).toBe(false);
    expect(isStale('2019-01-01', now)).toBe(true);
    // An unparseable date is not "stale": it is a note nobody can date, and
    // claiming it is old would be a guess.
    expect(isStale('not a date', now)).toBe(false);
  });
});
