// ESLint (flat config) for the whole monorepo: `pnpm lint`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/desktop/resources/**',
      'apps/desktop/bin/**',
      'apps/desktop/.build/**',
      'apps/api/prisma/**',
      'native/**',
      'docs/**',
      'tests/security/.work/**',
      'tests/security/results/**',
      'tests/e2e-video/.raw/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.serviceworker, chrome: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // a `let` captured by a closure created before its single assignment is fine
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // NestJS dependency injection reads constructor parameter types at runtime
    // (emitDecoratorMetadata): converting those imports to `import type` would break it.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Test code may use `any` for loosely-typed API responses and fakes.
    files: ['tests/**/*.ts', '**/test/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Node scripts
    files: ['**/*.{js,mjs,cjs}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
