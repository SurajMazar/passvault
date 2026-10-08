import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const HARNESS = join(ROOT, 'tests/security');
export const WORK = join(HARNESS, '.work');
export const RESULTS = join(HARNESS, 'results');
/** Per-run artifacts written by suites (moved into the run's results folder by the runner). */
export const ARTIFACTS = join(RESULTS, '_artifacts');
