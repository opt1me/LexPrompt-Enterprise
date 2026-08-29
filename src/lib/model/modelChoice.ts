import type { AllowedModel } from '@lexprompt/core';
import type { Settings } from '../../types';

/**
 * Everything the app has to say about "the model this browser has chosen",
 * in one place, because the two questions below were each about to acquire a
 * second implementation:
 *
 *  - **Is the stored choice still real?** `ModelPicker` already worked this
 *    out to decide whether to say "nothing is selected"; `App` needs the
 *    same fact to decide whether `isConfigured` may claim a review can run.
 *    Two copies of it would be free to disagree, and the disagreement has a
 *    direction: the screen saying "pick one" while the shell waves the user
 *    into a 40-clause run that fails on every clause.
 *  - **What do we write down as the model that did something?** Never
 *    `modelChoiceId` — see `modelProvenanceName`.
 */

/**
 * True when a stored `modelChoiceId` names nothing on the allowlist the
 * gateway currently serves.
 *
 * `models` must be a list that actually LOADED. A failed fetch is not
 * evidence that a choice is stale — it is evidence of nothing — and callers
 * pass their loaded list here rather than an empty array on error, which
 * would report every stored choice as retired the moment the network
 * blinked.
 */
export function isStaleModelChoice(modelChoiceId: string, models: AllowedModel[]): boolean {
  return Boolean(modelChoiceId) && !models.some(m => m.id === modelChoiceId);
}

/**
 * The shared opening clause of the two sentences that report a retired
 * choice — the picker's paragraph and App's toast. They end differently (one
 * points at the list below it, the other at Settings) and only the shared
 * half lives here: two full copies of a sentence about the same fact is the
 * drift `verificationLabel` exists to prevent, one screen earlier.
 */
export const MODEL_CHOICE_STALE =
  'The model this browser had chosen is no longer on the list for this workspace';

/** The toast raised when a flow that needs a model is blocked because the
 *  stored choice has been retired. Distinct from the generic "choose a
 *  model" prompt: a user who never picked one and a user whose pick was
 *  withdrawn are being told two different things. */
export const MODEL_CHOICE_STALE_MESSAGE =
  `${MODEL_CHOICE_STALE}. Choose another in Settings before running a review.`;

/**
 * What a persisted record may name as the model that produced something.
 *
 * **Never `modelChoiceId`.** That is an operator-defined allowlist alias
 * (`uks-gpt4o`) which identifies nothing outside this workspace's
 * `models.json`, and which an administrator can repoint at a different
 * provider and a different model at any time without touching a record that
 * already printed it. A provenance sentence that says `Drafted by
 * uks-gpt4o` is opaque on the day it is written and false the day after the
 * repoint — on a `StandardPosition` that has become a house rule and travels
 * into every export of the playbook.
 *
 * `AllowedModel.label` and `AllowedModel.model` are recorded beside the id
 * when the choice is made (and refreshed whenever the allowlist is re-read),
 * so this returns what the model was actually called at the moment the work
 * was done. That is what provenance means: a historical claim, not a
 * pointer to be resolved later.
 *
 * The empty string is returned when neither is known — a settings blob
 * written before those fields existed. That is deliberate, and its caller
 * (`positionProvenance`) already renders it as "an AI model": vague and
 * true, rather than specific and unresolvable.
 *
 * This composes a model NAME, not a provenance sentence. `positionProvenance`
 * remains the only place that wording is composed.
 */
export function modelProvenanceName(settings: Settings): string {
  const label = settings.modelChoiceLabel ?? '';
  const model = settings.modelChoiceModel ?? '';
  if (label && model && label !== model) return `${label} (${model})`;
  return model || label || '';
}
