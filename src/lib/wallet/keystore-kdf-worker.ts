import { parentPort, workerData } from 'node:worker_threads';
import * as Keystore from 'ox/Keystore';

// Structured-clone IPC only: passphrase and derived key never enter argv, env,
// files, stdout, stderr or an exception message. The parent terminates this
// single-use worker before accepting its result.
try {
  const key = await Keystore.toKeyAsync(workerData.keystore, { password: workerData.password });
  parentPort?.postMessage({ key: typeof key === 'function' ? key() : key });
} catch {
  parentPort?.postMessage({ error: 'Keystore derivation failed.' });
}
parentPort?.close();
