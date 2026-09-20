#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { renderProgress } from './progress';

// A small standalone bundle: a one-second footer refresh never loads Jev,
// MCP, the wallet, or the payment runtime, and never reads the env file.
try {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  if (!values.config) throw new Error('Missing config');
  const config = JSON.parse(await readFile(values.config, 'utf8')) as { stateDir?: unknown };
  if (typeof config.stateDir !== 'string') throw new Error('Missing state directory');
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 64_000) throw new Error('Status input too large');
  }
  const input = JSON.parse(raw) as { session_id?: unknown };
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 200)
    throw new Error('Missing session identity');
  process.stdout.write(
    `${await renderProgress({ stateDir: config.stateDir }, input.session_id, {
      columns: Number(process.env.COLUMNS),
    })}\n`,
  );
} catch {
  process.stdout.write('x402 · activity unavailable\n');
}
