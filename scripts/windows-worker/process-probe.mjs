import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(import.meta.url);
const run = promisify(execFile);
const canary = 'TENJIN_WINDOWS_CONTROLLER_CANARY';

function startLauncher(launcher, sid, directory, cancelFile, activityFile) {
  return spawn(
    launcher,
    [
      '--worker-sid',
      sid,
      '--parent-pid',
      String(process.pid),
      '--cwd',
      directory,
      '--cancel-file',
      cancelFile,
      '--',
      process.execPath,
      script,
      '--child',
      ...(activityFile ? [activityFile] : []),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // A controller can die while the Win32 logon call is blocked. The
      // launcher waits on the real controller handle and owns cleanup.
      detached: true,
      env: {
        ...process.env,
        [canary]: 'controller-only fixture',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        ANTHROPIC_API_KEY: 'local-windows-probe-credential',
      },
    },
  );
}

async function child(activityFile) {
  if (activityFile) await writeFile(activityFile, 'worker code started');
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

async function assertDrained(pids) {
  const expires = Date.now() + 10_000;
  while (Date.now() < expires) {
    const alive = await Promise.all(pids.map(processExists));
    if (alive.every((value) => !value)) return;
    await wait(100);
  }
  throw new Error('Worker descendants survived controller shutdown');
}

async function verify(probe, cancel) {
  const exited = once(probe, 'exit', { signal: AbortSignal.timeout(80_000) });
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
    await cancel();
    await exited;
    await assertDrained([report.child, report.leaf]);
  } finally {
    if (probe.exitCode === null && probe.signalCode === null) await cancel();
    await exited;
  }
}

function startController(args, extraEnv = {}) {
  return spawn(process.execPath, [script, '--controller', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
}

async function waitForReadyMarker(proc, marker) {
  const expires = Date.now() + 60_000;
  while (Date.now() < expires) {
    const stage = await readFile(marker, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stage) return JSON.parse(stage);
    if (proc.exitCode !== null || proc.signalCode !== null)
      throw new Error('Worker exited before reaching the suspended logon gate');
    await wait(30);
  }
  throw new Error('Worker did not reach the suspended logon gate');
}

async function verifyInterruptedLogin(launcher, sid, directory, ownerLoss) {
  const controllerArea = await mkdtemp(join(tmpdir(), 'tenjin-logon-probe-'));
  const cancelFile = join(controllerArea, 'cancel');
  const readyFile = join(controllerArea, 'ready');
  const releaseFile = join(controllerArea, 'release');
  const activityFile = join(directory, 'tenjin-probe-' + randomUUID());
  const proc = startController([launcher, sid, directory, cancelFile, activityFile], {
    TENJIN_TEST_LOGIN_READY: readyFile,
    TENJIN_TEST_LOGIN_RELEASE: releaseFile,
  });
  const exited = once(proc, 'exit', { signal: AbortSignal.timeout(95_000) });
  let activity = '';
  proc.stdout.on('data', (chunk) => {
    activity += String(chunk);
  });
  proc.stderr.resume();
  proc.stdin.on('error', () => {});
  proc.stdin.write('must not reach worker stdin\n');
  let stage;
  try {
    stage = await waitForReadyMarker(proc, readyFile);
    assert(Number.isSafeInteger(stage.launcher) && stage.launcher > 0);
    assert(Number.isSafeInteger(stage.bootstrap) && stage.bootstrap > 0);
    assert(await processExists(stage.bootstrap), 'Suspended alternate process was never created');
    if (ownerLoss) {
      assert(proc.kill(), 'Could not stop the test controller');
      await exited;
    } else {
      await writeFile(cancelFile, '');
    }
    assert(await processExists(stage.launcher), 'Launcher exited while logon was blocked');
    assert(await processExists(stage.bootstrap), 'Suspended process vanished before cleanup');
    await writeFile(releaseFile, '');
    if (!ownerLoss) {
      const [code] = await exited;
      assert.equal(code, 125, 'Launcher did not reject the cancelled start');
    }
    await assertDrained([stage.launcher, stage.bootstrap]);
    assert.equal(activity, '');
    await assert.rejects(stat(activityFile), { code: 'ENOENT' });
  } finally {
    // Always let the test-only logon wrapper return its process handles.
    // Keep the marker until the detached launcher has observed it and exited.
    await writeFile(cancelFile, '');
    await writeFile(releaseFile, '');
    await exited;
    if (stage) await assertDrained([stage.launcher, stage.bootstrap]);
    await rm(controllerArea, { recursive: true, force: true });
    await rm(activityFile, { force: true });
  }
}

const [first, ...args] = process.argv.slice(2);
if (process.platform !== 'win32') {
  throw new Error('The process ownership probe requires Windows');
}
if (first === '--child') {
  await child(args[0]);
} else if (first === '--leaf') {
  process.stdout.write('leaf ready\n');
  await wait(90_000);
} else if (first === '--controller') {
  const middle = startLauncher(...args);
  middle.stdin.on('error', () => {});
  process.stdin.pipe(middle.stdin);
  middle.stdout.pipe(process.stdout);
  middle.stderr.pipe(process.stderr);
  const [code] = await once(middle, 'exit');
  process.stdin.unpipe(middle.stdin);
  process.stdin.pause();
  process.exitCode = code ?? 125;
} else {
  const [sid, directory, heldLauncher] = args;
  if (!first || !isAbsolute(first) || !sid || !directory || !isAbsolute(directory)) {
    throw new Error('Expected absolute launcher path, worker SID and shared workspace');
  }
  const controllerArea = await mkdtemp(join(tmpdir(), 'tenjin-worker-probe-'));
  try {
    const directCancel = join(controllerArea, 'direct');
    const direct = startLauncher(first, sid, directory, directCancel);
    console.log('Windows process probe: cooperative stop');
    await verify(direct, () => writeFile(directCancel, ''));
    const middle = startController([first, sid, directory, join(controllerArea, 'lost')]);
    console.log('Windows process probe: parent loss');
    await verify(middle, () => middle.kill());
    if (heldLauncher) {
      assert(isAbsolute(heldLauncher), 'The held launcher path must be absolute');
      console.log('Windows process probe: cooperative stop during logon');
      await verifyInterruptedLogin(heldLauncher, sid, directory, false);
      console.log('Windows process probe: parent loss during logon');
      await verifyInterruptedLogin(heldLauncher, sid, directory, true);
    }
    console.log('Windows process probe passed.');
  } finally {
    await rm(controllerArea, { recursive: true, force: true });
  }
}
