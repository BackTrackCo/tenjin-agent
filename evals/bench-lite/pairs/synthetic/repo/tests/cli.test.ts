import { beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import type { CliIo } from '../src/cli.ts';
import { resetWorld, seedAccount } from '../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

function recorder(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe('runCli', () => {
  it('prints usage with no command', async () => {
    const { io, out } = recorder();
    expect(await runCli([], io)).toBe(1);
    expect(out.join('\n')).toContain('ledger <command>');
  });

  it('creates an account', async () => {
    const { io, out } = recorder();
    expect(await runCli(['create', 'Acme', 'scale'], io)).toBe(0);
    expect(out[0]).toMatch(/^acc_[0-9a-f]{10}\tAcme\tscale$/);
  });

  it('refuses an unknown plan', async () => {
    const { io, err } = recorder();
    expect(await runCli(['create', 'Acme', 'enterprise'], io)).toBe(2);
    expect(err[0]).toContain('usage: ledger create');
  });

  it('posts an entry and prints the balance', async () => {
    const account = seedAccount('starter');
    const { io, out } = recorder();
    expect(await runCli(['post', account.id, '1000', 'credit'], io)).toBe(0);
    expect(out[0]).toContain('fee 10');

    const second = recorder();
    expect(await runCli(['balance', account.id], second.io)).toBe(0);
    expect(second.out[0]).toBe('990 USD over 1 entries');
  });

  it('turns a domain error into exit 1', async () => {
    const { io, err } = recorder();
    expect(await runCli(['balance', 'acc_nope'], io)).toBe(1);
    expect(err[0]).toContain('account_not_found');
  });

  it('prints a summary', async () => {
    const account = seedAccount('standard', 'Summary Co');
    const { io, out } = recorder();
    expect(await runCli(['summary', account.id], io)).toBe(0);
    expect(out[0]).toContain('Summary Co');
    expect(out.join('\n')).toContain('limit     250000');
  });

  it('sweeps', async () => {
    const account = seedAccount('standard');
    await runCli(['post', account.id, '500', 'debit'], recorder().io);
    const { io, out } = recorder();
    expect(await runCli(['sweep'], io)).toBe(0);
    expect(out.at(-1)).toBe('scanned 1, settled 1, failed 0');
  });

  it('prints the effective config', async () => {
    const { io, out } = recorder();
    expect(await runCli(['config'], io)).toBe(0);
    expect(out).toContain('currency=USD');
  });
});
