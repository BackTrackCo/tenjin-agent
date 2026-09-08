import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Codex's hook trust ledger, read-only. Codex 0.153.4 runs a hook entry only
 * once it is trusted, and records that trust in `config.toml` as
 * `[hooks.state."<hooks.json path>:<event_snake>:<group>:<handler>"]` with a
 * `trusted_hash` of the entry's normalized identity (codex-rs/hooks/src/lib.rs,
 * engine/discovery.rs at rust-v0.153.4). Trust is granted in the TUI's `/hooks`
 * and nowhere else; this module never writes it, and never computes the hash
 * itself, because the hash is over a projection only Codex's own normalizer
 * spells. What doctor can say honestly is whether a record exists for an
 * entry we wrote, which is separate from whether the harness ever fired it.
 */

export interface TrustRecord {
  trustedHash?: string;
  enabled?: boolean;
}

/** `[hooks.state."<key>"]` section headers; the key is a TOML basic string. */
const SECTION_RE = /^\s*\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*$/;
const ANY_SECTION_RE = /^\s*\[/;
const TRUSTED_HASH_RE = /^\s*trusted_hash\s*=\s*"((?:[^"\\]|\\.)*)"/;
const ENABLED_RE = /^\s*enabled\s*=\s*(true|false)\b/;

function unescapeToml(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}

/** Every `hooks.state` record in a config.toml, keyed as Codex keys them. */
export function parseTrustState(toml: string): Map<string, TrustRecord> {
  const out = new Map<string, TrustRecord>();
  let current: TrustRecord | null = null;
  for (const line of toml.split('\n')) {
    const section = SECTION_RE.exec(line);
    if (section !== null) {
      current = {};
      out.set(unescapeToml(section[1] ?? ''), current);
      continue;
    }
    if (ANY_SECTION_RE.test(line)) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const hash = TRUSTED_HASH_RE.exec(line);
    if (hash !== null) current.trustedHash = unescapeToml(hash[1] ?? '');
    const enabled = ENABLED_RE.exec(line);
    if (enabled !== null) current.enabled = enabled[1] === 'true';
  }
  return out;
}

/** `PreToolUse` -> `pre_tool_use`, the label Codex keys state on. */
export function eventSnake(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** The state key for handler 0 of the entry at `index` under `event` in `hooksPath`. */
export function trustKey(hooksPath: string, event: string, index: number): string {
  return `${hooksPath}:${eventSnake(event)}:${index}:0`;
}

/**
 * Which of our entries carry a trust record. Reads `<codexHome>/config.toml`;
 * an absent or unreadable file is no record for any of them.
 */
export async function trustedEntries(
  codexHome: string,
  hooksPath: string,
  positions: Array<{ event: string; index: number }>,
): Promise<{ trusted: number; untrusted: Array<{ event: string; index: number }> }> {
  let state = new Map<string, TrustRecord>();
  try {
    state = parseTrustState(await readFile(join(codexHome, 'config.toml'), 'utf8'));
  } catch {
    // No config, no trust: reported as such rather than guessed.
  }
  const untrusted: Array<{ event: string; index: number }> = [];
  for (const p of positions) {
    const record = state.get(trustKey(hooksPath, p.event, p.index));
    if (record?.trustedHash === undefined || record.enabled === false) untrusted.push(p);
  }
  return { trusted: positions.length - untrusted.length, untrusted };
}
