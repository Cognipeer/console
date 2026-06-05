import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    pool: 'forks',
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      include: [
        'src/lib/services/**/*.ts',
        'src/lib/providers/**/*.ts',
        'src/lib/license/**/*.ts',
        'src/server/api/**/*.ts',
      ],
      exclude: ['node_modules/**', 'src/__tests__/**'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
