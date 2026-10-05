import { mock } from 'claude-code/testing';
import type { On } from 'claude-code';
import type { MockClock, Mounted } from 'claude-code/testing';

/** Every body that draws runs on both surfaces the mod draws on. */
export const SURFACES = ['terminal', 'desktop'] as const;

export const NOW = Date.parse('2026-10-04T00:53:43.000Z');
export const DATA = '/home/test/.tenjin';
export const TOOL = 'mcp__x402__request';

/** What no user surface may carry: the rail, a URL, or JSON. */
export const MODEL_TEXT = /x402|http|[{}]/;

/**
 * A machine with the CLI's data dir in memory: `HOME`, a clock at {@link NOW},
 * and `$.fs.read` answered from `files`, a missing path rejecting as the real
 * one does.
 */
export function machine(on: On): { files: Map<string, string>; clock: MockClock } {
  const files = new Map<string, string>();
  mock.env(on, { HOME: '/home/test' });
  const clock = mock.clock(on, { now: NOW });
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

/** An offer's spec as the hook keeps it, its model-facing text included. */
export async function keepSpec(
  files: Map<string, string>,
  id: string,
  spec: Record<string, unknown>,
): Promise<void> {
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(id)}.json`,
    JSON.stringify({
      id,
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
    provider: string;
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

/** Every line a drawing shows, in order. */
export async function shownLines(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map((text) => text.text);
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
