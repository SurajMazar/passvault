import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { TestProject } from 'vitest/node';

const API_DIR = resolve(__dirname, '..');
const REPO = resolve(API_DIR, '../..');

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Resets the e2e database before the run: drop + recreate the public schema,
 * then `prisma migrate deploy` (exercises the real migration, incl. the
 * pv_change_seq sequence). Refuses to touch a database whose name does not
 * end in "_test".
 */
export default async function setup(project: TestProject): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ??
    execFileSync('bash', [resolve(REPO, 'scripts/dev-postgres.sh'), 'url', 'passvault_test'], { encoding: 'utf8' }).trim();
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`refusing to reset database "${dbName}": e2e database names must end with _test`);
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }
  execFileSync(resolve(API_DIR, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  project.provide('databaseUrl', url);
}
