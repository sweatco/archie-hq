import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // tools/pm is exercised by `node --test`, which this provider cannot see.
      include: ['src/**/*.{ts,tsx}', 'tools/**/*.{ts,mjs}', 'scripts/**/*.ts'],
      exclude: ['**/*.test.*', '**/__tests__/**', 'src/test-support/**', 'tools/pm/**'],
      reporter: ['text-summary', 'html', 'json-summary', 'json'],
    },
  },
  resolve: {
    // TypeScript files import with .js extensions (NodeNext resolution).
    // Vitest needs to map those back to .ts for source resolution.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
