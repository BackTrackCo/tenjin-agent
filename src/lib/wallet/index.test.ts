import { describe, it, expect } from 'vitest';
import { CliError } from '../errors';
import type { CommandContext } from '../../context';
import { describeWallet, resolveWalletProvider } from './index';
import type { WalletProvider } from './provider';

function makeCtx(dataDir: string): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 10000 },
    dataDir,
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

const stubProvider = (describe: WalletProvider['describe']): WalletProvider => ({
  id: 'stub',
  describe,
  getSigner: async () => {
    throw new Error('unused');
  },
  diagnostics: async () => ({ warnings: [] }),
});

describe('resolveWalletProvider', () => {
  it('returns the injected provider when given one', () => {
    const injected = stubProvider(async () => {
      throw new Error('unused');
    });
    expect(resolveWalletProvider(makeCtx('/tmp/x'), { provider: injected })).toBe(injected);
  });

  it('defaults to the local provider', () => {
    expect(resolveWalletProvider(makeCtx('/tmp/x')).id).toBe('local');
  });
});

describe('describeWallet', () => {
  it('passes a CliError through unchanged', async () => {
    const provider = stubProvider(async () => {
      throw new CliError('WALLET_MISSING', 'no wallet');
    });
    const err = (await describeWallet(provider).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_MISSING');
  });

  it('normalizes a non-CliError rejection to PROVIDER_ERROR', async () => {
    const provider = stubProvider(async () => {
      throw new Error('network down');
    });
    const err = (await describeWallet(provider).catch((e) => e)) as CliError;
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('stub');
    expect(err.fix).toBeDefined();
  });
});
