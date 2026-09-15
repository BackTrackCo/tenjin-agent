import { afterEach, describe, expect, it } from 'vitest';
import { PRODUCTION_ORIGIN } from '../../lib/production-origin';
import { PRIMER_TEXT, PRIMER_TEXT_TEAM } from '../prose';
import type { KernelConfig } from '../types';
import { primerArm } from './primer';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig } from './test-support';

afterEach(cleanup);

function start(source: string) {
  return hookInput({ event: 'session.start', native: { event: 'SessionStart' }, source });
}

async function spoken(config: KernelConfig, source = 'startup') {
  const ctx = fireContext({ db: freshDb(), arm: primerArm, input: start(source), config });
  return primerArm.after?.(ctx, { reason: 'no-question' }, null);
}

describe('the primer arm', () => {
  it('is a human-wait arm on the session start with no lookup', () => {
    expect(primerArm.on).toEqual([{ event: 'session.start' }]);
    expect(primerArm.wait).toBe('human');
    expect(primerArm.plan).toBeUndefined();
  });

  it('speaks the team paragraph against a team origin and the public one otherwise', async () => {
    expect(await spoken(kernelConfig())).toEqual({ context: PRIMER_TEXT_TEAM });
    expect(await spoken({ ...kernelConfig(), baseUrl: PRODUCTION_ORIGIN })).toEqual({
      context: PRIMER_TEXT,
    });
  });

  it('startup, clear and compact alike', async () => {
    for (const source of ['startup', 'clear', 'compact'])
      expect(await spoken(kernelConfig(), source), source).toEqual({ context: PRIMER_TEXT_TEAM });
  });

  it('`off` is silent', async () => {
    expect(await spoken(kernelConfig({ primer: false }))).toBeNull();
  });
});
