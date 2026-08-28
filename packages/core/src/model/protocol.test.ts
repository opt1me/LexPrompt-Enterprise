import { describe, it, expect } from 'vitest';
import {
  PURPOSES, isPurpose, PROVIDER_IDS, isProviderId, jurisdictionLabel,
  ModelError, isSignInError, isServiceConfigError, isRetryableStatus,
} from './protocol.ts';

describe('providers (owner decision 1)', () => {
  it('is the five the owner named, plus the recorded adapter', () => {
    expect([...PROVIDER_IDS]).toEqual([
      'azure-foundry', 'azure-openai', 'openai', 'anthropic', 'openrouter', 'recorded',
    ]);
  });

  // Spec Revision 2 / §5.1: the offline stub is an ADAPTER, not a bypass.
  // Being on this list is what forces it through the registry completeness
  // test, the conformance suite and the jurisdiction gate like any other.
  it('includes recorded, so the offline stub cannot escape the adapter machinery', () => {
    expect(isProviderId('recorded')).toBe(true);
  });

  it('accepts a known provider and refuses anything else', () => {
    expect(isProviderId('anthropic')).toBe(true);
    expect(isProviderId('bedrock')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });
});

describe('jurisdiction (owner decision 3)', () => {
  it('reads as something an operator can act on, not a region code', () => {
    expect(jurisdictionLabel({ bloc: 'UK', region: 'uksouth', label: 'UK South' }))
      .toBe('UK · UK South');
    expect(jurisdictionLabel({ bloc: 'US', region: 'us', label: 'United States' }))
      .toBe('US · United States');
  });
});

describe('purposes (§10)', () => {
  it('is exactly the nine the spec names, in the spec order', () => {
    expect([...PURPOSES]).toEqual([
      'review.clause', 'review.collection_clause', 'assistant.chat',
      'playbook.draft', 'playbook.suggest', 'redlines.infer',
      'changeset.build', 'export.email', 'export.suggest_fix',
    ]);
  });

  it('accepts a known purpose and refuses anything else', () => {
    expect(isPurpose('review.clause')).toBe(true);
    expect(isPurpose('review.everything')).toBe(false);
    expect(isPurpose('')).toBe(false);
    expect(isPurpose(undefined)).toBe(false);
    expect(isPurpose(null)).toBe(false);
    expect(isPurpose(42)).toBe(false);
  });
});

describe('retry policy (§10, carried from openrouter.ts verbatim)', () => {
  it('retries 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(402)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
  });
});

describe('error classification — who is being told, and what they can do', () => {
  it('a rejected or expired user token is a sign-in problem the USER can fix', () => {
    expect(isSignInError(new ModelError('expired', 'sign_in_required', 401))).toBe(true);
    expect(isSignInError(new ModelError('no role', 'not_permitted', 403))).toBe(true);
  });

  it('a firm-configuration failure is NOT a sign-in problem', () => {
    const e = new ModelError('no managed identity token', 'service_misconfigured', 503);
    expect(isSignInError(e)).toBe(false);
    expect(isServiceConfigError(e)).toBe(true);
  });

  it('a refused model or purpose is a firm-configuration problem, not the user\'s', () => {
    expect(isServiceConfigError(new ModelError('x', 'model_not_allowed', 400))).toBe(true);
    expect(isServiceConfigError(new ModelError('x', 'purpose_not_allowed', 400))).toBe(true);
  });

  it('a refused jurisdiction is an admin problem, not the user\'s', () => {
    const e = new ModelError('processed in US', 'jurisdiction_not_allowed', 403);
    expect(isServiceConfigError(e)).toBe(true);
    expect(isSignInError(e)).toBe(false);
    expect(e.retryable).toBe(false);
  });

  // §7: a partner in forty groups must never be told they have no access.
  it('group overage is an admin problem, and is NOT a sign-in problem', () => {
    const e = new ModelError('overage', 'group_overage', 403);
    expect(isSignInError(e)).toBe(false);
    expect(isServiceConfigError(e)).toBe(true);
  });

  it('a transient upstream failure is neither', () => {
    const e = new ModelError('foundry 500', 'upstream_failed', 502);
    expect(isSignInError(e)).toBe(false);
    expect(isServiceConfigError(e)).toBe(false);
    expect(e.retryable).toBe(true);
  });

  it('is false for a plain Error and for a non-error value', () => {
    expect(isSignInError(new Error('boom'))).toBe(false);
    expect(isServiceConfigError('boom')).toBe(false);
    expect(isSignInError(null)).toBe(false);
  });

  it('carries the call id so a user can quote it to IT', () => {
    const e = new ModelError('nope', 'service_misconfigured', 503, 'c-7f3a');
    expect(e.callId).toBe('c-7f3a');
  });
});
