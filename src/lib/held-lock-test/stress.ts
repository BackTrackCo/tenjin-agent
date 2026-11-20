import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/**
 * Stress run: `stress.ts <ms> <none|kill|stop|both> [workers] [dir]`. N workers take one lock in
 * a loop; chaos kills (SIGKILL, then respawn) or stops (SIGSTOP 400 ms) a random one every
 * period. Prints one JSON line: overlaps must be 0, and so must timeouts.
 */
const [msArg = '20000', chaos = 'both', workersArg = '8', dirArg] = process.argv.slice(2);
const ms = Number(msArg);
const workers = Number(workersArg);
const dir = dirArg ?? mkdtempSync(join(tmpdir(), 'held-stress-'));
mkdirSync(dir, { recursive: true });
const worker = fileURLToPath(new URL('./stress-worker.ts', import.meta.url));
const register = new URL('./register.mjs', import.meta.url).href;

type Totals = { rounds: number; overlaps: number; timeouts: number; errors: number };
const last = new Map<number, Totals>();
const dead: Totals[] = [];
const children = new Set<ChildProcess>();
let kills = 0;
let stops = 0;

function start() {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      register,
      worker,
      join(dir, 'lock'),
      join(dir, 'marker'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.add(child);
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        last.set(child.pid!, JSON.parse(line) as Totals);
      } catch {
        // A torn line from a killed worker.
      }
    }
  });
  child.on('exit', () => {
    children.delete(child);
    const totals = last.get(child.pid!);
    if (totals) dead.push(totals);
    last.delete(child.pid!);
  });
}

for (let index = 0; index < workers; index++) start();
const end = performance.now() + ms;
while (performance.now() < end) {
  await delay(chaos === 'stop' ? 100 : 250);
  if (chaos === 'none') continue;
  const list = [...children];
  const pick = list[Math.floor(Math.random() * list.length)];
  if (!pick) continue;
  const action = chaos === 'both' ? (Math.random() < 0.5 ? 'kill' : 'stop') : chaos;
  if (action === 'kill' || process.platform === 'win32') {
    kills++;
    pick.kill('SIGKILL');
    start();
  } else {
    stops++;
    pick.kill('SIGSTOP');
    setTimeout(() => pick.kill('SIGCONT'), 400);
  }
}
for (const child of children) child.kill('SIGCONT');
for (const child of children) child.kill('SIGTERM');
await delay(1500);
const sum = [...dead, ...last.values()].reduce(
  (a, b) => ({
    rounds: a.rounds + b.rounds,
    overlaps: a.overlaps + b.overlaps,
    timeouts: a.timeouts + b.timeouts,
    errors: a.errors + b.errors,
  }),
  { rounds: 0, overlaps: 0, timeouts: 0, errors: 0 },
);
process.stdout.write(`${JSON.stringify({ ...sum, kills, stops, chaos, ms })}\n`);
rmSync(dir, { recursive: true, force: true });
for (const child of children) child.kill('SIGKILL');
process.exit(0);
