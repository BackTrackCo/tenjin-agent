import { describe, expect, it, vi } from 'vitest';
import { captureCtx } from '../context-test-utils';
import type { WalletOutcome } from '../commands/install-wallet';
import { finishTerminalFunding, fundingOncePerRun, fundStep } from './install-funding';
import { selectOne } from '../lib/clack';

vi.mock('../lib/clack', () => ({
  selectOne: vi.fn(async (options: { initialValue: string }) => options.initialValue),
}));

const wallet: WalletOutcome = {
  status: 'created',
  address: '0x1111111111111111111111111111111111111111',
  signing: { status: 'ready', source: 'file' },
};

async function setup() {
  const funding = await fundStep(wallet, 'unused', {}, 'tenjin wallet fund 5');
  const capture = captureCtx('/unused', { isTTY: true, json: false });
  return {
    ...capture,
    result: {
      data: { nextSteps: [funding!.step], disclosure: ['sharing'], next: 'Start a new session.' },
      humanLines: ['Tenjin is installed.', 'Next: Start a new session.'],
    },
  };
}

describe('installation funding', () => {
  it.each(['blocked', 'unknown', 'key', 'passphrase'] as const)(
    'does not offer funds for a wallet with %s signing access',
    async (mode) => {
      const candidate = { ...wallet, status: 'existing' as const };
      if (mode === 'blocked')
        candidate.signing = {
          status: 'blocked',
          reason: 'passphrase_missing',
          detail: 'No saved passphrase',
          fix: 'Repair the wallet',
        };
      else if (mode === 'unknown')
        candidate.signing = { status: 'unknown', reason: 'check_failed', detail: 'Check failed' };
      else candidate.shellOnly = mode;
      const walletBalance = vi.fn(async () => 0n);
      expect(
        await fundStep(candidate, 'unused', { walletBalance }, 'tenjin wallet fund 5'),
      ).toBeUndefined();
      expect(walletBalance).not.toHaveBeenCalled();
    },
  );

  it('defaults to Not now, so pressing Enter does not open checkout', async () => {
    const { ctx, result } = await setup();
    const fund = vi.fn();
    const out = await finishTerminalFunding(result, ctx, { isInteractive: true, fund });
    expect(selectOne).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'later' }));
    expect(fund).not.toHaveBeenCalled();
    expect(out.humanLines).toEqual([]);
  });

  it('does not ask when stdout is a terminal but stdin is a pipe', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      const { ctx, result, stdout } = await setup();
      const ask = vi.fn();
      const fund = vi.fn();
      expect(await finishTerminalFunding(result, ctx, { ask, fund })).toBe(result);
      expect(ask).not.toHaveBeenCalled();
      expect(fund).not.toHaveBeenCalled();
      expect(stdout()).toBe('');
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it('offers once when both host installers share the same wallet', async () => {
    const once = fundingOncePerRun();
    const claude = await once(wallet, 'unused', {}, 'tenjin wallet fund 5');
    const codex = await once(wallet, 'unused', {}, 'tenjin wallet fund 5');
    expect(claude?.step?.options.map((option) => option.command)).toEqual([
      'tenjin wallet fund 5',
      null,
    ]);
    expect(codex).toBeUndefined();
  });

  it.each(['later', null] as const)(
    'keeps a %s answer quiet after showing successful setup',
    async (answer) => {
      const { ctx, result, stdout } = await setup();
      const fund = vi.fn();
      const out = await finishTerminalFunding(result, ctx, {
        isInteractive: true,
        ask: async () => answer,
        fund,
      });
      expect(stdout()).toContain('Next: Start a new session.');
      expect(fund).not.toHaveBeenCalled();
      expect(out.humanLines).toEqual([]);
      expect(out.data).toEqual(result.data);
    },
  );

  it('opens checkout only after yes and never waits for payment during installation', async () => {
    const { ctx, result, stdout } = await setup();
    const fund = vi.fn(async () => {
      expect(stdout()).toContain('Tenjin is installed.');
      return { data: { funded: false }, humanLines: ['Complete checkout in your browser.'] };
    });
    const out = await finishTerminalFunding(result, ctx, {
      isInteractive: true,
      ask: async () => 'fund',
      fund,
    });
    expect(fund).toHaveBeenCalledWith(ctx, { amountUsd: '5', wait: false, qr: false });
    expect(out.humanLines).toEqual(['Complete checkout in your browser.']);
  });

  it('does not turn --yes into checkout consent', async () => {
    const { ctx, result, stdout } = await setup();
    const ask = vi.fn();
    const fund = vi.fn();
    expect(
      await finishTerminalFunding(result, ctx, { yes: true, isInteractive: true, ask, fund }),
    ).toBe(result);
    expect(ask).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
    expect(stdout()).toBe('');
  });

  it.each([
    { json: true, isTTY: true },
    { json: false, isTTY: false },
  ])('does not prompt or open checkout for machine output %j', async (mode) => {
    const { result } = await setup();
    const { ctx, stdout } = captureCtx('/unused', mode);
    const ask = vi.fn();
    const fund = vi.fn();
    expect(await finishTerminalFunding(result, ctx, { isInteractive: true, ask, fund })).toBe(
      result,
    );
    expect(ask).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
    expect(stdout()).toBe('');
  });

  it('keeps installation and activation successful when checkout fails', async () => {
    const { ctx, result, stdout } = await setup();
    const out = await finishTerminalFunding(result, ctx, {
      isInteractive: true,
      ask: async () => 'fund',
      fund: async () => {
        throw new Error('offline');
      },
    });
    expect(stdout()).toContain('Next: Start a new session.');
    expect(out.humanLines?.join(' ')).toContain('Tenjin remains installed');
    expect(out.humanLines?.join(' ')).toContain('Ask your agent to add funds later');
    expect(out.humanLines?.join(' ')).not.toContain('`tenjin');
    expect(out.data).toEqual(result.data);
  });

  it('does not suggest another payment when an existing balance is unknown', async () => {
    const out = await fundStep(
      { ...wallet, status: 'existing' },
      'unused',
      {
        walletBalance: async () => {
          throw new Error('offline');
        },
      },
      'tenjin wallet fund 5',
    );
    expect(out?.step).toBeUndefined();
    expect(out?.warning).toContain('does not mean you need to add money again');
    expect(out?.warning).toContain('Ask your agent to check your balance later');
  });
});
