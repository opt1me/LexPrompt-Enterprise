import React, { useEffect, useState } from 'react';
import type {
  Role, RoleMappingEffect, RoleMappingView, RoleMappingsPage,
} from '@lexprompt/core';
import { ROLES } from '@lexprompt/core';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import {
  changeRoleMapping, createRoleMapping, getRoleMappings, previewRoleMapping, removeRoleMapping,
} from '../../lib/api/admin';

/**
 * WHICH GROUP GRANTS WHICH ROLE — the one screen in LexPrompt that writes
 * policy.
 *
 * ## What this component is NOT allowed to do
 *
 * It never composes a sentence describing what a change will do. Those come
 * from `POST /v1/admin/role-mappings/preview` and are rendered VERBATIM
 * (P53). A screen that describes a policy change in its own words is a
 * screen that can describe it wrongly, and the two descriptions would drift
 * the first time the server's rules changed.
 *
 * It also never renders a person's role as policy. `app_user.role` is a
 * cache of what the last request derived; showing it here would present a
 * stale mapping as the current one, which is the failure this whole
 * apparatus exists to prevent (P54). This component takes no directory prop
 * of any kind, and its own test asserts that structurally as well as by
 * render — "we just won't pass it" is a habit, not a guarantee.
 *
 * ## Dead controls are worse than absent ones
 *
 * A configuration row's controls are DISABLED and say why, naming the
 * variable an administrator would have to edit instead. The alternative — a
 * live-looking control that 409s on click — is the shape `WorkspaceModelPanel`
 * already refuses next door.
 */

export interface RoleMappingPanelProps {
  /**
   * Injected so a test can drive every state without mocking a module. The
   * defaults are the real calls; nothing else is ever passed in the app.
   */
  api?: {
    list: typeof getRoleMappings;
    preview: typeof previewRoleMapping;
    create: typeof createRoleMapping;
    change: typeof changeRoleMapping;
    remove: typeof removeRoleMapping;
  };
}

const DEFAULT_API = {
  list: getRoleMappings,
  preview: previewRoleMapping,
  create: createRoleMapping,
  change: changeRoleMapping,
  remove: removeRoleMapping,
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; page: RoleMappingsPage };

/** What a pending write is, held while its effect sentence is on screen. */
type Pending =
  | { kind: 'create'; issuer: string; groupValue: string; grantsRole: Role }
  | { kind: 'change'; mapping: RoleMappingView; grantsRole: Role }
  | { kind: 'remove'; mapping: RoleMappingView };

/** Complete literal class names per role — never `` `text-${role}` ``,
 *  which Tailwind's scanner cannot see and which renders with no colour at
 *  all, silently. */
const ROLE_INK: Record<Role, string> = {
  reviewer: 'text-ink-2',
  partner: 'text-accent',
  admin: 'text-risk-high',
};

const ROLE_LABEL: Record<Role, string> = {
  reviewer: 'Reviewer',
  partner: 'Partner',
  admin: 'Administrator',
};

/** The instant, in words. Local time, because the reader is looking at it
 *  now and an ISO string in UTC is a fact they would have to convert. */
function readAtLine(readAt: number): string {
  return `Read at ${new Date(readAt).toLocaleString()}`;
}

export function RoleMappingPanel({ api = DEFAULT_API }: RoleMappingPanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [effect, setEffect] = useState<RoleMappingEffect | null>(null);
  const [effectError, setEffectError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const [newIssuer, setNewIssuer] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newRole, setNewRole] = useState<Role>('reviewer');

  const load = (): void => {
    setState({ status: 'loading' });
    api.list()
      .then(page => setState({ status: 'ready', page }))
      .catch((err: unknown) => setState({
        status: 'error',
        message: err instanceof Error && err.message
          ? `The role mapping could not be loaded: ${err.message}`
          : 'The role mapping could not be loaded. Try again.',
      }));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ask = (next: Pending): void => {
    setPending(next);
    setEffect(null);
    setEffectError(null);
    setWriteError(null);
    setTyped('');
    const issuer = next.kind === 'create' ? next.issuer : next.mapping.issuer;
    const group = next.kind === 'create' ? next.groupValue : next.mapping.groupValue;
    const role = next.kind === 'remove' ? undefined : next.grantsRole;
    api.preview(issuer, group, role)
      .then(setEffect)
      .catch((err: unknown) => setEffectError(
        err instanceof Error && err.message
          ? `LexPrompt could not work out what this change would do: ${err.message}`
          : 'LexPrompt could not work out what this change would do.'));
  };

  const apply = (): void => {
    if (!pending) return;
    setBusy(true);
    setWriteError(null);
    const done = (): void => { setBusy(false); setPending(null); setEffect(null); load(); };
    const failed = (err: unknown): void => {
      setBusy(false);
      setWriteError(err instanceof Error && err.message
        ? err.message
        : 'LexPrompt could not make that change.');
    };
    const call = pending.kind === 'create'
      ? api.create(pending.issuer, pending.groupValue, pending.grantsRole)
      : pending.kind === 'change'
        ? api.change(pending.mapping.id, pending.grantsRole)
        : api.remove(pending.mapping.id);
    void call.then(done).catch(failed);
  };

  if (state.status === 'loading') {
    return (
      <div className="font-ui text-ui text-ink-3 flex items-center gap-2" data-busy="true" aria-live="polite">
        Loading the role mapping…
      </div>
    );
  }

  if (state.status === 'error') {
    return <LoadErrorPanel message={state.message} onRetry={load} />;
  }

  const { mappings, readAt, configurationSource } = state.page;
  // The typed confirmation is required only for a WIDENING, and the word it
  // asks for is the role's own name — the thing the change actually grants.
  const needsTyping = effect?.widens === true;
  const wanted = effect?.grantsRole ?? '';
  const confirmReady = !!effect && (!needsTyping || typed.trim().toLowerCase() === wanted);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="font-prose text-section text-ink-1">Who gets which role</h2>
        <p className="font-ui text-ui-sm text-ink-3">
          A person&rsquo;s role comes from the groups their sign-in carries. This is the whole
          of that mapping. A change applies on their next request, including for anyone
          already signed in.
        </p>
        {/* P54: a policy screen with no instant cannot be told apart from a
            stale one, and the reader has no way to know which they have. */}
        <p className="font-ui text-ui-sm text-ink-4" data-testid="read-at">{readAtLine(readAt)}</p>
      </header>

      {mappings.length === 0 ? (
        // NOT a blank table. An empty `role_mapping` means nobody in the firm
        // can sign in at all, which is a catastrophe and must not render as
        // an ordinary "nothing here yet".
        <div className="p-6 border border-risk-high-edge bg-risk-high-tint rounded-card space-y-2">
          <p className="font-ui text-ui text-risk-high font-semibold">
            This workspace has no role mapping at all, so nobody can sign in to LexPrompt.
          </p>
          <p className="font-ui text-ui-sm text-ink-2">
            Add a mapping below, or name one in {configurationSource} and redeploy.
          </p>
        </div>
      ) : (
        <ul className="border border-rule rounded-card divide-y divide-rule">
          {mappings.map(m => (
            <li key={m.id} className="p-4 space-y-2" data-group={m.groupValue}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="space-y-0.5">
                  <p className="font-ui text-ui text-ink-1">
                    <span className="font-semibold">{m.groupValue}</span>
                    <span className="text-ink-4"> from {m.issuer}</span>
                  </p>
                  <p className={`font-ui text-ui-sm ${ROLE_INK[m.role]}`}>
                    Grants {ROLE_LABEL[m.role]}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {ROLES.filter(r => r !== m.role).map(r => (
                    <button
                      key={r}
                      type="button"
                      disabled={m.source === 'configuration'}
                      onClick={() => ask({ kind: 'change', mapping: m, grantsRole: r })}
                      className="font-ui text-ui-sm px-2.5 py-1.5 rounded-inset border border-rule text-ink-2 hover:bg-chip-fill disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Make {ROLE_LABEL[r]}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={m.source === 'configuration'}
                    onClick={() => ask({ kind: 'remove', mapping: m })}
                    className="font-ui text-ui-sm px-2.5 py-1.5 rounded-inset border border-risk-high-edge text-risk-high hover:bg-risk-high-tint disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {m.source === 'configuration' && (
                // A disabled control with no reason is a dead control. This
                // says WHY, and names the variable to edit instead.
                <p className="font-ui text-ui-sm text-ink-3">
                  This mapping comes from deployment configuration ({configurationSource}), so it
                  cannot be changed here. An administrator changes it by editing that variable
                  and redeploying.
                </p>
              )}
              {m.convertedFromAdminAt !== undefined && (
                // P52, permanently. An administrator must be able to see that
                // their change was superseded without going and reading a log.
                <p className="font-ui text-ui-sm text-risk-med">
                  This mapping was added here and has since been replaced by deployment
                  configuration ({new Date(m.convertedFromAdminAt).toLocaleString()}). What it
                  grants now comes from {configurationSource}.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-3 border border-rule rounded-card p-4">
        <h3 className="font-ui text-ui text-ink-1 font-semibold">Add a mapping</h3>
        <div className="flex flex-wrap gap-3">
          <label className="font-ui text-ui-sm text-ink-3 space-y-1">
            <span className="block">Issuer</span>
            <input
              type="text"
              value={newIssuer}
              onChange={e => setNewIssuer(e.target.value)}
              className="font-ui text-ui px-2 py-1.5 rounded-inset border border-rule bg-paper text-ink-1"
            />
          </label>
          <label className="font-ui text-ui-sm text-ink-3 space-y-1">
            <span className="block">Group</span>
            <input
              type="text"
              value={newGroup}
              onChange={e => setNewGroup(e.target.value)}
              className="font-ui text-ui px-2 py-1.5 rounded-inset border border-rule bg-paper text-ink-1"
            />
          </label>
          <label className="font-ui text-ui-sm text-ink-3 space-y-1">
            <span className="block">Grants</span>
            <select
              value={newRole}
              onChange={e => setNewRole(e.target.value as Role)}
              className="font-ui text-ui px-2 py-1.5 rounded-inset border border-rule bg-paper text-ink-1"
            >
              {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
        </div>
        <Button
          disabled={!newIssuer.trim() || !newGroup.trim()}
          onClick={() => ask({
            kind: 'create',
            issuer: newIssuer.trim(),
            groupValue: newGroup.trim(),
            grantsRole: newRole,
          })}
        >
          Add mapping
        </Button>
      </section>

      <Modal
        isOpen={pending !== null}
        title="What this change will do"
        onClose={() => { setPending(null); setEffect(null); }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setPending(null); setEffect(null); }}>
              Cancel
            </Button>
            <Button
              variant={effect?.action === 'remove' ? 'danger' : 'primary'}
              disabled={!confirmReady}
              loading={busy}
              onClick={apply}
            >
              {effect?.action === 'remove' ? 'Remove the mapping' : 'Apply the change'}
            </Button>
          </>
        )}
      >
        {effectError && <LoadErrorPanel message={effectError} compact />}
        {!effect && !effectError && (
          <p className="font-ui text-ui text-ink-3" data-busy="true" aria-live="polite">
            Asking the server what this would do…
          </p>
        )}
        {effect && (
          <div className="space-y-4">
            {/* THE SERVER'S SENTENCE, VERBATIM. Nothing here reformats it,
                truncates it or adds to it. */}
            <p className="font-prose text-body text-ink-1" data-testid="effect-sentence">
              {effect.sentence}
            </p>
            {effect.widens && (
              <div className="space-y-2">
                <p className="font-ui text-ui-sm text-ink-2">
                  This grants more than the mapping grants today. Type
                  {' '}<span className="font-semibold">{effect.grantsRole}</span>{' '}
                  to confirm.
                </p>
                <input
                  type="text"
                  aria-label="Type the role name to confirm"
                  value={typed}
                  onChange={e => setTyped(e.target.value)}
                  className="font-ui text-ui px-2 py-1.5 rounded-inset border border-rule bg-paper text-ink-1"
                />
              </div>
            )}
            {writeError && <LoadErrorPanel message={writeError} compact />}
          </div>
        )}
      </Modal>
    </div>
  );
}
