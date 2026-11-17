/**
 * HOW CLOSE A TYPED NAME IS TO A NAME: the matching behind `tenjin config`'s
 * names, its "Did you mean" and `tenjin config names <word>`. Pure and
 * dependency-free, so the CLI's command table can use it without loading the
 * router; the catalog it matches is a few hundred names.
 */

/** A name and the id it stands for. */
export interface Named {
  id: string;
  label: string;
}

/**
 * A NAME WITH ITS FORMATTING SET ASIDE: one case, and no spaces, hyphens or
 * punctuation, so "Fire crawl", "fire-crawl" and "firecrawl" are one name.
 * Two names equal here are the same name, not a guess at one.
 */
export const normalised = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** The words of a name, in one case. */
const wordsOf = (text: string): string[] =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/** Edits between two strings, a swap of neighbours counting as one. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** How alike two strings are by edits, from 0 to 1. */
function alike(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

/** A typed word and a word of a name: one starts the other, or a typo apart. */
function wordMatches(typed: string, word: string): boolean {
  if (word.startsWith(typed) || (word.length >= 3 && typed.startsWith(word))) return true;
  return Math.min(typed.length, word.length) >= 4 && alike(typed, word) >= 0.75;
}

/**
 * HOW CLOSE A TYPED NAME IS TO ONE NAME, FROM 0 TO 1: 1 for the same name
 * once formatting is set aside; otherwise the best of one inside the other,
 * every typed word found in it (in any order, a typo allowed), and a few
 * edits apart. No new dependency: the catalog is a few hundred names.
 */
export function closeness(typed: string, name: string): number {
  const want = normalised(typed);
  const have = normalised(name);
  if (want.length === 0 || have.length === 0) return 0;
  if (want === have) return 1;
  let score = alike(want, have);
  if (have.includes(want)) score = Math.max(score, 0.7 + 0.25 * (want.length / have.length));
  else if (have.length >= 3 && want.includes(have))
    score = Math.max(score, 0.7 + 0.25 * (have.length / want.length));
  const typedWords = wordsOf(typed);
  const words = wordsOf(name);
  if (typedWords.every((typedWord) => words.some((word) => wordMatches(typedWord, word)))) {
    const used = words.filter((word) =>
      typedWords.some((typedWord) => wordMatches(typedWord, word)),
    );
    score = Math.max(score, 0.7 + 0.25 * (used.length / words.length));
  }
  return score;
}

/** How close a typed name is to an entry, by its id or its label. */
export const closenessTo = (typed: string, { id, label }: Named): number =>
  Math.max(closeness(typed, id), closeness(typed, label));

/** What `tenjin config names <word>` lists: a name this close to the word. */
export const SEARCH_CLOSENESS = 0.7;

/** What a "Did you mean" suggests: a name at least this close, and near the closest. */
const SUGGEST_CLOSENESS = 0.6;
const SUGGEST_MARGIN = 0.15;
const MAX_SUGGESTIONS = 3;

/** The few names closest to a typed one, closest first: a "Did you mean". */
export function closestNames(entries: readonly Named[], typed: string): Named[] {
  const scored = entries
    .map((entry) => ({ entry, score: closenessTo(typed, entry) }))
    .filter(({ score }) => score >= SUGGEST_CLOSENESS)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return scored
    .filter(({ score }) => score >= best - SUGGEST_MARGIN)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => entry);
}
