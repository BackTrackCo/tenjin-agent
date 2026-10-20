import { mock } from 'claude-code/testing';
import type { On } from 'claude-code';
import type { MockClock, Mounted } from 'claude-code/testing';

/** Every body that draws runs on both surfaces the mod draws on. */
export const SURFACES = ['terminal', 'desktop'] as const;

export const NOW = Date.parse('2026-10-04T00:53:43.000Z');
export const DATA = '/home/test/.tenjin';
export const TOOL = 'mcp__plugin_tenjin_router__request';
export const ADDRESS = '0x5c6eA1b2C3d4E5f60718293a4B5c6D7e8F90B7ff';

/** What no user surface may carry: the rail, a URL, or JSON. */
export const MODEL_TEXT = /x402|http|[{}]/;

/**
 * A machine with the CLI's data dir in memory: `HOME`, a clock at {@link NOW},
 * and `$.fs.read` answered from `files`, a missing path rejecting as the real
 * one does. Toasts and transcript lines land in `toasts` and `logs`.
 */
export function machine(
  on: On,
  store: Record<string, unknown> = {},
): { files: Map<string, string>; clock: MockClock; toasts: string[]; logs: string[] } {
  const files = new Map<string, string>();
  const toasts: string[] = [];
  const logs: string[] = [];
  mock.env(on, { HOME: '/home/test' });
  mock.store(on, store);
  const clock = mock.clock(on, { now: NOW });
  on('fs.read', (_$, e) => {
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  // Beneath every plugin these hooks stand for the engine's own drawing.
  on('ui.toast', (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('ui.log', (_$, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  return { files, clock, toasts, logs };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An offer's spec as the hook keeps it, its model-facing text included. */
export async function keepSpec(
  files: Map<string, string>,
  id: string,
  spec: Record<string, unknown>,
  shownField: string | null = 'query',
): Promise<void> {
  // The CLI's record of the one input a row may show (`specs.ts` `storeSpecs`).
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(id)}.shown.json`,
    JSON.stringify({ version: 1, field: shownField }),
  );
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(id)}.json`,
    JSON.stringify({
      id,
      provider: 'Exa',
      description: 'Searches the web through an x402 endpoint at https://api.exa.ai/search',
      priceVaries: false,
      payTo: '0xC751344Ee09B5159160173F77D4a1169bCd386A1',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      request: { method: 'POST', url: 'https://api.exa.ai/search', fields: {}, location: 'body' },
      input: {},
      pinned: {},
      ...spec,
    }),
  );
}

/** What the request tool leaves when it pays: the spec's payment record and a ledger row. */
export async function recordPayment(
  files: Map<string, string>,
  id: string,
  row: {
    capabilityId: string;
    amountAtomic: string;
    txHash: string;
    settlement?: 'settled' | 'unknown';
  },
): Promise<void> {
  const at = new Date(NOW).toISOString();
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(id)}.paid.json`,
    JSON.stringify({ state: 'paid', at, amountAtomic: row.amountAtomic, txHash: row.txHash }),
  );
  const ledger = `${DATA}/paid/ledger.jsonl`;
  const line = JSON.stringify({
    version: 1,
    ts: at,
    provider: 'Exa',
    url: 'https://api.exa.ai/search',
    sent: '{"query":"rust async runtimes"}',
    settlement: 'settled',
    savedFiles: [],
    ...row,
  });
  files.set(ledger, `${files.get(ledger) ?? ''}${line}\n`);
}

/** The request tool's result as the model reads it: summary, then envelope. */
export function resultText(status: string): string {
  return `Fulfilled by api.exa.ai · provider price 0.007 USD${JSON.stringify({
    status,
    supplier: 'api.exa.ai',
    cost: ['provider: $0.007'],
    result: 'Tokio, async-std, smol',
    providerContentUntrusted: true,
  })}`;
}

/** A wallet on disk, the install's marker when it made it, and its last balance read. */
export function wallet(
  files: Map<string, string>,
  opts: { created?: boolean; balanceAtomic?: string; maxAutoSpend?: string } = {},
): void {
  files.set(`${DATA}/wallet.json`, JSON.stringify({ schemaVersion: 2, address: ADDRESS }));
  if (opts.created === true) {
    files.set(
      `${DATA}/wallet-created.json`,
      JSON.stringify({ version: 1, address: ADDRESS, at: new Date(NOW).toISOString() }),
    );
  }
  if (opts.balanceAtomic !== undefined) {
    files.set(
      `${DATA}/balance.json`,
      JSON.stringify({
        version: 1,
        address: ADDRESS.toLowerCase(),
        atomic: opts.balanceAtomic,
        at: NOW,
      }),
    );
  }
  if (opts.maxAutoSpend !== undefined) {
    files.set(`${DATA}/config.json`, JSON.stringify({ maxAutoSpend: opts.maxAutoSpend }));
  }
}

/** Every line a drawing shows, in order. */
export async function shownLines(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map((text) => text.text);
}

/** A one-line row as the person reads it: the dot's gutter, then its pieces. */
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
export function toolRow(toolUseId: string, tool: string, input: unknown) {
  return {
    tool_use_id: toolUseId,
    tool,
    input,
    isRunning: true,
    isErrored: false,
    isInterrupted: false,
  };
}

/** A choice set as the CLI keeps it beside the line's id: each option's key and own offer id. */
export async function keepChoices(
  files: Map<string, string>,
  id: string,
  options: { key: string; id: string; label: string }[],
): Promise<void> {
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(id)}.choices.json`,
    JSON.stringify({
      choices: {
        group: 'image model',
        default: options[0]!.key,
        input: ['prompt'],
        options: options.map((option) => ({ ...option, strength: 'fast' })),
        all: { totalAtomic: '0' },
      },
      hint: 'Pick an image model: https://example.test',
    }),
  );
}
