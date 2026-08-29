import React, { useMemo } from 'react';
import { Button } from '../../components/Button';
import type { PrecedentDocument, PrecedentRole } from '../../lib/chains';
import { PRECEDENT_STORAGE_PRIVACY } from '../../lib/privacyCopy';

/**
 * Precedent intake — spec §7. Chain cards and standalone cards, a role chip
 * on every document, and an explicit "what is this?" prompt on anything
 * ambiguous. Nothing here ever asserts a role: `chains.ts`'s `proposeRole`
 * NEVER returns `inferred: false` (R-F4), so every document arrives as a
 * proposal, and this component's only path to a confirmed role is the user
 * clicking one of the buttons in `RoleControls` — never a default, never an
 * effect that "confirms" on mount.
 *
 * Getting a role wrong silently is spec §7's worst failure mode for this
 * screen: read the counterparty's own opening draft back as the firm's own
 * house position. So `role === 'unknown'` gets its own, harder prompt
 * ("What is this?") rather than being folded into the same "confirm or
 * change" control every other, more-confident-but-still-unconfirmed role
 * gets.
 *
 * `RoleChip` (sub-project G restyle): a confirmed, non-inferred role is
 * ACCENT — teal, "a person did something" (§6.3) — because confirming a
 * proposed role, or reading one unambiguously, is exactly that: a human (or
 * an unambiguous read) settled the question. A proposed-but-unconfirmed role
 * gets the plain neutral chip fill, never accent, so it cannot be mistaken
 * for the confirmed shape at a glance (R-F4) — this is the one place in
 * these five files where getting a colour wrong would reproduce this
 * sub-project's founding failure.
 *
 * ## The sentence in this header
 *
 * It used to say the documents brought in here were read once and kept
 * nowhere. That was TRUE when it was written, and the server design's §11.1
 * made it false: precedent documents are stored, in the firm's own tenant,
 * as `kind = 'precedent'` documents belonging to a precedent set. The
 * storage and this sentence shipped in the SAME COMMIT, which §11.1 states
 * as an acceptance condition — *"there is no release in which the storage
 * exists and the sentence does"* — because shipping the storage while the
 * old wording was still on screen would be this project's founding defect in
 * its purest form: something incorrect presented as correct, to a lawyer, at
 * the moment they are deciding whether to hand over a client's document.
 *
 * The replacement is as strong in its new direction as the old one was in
 * its: it says what happens, where, and what it is kept apart from. It lives
 * in `privacyCopy.ts` (R-G5, §11.1 requirement 2) rather than inline, and it
 * is still said exactly ONCE, here, by the screen that owns the header — two
 * wordings of one promise is a defect this route has already had to fix.
 * `PrecedentUploadPanel`'s own sentence is about what is READ and says
 * nothing about storage, so it is untouched.
 */

export interface UnreadableDocument {
  id?: string;
  name: string;
}

export interface PrecedentIntakeProps {
  documents: PrecedentDocument[];
  /** Documents whose tracked changes could not be read (spec §8). Reported
   *  by name, with the diff fallback OFFERED via `onOfferDiff` — never taken
   *  automatically. */
  unreadable?: UnreadableDocument[];
  /** Total tracked/diff edits still to read, for the running summary line
   *  (spec §7: "7 documents · 1 chain · 146 tracked edits to read"). Omitted
   *  from the summary when not supplied rather than shown as zero, which
   *  would misreport documents nobody has parsed yet. */
  totalEditsToRead?: number;
  /** The name this session's playbook will be saved under — a ruling on a
   *  gap Task 10A-fix left open: it used to name every redlines playbook
   *  with the same constant, unusable the moment the flow ran twice. Lives
   *  here, beside the documents, because the person is already telling the
   *  app what these documents are — mirroring E's `DraftForm`, which asks
   *  the same question before it drafts anything. Never gates `onContinue`:
   *  the app's own save gate (`handleRedlinesToDraftReview`, mirroring
   *  `DraftForm`'s `canSubmit`) is where this is actually required, not
   *  here — someone should be able to explore what the redlines say before
   *  committing to a name. */
  contractType?: string;
  onContractTypeChange?: (value: string) => void;
  /** Sets (or confirms, when passed the document's own current role) a
   *  document's role. This is the ONLY route by which `roleInferred` can
   *  become `false` — that happens in the caller's state update, not here. */
  onSetRole: (document: PrecedentDocument, role: PrecedentRole) => void;
  onRemoveDocument?: (document: PrecedentDocument) => void;
  /** Spec §8: "a chain the user rejects is ungrouped, not re-proposed." */
  onRejectChain?: (chainId: string) => void;
  /** Spec §8: the diff fallback is offered explicitly here, never substituted
   *  silently for a document whose tracked changes could not be read. */
  onOfferDiff: (document: UnreadableDocument) => void;
  onContinue?: () => void;
}

const ROLE_LABEL: Record<PrecedentRole, string> = {
  'their-draft': 'Their draft',
  'our-markup': 'Our markup',
  executed: 'Executed',
  unknown: 'Unknown',
};

const ROLE_CHOICES: PrecedentRole[] = ['their-draft', 'our-markup', 'executed'];

interface ChainGroup {
  chainId?: string;
  docs: PrecedentDocument[];
}

function groupByChain(documents: PrecedentDocument[]): ChainGroup[] {
  const chained = new Map<string, PrecedentDocument[]>();
  const standalone: PrecedentDocument[] = [];
  for (const doc of documents) {
    if (doc.chainId) {
      const list = chained.get(doc.chainId) ?? [];
      list.push(doc);
      chained.set(doc.chainId, list);
    } else {
      standalone.push(doc);
    }
  }
  const groups: ChainGroup[] = Array.from(chained.entries()).map(([chainId, docs]) => ({ chainId, docs }));
  for (const doc of standalone) groups.push({ docs: [doc] });
  return groups;
}

export function PrecedentIntake({
  documents,
  unreadable = [],
  totalEditsToRead,
  contractType = '',
  onContractTypeChange,
  onSetRole,
  onRemoveDocument,
  onRejectChain,
  onOfferDiff,
  onContinue,
}: PrecedentIntakeProps) {
  const chains = useMemo(() => groupByChain(documents), [documents]);
  const chainCount = useMemo(() => new Set(documents.filter((d) => d.chainId).map((d) => d.chainId)).size, [
    documents,
  ]);
  // Nothing proceeds on a guessed role (spec §7): the gate is any document
  // still sitting at the truly ambiguous role, not merely "inferred" — every
  // proposed document is `roleInferred`, so gating on that alone would block
  // on documents nobody has even been asked to look at yet.
  const hasAmbiguousRole = documents.some((d) => d.role === 'unknown');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 bg-paper">
      <header>
        <h2 className="font-prose text-screen-title text-ink-1">Bring in what you negotiated</h2>
        <p className="font-ui text-meta text-ink-3 mt-1">
          {documents.length} document{documents.length === 1 ? '' : 's'}
          {' · '}
          {chainCount} chain{chainCount === 1 ? '' : 's'}
          {typeof totalEditsToRead === 'number' && (
            <>
              {' · '}
              {totalEditsToRead} edit{totalEditsToRead === 1 ? '' : 's'} to read
            </>
          )}
        </p>
        <p className="font-ui text-meta text-ink-2 mt-1">
          {/* The storage promise. See "The sentence in this header" at the
              top of this file for what it replaced and why. */}
          {PRECEDENT_STORAGE_PRIVACY}
        </p>
      </header>

      {onContractTypeChange && (
        <div className="max-w-md">
          <label className="block font-mono text-label uppercase text-ink-4 mb-1">
            Playbook name
          </label>
          <input
            aria-label="Playbook name"
            value={contractType}
            onChange={(e) => onContractTypeChange(e.target.value)}
            placeholder="e.g. Commercial Lease (Landlord)"
            className="w-full bg-paper border border-rule rounded-control p-2.5 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
          />
          <p className="font-ui text-meta text-ink-4 mt-1">
            Names the playbook you are about to create from these documents — not the documents themselves.
          </p>
        </div>
      )}

      {unreadable.length > 0 && (
        <div className="space-y-2">
          {unreadable.map((doc, i) => (
            <div
              key={doc.id ?? `${doc.name}-${i}`}
              className="flex flex-wrap items-center justify-between gap-3 bg-risk-med-tint border border-risk-med-edge rounded-card p-3"
            >
              <p className="font-ui text-ui text-risk-med">
                <strong>{doc.name}</strong> &mdash; its tracked changes could not be read.
              </p>
              <Button variant="ghost" onClick={() => onOfferDiff(doc)}>
                Compare versions instead
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {chains.map((chain) => (
          <ChainCard
            key={chain.chainId ?? chain.docs[0]?.id}
            chain={chain}
            onSetRole={onSetRole}
            onRemoveDocument={onRemoveDocument}
            onRejectChain={onRejectChain}
          />
        ))}
        {documents.length === 0 && unreadable.length === 0 && (
          <p className="font-ui text-ui text-ink-3 italic">No documents brought in yet.</p>
        )}
      </div>

      {onContinue && (
        <div className="flex flex-col items-end gap-2 pt-4 border-t border-rule">
          {hasAmbiguousRole && (
            <p className="font-ui text-ui text-risk-med">Say what each document is before continuing.</p>
          )}
          <Button onClick={onContinue} disabled={hasAmbiguousRole || documents.length === 0}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}

interface ChainCardProps {
  chain: ChainGroup;
  onSetRole: (document: PrecedentDocument, role: PrecedentRole) => void;
  onRemoveDocument?: (document: PrecedentDocument) => void;
  onRejectChain?: (chainId: string) => void;
}

function ChainCard({ chain, onSetRole, onRemoveDocument, onRejectChain }: ChainCardProps) {
  const isChain = Boolean(chain.chainId);

  return (
    <div className={isChain ? 'border border-draft rounded-panel p-3 bg-draft-tint space-y-3' : 'space-y-3'}>
      {isChain && (
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-label uppercase text-draft">
            {chain.docs.length} turns: {chain.docs.map((d) => ROLE_LABEL[d.role]).join(' → ')}
          </p>
          {onRejectChain && chain.chainId && (
            <button
              onClick={() => onRejectChain(chain.chainId!)}
              className="font-ui text-meta text-ink-3 hover:text-ink-1"
            >
              Not one chain
            </button>
          )}
        </div>
      )}
      <div className="space-y-2">
        {chain.docs.map((document) => (
          <DocumentRow
            key={document.id}
            document={document}
            onSetRole={onSetRole}
            onRemoveDocument={onRemoveDocument}
          />
        ))}
      </div>
    </div>
  );
}

interface DocumentRowProps {
  document: PrecedentDocument;
  onSetRole: (document: PrecedentDocument, role: PrecedentRole) => void;
  onRemoveDocument?: (document: PrecedentDocument) => void;
}

function DocumentRow({ document, onSetRole, onRemoveDocument }: DocumentRowProps) {
  const isAmbiguous = document.role === 'unknown';

  return (
    <div className="border border-rule rounded-card p-3 bg-card space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-ui text-ui text-ink-1">{document.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          <RoleChip role={document.role} inferred={document.roleInferred} />
          {onRemoveDocument && (
            <button
              onClick={() => onRemoveDocument(document)}
              aria-label={`Remove ${document.name}`}
              className="font-ui text-meta text-ink-3 hover:text-ink-1"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {isAmbiguous ? (
        <div className="space-y-1">
          <p className="font-ui text-ui text-risk-med">
            What is this? We could not tell from the filename or its content.
          </p>
          <div className="flex flex-wrap gap-2">
            {ROLE_CHOICES.map((role) => (
              <button
                key={role}
                onClick={() => onSetRole(document, role)}
                className="font-ui text-ui-sm px-2 py-1 rounded-control bg-chip-fill hover:bg-rule text-ink-1"
              >
                {ROLE_LABEL[role]}
              </button>
            ))}
          </div>
        </div>
      ) : document.roleInferred ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-ui text-meta text-ink-3">Proposed from the filename &mdash; not yet confirmed.</p>
          <button
            onClick={() => onSetRole(document, document.role)}
            className="font-ui text-ui-sm font-semibold text-accent hover:text-accent-strong"
          >
            Confirm
          </button>
          {ROLE_CHOICES.filter((r) => r !== document.role).map((role) => (
            <button
              key={role}
              onClick={() => onSetRole(document, role)}
              className="font-ui text-meta text-ink-3 hover:text-ink-1"
            >
              It&apos;s actually {ROLE_LABEL[role]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RoleChip({ role, inferred }: { role: PrecedentRole; inferred: boolean }) {
  const base = 'font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border whitespace-nowrap';
  if (role === 'unknown') {
    return <span className={`${base} bg-risk-med-tint border-risk-med-edge text-risk-med`}>Ambiguous</span>;
  }
  // Confirmed (not inferred) is ACCENT — a person settled this, or it was
  // read unambiguously. Proposed-but-unconfirmed is the plain neutral chip
  // fill. The two must never converge (R-F4): a reader glancing at this chip
  // is the only thing standing between "proposed" and "asserted as fact."
  const confirmedClass = inferred
    ? 'bg-chip-fill border-rule text-ink-3'
    : 'bg-accent-tint border-accent-edge text-accent';
  return (
    <span className={`${base} ${confirmedClass}`}>
      {ROLE_LABEL[role]}
      {inferred ? ' (proposed)' : ''}
    </span>
  );
}
