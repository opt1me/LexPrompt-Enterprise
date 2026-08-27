import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Clause, Finding } from '../../types';
import { FindingCard } from './FindingCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUSE: Clause = { id: 'c1', title: 'Governing Law', prompt: 'Extract the governing law clause.' };

function render(node: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container, root };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(node: React.ReactElement): HTMLDivElement {
  const { container, root } = render(node);
  cleanup = () => { act(() => { root.unmount(); }); container.remove(); };
  return container;
}

function hasRetryButton(container: HTMLDivElement): boolean {
  return Array.from(container.querySelectorAll('button')).some(b => /retry/i.test(b.textContent || ''));
}

describe('FindingCard — interrupted prop (Important 1)', () => {
  it('a pending cell offers no Retry when the run is live (default/not interrupted)', () => {
    const container = mount(
      <FindingCard clause={CLAUSE} finding={undefined} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(container.textContent).toContain('Governing Law');
    expect(hasRetryButton(container)).toBe(false);
  });

  it('a running cell offers no Retry when the run is live (default/not interrupted)', () => {
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [] };
    const container = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(container)).toBe(false);
  });

  it('a pending cell offers Retry when interrupted, and it calls onRetry with the clause id', () => {
    const onRetry = vi.fn();
    const container = mount(
      <FindingCard clause={CLAUSE} finding={undefined} onCiteClick={() => {}} onRetry={onRetry} interrupted />,
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetry).toHaveBeenCalledWith('c1');
  });

  it('a running cell offers Retry when interrupted, and it calls onRetry with the clause id', () => {
    const onRetry = vi.fn();
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [] };
    const container = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={onRetry} interrupted />,
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetry).toHaveBeenCalledWith('c1');
  });

  it('error and cancelled cells keep offering Retry regardless of interrupted (unchanged behaviour)', () => {
    const errorFinding: Finding = { clauseId: 'c1', status: 'error', citations: [], error: 'boom' };
    const containerA = mount(
      <FindingCard clause={CLAUSE} finding={errorFinding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(containerA)).toBe(true);
    cleanup?.();

    const cancelledFinding: Finding = { clauseId: 'c1', status: 'cancelled', citations: [] };
    const containerB = mount(
      <FindingCard clause={CLAUSE} finding={cancelledFinding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(containerB)).toBe(true);
  });

  it('a done cell never offers Retry, interrupted or not', () => {
    const doneFinding: Finding = { clauseId: 'c1', status: 'done', citations: [], summary: 'ok' };
    const container = mount(
      <FindingCard clause={CLAUSE} finding={doneFinding} onCiteClick={() => {}} onRetry={() => {}} interrupted />,
    );
    expect(hasRetryButton(container)).toBe(false);
  });
});
