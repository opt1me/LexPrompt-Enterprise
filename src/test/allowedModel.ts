import type { AllowedModel } from '@lexprompt/core';

/**
 * The allowlist entry that matches the `modelChoiceId: 'test/model'` every
 * `App.*.test.tsx` seeds into `localStorage`.
 *
 * Extracted at the seventh copy, not the second — but extracted, because the
 * alternative was seven hand-written literals of the same fixture.
 *
 * It exists because `listModels` is no longer only a source of capability
 * hints. App's own `isConfigured` reads the result: a stored choice that a
 * SUCCESSFUL allowlist read cannot find is a retired choice, and the app now
 * refuses to start a review over it rather than waving the user into forty
 * clauses that will each fail with `model_not_allowed`. A suite that seeds a
 * choice and stubs `listModels` with `[]` is therefore describing a
 * workspace whose administrator has configured nothing — which is a real
 * state, and one a handful of tests deliberately exercise, but not the one
 * most of them mean. Stub with this where the test's subject is anything
 * other than model configuration.
 */
export const TEST_ALLOWED_MODEL: AllowedModel = {
  id: 'test/model',
  provider: 'recorded',
  model: 'test-model',
  label: 'Test Model',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000,
  supportsImages: true,
  supportsStructuredOutput: true,
  isDefault: true,
};
