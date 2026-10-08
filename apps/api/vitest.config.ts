import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (instead of esbuild) so Nest's decorator metadata (emitDecoratorMetadata) works.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2022' } })],
  test: {
    include: ['test/**/*.e2e.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // all files share one real Postgres database
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
