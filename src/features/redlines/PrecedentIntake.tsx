import React, { useMemo } from 'react';
import { Button } from '../../components/Button';
import type { PrecedentDocument, PrecedentRole } from '../../lib/chains';

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
    <div className="p-6 max-w-5xl mx-auto space-y-6 bg-[#09090b]">
      <header>
        <h2 className="text-xl font-bold text-white">Bring in what you negotiated</h2>
        <p className="text-xs text-gray-500 mt-1">
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
        <p className="text-xs text-gray-600 mt-1">
          Read once to learn from. Not stored with the playbook.
        </p>
      </header>

      {unreadable.length > 0 && (
        <div className="space-y-2">
          {unreadable.map((doc, i) => (
            <div
              key={doc.id ?? `${doc.name}-${i}`}
              className="flex flex-wrap items-center justify-between gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3"
            >
              <p className="text-sm text-amber-200">
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
          <p className="text-sm text-gray-500 italic">No documents brought in yet.</p>
        )}
      </div>

      {onContinue && (
        <div className="flex flex-col items-end gap-2 pt-4 border-t border-white/10">
          {hasAmbiguousRole && (
            <p className="text-xs text-amber-300">Say what each document is before continuing.</p>
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
    <div className={isChain ? 'border border-violet-500/30 rounded-xl p-3 bg-violet-500/5 space-y-3' : 'space-y-3'}>
      {isChain && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-violet-300 uppercase tracking-wide">
            {chain.docs.length} turns: {chain.docs.map((d) => ROLE_LABEL[d.role]).join(' → ')}
          </p>
          {onRejectChain && chain.chainId && (
            <button
              onClick={() => onRejectChain(chain.chainId!)}
              className="text-[11px] text-gray-500 hover:text-gray-300"
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
    <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-200">{document.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          <RoleChip role={document.role} inferred={document.roleInferred} />
          {onRemoveDocument && (
            <button
              onClick={() => onRemoveDocument(document)}
              aria-label={`Remove ${document.name}`}
              className="text-gray-500 hover:text-gray-300 text-xs"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {isAmbiguous ? (
        <div className="space-y-1">
          <p className="text-xs text-amber-300">
            What is this? We could not tell from the filename or its content.
          </p>
          <div className="flex flex-wrap gap-2">
            {ROLE_CHOICES.map((role) => (
              <button
                key={role}
                onClick={() => onSetRole(document, role)}
                className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-gray-200"
              >
                {ROLE_LABEL[role]}
              </button>
            ))}
          </div>
        </div>
      ) : document.roleInferred ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[11px] text-gray-500">Proposed from the filename &mdash; not yet confirmed.</p>
          <button
            onClick={() => onSetRole(document, document.role)}
            className="text-xs font-semibold text-violet-300 hover:text-violet-200"
          >
            Confirm
          </button>
          {ROLE_CHOICES.filter((r) => r !== document.role).map((role) => (
            <button
              key={role}
              onClick={() => onSetRole(document, role)}
              className="text-xs text-gray-500 hover:text-gray-300"
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
  const base = 'text-[10px] font-bold uppercase px-2 py-1 rounded border whitespace-nowrap';
  if (role === 'unknown') {
    return <span className={`${base} bg-amber-500/15 border-amber-500/30 text-amber-300`}>Ambiguous</span>;
  }
  const confirmedClass = inferred
    ? 'bg-white/10 border-white/20 text-gray-300'
    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300';
  return (
    <span className={`${base} ${confirmedClass}`}>
      {ROLE_LABEL[role]}
      {inferred ? ' (proposed)' : ''}
    </span>
  );
}
