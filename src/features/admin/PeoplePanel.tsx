import React, { useEffect, useState } from 'react';
import type { WorkspaceUser } from '@lexprompt/core';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import {
  disableUser, enableUser, listWorkspacePeople, pseudonymiseUser,
} from '../../lib/api/admin';

/**
 * THE WORKSPACE'S PEOPLE, and the two things an administrator may do to an
 * account.
 *
 * ## The role shown here is NOT this workspace's policy
 *
 * `WorkspaceUser.role` is `app_user.role`, which is a cache of what
 * `roleFor` derived from that person's groups on their LAST request. It is
 * not policy — the policy is the role mapping, one tab across — and a screen
 * presenting it as "their role" presents a stale mapping as current, which
 * is exactly what P54 forbids. So it is labelled as what it is, and the
 * label does not claim an instant: the directory carries no `lastSeenAt` on
 * the wire, and inventing a time would be a second wrong answer on top of
 * the first.
 *
 * ## Pseudonymise is not called "delete", anywhere
 *
 * It retires a name and an address and turns the account off. Every
 * judgement that person recorded stays attributed to the same id in records
 * nothing in this system can erase. A button labelled "delete this person"
 * over that implementation would be a confident claim of erasure that did
 * not happen — the exact shape this project's one rule is about, on the one
 * screen a firm would reach for after a subject-access request.
 */

export interface PeoplePanelProps {
  /** Injected so a test can drive every state without mocking a module. */
  api?: {
    list: typeof listWorkspacePeople;
    disable: typeof disableUser;
    enable: typeof enableUser;
    pseudonymise: typeof pseudonymiseUser;
  };
  /** The signed-in administrator's own id, so their own row can say why it
   *  offers nothing. Absent while `/v1/me` has not answered — the row then
   *  looks like any other, which is safe: the SERVER refuses a self-disable
   *  whatever this renders. */
  selfUserId?: string;
}

const DEFAULT_API = {
  list: listWorkspacePeople,
  disable: disableUser,
  enable: enableUser,
  pseudonymise: pseudonymiseUser,
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; people: WorkspaceUser[] };

/** Complete literal class names per status — never interpolated. */
const STATUS_INK: Record<'active' | 'disabled', string> = {
  active: 'text-ink-3',
  disabled: 'text-risk-high',
};

export function PeoplePanel({ api = DEFAULT_API, selfUserId }: PeoplePanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pending, setPending] = useState<WorkspaceUser | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = (): void => {
    setState({ status: 'loading' });
    api.list()
      .then(people => setState({ status: 'ready', people }))
      .catch((err: unknown) => setState({
        status: 'error',
        message: err instanceof Error && err.message
          ? `The people in this workspace could not be loaded: ${err.message}`
          : 'The people in this workspace could not be loaded. Try again.',
      }));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (call: Promise<unknown>): void => {
    setBusy(true);
    setWriteError(null);
    void call
      .then(() => { setBusy(false); setPending(null); setTyped(''); load(); })
      .catch((err: unknown) => {
        setBusy(false);
        setWriteError(err instanceof Error && err.message
          ? err.message
          : 'LexPrompt could not make that change.');
      });
  };

  if (state.status === 'loading') {
    return (
      <div className="font-ui text-ui text-ink-3" data-busy="true" aria-live="polite">
        Loading the people in this workspace…
      </div>
    );
  }

  if (state.status === 'error') {
    return <LoadErrorPanel message={state.message} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="font-prose text-section text-ink-1">People</h2>
        <p className="font-ui text-ui-sm text-ink-3">
          Everyone this workspace has seen. A disabled account is refused on its next request,
          with the token it already holds, and signing in again does not undo it.
        </p>
      </header>

      {writeError && <LoadErrorPanel message={writeError} compact />}

      <ul className="border border-rule rounded-card divide-y divide-rule">
        {state.people.map(p => (
          <li key={p.id} className="p-4 flex items-start justify-between gap-4 flex-wrap"
            data-user={p.id}>
            <div className="space-y-0.5">
              <p className="font-ui text-ui text-ink-1 font-semibold">{p.displayName}</p>
              {p.email && <p className="font-ui text-ui-sm text-ink-4">{p.email}</p>}
              {/* P54: NOT "their role". The column is what the last request
                  derived, and the label claims no instant the wire does not
                  carry. */}
              <p className="font-ui text-ui-sm text-ink-3">
                {p.role} — the role at their last request. What decides it is the role mapping,
                not this record.
              </p>
              <p className={`font-ui text-ui-sm ${STATUS_INK[p.status]}`}>
                {p.status === 'disabled' ? 'Account turned off' : 'Account active'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {p.id === selfUserId ? (
                <p className="font-ui text-ui-sm text-ink-4 max-w-xs">
                  This is you. LexPrompt refuses to let an administrator turn off their own
                  account — nobody could undo it from here.
                </p>
              ) : (
                <>
                  {p.status === 'active' ? (
                    <button
                      type="button"
                      onClick={() => run(api.disable(p.id))}
                      className="font-ui text-ui-sm px-2.5 py-1.5 rounded-inset border border-rule text-ink-2 hover:bg-chip-fill"
                    >
                      Turn off
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => run(api.enable(p.id))}
                      className="font-ui text-ui-sm px-2.5 py-1.5 rounded-inset border border-rule text-ink-2 hover:bg-chip-fill"
                    >
                      Turn back on
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setPending(p); setTyped(''); setWriteError(null); }}
                    className="font-ui text-ui-sm px-2.5 py-1.5 rounded-inset border border-risk-high-edge text-risk-high hover:bg-risk-high-tint"
                  >
                    Retire this name
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Modal
        isOpen={pending !== null}
        title="Retire this name"
        onClose={() => { setPending(null); setTyped(''); }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setPending(null); setTyped(''); }}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!pending || typed.trim() !== pending.displayName}
              onClick={() => pending && run(api.pseudonymise(pending.id))}
            >
              Retire this name
            </Button>
          </>
        )}
      >
        {pending && (
          <div className="space-y-4">
            <p className="font-prose text-body text-ink-1">
              This replaces {pending.displayName}&rsquo;s name and email address with a
              pseudonym, and turns the account off. It is permanent: LexPrompt cannot put the
              name back.
            </p>
            {/* SAYS WHAT SURVIVES. A screen that implied erasure would be a
                confident claim about a thing that did not happen, on the one
                screen a firm reaches for after a subject-access request. */}
            <p className="font-ui text-ui-sm text-ink-2">
              It is not deletion. Every disposition, note and audited act this person recorded
              stays exactly as it is and stays attributed to them — the records are append-only
              and nothing in LexPrompt can erase them. What goes is the name and the address.
            </p>
            <div className="space-y-2">
              <p className="font-ui text-ui-sm text-ink-2">
                Type <span className="font-semibold">{pending.displayName}</span> to confirm.
              </p>
              <input
                type="text"
                aria-label="Type the person's name to confirm"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                className="font-ui text-ui px-2 py-1.5 rounded-inset border border-rule bg-paper text-ink-1"
              />
            </div>
            {writeError && <LoadErrorPanel message={writeError} compact />}
          </div>
        )}
      </Modal>
    </div>
  );
}
