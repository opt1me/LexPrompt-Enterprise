import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Matter, PlaybookVersion, Review } from '../types';

const listVersionsMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();

vi.mock('./db/playbookVersions', () => ({
  listVersions: (...args: unknown[]) => listVersionsMock(...args),
}));
vi.mock('./db/matters', () => ({
  listMatters: (...args: unknown[]) => listMattersMock(...args),
}));
vi.mock('./db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
}));

const { scanPlaybookAcrossMatters } = await import('./playbookScan');

function matter(id: string): Matter {
  return { id, name: id, ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function version(id: string, playbookId: string): PlaybookVersion {
  return {
    id, playbookId, version: 1, name: 'v', contractType: 'c',
    systemPrompt: 's', formatPrompt: 'f', clauses: [], changeSummary: '',
    publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 1,
  };
}

function review(id: string, matterId: string): Review {
  return {
    id, matterId, startedAt: 1, findings: {},
    templateSnapshot: { playbookId: 'p1', name: 'n', systemPrompt: 's', formatPrompt: 'f', clauses: [] },
  } as unknown as Review;
}

describe('scanPlaybookAcrossMatters', () => {
  beforeEach(() => {
    listVersionsMock.mockReset();
    listMattersMock.mockReset();
    listReviewsMock.mockReset();
  });

  it('reads a playbook\'s versions and every matter\'s reviews, in matter order', async () => {
    listVersionsMock.mockResolvedValue([version('v1', 'p1')]);
    listMattersMock.mockResolvedValue([matter('m1'), matter('m2')]);
    listReviewsMock.mockImplementation(async (matterId: string) =>
      matterId === 'm1' ? [review('r1', 'm1')] : [review('r2', 'm2')]);

    const scan = await scanPlaybookAcrossMatters('p1');

    expect(scan.versions.map(v => v.id)).toEqual(['v1']);
    expect(scan.matters.map(m => m.id)).toEqual(['m1', 'm2']);
    // Parallel to `matters` — this is the contract `loadVersionHistory` and
    // `loadPositionHealth` both depend on to line reviews back up with the
    // matter that ran them.
    expect(scan.reviewsByMatter.map(rs => rs.map(r => r.id))).toEqual([['r1'], ['r2']]);
    expect(listVersionsMock).toHaveBeenCalledWith('p1');
    expect(listReviewsMock).toHaveBeenCalledWith('m1');
    expect(listReviewsMock).toHaveBeenCalledWith('m2');
  });

  it('propagates a failure from any of the three reads, rather than swallowing it', async () => {
    // D3's docstring is explicit that this function does NOT catch — each
    // caller owns its own error state. Breaking that (a stray try/catch
    // that resolved to `{ versions: [], matters: [], reviewsByMatter: [] }`
    // instead of rejecting) is exactly the "empty" vs "broken" confusion
    // CLAUDE.md exists to prevent, and this test would fail against it.
    listVersionsMock.mockRejectedValue(new Error('boom'));
    listMattersMock.mockResolvedValue([]);
    listReviewsMock.mockResolvedValue([]);
    await expect(scanPlaybookAcrossMatters('p1')).rejects.toThrow('boom');
  });
});
