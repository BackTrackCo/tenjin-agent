import { describe, expect, it } from 'vitest';
import { channelTag, resolveTarget } from './lib/update-check';

// Mounted as src/bench3-independent.test.ts only in the verifier image.
// These synthetic version tables specify the requested release policy.
describe('the promoted release controls updates', () => {
  it.each(['3.7.0-alpha.4', '3.7.0', '0.8.0-alpha.12'])(
    'follows latest for supported build %s',
    (current) => {
      expect(channelTag(current)).toBe('latest');
      expect(resolveTarget(current, { latest: '3.8.0', alpha: '9.0.0-alpha.3' })).toBe('3.8.0');
    },
  );

  it.each([{}, { alpha: '9.0.0-alpha.3' }, { latest: 'broken', alpha: '9.0.0-alpha.3' }])(
    'does not substitute an unpromoted release when latest is unusable: %j',
    (tags) => {
      expect(resolveTarget('3.7.0-alpha.4', tags)).toBeNull();
    },
  );

  it('refuses unknown current builds and accepts a lower promoted target as policy data', () => {
    expect(channelTag('development')).toBeNull();
    expect(resolveTarget('development', { latest: '3.8.0' })).toBeNull();
    // Resolver policy is separate from the caller deciding whether to install.
    expect(resolveTarget('3.7.0-alpha.4', { latest: '3.6.0', alpha: '3.9.0-alpha.1' })).toBe(
      '3.6.0',
    );
  });
});
