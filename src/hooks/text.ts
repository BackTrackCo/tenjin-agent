/**
 * The two string bounds every arm and every shared piece uses, in one place.
 *
 * They were four copies of the same control-character regex and two copies of
 * `clean` across `question.ts`, `deliver.ts`, `legs/search.ts` and the arms; a
 * rule about what may leave this machine is worth exactly one implementation.
 *
 * BOTH CUTS ARE SURROGATE-SAFE. `slice` counts UTF-16 units, so a cut that lands
 * between a high and a low surrogate leaves a lone half that the shelf's own
 * `z.string().max(512)` accepts and then embeds as U+FFFD. Space-free text past
 * the bound is the only way to reach it (CJK), which is rare and not a reason to
 * ship a cut that can produce an invalid string.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Control characters out, one space in. This text lands in a model's context. */
export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}

/**
 * The C0 bytes that are never layout. `\t`, `\n` and `\r` are missing on
 * purpose: they are the only ones the reader of a multi-line block needs.
 */
// eslint-disable-next-line no-control-regex
const NON_LAYOUT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The same strip for text that is read as LINES rather than as a query: a
 * shelf body's own breaks and indentation are its layout, and the fence around
 * it is checked line by line, so flattening it would both mangle the piece and
 * hide what the fence is looking for. Everything else in C0 still goes — an
 * escape byte in a stranger's body repaints the terminal it lands in.
 */
export function stripControlKeepingLines(text: string): string {
  return text.replace(NON_LAYOUT_CONTROL_CHARS, ' ');
}

/** Drop a trailing high surrogate a cut left without its pair. */
function whole(text: string): string {
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

/** Strip control characters, trim, and cap. */
export function clean(value: string | undefined, max: number): string {
  return whole(
    stripControl(value ?? '')
      .trim()
      .slice(0, max),
  );
}

/** The same cap at a whole word, for text a shelf will read as a query. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(' ');
  return whole((space > 0 ? head.slice(0, space) : head).trimEnd());
}
