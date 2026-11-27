import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/**
 * Stress run: `stress.ts <ms> <none|kill|stop|both> [workers] [dir] [broken] [minBroken] [primitive]`. N workers take one lock in
 * a loop; chaos kills (SIGKILL, then respawn) or stops (SIGSTOP 400 ms) a random one every
 * period. Prints one JSON line: overlaps must be 0, and so must timeouts. `broken` (a probability) makes
 * that share of rounds skip the lock, as a control: the run must then report overlaps. The run lasts
 * `ms` at least, and goes on until the workers broke the lock `minBroken` times (capped at four
 * times `ms`), so a control cannot end before it had the chance to be seen. `primitive` is
 * `sqlite` for the Linux primitive on any platform that has node:sqlite.
 */
const [
  msArg = '20000',
  chaos = 'both',
  workersArg = '8',
  dirArg,
  brokenArg = '0',
  minBrokenArg = '0',
  primitive = '',
] = process.argv.slice(2);
const minBroken = Number(minBrokenArg);
const ms = Number(msArg);
const workers = Number(workersArg);
const dir = dirArg ?? mkdtempSync(join(tmpdir(), 'held-stress-'));
mkdirSync(dir, { recursive: true });
const log = join(dir, 'log');
appendFileSync(log, '');
const worker = fileURLToPath(new URL('./stress-worker.ts', import.meta.url));
const register = new URL('./register.mjs', import.meta.url).href;

type Totals = { rounds: number; timeouts: number; errors: number; broken: number };
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
      log,
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, STRESS_BROKEN: brokenArg, STRESS_PRIMITIVE: primitive },
    },
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
const sumOf = () =>
  [...dead, ...last.values()].reduce(
    (a, b) => ({
      rounds: a.rounds + b.rounds,
      timeouts: a.timeouts + b.timeouts,
      errors: a.errors + b.errors,
      broken: a.broken + b.broken,
    }),
    { rounds: 0, timeouts: 0, errors: 0, broken: 0 },
  );
const end = performance.now() + ms;
const cap = performance.now() + 4 * ms;
while (performance.now() < end || (sumOf().broken < minBroken && performance.now() < cap)) {
  await delay(chaos === 'stop' ? 100 : 250);
  if (chaos === 'none') continue;
  const list = [...children];
  const pick = list[Math.floor(Math.random() * list.length)];
  if (!pick) continue;
  const action = chaos === 'both' ? (Math.random() < 0.5 ? 'kill' : 'stop') : chaos;
  if (action === 'kill' || process.platform === 'win32') {
    kills++;
    // Logged first: a holder killed inside leaves no exit line, and this closes its entry.
    appendFileSync(log, `K ${pick.pid}\n`);
    pick.kill('SIGKILL');
    start();
  } else {
    stops++;
    pick.kill('SIGSTOP');
    setTimeout(() => pick.kill('SIGCONT'), 400);
  }
}
if (process.platform !== 'win32') for (const child of children) child.kill('SIGCONT');
for (const child of children) child.kill('SIGTERM');
await delay(1500);
const sum = sumOf();
// Replay the log: an enter while another holder is inside, and not killed, is an overlap.
const inside = new Set<string>();
const killed = new Set<string>();
let overlaps = 0;
let entries = 0;
for (const line of readFileSync(log, 'utf8').split('\n')) {
  const [kind, pid] = line.split(' ');
  if (!pid) continue;
  // A holder logs its own lines until the kill lands: once it is marked killed, none count.
  if (kind === 'K') {
    killed.add(pid);
    inside.delete(pid);
    continue;
  }
  if (killed.has(pid)) continue;
  if (kind === 'E') {
    entries++;
    if (inside.size > 0) overlaps++;
    inside.add(pid);
  } else inside.delete(pid);
}
process.stdout.write(
  `${JSON.stringify({ ...sum, rounds: entries, overlaps, kills, stops, chaos, ms })}\n`,
);
rmSync(dir, { recursive: true, force: true });
for (const child of children) child.kill('SIGKILL');
process.exit(0);
