import React from 'react';
import { Wand2, PenTool, GitPullRequest } from 'lucide-react';
import { Modal } from '../../components/Modal';

/** The route chooser (spec §6, "Route chooser"): three parallel routes to a
 *  playbook, not a fork. `learnFromRedlinesAvailable` gates whether the
 *  third route (sub-project F) can actually be entered — but the card is
 *  ALWAYS rendered (R-E6): the handoff frames the three as parallel, and
 *  hiding one until F ships would misrepresent what the product is. A
 *  visible card that silently no-ops on click would be worse than one that
 *  says why it is inert, so the click handler itself is guarded — never
 *  relying on the `disabled` attribute alone to keep `onLearnFromRedlines`
 *  from firing. */
export interface RouteChooserProps {
  onDraftWithAI: () => void;
  onBuildByHand: () => void;
  /** R-E6: rendered, disabled, saying "not built yet" — never hidden. */
  learnFromRedlinesAvailable: boolean;
  onLearnFromRedlines?: () => void;
  onClose: () => void;
}

export function RouteChooser({
  onDraftWithAI,
  onBuildByHand,
  learnFromRedlinesAvailable,
  onLearnFromRedlines,
  onClose,
}: RouteChooserProps) {
  const handleLearnFromRedlines = () => {
    // Guarded here, not just via `disabled`: a disabled button's click can
    // still be simulated in tests and some environments, and the whole
    // point of R-E6 is that this route must not silently fire while it
    // isn't real yet.
    if (!learnFromRedlinesAvailable) return;
    onLearnFromRedlines?.();
  };

  return (
    <Modal isOpen title="Start a new playbook" onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={onDraftWithAI}
          className="text-left p-5 bg-card border border-rule rounded-panel hover:border-accent-edge transition-colors flex flex-col gap-3"
        >
          <Wand2 className="h-5 w-5 text-accent" aria-hidden="true" />
          <div>
            <h4 className="font-ui text-ui font-semibold text-ink-1 mb-1">Draft with AI</h4>
            <p className="font-ui text-meta text-ink-3 leading-relaxed">
              Describe the contract type and let a model propose a first pass, clause by clause.
            </p>
          </div>
        </button>

        <button
          onClick={onBuildByHand}
          className="text-left p-5 bg-card border border-rule rounded-panel hover:border-accent-edge transition-colors flex flex-col gap-3"
        >
          <PenTool className="h-5 w-5 text-ink-2" aria-hidden="true" />
          <div>
            <h4 className="font-ui text-ui font-semibold text-ink-1 mb-1">Build by hand</h4>
            <p className="font-ui text-meta text-ink-3 leading-relaxed">
              Add clauses one at a time, with AI suggestions for individual fields on request.
            </p>
          </div>
        </button>

        <button
          onClick={handleLearnFromRedlines}
          aria-disabled={!learnFromRedlinesAvailable}
          className={`text-left p-5 bg-card border border-rule rounded-panel flex flex-col gap-3 ${
            learnFromRedlinesAvailable
              ? 'hover:border-accent-edge transition-colors'
              : 'opacity-60 cursor-not-allowed'
          }`}
        >
          <GitPullRequest className="h-5 w-5 text-ink-2" aria-hidden="true" />
          <div>
            <h4 className="font-ui text-ui font-semibold text-ink-1 mb-1">Learn from redlines</h4>
            {/* R-G19: this line discloses whether the route actually works,
               so it stays at text-ink-2 rather than the ink-3 the two
               sibling cards' plain descriptions use — never ink-4 or below. */}
            <p className="font-ui text-meta text-ink-2 leading-relaxed">
              {learnFromRedlinesAvailable
                ? 'Infer standard positions from a chain of tracked-changes documents.'
                : 'Infer standard positions from tracked changes. Not built yet.'}
            </p>
          </div>
        </button>
      </div>
    </Modal>
  );
}
