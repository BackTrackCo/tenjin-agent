import { expect, it } from 'vitest';
import { codexAppServerVersion } from './codex-app-server';

it.each([
  'tenjin/0.163.0 (Mac OS26.5.2;arm64)',
  'Codex Desktop/0.163.0 (Mac OS26.5.2;arm64) dumb (tenjin;1)',
])('recognizes the qualified server version with host originator %s', (agent) => {
  expect(codexAppServerVersion(agent)).toBe('0.163.0');
});

it.each([
  'Codex Desktop/0.157.1 (tenjin/0.163.0)',
  'Codex Desktop/0.163.0-dev',
  'missing version',
  undefined,
])('does not qualify a mismatched or missing first product version: %s', (agent) => {
  expect(codexAppServerVersion(agent)).not.toBe('0.163.0');
});
