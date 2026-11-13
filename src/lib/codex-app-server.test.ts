import { expect, it } from 'vitest';
import { codexAppServerVersion } from './codex-app-server';
import { isQualifiedCodexModelVersion } from './codex-model-version';

it.each([
  'tenjin/0.163.0 (Mac OS26.5.2;arm64)',
  'Codex Desktop/0.163.0 (Mac OS26.5.2;arm64) dumb (tenjin;1)',
])('recognizes the qualified server version with host originator %s', (agent) => {
  expect(codexAppServerVersion(agent)).toBe('0.163.0');
});

it('preserves the complete qualified Desktop prerelease version', () => {
  const version = codexAppServerVersion('Codex Desktop/0.167.0-alpha.4.1 (Mac OS; arm64)');
  expect(version).toBe('0.167.0-alpha.4.1');
  expect(isQualifiedCodexModelVersion(version)).toBe(true);
});

it.each([
  '0.167.0',
  '0.167.0-alpha.4',
  '0.167.0-alpha.4.2',
  '0.167.0-alpha.4.1-dev',
  '0.163.1',
  '0.163.0+build',
])('keeps an unqualified build native: %s', (version) => {
  expect(isQualifiedCodexModelVersion(version)).toBe(false);
});

it.each([
  'Codex Desktop/0.157.1 (tenjin/0.163.0)',
  'Codex Desktop/0.157.1-dev (tenjin/0.163.0)',
  'Codex Desktop/0.157.1-dev tenjin/0.163.0',
  'Codex Desktop/0.163.0-dev',
  'missing version',
  undefined,
])('does not qualify a mismatched or missing first product version: %s', (agent) => {
  expect(codexAppServerVersion(agent)).not.toBe('0.163.0');
});
