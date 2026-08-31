import React, { useState } from 'react';
import type { AuditExport, AuditExportManifest } from '@lexprompt/core';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Button } from '../../components/Button';
import { getAuditExport } from '../../lib/api/admin';

/**
 * TAKING THE WORKSPACE'S AUDIT EXTRACT.
 *
 * ## It opens on a bounded range and never on everything
 *
 * "Everything this workspace has ever done" is a decision somebody makes,
 * not a default a screen makes for them — and the route refuses an unbounded
 * range for the same reason. The opening range is
 * `AUDIT_EXPORT_DEFAULT_DAYS`.
 *
 * ## The manifest is shown BEFORE the download, not only inside the file
 *
 * A person choosing a range should see what they are about to take before
 * they take it: which sources, how many rows in each, and when it was read.
 * A file whose scope is only discoverable by opening it is a file somebody
 * forwards without ever having read the scope.
 *
 * ## A refusal is rendered as a refusal
 *
 * `export_too_large` names the source that overflowed and offers a narrower
 * range as a control, rather than a message telling a person to go and edit
 * a URL. It is NOT rendered as an empty extract, which would be a file that
 * says nothing happened.
 */

/** The range the panel opens on. Thirty days: long enough to be useful, and
 *  short enough that the first thing an administrator does is not hit the
 *  ceiling. */
export const AUDIT_EXPORT_DEFAULT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ranges offered, narrowest last so a refusal has somewhere to send the
 *  reader. */
export const RANGE_CHOICES: { label: string; days: number }[] = [
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 7 days', days: 7 },
];

type State =
  | { status: 'idle' }
  | { status: 'taking' }
  | { status: 'refused'; message: string }
  | { status: 'taken'; result: AuditExport };

/**
 * THE MANIFEST, IN WORDS, and the same sentences whether it is on screen or
 * at the top of the file.
 *
 * One producer, so the block a person reads before downloading and the block
 * inside the download cannot drift — the same rule `verificationLabel` holds
 * for export wording one layer down.
 */
export function manifestLines(manifest: AuditExportManifest): string[] {
  const range = `${new Date(manifest.from).toLocaleString()} to `
    + `${new Date(manifest.to).toLocaleString()}`;
  return [
    `LexPrompt audit extract for workspace ${manifest.workspaceId}`,
    `Covers ${range} (${manifest.timeZone}), including the start and excluding the end`,
    `Taken ${new Date(manifest.takenAt).toLocaleString()} by user ${manifest.takenByUserId}`,
    ...manifest.sources.map(s => `Source ${s.source}: ${s.rows} row(s)`),
    manifest.complete
      ? 'This extract is COMPLETE for the range above. LexPrompt refuses to produce a partial '
        + 'extract, so there are no rows missing from it.'
      : 'This extract is INCOMPLETE.',
  ];
}

/** The CSV, with the manifest as its first block — exactly as the DOCX puts
 *  `dispositionsAsAtLine` first, and for the same reason: a reader who opens
 *  the file must meet its scope before its rows. */
export function toCsv(result: AuditExport): string {
  const cell = (v: string | number | undefined): string =>
    `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = manifestLines(result.manifest).map(l => cell(l));
  lines.push('');
  lines.push([
    'When', 'Source', 'What', 'By user', 'Matter', 'Review', 'Clause', 'Cause', 'Subject',
  ].map(cell).join(','));
  for (const r of result.rows) {
    lines.push([
      cell(new Date(r.at).toISOString()),
      cell(r.source),
      cell(r.kind),
      cell(r.byUserId),
      cell(r.matterName ?? r.matterId),
      cell(r.reviewName ?? r.reviewId),
      cell(r.clauseId),
      cell(r.cause),
      cell(r.subjectType ? `${r.subjectType} ${r.subjectId ?? ''}`.trim() : undefined),
    ].join(','));
  }
  return lines.join('\n');
}

export interface AuditExportPanelProps {
  /** Injected so a test can drive every state without mocking a module. */
  take?: typeof getAuditExport;
  /** Injected so a test can assert what the download would contain without a
   *  real anchor click, which jsdom does not perform. */
  onDownload?: (filename: string, csv: string) => void;
}

function defaultDownload(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function AuditExportPanel({
  take = getAuditExport, onDownload = defaultDownload,
}: AuditExportPanelProps) {
  const [days, setDays] = useState(AUDIT_EXPORT_DEFAULT_DAYS);
  const [state, setState] = useState<State>({ status: 'idle' });

  const run = (forDays: number): void => {
    setDays(forDays);
    setState({ status: 'taking' });
    const to = Date.now();
    take(to - forDays * DAY_MS, to)
      .then(result => setState({ status: 'taken', result }))
      .catch((err: unknown) => setState({
        status: 'refused',
        message: err instanceof Error && err.message
          ? err.message
          : 'LexPrompt could not take this extract.',
      }));
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="font-prose text-section text-ink-1">Audit export</h2>
        <p className="font-ui text-ui-sm text-ink-3">
          Every audited act, every disposition change and every run in this workspace, for a
          range you choose. The file states what it covers and when it was taken, and LexPrompt
          refuses to produce a partial one.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {RANGE_CHOICES.map(c => (
          <button
            key={c.days}
            type="button"
            onClick={() => run(c.days)}
            aria-current={c.days === days ? 'true' : undefined}
            className="font-ui text-ui-sm px-2.5 py-1.5 rounded-inset border border-rule text-ink-2 hover:bg-chip-fill"
          >
            {c.label}
          </button>
        ))}
      </div>

      {state.status === 'taking' && (
        <p className="font-ui text-ui text-ink-3" data-busy="true" aria-live="polite">
          Taking the extract…
        </p>
      )}

      {state.status === 'refused' && (
        <div className="space-y-3">
          {/* A REFUSAL, rendered as one. Never an empty extract, which would
              be a file saying nothing happened. */}
          <LoadErrorPanel message={state.message} compact />
          <p className="font-ui text-ui-sm text-ink-3">
            Take it in narrower pieces — each one states its own range, so together they cover
            the whole of it with nothing missing and nothing counted twice.
          </p>
        </div>
      )}

      {state.status === 'taken' && (
        <div className="space-y-4">
          {/* THE MANIFEST, BEFORE THE DOWNLOAD. A person choosing a range
              should see what they are about to take. */}
          <ul className="border border-rule rounded-card p-4 space-y-1" data-testid="manifest">
            {manifestLines(state.result.manifest).map(line => (
              <li key={line} className="font-ui text-ui-sm text-ink-2">{line}</li>
            ))}
          </ul>
          <Button
            onClick={() => onDownload(
              `lexprompt-audit-${new Date(state.result.manifest.takenAt).toISOString().slice(0, 10)}.csv`,
              toCsv(state.result))}
          >
            Download the extract
          </Button>
        </div>
      )}
    </div>
  );
}
