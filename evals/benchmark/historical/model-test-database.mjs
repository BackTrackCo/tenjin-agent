import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe } from 'vitest';
import * as schema from '../lib/db/schema';

const adminUrl = 'postgresql://postgres@127.0.0.1:5432/benchmark';
if (process.env.BENCHMARK_DATABASE_URL !== adminUrl) {
  throw new Error(
    'Disposable benchmark database is unavailable; integration tests cannot be skipped.',
  );
}
export const describeIntegration = describe;
export const newTestClient = (url) => new Client({ connectionString: url });
const shutdownCodes = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08006',
  '08003',
  '08000',
  'ECONNRESET',
  'EPIPE',
]);
export async function endQuietly(resource) {
  let unexpected;
  const onError = (error) => {
    if (!shutdownCodes.has(error.code)) unexpected ??= error;
  };
  resource.on('error', onError);
  try {
    await resource.end();
  } catch (error) {
    onError(error);
  } finally {
    resource.off('error', onError);
    resource.on('error', (error) => {
      if (!shutdownCodes.has(error.code)) throw error;
    });
  }
  if (unexpected) throw unexpected;
}
let sequence = 0;
export function testDbOwnerIsAlive(name) {
  const match = /^(?:t|blank)_(\d+)_/.exec(name);
  if (!match) return true;
  try {
    process.kill(Number(match[1]), 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}
// Preserve the source helper's conservative dead-worker cleanup contract.
async function reapStaleTestDbs(admin) {
  const candidates = await admin.query(
    'SELECT d.datname FROM pg_database d WHERE NOT EXISTS ' +
      '(SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)',
  );
  for (const { datname } of candidates.rows) {
    if (!/^(?:t|blank)_\d+_/.test(datname) || testDbOwnerIsAlive(datname)) continue;
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${datname.replaceAll('"', '""')}"`);
    } catch (error) {
      if (error?.code !== '55006') throw error;
    }
  }
}
async function create(migrated) {
  const name = `${migrated ? 't' : 'blank'}_${process.pid}_${sequence++}_${randomBytes(4).toString('hex')}`;
  const admin = newTestClient(adminUrl);
  await admin.connect();
  let result;
  try {
    await reapStaleTestDbs(admin);
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl);
    url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    result = { pool, db: drizzle(pool, { schema }), url: url.toString() };
    if (migrated) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await migrate(result.db, {
        migrationsFolder: path.join(process.cwd(), 'drizzle/migrations'),
      });
    }
    return result;
  } catch (error) {
    if (result) await endQuietly(result.pool);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    throw error;
  } finally {
    await endQuietly(admin);
  }
}
export const startTestDb = () => create(true);
export const startBlankDb = () => create(false);
export async function stopTestDb(db) {
  const parsed = new URL(db.url);
  const name = parsed.pathname.slice(1);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    !/^(?:t|blank)_\d+_\d+_[0-9a-f]{8}$/.test(name)
  ) {
    throw new Error('Refusing to remove a database outside this disposable task.');
  }
  await endQuietly(db.pool);
  const admin = newTestClient(adminUrl);
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await endQuietly(admin);
  }
}
// No reusable Docker/template state to warm. Each checkout applies the current
// migration bytes to its own database; a killed task loses the entire service.
export function warmTestContainer() {}
