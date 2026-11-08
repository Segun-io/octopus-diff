/**
 * Small subsequence fuzzy matcher for the command palette. Scores prefer matches at word starts,
 * consecutive runs and shorter haystacks; returns null when the query is not a subsequence.
 */
export interface FuzzyMatch {
  score: number;
  /** Indexes of the matched characters in the haystack (for highlighting). */
  positions: number[];
}

export function fuzzyMatch(query: string, haystack: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const h = haystack.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const positions: number[] = [];
  let score = 0;
  let hi = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi] as string;
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    positions.push(found);
    const prev = found === 0 ? ' ' : (h[found - 1] as string);
    const wordStart = found === 0 || /[\s/\-_.:·]/.test(prev);
    score += wordStart ? 10 : 1;
    if (found === lastMatch + 1) score += 6;
    if (found === qi) score += 3; // prefix run
    lastMatch = found;
    hi = found + 1;
  }
  score -= Math.min(20, Math.floor(h.length / 8));
  return { score, positions };
}

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
