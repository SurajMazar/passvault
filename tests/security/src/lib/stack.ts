import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ROOT, WORK } from './paths';

/**
 * Disposable PassVault stack for the harness: its own compose project
 * (`pv-security`), its own database volume, freshly generated secrets, and
 * loopback-only ports. Torn down with `down -v` (data deleted) after the run.
 *
 * The API runs with LOG_LEVEL=debug on purpose: the leakage suite checks the
 * most verbose logs the server can produce.
 */
export const PROJECT = 'pv-security';
/** Container CLI: podman (default) or docker (e.g. GitHub-hosted runners): PV_SEC_CONTAINER=docker. */
const CLI = process.env.PV_SEC_CONTAINER === 'docker' ? 'docker' : 'podman';
const ENV_FILE = join(WORK, 'stack.env');

export interface Stack {
  apiUrl: string;
  mailpitUrl: string;
  webOrigin: string;
  project: string;
  psql(sql: string): string;
  pgDump(): string;
  apiLogs(): string;
  containerId(service: string): string;
}

function compose(args: string[], opts: { input?: string; quiet?: boolean } = {}): string {
  const r = spawnSync(CLI, ['compose', '-p', PROJECT, '--env-file', ENV_FILE, '-f', join(ROOT, 'compose.yaml'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`${CLI} compose ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).slice(-2000)}`);
  return r.stdout;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

async function pickPort(preferred: number, fallback: number): Promise<number> {
  if (await portFree(preferred)) return preferred;
  if (await portFree(fallback)) return fallback;
  throw new Error(`ports ${preferred} and ${fallback} are both in use`);
}

export function containerId(service: string): string {
  const id = execFileSync(
    CLI,
    ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--filter', `label=com.docker.compose.service=${service}`],
    { encoding: 'utf8' },
  ).trim();
  if (!id) throw new Error(`no running ${service} container in project ${PROJECT}`);
  return id.split('\n')[0]!;
}

function handle(apiPort: number, mailPort: number, webOrigin: string): Stack {
  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    mailpitUrl: `http://127.0.0.1:${mailPort}`,
    webOrigin,
    project: PROJECT,
    containerId,
    psql: (sql) => execFileSync(CLI, ['exec', '-i', containerId('postgres'), 'psql', '-U', 'passvault', '-d', 'passvault', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }),
    pgDump: () => execFileSync(CLI, ['exec', containerId('postgres'), 'pg_dump', '-U', 'passvault', '-d', 'passvault', '--data-only', '--inserts'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }),
    apiLogs: () => {
      const r = spawnSync(CLI, ['logs', containerId('api')], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
      return `${r.stdout}\n${r.stderr}`;
    },
  };
}

export async function stackUp(opts: { build?: boolean; log?: (s: string) => void } = {}): Promise<Stack> {
  const log = opts.log ?? (() => undefined);
  mkdirSync(WORK, { recursive: true });
  if (existsSync(ENV_FILE)) {
    // A kept stack (PV_SEC_KEEP_STACK=1): reuse its secrets/ports so the database password still matches.
    const s = existingStack();
    log(`reusing the kept disposable stack (${PROJECT}) on ${s.apiUrl}…`);
    if (opts.build ?? process.env.PV_SEC_SKIP_BUILD !== '1') compose(['build', 'api']);
    compose(['up', '-d']);
    return waitHealthy(s);
  }
  const apiPort = Number(process.env.PV_SEC_API_PORT) || (await pickPort(3000, 3911));
  const mailPort = Number(process.env.PV_SEC_MAILPIT_PORT) || (await pickPort(8025, 8911));
  const webOrigin = 'http://127.0.0.1:4317';
  const secret = () => randomBytes(32).toString('base64');
  writeFileSync(
    ENV_FILE,
    [
      `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
      `MFA_ENCRYPTION_KEY=${secret()}`,
      `RECOVERY_CODE_PEPPER=${secret()}`,
      `PRELOGIN_SECRET=${secret()}`,
      `API_PORT=${apiPort}`,
      `MAILPIT_UI_PORT=${mailPort}`,
      `WEB_APP_URL=${webOrigin}`,
      `CORS_ORIGINS=${webOrigin},http://localhost:5173`,
      'LOG_LEVEL=debug',
      'API_NODE_ENV=development',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  if (opts.build ?? process.env.PV_SEC_SKIP_BUILD !== '1') {
    log('building the API image from the working tree…');
    compose(['build', 'api']);
  }
  log(`starting disposable stack (${PROJECT}) on 127.0.0.1:${apiPort}…`);
  compose(['up', '-d']);
  return waitHealthy(handle(apiPort, mailPort, webOrigin));
}

async function waitHealthy(s: Stack): Promise<Stack> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${s.apiUrl}/api/v1/health`);
      const m = await fetch(`${s.mailpitUrl}/readyz`);
      if (r.ok && m.ok) return s;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`API did not become healthy:\n${s.apiLogs().slice(-3000)}`);
}

export function stackDown(log: (s: string) => void = () => undefined) {
  if (!existsSync(ENV_FILE)) return;
  log(`removing disposable stack ${PROJECT} (containers + volume)…`);
  compose(['down', '-v'], { quiet: true });
  rmSync(ENV_FILE, { force: true });
}

/** Connect to a stack that is already up (stack:up) without rebuilding. */
export function existingStack(): Stack {
  const env = Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return handle(Number(env.API_PORT), Number(env.MAILPIT_UI_PORT), env.WEB_APP_URL!);
}
