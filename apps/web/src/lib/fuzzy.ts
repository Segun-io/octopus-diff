/**
 * Small subsequence fuzzy matcher for the command palette. Scores prefer matches at word starts,
 * consecutive runs and shorter haystacks; returns null when the query is not a subsequence.
 */
import { type FuzzyMatch, fuzzyMatch } from '@octopus-diff/contracts';

// The matcher lives in the contracts (#42) so the daemon's file search ranks like the palette.
export { type FuzzyMatch, fuzzyMatch };

export function rankBy<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  limit = 50,
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}
