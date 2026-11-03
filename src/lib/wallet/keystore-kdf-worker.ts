import { parentPort, workerData } from 'node:worker_threads';
import { scrypt } from 'hash-wasm';
import * as Bytes from 'ox/Bytes';
import * as Keystore from 'ox/Keystore';

// Structured-clone IPC only: passphrase and derived key never enter argv, env,
// files, stdout, stderr or an exception message. The parent terminates this
// single-use worker before accepting its result.
try {
  const keystore = workerData.keystore as Keystore.Keystore;
  const params = keystore.crypto.kdfparams;
  const n = 'n' in params ? params.n : 0;
  let key: Keystore.Key;
  // Accelerate the existing wallet shape, including cheaper test fixtures.
  // Bound WASM's main workspace to 32 MiB; other formats/costs keep Ox's behavior.
  if (
    keystore.crypto.kdf === 'scrypt' &&
    'r' in params &&
    params.r === 1 &&
    'p' in params &&
    params.p === 8 &&
    params.dklen === 32 &&
    Number.isSafeInteger(n) &&
    n >= 2 &&
    n <= 262144 &&
    (n & (n - 1)) === 0
  ) {
    // Keep Ox's decoding of both fields, including rejection of malformed IVs.
    Bytes.from(`0x${keystore.crypto.cipherparams.iv}`);
    const salt = Bytes.from(`0x${params.salt}`);
    try {
      const derived = await scrypt({
        password: workerData.password,
        salt,
        costFactor: n,
        blockSize: 1,
        parallelism: 8,
        hashLength: 32,
        outputType: 'binary',
      });
      key = Bytes.toHex(derived);
      derived.fill(0);
    } catch {
      // Runtimes that disable WASM still unlock with the existing implementation.
      key = await Keystore.toKeyAsync(keystore, { password: workerData.password });
    }
  } else {
    key = await Keystore.toKeyAsync(keystore, { password: workerData.password });
  }
  parentPort?.postMessage({ key: typeof key === 'function' ? key() : key });
} catch {
  parentPort?.postMessage({ error: 'Keystore derivation failed.' });
}
parentPort?.close();
