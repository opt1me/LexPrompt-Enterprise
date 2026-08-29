import React, { useCallback, useEffect, useState } from 'react';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { describeLoadError } from '../../lib/loadError';
import { formatBytes, scanLocalData, type LocalDataScan } from '../../lib/upload/scan';
import { STORE_LABELS, UPLOAD_STORES, type StoreName } from '../../lib/upload/report';

/**
 * The one screen that moves a firm's working history out of this browser
 * (§13.1), in its first half: reading what is here and saying exactly what
 * that is, by name, before anything moves.
 *
 * Nothing on this screen writes anything anywhere. It shows every store,
 * its count, every record by the name a person would call it, every warning,
 * and the size the upload would be. `Upload everything` is the only action,
 * and it is `onUpload`'s to perform.
 *
 * ## Three different empties
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

export interface UploadLocalDataProps {
  /** Performs the upload. Absent while the uploader itself is not wired in;
   *  the screen is still useful without it, because knowing what is in the
   *  browser is the half that has to be right first. */
  onUpload?: (scan: LocalDataScan) => void;
  onClose: () => void;
}

export function UploadLocalData({ onUpload, onClose }: UploadLocalDataProps) {
  const [scan, setScan] = useState<LocalDataScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    scanLocalData().then(
      result => { setScan(result); setLoading(false); },
      (e: unknown) => {
        // `describeLoadError`, not a hand-rolled sentence: `DbBlockedError`
        // says "close your other tabs", `DbOpenTimeoutError` says "your data
        // has not been lost", and replacing either with a generic apology
        // would leave a person retrying something that will keep failing.
        setError(describeLoadError(
          e, 'The data in this browser could not be read. Nothing has been changed.'));
        setScan(null);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <header className="space-y-2">
          <h1 className="font-prose text-screen-title text-ink-1">Move this browser&apos;s data to the server</h1>
          <p className="font-ui text-ui text-ink-3">
            LexPrompt used to keep everything in this browser. Everything below is still here and
            has not been moved yet. Nothing is deleted from this browser by moving it.
          </p>
        </header>

        {loading && <p className="font-ui text-ui text-ink-4">Reading this browser&hellip;</p>}

        {!loading && error && <LoadErrorPanel message={error} onRetry={load} />}

        {!loading && !error && scan && scan.isEmpty && (
          <p className="font-ui text-ui text-ink-3">
            There is nothing stored in this browser. Everything you work on is already on your
            firm&apos;s server.
          </p>
        )}

        {!loading && !error && scan && !scan.isEmpty && (
          <>
            <ScanSummary scan={scan} />
            {onUpload && (
              <button
                onClick={() => onUpload(scan)}
                className="px-4 py-2 rounded-control bg-accent text-page font-ui text-button font-semibold hover:bg-accent-strong"
              >
                Upload everything
              </button>
            )}
          </>
        )}

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
