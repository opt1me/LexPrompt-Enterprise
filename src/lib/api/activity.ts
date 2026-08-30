import type { MatterActivityPage, ActivityRow } from '@lexprompt/core';
import { apiGet } from './client';

/**
 * WHAT HAPPENED IN THIS MATTER, from the records that hold it.
 *
 * REJECTS on any failure and never resolves to an empty feed. "Nothing has
 * happened in this matter" and "the feed could not be read" render
 * identically once the second has been flattened into the first, and what
 * they render as is a matter that looks untouched.
 */
export async function getMatterActivity(
  matterId: string, limit?: number,
): Promise<ActivityRow[]> {
  const suffix = limit === undefined ? '' : `?limit=${limit}`;
  const page = await apiGet<MatterActivityPage>(
    `/v1/matters/${encodeURIComponent(matterId)}/activity${suffix}`);
  return page.rows ?? [];
}
