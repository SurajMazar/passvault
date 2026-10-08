import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { VITE_PRODUCTION_URL: 'https://vault.example.com' },
  },
});
