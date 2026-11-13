/**
 * Subsequence fuzzy match. Every query character must appear in order. Higher scores for
 * consecutive runs, matches at word starts (after `.`, `_`, space, `-` or a lowercase→uppercase
 * step), and a match at the very start. Returns null when the query does not match.
 */
export interface FuzzyMatch {
  score: number;
  /** Indices of matched characters in the candidate, for highlighting. */
  positions: number[];
}

const isBoundary = (text: string, i: number) =>
  i === 0 || /[._\s\-/]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();

  // Exact substring wins outright, ranked by how early it starts.
  const at = t.indexOf(q);
  if (at >= 0) {
    const positions = Array.from({ length: q.length }, (_, k) => at + k);
    return { score: 1000 - at * 2 + (isBoundary(text, at) ? 50 : 0) - (t.length - q.length) * 0.5, positions };
  }

  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    run = positions.length && found === positions[positions.length - 1] + 1 ? run + 1 : 0;
    score += 10 + run * 15 + (isBoundary(text, found) ? 25 : 0) - Math.min(found - ti, 10);
    positions.push(found);
    ti = found + 1;
  }
  return { score: score - (t.length - q.length) * 0.5, positions };
}

/** Matches and sorts items by score (stable for equal scores). */
export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string, limit = 50): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; order: number }[] = [];
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match, order });
  });
  out.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return out.slice(0, limit).map(({ item, match }) => ({ item, match }));
}
