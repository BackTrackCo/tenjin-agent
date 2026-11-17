import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(import.meta.url);
const run = promisify(execFile);
const canary = 'TENJIN_WINDOWS_CONTROLLER_CANARY';

function startLauncher(launcher, sid, directory) {
  return spawn(
    launcher,
    [
      '--worker-sid',
      sid,
      '--parent-pid',
      String(process.pid),
      '--cwd',
      directory,
      '--',
      process.execPath,
      script,
      '--child',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        [canary]: 'controller-only fixture',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        ANTHROPIC_API_KEY: 'local-windows-probe-credential',
      },
    },
  );
}

async function child() {
  process.stderr.write('tenjin Windows qualification: node probe started\n');
  const input = createInterface({ input: process.stdin });
  const incoming = once(input, 'line');
  const leaf = spawn(process.execPath, [script, '--leaf'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  await once(leaf.stdout, 'data');
  process.stderr.write('tenjin Windows qualification: probe grandchild ready\n');
  const [roundTrip] = await incoming;
  process.stdout.write(
    JSON.stringify({
      child: process.pid,
      leaf: leaf.pid,
      roundTrip,
      profile: process.env.USERPROFILE,
      controllerValueAbsent: process.env[canary] === undefined,
    }) + '\n',
  );
  process.stderr.write('tenjin Windows qualification: probe received stdio\n');
  await wait(90_000);
}

function reportFrom(proc) {
  let timer;
  return Promise.race([
    new Promise((resolve, reject) => {
      const output = createInterface({ input: proc.stdout });
      output.once('line', (line) => {
        output.close();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error('Worker process probe did not emit a valid report'));
        }
      });
      proc.once('error', reject);
      proc.once('exit', () =>
        reject(new Error('Worker exited before the process probe handshake')),
      );
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker process probe timed out')), 60_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function processExists(pid) {
  const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
  const { stdout } = await run(tasklist, ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
    timeout: 5_000,
    windowsHide: true,
  });
  return stdout.split(/\r?\n/).some((line) => line.split(',')[1] === '"' + pid + '"');
}

async function assertDrained(report) {
  const expires = Date.now() + 10_000;
  while (Date.now() < expires) {
    const alive = await Promise.all([processExists(report.child), processExists(report.leaf)]);
    if (alive.every((value) => !value)) return;
    await wait(100);
  }
  throw new Error('Worker descendants survived controller shutdown');
}

async function verify(probe, kill) {
  const exited = once(probe, 'exit');
  const diagnostics = createInterface({ input: probe.stderr });
  diagnostics.on('line', (line) => {
    if (/^tenjin Windows (qualification|worker): [\w ()-]{1,100}$/.test(line)) console.log(line);
  });
  try {
    probe.stdin.write('stdio probe\n');
    const report = await reportFrom(probe);
    assert.equal(report.roundTrip, 'stdio probe');
    assert(report.controllerValueAbsent);
    assert(
      report.profile && report.profile.toLowerCase() !== process.env.USERPROFILE?.toLowerCase(),
    );
    const alive = await Promise.all([processExists(report.child), processExists(report.leaf)]);
    assert(alive.every(Boolean), 'Both worker descendants must be observable before shutdown');
    kill();
    await exited;
    await assertDrained(report);
  } finally {
    if (probe.exitCode === null && probe.signalCode === null) probe.kill();
    await exited;
  }
}

const [first, ...args] = process.argv.slice(2);
if (process.platform !== 'win32') {
  throw new Error('The process ownership probe requires Windows');
}
if (first === '--child') {
  await child();
} else if (first === '--leaf') {
  process.stdout.write('leaf ready\n');
  await wait(90_000);
} else if (first === '--controller') {
  const middle = startLauncher(...args);
  process.stdin.pipe(middle.stdin);
  middle.stdout.pipe(process.stdout);
  middle.stderr.pipe(process.stderr);
  await once(middle, 'exit');
} else {
  const [sid, directory] = args;
  if (!first || !isAbsolute(first) || !sid || !directory || !isAbsolute(directory)) {
    throw new Error('Expected absolute launcher path, worker SID and shared workspace');
  }
  const direct = startLauncher(first, sid, directory);
  console.log('Windows process probe: direct stop');
  await verify(direct, () => direct.kill());
  const middle = spawn(process.execPath, [script, '--controller', first, sid, directory], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  console.log('Windows process probe: parent loss');
  await verify(middle, () => middle.kill());
  console.log('Windows process probe passed for direct stop and parent loss.');
}
