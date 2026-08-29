import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import type { AllowedModel } from '@lexprompt/core';
import { mountOnce, click, buttonNamed, flushUntil } from '../../test/mount';
import type { Settings } from '../../types';

const listModelsMock = vi.fn<() => Promise<AllowedModel[]>>();

vi.mock('../../lib/model/gatewayModelClient', () => ({
  gatewayModelClient: { listModels: (...args: []) => listModelsMock(...args) },
}));

const { ModelPicker, RECORDED_PROVIDER_NOTICE } = await import('./ModelPicker');

const UK: AllowedModel = {
  id: 'uk-sonnet',
  provider: 'azure-foundry',
  model: 'claude-sonnet-4',
  label: 'Claude Sonnet 4',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 200000,
  supportsImages: true,
  supportsStructuredOutput: true,
  isDefault: true,
};

const US: AllowedModel = {
  id: 'us-gpt',
  provider: 'azure-openai',
  model: 'gpt-4o',
  label: 'GPT-4o',
  // The operator writes this label. "the United States" is what a firm's own
  // allowlist entry says, and the picker prints it verbatim rather than
  // deriving prose from the two-letter bloc.
  jurisdiction: { bloc: 'US', region: 'eastus', label: 'the United States' },
  contextLength: 128000,
  supportsImages: false,
  supportsStructuredOutput: false,
  isDefault: false,
};

const RECORDED: AllowedModel = {
  id: 'recorded-fixtures',
  provider: 'recorded',
  model: 'fixtures',
  label: 'Recorded fixtures',
  jurisdiction: { bloc: 'UK', region: 'local', label: 'UK South' },
  contextLength: 100000,
  supportsImages: false,
  supportsStructuredOutput: true,
  isDefault: false,
};

const BASE: Settings = { modelChoiceId: '', concurrency: 5 };

function settingsWith(modelChoiceId: string): Settings {
  return { ...BASE, modelChoiceId };
}

function options(container: ParentNode): HTMLOptionElement[] {
  return Array.from(container.querySelectorAll('option'));
}

/** Every option except the "choose a model" placeholder, which carries no
 *  model and therefore no jurisdiction. */
function modelOptions(container: ParentNode): HTMLOptionElement[] {
  return options(container).filter(o => o.value !== '');
}

function selectIn(container: ParentNode): HTMLSelectElement | null {
  return container.querySelector('select');
}

/** Changes a controlled <select> the way React sees it (the same prototype-
 *  setter dance `mount.tsx`'s `type()` does for inputs). */
function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) throw new Error('No value setter on HTMLSelectElement.prototype.');
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  listModelsMock.mockReset();
});

describe('ModelPicker — three load states, told apart', () => {
  it('renders a busy element and no select while the list is in flight', () => {
    listModelsMock.mockReturnValue(new Promise<AllowedModel[]>(() => { /* never settles */ }));
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={vi.fn()} />);

    expect(container.querySelector('[data-busy="true"]')).not.toBe(null);
    expect(selectIn(container)).toBe(null);
    unmount();
  });

  it('renders the failure and a working Retry when the list cannot be loaded', async () => {
    listModelsMock.mockRejectedValue(new Error('LexPrompt could not reach its server (offline).'));
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={vi.fn()} />);
    await flushUntil(() => container.textContent!.includes('could not be loaded'), 'the error panel');

    expect(container.textContent).toContain('could not be loaded');
    // The specific reason survives; a generic message would throw away the
    // one sentence that tells the user what to do about it.
    expect(container.textContent).toContain('could not reach its server');
    expect(selectIn(container)).toBe(null);

    const retry = buttonNamed(container, /retry/i);
    expect(retry).toBeDefined();
    listModelsMock.mockResolvedValue([UK]);
    click(retry);
    await flushUntil(() => selectIn(container) !== null, 'the retried list');
    expect(listModelsMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('renders "no model has been configured" for an empty list — not an error panel, not an empty select', async () => {
    listModelsMock.mockResolvedValue([]);
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={vi.fn()} />);
    await flushUntil(
      () => container.querySelector('[data-busy="true"]') === null,
      'the empty state',
    );

    expect(container.textContent).toContain('No model has been configured for this workspace yet');
    expect(container.querySelector('select')).toBe(null);
    expect(container.textContent).not.toContain('could not be loaded');
    unmount();
  });
});

describe('ModelPicker — the list itself', () => {
  it('renders one option per model', async () => {
    listModelsMock.mockResolvedValue([UK, US]);
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    expect(modelOptions(container).map(o => o.value)).toEqual(['uk-sonnet', 'us-gpt']);
    unmount();
  });

  it('names the jurisdiction on every option, in the same form, with none unlabelled', async () => {
    listModelsMock.mockResolvedValue([UK, US, RECORDED]);
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    const rendered = modelOptions(container);
    expect(rendered).toHaveLength(3);
    // Every one of them, not just the ones a reader might find surprising:
    // an absent label would come to mean something, which is the blank-CSV-
    // cell defect.
    for (const option of rendered) {
      expect(option.textContent).toMatch(/(UK|EU|US|other) · /);
      expect(option.textContent).toMatch(/Processed in /);
    }
    const uk = rendered.find(o => o.value === 'uk-sonnet')!;
    expect(uk.textContent).toContain('UK · UK South');
    unmount();
  });

  it('states where processing occurs in words on every option, not only the non-UK ones', async () => {
    listModelsMock.mockResolvedValue([UK, US]);
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    const rendered = modelOptions(container);
    expect(rendered.find(o => o.value === 'uk-sonnet')!.textContent).toContain('Processed in UK South');
    expect(rendered.find(o => o.value === 'us-gpt')!.textContent).toContain('Processed in the United States');
    unmount();
  });

  it('is factual and never evaluative about a jurisdiction', async () => {
    listModelsMock.mockResolvedValue([UK, US]);
    const { container, unmount } = mountOnce(<ModelPicker settings={settingsWith('us-gpt')} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    // Whether a jurisdiction is acceptable was settled by the operator's
    // contracts and their GATEWAY_ALLOWED_JURISDICTIONS. Every entry here
    // already passed that gate; this screen does not re-litigate it.
    expect(container.textContent).not.toMatch(/warning|caution|risk|unsafe|outside/i);
    unmount();
  });
});

describe('ModelPicker — selection', () => {
  it('calls onChange with the choice id and the three capability fields', async () => {
    listModelsMock.mockResolvedValue([UK, US]);
    const onChange = vi.fn();
    const { container, unmount } = mountOnce(<ModelPicker settings={settingsWith('uk-sonnet')} onChange={onChange} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    choose(selectIn(container)!, 'us-gpt');
    expect(onChange).toHaveBeenCalledWith({
      modelChoiceId: 'us-gpt',
      // The label and the provider-side model name travel with the choice:
      // `modelChoiceId` is an operator-defined alias that can be repointed,
      // so nothing persisted may name it. See `modelProvenanceName`.
      modelChoiceLabel: 'GPT-4o',
      modelChoiceModel: 'gpt-4o',
      modelSupportsImages: false,
      modelSupportsStructuredOutput: false,
      modelContextLength: 128000,
    });
    unmount();
  });

  it('preselects the isDefault model when nothing is chosen yet, and commits that choice', async () => {
    listModelsMock.mockResolvedValue([US, UK]);
    const onChange = vi.fn();
    const { container, unmount } = mountOnce(<ModelPicker settings={BASE} onChange={onChange} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    expect(selectIn(container)!.value).toBe('uk-sonnet');
    // The displayed selection must be a real one: showing a model as chosen
    // while `modelChoiceId` stays empty is a screen claiming a configured
    // state the store does not have.
    expect(onChange).toHaveBeenCalledWith({
      modelChoiceId: 'uk-sonnet',
      modelChoiceLabel: 'Claude Sonnet 4',
      modelChoiceModel: 'claude-sonnet-4',
      modelSupportsImages: true,
      modelSupportsStructuredOutput: true,
      modelContextLength: 200000,
    });
    unmount();
  });

  it('does not silently resolve a stored choice that is no longer on the list', async () => {
    listModelsMock.mockResolvedValue([UK, US]);
    const onChange = vi.fn();
    const { container, unmount } = mountOnce(
      <ModelPicker settings={settingsWith('retired-model')} onChange={onChange} />,
    );
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    expect(selectIn(container)!.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Choose a model');
    expect(container.textContent).toContain('is no longer on the list for this workspace');
    unmount();
  });
});

describe('ModelPicker — the recorded-provider banner', () => {
  it('renders, non-dismissibly, when the selected model is the recorded provider', async () => {
    listModelsMock.mockResolvedValue([RECORDED, UK]);
    const { container, unmount } = mountOnce(
      <ModelPicker settings={settingsWith('recorded-fixtures')} onChange={vi.fn()} />,
    );
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    expect(container.textContent).toContain(RECORDED_PROVIDER_NOTICE.heading);
    expect(container.textContent).toContain(RECORDED_PROVIDER_NOTICE.body);
    expect(buttonNamed(container, /dismiss|close|hide/i)).toBeUndefined();
    unmount();
  });

  it('renders for no other provider', async () => {
    listModelsMock.mockResolvedValue([RECORDED, UK]);
    const { container, unmount } = mountOnce(
      <ModelPicker settings={settingsWith('uk-sonnet')} onChange={vi.fn()} />,
    );
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    expect(container.textContent).not.toContain(RECORDED_PROVIDER_NOTICE.heading);
    unmount();
  });

  it('is conditional on the provider the gateway reported, and on nothing else', async () => {
    // Same environment, same build, same everything: only the provider on
    // the selected allowlist entry differs, and that alone decides it.
    listModelsMock.mockResolvedValue([{ ...UK, provider: 'recorded' }]);
    const first = mountOnce(<ModelPicker settings={settingsWith('uk-sonnet')} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(first.container) !== null, 'the model list');
    expect(first.container.textContent).toContain(RECORDED_PROVIDER_NOTICE.heading);
    first.unmount();

    listModelsMock.mockResolvedValue([UK]);
    const second = mountOnce(<ModelPicker settings={settingsWith('uk-sonnet')} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(second.container) !== null, 'the model list');
    expect(second.container.textContent).not.toContain(RECORDED_PROVIDER_NOTICE.heading);
    second.unmount();
  });
});

describe('ModelPicker — where your requests go', () => {
  it('states the provider and the jurisdiction of the selected model as a sentence', async () => {
    listModelsMock.mockResolvedValue([UK, US]);
    const { container, unmount } = mountOnce(<ModelPicker settings={settingsWith('us-gpt')} onChange={vi.fn()} />);
    await flushUntil(() => selectIn(container) !== null, 'the model list');

    expect(container.textContent).toContain('Where your requests go');
    expect(container.textContent).toContain('azure-openai');
    expect(container.textContent).toContain('the United States');
    unmount();
  });
});
