import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { RouteChooser } from './RouteChooser';

describe('RouteChooser', () => {
  it('shows the learn-from-redlines route as present but not yet built (R-E6)', () => {
    const c = mount(<RouteChooser learnFromRedlinesAvailable={false}
      onDraftWithAI={() => {}} onBuildByHand={() => {}} onClose={() => {}} />);
    expect(c.textContent).toMatch(/redline/i);
    expect(c.textContent).toMatch(/not built yet/i);
  });

  it('does not offer the redlines route as clickable while it is unavailable', () => {
    // R-E6 keeps the card VISIBLE so the product is not misrepresented — but a
    // visible card that silently does nothing is worse than one that says why.
    const onLearn = vi.fn();
    const c = mount(<RouteChooser learnFromRedlinesAvailable={false} onLearnFromRedlines={onLearn}
      onDraftWithAI={() => {}} onBuildByHand={() => {}} onClose={() => {}} />);
    const card = buttonNamed(c, /redline/i);
    if (card) { click(card); }
    expect(onLearn).not.toHaveBeenCalled();
  });

  it('invokes onLearnFromRedlines when the route is available', () => {
    // Mutation guard for the test above: if the implementation just ignores
    // `learnFromRedlinesAvailable` and never calls the handler at all, the
    // "not clickable while unavailable" test would pass for the wrong
    // reason. This proves the handler CAN fire when the flag says it should.
    const onLearn = vi.fn();
    const c = mount(<RouteChooser learnFromRedlinesAvailable onLearnFromRedlines={onLearn}
      onDraftWithAI={() => {}} onBuildByHand={() => {}} onClose={() => {}} />);
    const card = buttonNamed(c, /redline/i);
    click(card);
    expect(onLearn).toHaveBeenCalledTimes(1);
  });

  it('calls onDraftWithAI when that route is chosen', () => {
    const onDraft = vi.fn();
    const c = mount(<RouteChooser learnFromRedlinesAvailable={false}
      onDraftWithAI={onDraft} onBuildByHand={() => {}} onClose={() => {}} />);
    click(buttonNamed(c, /draft with ai/i));
    expect(onDraft).toHaveBeenCalledTimes(1);
  });

  it('calls onBuildByHand when that route is chosen', () => {
    const onHand = vi.fn();
    const c = mount(<RouteChooser learnFromRedlinesAvailable={false}
      onDraftWithAI={() => {}} onBuildByHand={onHand} onClose={() => {}} />);
    click(buttonNamed(c, /by hand/i));
    expect(onHand).toHaveBeenCalledTimes(1);
  });

  it('calls onClose from the close control', () => {
    const onClose = vi.fn();
    const c = mount(<RouteChooser learnFromRedlinesAvailable={false}
      onDraftWithAI={() => {}} onBuildByHand={() => {}} onClose={onClose} />);
    click(buttonNamed(c, /close/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
