import type { Finding, Playbook, PlaybookVersion, Review } from '../../types';

/** One "learn from" source offered on the AI-draft form: an existing
 *  playbook (its current version's clause titles and standard positions) or
 *  a completed matter (its verified findings only). See `buildFewShot`. */
export interface FewShotSource {
  kind: 'playbook' | 'matter';
  id: string;
  name: string;
}

function playbookSection(
  source: FewShotSource,
  playbooks: Playbook[],
  versions: PlaybookVersion[],
): string | undefined {
  const playbook = playbooks.find((p) => p.id === source.id);
  if (!playbook?.currentVersionId) return undefined;
  const version = versions.find((v) => v.id === playbook.currentVersionId);
  if (!version || version.clauses.length === 0) return undefined;

  const lines = version.clauses.map((clause) => {
    const position = clause.standardPosition ? ` — ${clause.standardPosition.text}` : '';
    return `- ${clause.title}${position}`;
  });
  return `From "${source.name}" (existing playbook):\n${lines.join('\n')}`;
}

/** Every finding a completed matter produced that a human has actually
 *  verified. An unverified finding is the model's own output; feeding it
 *  back as house style would launder a guess into a rule. A flagged or
 *  rejected finding is worse — a human looked at it and said it was wrong.
 *  This filter is this function's whole reason to exist, and is the one
 *  named for mutation testing in spec §8/§10. */
function verifiedFindings(reviews: Review[], matterId: string): Finding[] {
  const found: Finding[] = [];
  for (const review of reviews) {
    if (review.matterId !== matterId) continue;
    for (const byClause of Object.values(review.findings)) {
      for (const finding of Object.values(byClause)) {
        if (finding.verification.state === 'verified') found.push(finding);
      }
    }
  }
  return found;
}

function matterSection(source: FewShotSource, reviews: Review[]): string | undefined {
  const summaries = verifiedFindings(reviews, source.id)
    .map((f) => f.summary?.trim())
    .filter((s): s is string => !!s);
  if (summaries.length === 0) return undefined;
  return `From "${source.name}" (completed matter, verified findings only):\n` +
    summaries.map((s) => `- ${s}`).join('\n');
}

/**
 * Style material for the AI-draft generation prompt (spec §5). Built ONLY
 * from `selected` sources — an unselected playbook or matter contributes
 * nothing, however much history exists for it — and, for a matter, from its
 * `verified` findings only (see `verifiedFindings` above). This is spec
 * §10's "quiet privacy question": the only place in this app another
 * matter's content is sent to the model as prompt material, gated entirely
 * on the human having explicitly picked that matter in the form.
 */
export function buildFewShot(
  playbooks: Playbook[],
  versions: PlaybookVersion[],
  reviews: Review[],
  selected: FewShotSource[],
): string {
  const sections = selected
    .map((source) => (source.kind === 'playbook'
      ? playbookSection(source, playbooks, versions)
      : matterSection(source, reviews)))
    .filter((s): s is string => !!s);
  return sections.join('\n\n');
}
