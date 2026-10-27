import { mock } from 'claude-code/testing';
import type { On } from 'claude-code';
import type { MockClock, Mounted } from 'claude-code/testing';

/** Every body that draws runs on both surfaces the mod draws on. */
export const SURFACES = ['terminal', 'desktop'] as const;

export const NOW = Date.parse('2026-10-04T00:53:43.000Z');
export const DATA = '/home/test/.tenjin';
export const TOOL = 'mcp__plugin_tenjin_router__request';
export const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
export const SESSION = 'sess-test';

/** What no user surface may carry: the rail, a URL, or JSON. */
export const MODEL_TEXT = /x402|http|[{}]/;

/** A machine with the CLI's data dir in memory, `$.fs.read` answered from `files`. */
export function machine(on: On): { files: Map<string, string>; clock: MockClock } {
  const files = new Map<string, string>();
  mock.env(on, { HOME: '/home/test' });
  const clock = mock.clock(on, { now: NOW });
  on('session.id', () => ({ value: SESSION }));
  on('fs.read', (_$, e) => {
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  return { files, clock };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An offer's spec as `storeSpecs` keeps it, `shown` beside it. */
export async function keepSpec(
  files: Map<string, string>,
  id: string,
  spec: Record<string, unknown>,
  shown: string | null = 'query',
): Promise<void> {
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(id)}.json`,
    JSON.stringify({
      id,
      provider: 'Exa',
      description: 'Searches the web through an x402 endpoint at https://api.exa.ai/search',
      priceVaries: false,
      request: { method: 'POST', url: 'https://api.exa.ai/search', fields: {}, location: 'body' },
      input: {},
      pinned: {},
      ...spec,
      shown,
    }),
  );
}

/** The offer record the pre-call hook writes for a native call it held (`markOffered`). */
export async function keepOffer(
  files: Map<string, string>,
  sessionId: string,
  toolUseId: string,
  label = 'Exa search',
): Promise<void> {
  files.set(
    `${DATA}/progress/${await sha256Hex(sessionId)}/offer-${await sha256Hex(toolUseId)}.json`,
    JSON.stringify({ version: 1, at: NOW, offerId: OFFER, label, priceAtomic: '7000' }),
  );
}

/** The offer record the prompt hook writes for an offer it made on `prompt`. */
export async function keepPromptOffer(
  files: Map<string, string>,
  prompt: string,
  record: Record<string, unknown> = {},
): Promise<void> {
  files.set(
    `${DATA}/progress/${await sha256Hex(SESSION)}/offer-${await sha256Hex(`prompt:${prompt}`)}.json`,
    JSON.stringify({
      version: 1,
      at: NOW,
      offerId: OFFER,
      label: 'Exa search',
      priceAtomic: '40000',
      ...record,
    }),
  );
}

/** An envelope with `status` first, as `JSON.stringify` writes the CLI's. */
export function envelope(status: string, rest: Record<string, unknown> = {}): string {
  return `summary line${JSON.stringify({ status, supplier: 'api.exa.ai', ...rest })}`;
}

/** Every line a drawing shows, in order. */
export async function shownLines(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map((text) => text.text);
}

/** A one-line row as the person reads it. */
export async function rowText(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  return (await shownLines(ui)).join('').replace(/^⏺/, '⏺ ');
}

/** The row's status dot: its color, or dim while the call runs. */
export async function dotOf(
  ui: Pick<Mounted, 'findAll'>,
): Promise<{ color?: unknown; dimColor?: unknown } | undefined> {
  const [dot] = await ui.findAll({ type: 'Text', text: '⏺' });
  return dot === undefined ? undefined : { color: dot.props.color, dimColor: dot.props.dimColor };
}

/** A tool row's props, as the engine hands them to `ui.render`. */
export function toolRow(toolUseId: string, tool: string, input: unknown, output?: string) {
  return {
    tool_use_id: toolUseId,
    tool,
    input,
    isRunning: output === undefined,
    isErrored: false,
    isInterrupted: false,
    ...(output !== undefined ? { output } : {}),
  };
}
