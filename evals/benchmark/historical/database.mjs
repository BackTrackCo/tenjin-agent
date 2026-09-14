import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// The controller starts this service in the verifier's network namespace.
// Dependency resolution uses the immutable image tree restored by the verifier.
export async function startDatabase(schema) {
  const url = process.env.BENCHMARK_DATABASE_URL;
  if (url !== 'postgresql://postgres@127.0.0.1:5432/benchmark') {
    throw new Error('No disposable benchmark database is attached');
  }
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const { Pool } = require('pg');
  const { drizzle } = require('drizzle-orm/node-postgres');
  const { migrate } = require('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle/migrations') });
    return { pool, db, url, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
