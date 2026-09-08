import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    include: [
      '{apps,packages}/*/src/**/*.test.ts',
      'evaluation/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    root: import.meta.dirname,
  },
});
