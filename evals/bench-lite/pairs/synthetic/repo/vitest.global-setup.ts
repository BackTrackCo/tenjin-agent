import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Refresh the generated pricing table before the suite runs. */
export default function setup(): void {
  const script = fileURLToPath(new URL('./scripts/build-pricing.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { stdio: 'ignore' });
}
