import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DocumentFile, PlaybookVersion } from '../../types';
import { RunPanel } from './RunPanel';

// No @testing-library/react in this project — see Toast.test.tsx for the
// precedent this follows: drive a real react-dom root directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTemplate(): PlaybookVersion {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' }],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
  };
}

function makeDoc(id: string, name: string): DocumentFile {
  return {
    id,
    name,
    text: 'Some contract text.',
    file: new File(['Some contract text.'], name, { type: 'text/plain' }),
    kind: 'txt',
  };
}

describe('RunPanel — initialDocuments (Task 11 fix round 1: matter-scoped "Run a review")', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('renders pre-seeded documents without requiring an upload', () => {
    const docs = [makeDoc('d1', 'nda.txt'), makeDoc('d2', 'msa.txt')];
    act(() => {
      root.render(
        <RunPanel template={makeTemplate()} onBack={() => {}} onRun={() => {}} initialDocuments={docs} />,
      );
    });

    expect(container.textContent).toContain('nda.txt');
    expect(container.textContent).toContain('msa.txt');
    expect(container.textContent).toContain('2 documents');
  });

  it('runs with exactly the pre-seeded documents when "Run review" is clicked, with no upload step', () => {
    const docs = [makeDoc('d1', 'nda.txt')];
    const onRun = vi.fn();
    act(() => {
      root.render(
        <RunPanel template={makeTemplate()} onBack={() => {}} onRun={onRun} initialDocuments={docs} />,
      );
    });

    const runButton = Array.from(container.querySelectorAll('button'))
      .find(b => /run review/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(runButton).toBeTruthy();
    expect(runButton.disabled).toBe(false); // never had to upload anything to enable this

    act(() => { runButton.click(); });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(docs);
  });

  it('defaults to an empty, upload-required panel when initialDocuments is omitted (Library\'s standalone flow)', () => {
    const onRun = vi.fn();
    act(() => {
      root.render(<RunPanel template={makeTemplate()} onBack={() => {}} onRun={onRun} />);
    });

    expect(container.textContent).toContain('0 documents');
    const runButton = Array.from(container.querySelectorAll('button'))
      .find(b => /run review/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
  });
});
