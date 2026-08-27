import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { FieldSuggestion } from './FieldSuggestion';

describe('FieldSuggestion', () => {
  it('renders a suggestion as visibly unaccepted', () => {
    const c = mount(
      <FieldSuggestion text="We ask for six months." onAccept={() => {}} onRegenerate={() => {}} onDismiss={() => {}} />,
    );
    expect(c.textContent).toMatch(/suggestion|not accepted/i);
    expect(c.innerHTML).toMatch(/dashed/);
  });

  it('offers accept, regenerate and dismiss', () => {
    const c = mount(
      <FieldSuggestion text="x" onAccept={() => {}} onRegenerate={() => {}} onDismiss={() => {}} />,
    );
    for (const re of [/use this/i, /try again/i, /i.ll write it/i]) {
      expect(buttonNamed(c, re)).toBeTruthy();
    }
  });

  it('calls onAccept, onRegenerate and onDismiss from their own buttons only', () => {
    const onAccept = vi.fn();
    const onRegenerate = vi.fn();
    const onDismiss = vi.fn();
    const c = mount(<FieldSuggestion text="x" onAccept={onAccept} onRegenerate={onRegenerate} onDismiss={onDismiss} />);

    click(buttonNamed(c, /try again/i));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    click(buttonNamed(c, /i.ll write it/i));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    click(buttonNamed(c, /use this/i));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('disables its controls while busy, without hiding the suggestion text', () => {
    const c = mount(
      <FieldSuggestion text="Still here." onAccept={() => {}} onRegenerate={() => {}} onDismiss={() => {}} busy />,
    );
    expect(c.textContent).toMatch(/Still here\./);
    expect(buttonNamed(c, /use this/i)?.disabled).toBe(true);
    expect(buttonNamed(c, /try again/i)?.disabled).toBe(true);
    expect(buttonNamed(c, /i.ll write it/i)?.disabled).toBe(true);
  });
});
