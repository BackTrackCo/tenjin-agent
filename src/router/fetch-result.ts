/**
 * WHAT A WEBFETCH RESULT SAYS ABOUT THE PAGE IT READ. WebFetch does not hand
 * back the page: `result` is a small model's answer to the agent's prompt,
 * written from the page's text. So a page that came back as a shell (a
 * JavaScript app's title, a video page's footer) still answers 200 with tens
 * of kilobytes, and the only place that says nothing was there is that
 * answer's own opening.
 *
 * Read deterministically, with no model and no network call, from the opening
 * alone, where the summarizer says what it was given. Every pattern names the
 * WHOLE page as empty or as page furniture only (a title, navigation, a
 * footer) or as needing JavaScript. "The page does not mention X" is the page
 * answering, not a shell, and matches nothing here. Over 682 recorded 2xx
 * WebFetch results these match the eight shells among them and nothing else;
 * `fixtures/harness/claude-WebFetch-results.json` keeps those eight and the
 * near misses a looser rule would take.
 */

/** Where the summarizer says what it was given: its first few sentences. */
const OPENING_CHARS = 600;

/** The page as a whole, as the summarizer refers to it. */
const PAGE = String.raw`(?:web ?page|page|site|content|excerpt)`;
/** "only shows", "contains only", and their kin, in either order. */
const ONLY = String.raw`(?:only (?:shows?|contains?|includes?|consists? of|has|displays?)|(?:shows?|contains?|includes?|consists? of|has|displays?) only)`;
/** Page furniture: what every page has and no page is about. A title counts
 *  alone, not as the first of "the title and abstract". */
const FURNITURE = String.raw`(?:navigation|nav (?:bar|links|menu)|footer|legal links|boilerplate|loading (?:screen|spinner|indicator|message)|title\b(?!\s*(?:,|and\b|&)))`;
/** Within one sentence: no full stop, no line break. */
const SAME_SENTENCE = (max: number): string => String.raw`[^.\n]{0,${max}}?`;

const EMPTY_PAGE_PATTERNS: readonly RegExp[] = [
  // "the web page content provided is empty", "\"Web page content:\" appears to be empty"
  new RegExp(
    String.raw`\b(?:web ?page|page) content\b${SAME_SENTENCE(40)}\b(?:is|was|appears to be|seems to be) (?:entirely |completely )?empty\b`,
    'i',
  ),
  // "I don't see any web page content provided"
  /\b(?:don't|do not|can't|cannot) see any (?:web ?page |page )?content\b/i,
  // "the webpage content provided only shows YouTube's footer navigation",
  // "contains only navigation elements, footer links", "only contains a title"
  new RegExp(
    String.raw`\b${PAGE}\b${SAME_SENTENCE(60)}\b${ONLY}\b${SAME_SENTENCE(80)}\b${FURNITURE}`,
    'i',
  ),
  // "The only information shown is \"Uniswap Interface,\" ... a page title or header"
  new RegExp(
    String.raw`\bthe only (?:information|content|text|thing)s? (?:shown|present|visible|available|provided|included)\b${SAME_SENTENCE(120)}\b${FURNITURE}`,
    'i',
  ),
  // "looks like a shell", "appears to be an empty app shell"
  /\b(?:looks like|appears to be|seems to be|is (?:just|only|merely)) an? (?:(?:empty|javascript|js|html|page|app|application|loading) ){0,2}(?:shell|skeleton)\b/i,
  // A page that needs the JavaScript the fetch did not run: React's own
  // noscript line is "You need to enable JavaScript to run this app."
  /\benable JavaScript\b/i,
  /\bJavaScript (?:is )?(?:required|disabled|must be enabled)\b/i,
  new RegExp(String.raw`\b${PAGE}\b${SAME_SENTENCE(60)}\b(?:requires?|needs?) JavaScript\b`, 'i'),
  // PyPI's script-less fallback: "A required part of this site couldn't load".
  /\b(?:site|page) (?:couldn't|could not) load\b/i,
];

/**
 * True when the summarizer says the page it was given had no main content:
 * empty, only a title, navigation or footer, or a script-rendered shell.
 */
export function readsAsEmptyPage(result: string): boolean {
  const opening = result.slice(0, OPENING_CHARS);
  return EMPTY_PAGE_PATTERNS.some((pattern) => pattern.test(opening));
}

/**
 * The note Claude Code appends as the result's last line when the body was
 * binary: `[Binary content (application/pdf, 2.1MB) also saved to <path>]`.
 */
const SAVED_PDF_RE =
  /\n\[Binary content \(application\/pdf, [^)\n]{1,24}\) also saved to ([^\]\n]+)\]\s*$/;
/** How WebFetch names the file it saved, in `<session id>/tool-results`. */
const SAVED_PDF_NAME_RE = /[\\/]([^\\/]+)[\\/]tool-results[\\/]webfetch-\d+-[a-z0-9]+\.pdf$/i;
const PARENT_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Where WebFetch saved the PDF it fetched, or null. Its summary cannot read a
 * PDF (it is handed the compressed bytes: arxiv.org/pdf/1706.03762 came back
 * as "a corrupted or binary PDF file that I cannot parse"), but the file it
 * saved is whole, and `Read` parses its pages for free.
 *
 * Trusted only as the result's LAST line, only for a file named the way
 * WebFetch names one, and only in this session's own `tool-results`, so a
 * summary quoting a page that says otherwise cannot point the agent at any
 * other file, another session's included.
 */
export function savedPdfOf(result: string, sessionId: string): string | null {
  const path = SAVED_PDF_RE.exec(result)?.[1];
  if (path === undefined || PARENT_SEGMENT_RE.test(path)) return null;
  return SAVED_PDF_NAME_RE.exec(path)?.[1] === sessionId ? path : null;
}
