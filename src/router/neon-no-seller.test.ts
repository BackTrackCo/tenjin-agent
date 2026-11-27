import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const commands = join(here, '..', 'commands');

/** Every file that holds the Neon door, its worker's wire, its payer and its refund. */
const files = [
  ...readdirSync(here)
    .filter((name) => /^neon-.*\.ts$/.test(name) && !name.endsWith('.test.ts'))
    .map((name) => join(here, name)),
  join(here, 'model-handoff.ts'),
  join(here, 'model-settings.ts'),
  join(commands, 'refund.ts'),
  join(commands, 'config-neon-probe.ts'),
];

// Failure caught: a seller, an origin, a payee or a price written into the CLI turns a catalog
// change into a CLI release, and lets a stale build pay someone the catalog no longer names. The
// provider row is the only source. The one literal is the row's own id, the name of what to look
// up, which is not a seller's address or a price.
it('names no seller, origin, payee or price outside the provider row', () => {
  for (const file of files) {
    // The code only: a documentation link in a comment is no destination the CLI can pay.
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.includes("NEON_ROW_ID = '") && !/^\s*\/\//.test(line))
      .join('\n');
    expect(text, file).not.toMatch(/blockrun/i);
    expect(text, file).not.toMatch(/x402inference|nanogpt\.com/i);
    expect(text, file).not.toMatch(/https?:\/\/(?!tenjin\.sh)/);
    expect(text, file).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text, file).not.toMatch(/NEON_MODELS|inMilli|outMilli|PerMillion: '\d/);
  }
});

it('has no Neon switch, consent record or consent step left in the code', () => {
  const core = readFileSync(join(here, '..', 'cli', 'core.ts'), 'utf8');
  expect(core).not.toMatch(/config\.command\('neon \[mode\]'\)|neonConsent/);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    expect(text, file).not.toMatch(/neonConsent|router\.neon\b|config neon on/);
  }
});
