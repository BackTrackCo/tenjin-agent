/**
 * Deterministic markdown structure helpers for library delivery: the default buy
 * output carries an outline instead of the body (agent transcripts stay small),
 * and `--sections <budget>` selects leading sections within a token budget. No
 * model calls, no scoring: heading split plus document order is the whole
 * algorithm, so identical input always yields identical output.
 */

export interface MarkdownSection {
  /** Heading text without the leading #s; null for preamble before any heading. */
  heading: string | null;
  level: number;
  body: string;
  estimatedTokens: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** The server's own heuristic: ceil(words x 1.33). A display hint, never a boundary. */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(words * 1.33);
}

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

  for (const line of bodyMd.split('\n')) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const match = inFence ? null : line.match(HEADING_RE);
    if (match !== null) {
      push();
      heading = (match[2] as string).trim();
      level = (match[1] as string).length;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  push();
  return sections;
}

/** Heading outline, `##`-indented, for the default (bodyless) buy output. */
export function outline(bodyMd: string): string[] {
  return splitSections(bodyMd)
    .filter((s) => s.heading !== null)
    .map((s) => `${'#'.repeat(s.level)} ${s.heading as string}`);
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
