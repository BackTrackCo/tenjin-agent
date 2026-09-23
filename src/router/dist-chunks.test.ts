import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The hook handlers run on EVERY prompt and every native search, so their boot
 * cost is the product's floor. tsup splits each dynamic-import boundary into its
 * own chunk for exactly this reason, and this asserts the result: nothing in the
 * chunk graph a hook loads comes from the wallet, `ox`, `viem`, the x402 SDK or
 * the MCP SDK.
 *
 * It reads `dist`, so it needs a build. Without one it SKIPS rather than
 * passing: a green assertion over a directory that is not there would be the
 * one failure mode this test exists to catch.
 */

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

const FORBIDDEN = [
  { label: 'viem', re: /[/\\]viem@/ },
  { label: 'ox', re: /[/\\]ox@/ },
  { label: 'the x402 SDK', re: /@x402[/\\+]/ },
  { label: 'the MCP SDK', re: /@modelcontextprotocol/ },
  { label: 'the wallet', re: /src[/\\]lib[/\\]wallet[/\\]/ },
  { label: 'the payment builder', re: /src[/\\]lib[/\\]x402-pay/ },
];

function importsOf(file: string): string[] {
  const code = readFileSync(join(dist, file), 'utf8');
  return [...code.matchAll(/from\s*['"]\.\/([A-Za-z0-9_.-]+\.js)['"]/g)].map((m) => m[1]!);
}

function sourcesOf(file: string): string[] {
  const map = join(dist, `${file}.map`);
  if (!existsSync(map)) return [];
  const parsed = JSON.parse(readFileSync(map, 'utf8')) as { sources?: string[] };
  return parsed.sources ?? [];
}

/** Every chunk reachable from `entry`, itself included. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return [...seen];
}

function chunkContaining(source: string): string | undefined {
  return readdirSync(dist)
    .filter((name) => name.endsWith('.js'))
    .find((name) => sourcesOf(name).some((s) => s.includes(source)));
}

describe.skipIf(!existsSync(dist))('the hook chunk graph', () => {
  it('pulls in no wallet, ox, viem, x402 or MCP chunk', () => {
    const entry = chunkContaining('router/hook-command');
    expect(entry, 'the hook command should have its own chunk').toBeDefined();
    const sources = closure(entry!).flatMap(sourcesOf);
    for (const { label, re } of FORBIDDEN) {
      expect(
        sources.filter((s) => re.test(s)),
        `${label} reached the hook graph`,
      ).toEqual([]);
    }
  });

  it('keeps the redaction corpus out of the status line, which runs every second', () => {
    const entry = chunkContaining('router/status-line');
    expect(entry, 'the status line should have its own chunk').toBeDefined();
    const sources = closure(entry!).flatMap(sourcesOf);
    for (const { label, re } of FORBIDDEN) {
      expect(
        sources.filter((s) => re.test(s)),
        `${label} reached the status line`,
      ).toEqual([]);
    }
    // The rule corpus and the BIP-39 wordlist are a real parse cost, and the
    // renderer needs neither: what it reads was redacted when it was written.
    expect(sources.filter((s) => /src[/\\]lib[/\\]redact/.test(s))).toEqual([]);
  });

  it('keeps the request tool in a chunk of its own, where the wallet is allowed', () => {
    const tool = chunkContaining('router/tool');
    expect(tool, 'the request tool should have its own chunk').toBeDefined();
    expect(tool).not.toBe(chunkContaining('router/hook-command'));
  });
});
