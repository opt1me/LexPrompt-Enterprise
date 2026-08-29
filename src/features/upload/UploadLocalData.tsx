import React, { useCallback, useEffect, useState } from 'react';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { describeLoadError } from '../../lib/loadError';
import { formatBytes, scanLocalData, type LocalDataScan } from '../../lib/upload/scan';
import {
  STORE_LABELS, UPLOAD_STORES, movedLine, type StoreName, type UploadReport,
} from '../../lib/upload/report';
import { runUpload } from '../../lib/upload/run';

/**
 * The one screen that moves a firm's working history out of this browser
 * (§13.1): reading what is here, moving it, and reporting BY NAME what did
 * not move.
 *
 * ## The sentence this screen must never say
 *
 * "Everything moved", over anything less than everything. So the heading is
 * `report.complete`'s and nothing else's, `complete` is derived by
 * `isComplete` rather than set by the run, and the failures are listed
 * ABOVE the successes — a person who has to scroll past nine good records to
 * find the one that did not move will not scroll.
 *
 * ## Three different empties, before anything moves
 *
 * - **Loading.** Not yet known.
 * - **Nothing here.** Read successfully, and there is nothing to move.
 * - **Could not be read.** `LoadErrorPanel` with `describeLoadError`'s own
 *   wording, rendered INSTEAD OF the content and never alongside it, with a
 *   Retry — the load-path rule, at the one screen where getting it wrong
 *   would tell somebody their firm's matters are gone.
 *
 * A store that could not be read while the others could is a fourth thing,
 * and it is shown IN the content: the readable stores are listed with their
 * counts, and the unreadable ones are named as unknown rather than as zero.
 */

/** Said on every phase of this screen, and not behind a disclosure. §13.1,
 *  S13 and "never delete what you cannot read": the local copy is left
 *  exactly as it was, and a person who has just watched a progress bar
 *  should not have to wonder. */
const NOTHING_DELETED =
  'Your data is still in this browser as well. Nothing here has been deleted.';

export interface UploadLocalDataProps {
  onClose: () => void;
  /** Told when a run finishes, so the app can change what its banner says.
   *  Handed the report, not a boolean: "it finished" and "everything moved"
   *  are different facts. */
  onUploaded?: (report: UploadReport) => void;
  /** Overridden only by tests. The default is the real uploader, going
   *  through the ordinary repositories. */
  upload?: typeof runUpload;
}

type Phase =
  | { kind: 'scanning' }
  | { kind: 'scan-failed'; message: string }
  | { kind: 'ready'; scan: LocalDataScan }
  | { kind: 'uploading'; scan: LocalDataScan; progress: UploadReport | null }
  | { kind: 'upload-failed'; scan: LocalDataScan; message: string }
  | { kind: 'done'; report: UploadReport };

export function UploadLocalData({ onClose, onUploaded, upload = runUpload }: UploadLocalDataProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });

  const load = useCallback(() => {
    setPhase({ kind: 'scanning' });
    scanLocalData().then(
      scan => setPhase({ kind: 'ready', scan }),
      (e: unknown) => setPhase({
        kind: 'scan-failed',
        // `describeLoadError`, not a hand-rolled sentence: `DbBlockedError`
        // says "close your other tabs", `DbOpenTimeoutError` says "your data
        // has not been lost", and replacing either with a generic apology
        // would leave a person retrying something that will keep failing.
        message: describeLoadError(
          e, 'The data in this browser could not be read. Nothing has been changed.'),
      }),
    );
  }, []);

  useEffect(() => { load(); }, [load]);

  const start = useCallback((scan: LocalDataScan) => {
    setPhase({ kind: 'uploading', scan, progress: null });
    upload(scan, {
      onProgress: progress => setPhase(current => (
        current.kind === 'uploading' ? { ...current, progress } : current)),
    }).then(
      report => { setPhase({ kind: 'done', report }); onUploaded?.(report); },
      (e: unknown) => setPhase({
        kind: 'upload-failed',
        scan,
        // A run that could not START at all — most likely `getProfile()`
        // rejecting, which is the migration being unable to say who ran it.
        // Reported as its own failure rather than as a report full of
        // failures, because nothing was attempted and saying "12 records
        // failed" would be twelve wrong sentences instead of one right one.
        message: describeLoadError(
          e, 'The upload could not be started. Nothing has been changed.'),
      }),
    );
  }, [upload, onUploaded]);

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <header className="space-y-2">
          <h1 className="font-prose text-screen-title text-ink-1">
            Move this browser&apos;s data to the server
          </h1>
          <p className="font-ui text-ui text-ink-3">
            LexPrompt used to keep everything in this browser. {NOTHING_DELETED}
          </p>
        </header>

        {phase.kind === 'scanning' && (
          <p className="font-ui text-ui text-ink-4">Reading this browser&hellip;</p>
        )}

        {phase.kind === 'scan-failed' && <LoadErrorPanel message={phase.message} onRetry={load} />}

        {phase.kind === 'ready' && phase.scan.isEmpty && (
          <p className="font-ui text-ui text-ink-3">
            There is nothing stored in this browser. Everything you work on is already on your
            firm&apos;s server.
          </p>
        )}

        {phase.kind === 'ready' && !phase.scan.isEmpty && (
          <>
            <ScanSummary scan={phase.scan} />
            <button
              onClick={() => start(phase.scan)}
              className="px-4 py-2 rounded-control bg-accent text-page font-ui text-button font-semibold hover:bg-accent-strong"
            >
              Upload everything
            </button>
          </>
        )}

        {phase.kind === 'uploading' && (
          <div className="space-y-2">
            <p className="font-ui text-ui text-ink-2">
              Moving your data. Leaving this page will stop it part way; you can come back and
              press Upload again, and anything already moved will be confirmed rather than sent
              twice.
            </p>
            {phase.progress && (
              <p className="font-ui text-ui-sm text-ink-4">
                {phase.progress.outcomes.length} of {totalExpected(phase.scan)} records so far.
              </p>
            )}
          </div>
        )}

        {phase.kind === 'upload-failed' && (
          <LoadErrorPanel message={phase.message} onRetry={() => start(phase.scan)} />
        )}

        {phase.kind === 'done' && <ReportView report={phase.report} />}

        <button
          onClick={onClose}
          className="block px-4 py-2 rounded-control border border-rule-strong font-ui text-button text-ink-2 hover:bg-chip-fill"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function totalExpected(scan: LocalDataScan): number {
  return UPLOAD_STORES.reduce((sum, store) => sum + (scan.totals[store] ?? 0), 0);
}

/**
 * The finished report.
 *
 * The heading is `report.complete`'s and nothing else's, and the word
 * "complete" and the tick appear ONLY under it — so a report with a single
 * failure cannot be skim-read as a success. Everything that did not move is
 * listed first, by name and with the reason.
 */
export function ReportView({ report }: { report: UploadReport }) {
  const failed = report.outcomes.filter(o => o.status === 'failed');
  const partial = report.outcomes.filter(o => o.status === 'moved-without-bytes');
  const noted = report.outcomes.filter(o => o.status === 'moved' && o.reason);

  return (
    <div className="space-y-6">
      {report.complete ? (
        <div className="space-y-1">
          <h2 className="font-prose text-screen-title text-ink-1">&#10003; Everything moved</h2>
          <p className="font-ui text-ui text-ink-3">
            This migration is complete. {NOTHING_DELETED}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <h2 className="font-prose text-screen-title text-risk-high">
            Some of your data did not move
          </h2>
          <p className="font-ui text-ui text-ink-3">
            Everything named below is still only in this browser. {NOTHING_DELETED} You can press
            Upload again — anything that did move will be confirmed rather than sent twice.
          </p>
        </div>
      )}

      {report.unreadable.length > 0 && (
        <section className="border border-risk-high-edge bg-risk-high-tint rounded-card p-4">
          <p className="font-ui text-ui text-risk-high">
            LexPrompt could not read {report.unreadable.map(s => STORE_LABELS[s].many).join(', ')} in
            this browser at all, so nothing from there was moved and there is no way to say how
            much there was.
          </p>
        </section>
      )}

      {failed.length > 0 && (
        <OutcomeList
          title="Did not move"
          tone="bad"
          rows={failed.map(o => ({ id: o.id, label: o.label, reason: o.reason }))}
        />
      )}

      {partial.length > 0 && (
        <OutcomeList
          title="Moved without their original file"
          tone="bad"
          rows={partial.map(o => ({ id: o.id, label: o.label, reason: o.reason }))}
        />
      )}

      {noted.length > 0 && (
        <OutcomeList
          title="Moved, with something worth knowing"
          tone="note"
          rows={noted.map(o => ({ id: o.id, label: o.label, reason: o.reason }))}
        />
      )}

      {report.unmapped > 0 && (
        <p className="font-ui text-ui-sm text-risk-high">
          {report.unmapped} {report.unmapped === 1 ? 'record names' : 'records name'} a person this
          browser could not identify. Those names were left exactly as they were rather than
          being changed to yours.
        </p>
      )}

      <section className="space-y-1">
        <h3 className="font-ui text-label uppercase text-ink-4">Moved</h3>
        <ul className="space-y-0.5">
          {UPLOAD_STORES.filter(store => report.expected[store] !== undefined
            || report.unreadable.includes(store)).map(store => (
              <li key={store} className="font-ui text-ui-sm text-ink-2">{movedLine(store, report)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function OutcomeList({ title, tone, rows }: {
  title: string;
  tone: 'bad' | 'note';
  rows: { id: string; label: string; reason?: string }[];
}) {
  // Mapped, never interpolated: a Tailwind class built from a variable never
  // appears as a complete literal in the source, so the compiler never
  // generates it and the element renders with no colour at all.
  const heading = tone === 'bad' ? 'text-risk-high' : 'text-ink-3';
  return (
    <section className="space-y-1">
      <h3 className={`font-ui text-label uppercase ${heading}`}>{title}</h3>
      <ul className="space-y-1.5">
        {rows.map(row => (
          <li key={row.id} className="font-ui text-ui-sm text-ink-2">
            <span className="font-semibold">{row.label}</span>
            {row.reason && <span className="block text-ink-3">{row.reason}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ScanSummary({ scan }: { scan: LocalDataScan }) {
  return (
    <div className="space-y-5">
      <p className="font-ui text-ui text-ink-3">
        About {formatBytes(scan.totalBytes)} of original files, plus the records below.
      </p>

      {scan.unreadable.length > 0 && (
        <div className="border border-risk-high-edge bg-risk-high-tint rounded-card p-4 space-y-1">
          <p className="font-ui text-ui text-risk-high">
            {/* NOT rendered as "0". A store nobody could read holds an unknown
                number of records, and reporting zero for it is the founding
                defect: an empty library indistinguishable from a fresh
                install. */}
            LexPrompt could not read {scan.unreadable.map(s => STORE_LABELS[s].many).join(', ')} in
            this browser at all. Whatever is in there is not counted below, and moving everything
            else will not move it.
          </p>
        </div>
      )}

      {UPLOAD_STORES.map(store => (
        <StoreSection key={store} store={store} scan={scan} />
      ))}
    </div>
  );
}

function StoreSection({ store, scan }: { store: StoreName; scan: LocalDataScan }) {
  const records = scan.records[store];
  const total = scan.totals[store];
  if (total === undefined) {
    return (
      <section className="space-y-1">
        <h2 className="font-ui text-label uppercase text-ink-4">{STORE_LABELS[store].many}</h2>
        <p className="font-ui text-ui-sm text-risk-high">
          Unknown — this store could not be read.
        </p>
      </section>
    );
  }
  if (total === 0) return null;
  return (
    <section className="space-y-1">
      <h2 className="font-ui text-label uppercase text-ink-4">
        {total} {total === 1 ? STORE_LABELS[store].one : STORE_LABELS[store].many}
      </h2>
      <ul className="space-y-0.5">
        {records.map(r => (
          <li key={r.id} className="font-ui text-ui-sm text-ink-2">
            {r.label}
            {r.warning && (
              <span className="block text-ui-sm text-risk-high">{r.warning}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
