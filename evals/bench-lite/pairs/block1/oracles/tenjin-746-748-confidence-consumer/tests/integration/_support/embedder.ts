// A deterministic stub embedder for the retrieval integration suites, replacing
// OpenAI: chunk texts and queries are mapped to fixed unit vectors so designated
// paraphrase pairs are NEAR (cosine 1) and everything else is FAR (cosine 0),
// which makes dense hits, the cosine floor, RRF fusion and the confidence
// buckets derived from them assertable without a live model.
//
// Shared rather than copied because two suites now assert on the SAME dense
// geometry from opposite ends: lookup-hybrid.test.ts pins where the retrieval
// floor sits, answer.test.ts pins where the confidence gate above it sits. Two
// private copies of `atCosine` would let one drift and quietly turn the other
// suite's "just above the floor" fixture into something else.
//
// Module state (the concept registry) is process-global, so every suite that
// imports this MUST call `reset()` in beforeEach or a vector registered by an
// earlier case leaks into a later one.
import { type EmbeddingProvider } from '@/lib/embeddings';

/** The live model's width, so a stub vector is storable in the same column. */
export const DIM = 1536;

/** A unit vector along one basis dimension. Two texts mapped to the same basis
 *  are cosine-identical; different bases are orthogonal (cosine 0). */
export function basis(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

/** Weighted, normalized blend — used to place a query at a chosen cosine to a card. */
export function mix(parts: [number, number[]][]): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [w, comp] of parts) {
    for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) + w * (comp[i] ?? 0);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Places a text at exactly cosine `t` to basis(0): the two components are orthogonal
 *  unit vectors, so the blend's cosine to basis(0) is its basis(0) weight. Threshold
 *  cases derive `t` from the constant they are probing (DENSE_COSINE_SIMILARITY_FLOOR,
 *  CONFIDENCE_MEDIUM_SIMILARITY) so they follow a retune instead of silently going
 *  slack, which is all deriving buys: being relative, they pass at ANY value of the
 *  constant. The values themselves are pinned in lib/lookup.test.ts and
 *  lib/search-response.test.ts. */
export function atCosine(t: number): number[] {
  return mix([
    [t, basis(0)],
    [Math.sqrt(1 - t * t), basis(9)],
  ]);
}

/** Reserved orthogonal concept for any UNREGISTERED text. Unregistered defaults to
 *  FAR rather than to a near vector on purpose: a fixture has to opt IN to being
 *  dense-findable, so a case that forgot to register something fails as a miss
 *  rather than passing on an accidental hit. */
export const FAR = basis(DIM - 1);

const stubVectors = new Map<string, number[]>();

/** Register `text` at `vec` and return the text, so a case can register and use a
 *  phrase in one expression. */
export function concept(text: string, vec: number[]): string {
  stubVectors.set(text, vec);
  return text;
}

/** The vector `text` is registered at, or undefined. For a fixture that has to
 *  re-register one concept's vector under a second text (a body chunk under the
 *  vector its card question already holds). */
export function conceptVector(text: string): number[] | undefined {
  return stubVectors.get(text);
}

export const stub: EmbeddingProvider = {
  model: 'stub-embed',
  embed: async (texts) => texts.map((t) => stubVectors.get(t) ?? FAR),
};

export const throwingStub: EmbeddingProvider = {
  model: 'stub-embed',
  embed: async () => {
    throw new Error('embedding provider down');
  },
};

/** Drop every registration. Call in beforeEach: the registry is module state and
 *  outlives a case. */
export function reset(): void {
  stubVectors.clear();
}
