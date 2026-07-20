/**
 * Deterministic markdown structure helpers for delivery output: the heading
 * outline that replaces the body on stdout, and the `--sections` budgeted
 * selection. No model calls, no scoring; identical input always yields
 * identical output. Split from library.ts so filesystem delivery and text
 * shaping stay separate concerns.
 */

export interface Heading {
  level: number;
  text: string;
}

/**
 * Deterministic ATX-heading outline for the stdout summary, never the body, so
 * agent transcripts stay small (spec 10). Skips fenced code blocks so a `#`
 * comment inside a code sample is not mistaken for a heading.
 */
export function headingOutline(bodyMd: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (const line of bodyMd.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      headings.push({ level: m[1].length, text: m[2] });
    }
  }
  return headings;
}

export interface MarkdownSection {
  /** Heading text without the leading #s; null for preamble before any heading. */
  heading: string | null;
  level: number;
  body: string;
  estimatedTokens: number;
}

/** The server's own heuristic: ceil(words x 1.33). A display hint, never a boundary. */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(words * 1.33);
}

/**
 * Deterministic heading-split of the body for `--sections` delivery: no model
 * calls, no scoring; the same input always splits identically. Fenced code
 * blocks are ignored for heading detection, like headingOutline.
 */
export function splitSections(bodyMd: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let heading: string | null = null;
  let level = 0;
  let lines: string[] = [];
  let inFence = false;

  const push = (): void => {
    const body = lines.join('\n').trim();
    if (heading === null && body.length === 0) return;
    sections.push({ heading, level, body, estimatedTokens: estimateTokens(body) });
  };

  for (const line of bodyMd.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      push();
      heading = m[2].trim();
      level = m[1].length;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  push();
  return sections;
}

/**
 * Sections in document order until the budget is spent. The first section always
 * ships even when it alone exceeds the budget, so a tiny budget still returns
 * something rather than an empty selection.
 */
export function selectSections(
  sections: MarkdownSection[],
  budgetTokens: number,
): MarkdownSection[] {
  const selected: MarkdownSection[] = [];
  let spent = 0;
  for (const section of sections) {
    if (selected.length > 0 && spent + section.estimatedTokens > budgetTokens) break;
    selected.push(section);
    spent += section.estimatedTokens;
    if (spent >= budgetTokens) break;
  }
  return selected;
}
