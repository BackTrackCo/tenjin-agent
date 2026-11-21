import { expect, it } from 'vitest';
import { claudeWorkerSandboxCompatible } from './claude-worker-sandbox';

it('keeps Windows native because its sandbox omits workspace-only shell read denies', () => {
  expect(claudeWorkerSandboxCompatible(['/repo'], { effective: {} }, 'win32')).toBe(false);
});

it.each(['darwin', 'linux'] as const)(
  'retains the qualified native read boundary on %s with ordinary settings',
  (platform) => {
    expect(claudeWorkerSandboxCompatible(['/client archive'], { effective: {} }, platform)).toBe(
      true,
    );
  },
);
